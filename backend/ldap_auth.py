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

from core import DEFAULT_ROLE, ENV, LDAP_ISSUER, db, now

ldap_router = APIRouter(prefix="/api/auth/ldap")
DEFAULT_FILTER = "(|(uid={u})(sAMAccountName={u})(mail={u}))"
MAX_FAILURES = 5
LOCK_MINUTES = 15


def ldap_enabled() -> bool:
    return bool(os.environ.get("LDAP_URL") and os.environ.get("LDAP_BASE_DN"))


def _connection(user=None, password=None) -> Connection:
    return Connection(Server(os.environ["LDAP_URL"], connect_timeout=8), user=user, password=password, receive_timeout=10)


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
    flt = (os.environ.get("LDAP_USER_FILTER") or DEFAULT_FILTER).replace("{u}", escape_filter_chars(username))
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
    uid = "ldap_" + hashlib.sha256(info["dn"].lower().encode()).hexdigest()[:24]
    admins = {e.strip().lower() for e in os.environ.get("ADMIN_EMAIL", "").split(",") if e.strip()}
    lead_group = os.environ.get("LDAP_TEAM_LEAD_GROUP_DN", "").lower()
    role = "admin" if info["email"] in admins else "team_lead" if lead_group and lead_group in info["member_of"] else DEFAULT_ROLE
    await db.users.update_one({"user_id": uid}, {
        "$set": {"email": info["email"], "name": info["name"], "auth": "ldap", "env": ENV},
        "$setOnInsert": {"user_id": uid, "role": role, "created_at": now()}}, upsert=True)
    exp = datetime.now(timezone.utc) + timedelta(hours=12)
    token = jwt.encode({"sub": uid, "iss": LDAP_ISSUER, "exp": exp}, os.environ["LDAP_JWT_SECRET"], algorithm="HS256")
    return {"token": token, "expires_at": exp.isoformat()}
