import hashlib
import os
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, HTTPException
from ldap3 import SUBTREE, Connection, Server
from ldap3.core.exceptions import LDAPException
from ldap3.utils.conv import escape_filter_chars
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from core import DEFAULT_ROLE, ENV, LDAP_ISSUER, db, effective_role, now
from auth_utils import verify_password

ldap_router = APIRouter(prefix="/api/auth/ldap")
DEFAULT_FILTER = "(|(uid={u})(sAMAccountName={u})(mail={u}))"
MAX_FAILURES = 5
LOCK_MINUTES = 15


def ldap_enabled() -> bool:
    return bool((os.environ.get("LDAP_URL") and os.environ.get("LDAP_BASE_DN")) or os.environ.get("DEV_LOGIN", "false").lower() in ("true", "1"))


def _connection(user=None, password=None) -> Connection:
    url = os.environ.get("LDAP_URL", "")
    use_ssl = url.startswith("ldaps://")
    tls = None
    if use_ssl:
        import ssl
        from ldap3 import Tls
        tls = Tls(validate=ssl.CERT_NONE)
    server = Server(url, connect_timeout=8, use_ssl=use_ssl, tls=tls)
    return Connection(server, user=user, password=password, receive_timeout=10)


def _service_connection() -> Connection:
    conn = _connection(os.environ.get("LDAP_BIND_DN") or None, os.environ.get("LDAP_BIND_PASSWORD") or None)
    if not conn.bind():
        raise LDAPException("Service account bind failed")
    return conn


def _first(attrs: dict, *names, default=""):
    for n in names:
        v = attrs.get(n)
        if v:
            return v[0] if isinstance(v, list) else v
    return default


def ldap_authenticate(username: str, password: str) -> dict | None:
    if not username or not password:
        return None
    conn = _service_connection()
    flt = os.environ.get("LDAP_USER_FILTER") or DEFAULT_FILTER
    if "{u}" not in flt:  # a base filter like (objectClass=person): add the username match
        flt = f"(&{flt}{DEFAULT_FILTER})"
    flt = flt.replace("{u}", escape_filter_chars(username))
    conn.search(os.environ["LDAP_BASE_DN"], flt, SUBTREE, attributes=["mail", "displayName", "cn", "memberOf"])
    entries = list(conn.entries)
    conn.unbind()
    if len(entries) != 1:
        return None
    entry = entries[0]
    user_conn = _connection(entry.entry_dn, password)
    if not user_conn.bind():
        return None
    user_conn.unbind()
    attrs = entry.entry_attributes_as_dict
    return {"dn": entry.entry_dn, "email": str(_first(attrs, "mail")).lower(),
            "name": str(_first(attrs, "displayName", "cn", default=username)),
            "member_of": [str(g).lower() for g in attrs.get("memberOf", [])]}


def ldap_team_lead_emails() -> list:
    group = os.environ.get("LDAP_TEAM_LEAD_GROUP_DN", "")
    if not (ldap_enabled() and group):
        return []
    conn = _service_connection()
    conn.search(os.environ["LDAP_BASE_DN"], f"(memberOf={escape_filter_chars(group)})", SUBTREE, attributes=["mail"])
    emails = [str(m).lower() for e in conn.entries for m in e.entry_attributes_as_dict.get("mail", [])]
    conn.unbind()
    return emails


class LdapLogin(BaseModel):
    username: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=500)


@ldap_router.get("/config")
async def ldap_config():
    return {"enabled": ldap_enabled()}


@ldap_router.post("/login")
async def ldap_login(body: LdapLogin):
    if not ldap_enabled():
        raise HTTPException(status_code=404, detail="Company login is not configured")
    key = body.username.strip().lower()

    # 1. Check if user exists locally with a set password
    local_user = await db.users.find_one({
        "$or": [
            {"email": key},
            {"username": key},
            {"user_id": key}
        ]
    })
    if local_user and local_user.get("password_hash"):
        if local_user.get("disabled"):
            raise HTTPException(status_code=403, detail="This account has been deactivated. Please contact an administrator.")
        
        valid = verify_password(body.password, local_user["password_hash"])

        if not valid:
            raise HTTPException(status_code=401, detail="Invalid username or password")
        
        uid = local_user["user_id"]
        role = effective_role(local_user.get("role"))
        exp = datetime.now(timezone.utc) + timedelta(hours=12)
        token = jwt.encode({"sub": uid, "iss": LDAP_ISSUER, "exp": exp}, os.environ["LDAP_JWT_SECRET"], algorithm="HS256")
        return {"token": token, "expires_at": exp.isoformat(), "role": role, "name": local_user.get("name", key)}
    
    if os.environ.get("LDAP_URL") and os.environ.get("LDAP_BASE_DN"):
        since = (datetime.now(timezone.utc) - timedelta(minutes=LOCK_MINUTES)).isoformat()
        if await db.ldap_failures.count_documents({"username": key, "at": {"$gte": since}}) >= MAX_FAILURES:
            raise HTTPException(status_code=429, detail=f"Too many attempts. Try again in {LOCK_MINUTES} minutes.")
        try:
            info = await run_in_threadpool(ldap_authenticate, body.username.strip(), body.password)
        except LDAPException:
            raise HTTPException(status_code=502, detail="Company directory is unreachable")
        if info is None:
            await db.ldap_failures.insert_one({"username": key, "at": now()})
            raise HTTPException(status_code=401, detail="Invalid username or password")
        await db.ldap_failures.delete_many({"username": key})
    else:
        # Development mode login fallback
        name = key.split("@")[0].replace(".", " ").title()
        info = {
            "dn": f"uid={key},ou=users,dc=local",
            "email": key if "@" in key else f"{key}@jswshakti.in",
            "name": name or "Local User",
            "member_of": []
        }

    uid = "ldap_" + hashlib.sha256(info["dn"].lower().encode()).hexdigest()[:24]
    admins = {e.strip().lower() for e in os.environ.get("ADMIN_EMAIL", "").split(",") if e.strip()}
    lead_group = os.environ.get("LDAP_TEAM_LEAD_GROUP_DN", "").lower()
    is_admin = info["email"] in admins
    role = "admin" if is_admin else "team_lead" if (lead_group and lead_group in info["member_of"]) else DEFAULT_ROLE

    await db.users.update_one({"user_id": uid}, {
        "$set": {"email": info["email"], "name": info["name"], "auth": "ldap", "env": ENV, "role": role},
        "$setOnInsert": {"user_id": uid, "created_at": now()}}, upsert=True)
    exp = datetime.now(timezone.utc) + timedelta(hours=12)
    token = jwt.encode({"sub": uid, "iss": LDAP_ISSUER, "exp": exp}, os.environ["LDAP_JWT_SECRET"], algorithm="HS256")
    return {"token": token, "expires_at": exp.isoformat(), "role": role, "name": info["name"]}
