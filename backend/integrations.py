import os
import smtplib
import ssl
from email.message import EmailMessage
from pathlib import Path
from pydantic import BaseModel
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from starlette.concurrency import run_in_threadpool

from core import require_role
from mailer import smtp_configured
from ldap_auth import ldap_enabled

ENV_PATH = Path(__file__).parent / ".env"

integrations_router = APIRouter(prefix="/api/integrations")

def update_env_file(updates: dict):
    lines = []
    if ENV_PATH.exists():
        lines = ENV_PATH.read_text(encoding="utf-8").splitlines()
    
    env_dict = {}
    ordered_keys = []
    for line in lines:
        line_clean = line.strip()
        if not line_clean or line_clean.startswith("#"):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            k = k.strip()
            env_dict[k] = v.strip()
            if k not in ordered_keys:
                ordered_keys.append(k)

    for k, v in updates.items():
        if v is not None:
            env_dict[k] = str(v)
            os.environ[k] = str(v)
            if k not in ordered_keys:
                ordered_keys.append(k)
        elif k in env_dict and v is None:
            pass

    out_lines = [f"{k}={env_dict[k]}" for k in ordered_keys]
    ENV_PATH.write_text("\n".join(out_lines) + "\n", encoding="utf-8")


@integrations_router.get("")
async def get_integrations(admin: dict = Depends(require_role("admin"))):
    return {
        "ldap": {
            "enabled": ldap_enabled(),
            "url": os.environ.get("LDAP_URL", ""),
            "base_dn": os.environ.get("LDAP_BASE_DN", ""),
            "bind_dn": os.environ.get("LDAP_BIND_DN", ""),
            "user_filter": os.environ.get("LDAP_USER_FILTER", ""),
            "team_lead_group_dn": os.environ.get("LDAP_TEAM_LEAD_GROUP_DN", ""),
            "has_password": bool(os.environ.get("LDAP_BIND_PASSWORD")),
        },
        "smtp": {
            "configured": smtp_configured(),
            "host": os.environ.get("SMTP_HOST", ""),
            "port": int(os.environ.get("SMTP_PORT") or 587),
            "security": os.environ.get("SMTP_SECURITY", "starttls"),
            "username": os.environ.get("SMTP_USERNAME", ""),
            "from_address": os.environ.get("SMTP_FROM", ""),
            "has_password": bool(os.environ.get("SMTP_PASSWORD")),
        },
        "ai": {
            "has_key": bool(os.environ.get("EMERGENT_LLM_KEY")),
            "provider": "Anthropic",
            "model": "claude-opus-5-5",
        }
    }


class LdapConfigIn(BaseModel):
    url: str
    base_dn: str
    bind_dn: Optional[str] = ""
    bind_password: Optional[str] = None
    user_filter: Optional[str] = ""
    team_lead_group_dn: Optional[str] = ""

class LdapTestIn(BaseModel):
    url: str
    base_dn: str
    bind_dn: Optional[str] = ""
    bind_password: Optional[str] = ""
    user_filter: Optional[str] = ""


@integrations_router.post("/ldap")
async def save_ldap(body: LdapConfigIn, admin: dict = Depends(require_role("admin"))):
    updates = {
        "LDAP_URL": body.url.strip(),
        "LDAP_BASE_DN": body.base_dn.strip(),
        "LDAP_BIND_DN": (body.bind_dn or "").strip(),
        "LDAP_USER_FILTER": (body.user_filter or "").strip(),
        "LDAP_TEAM_LEAD_GROUP_DN": (body.team_lead_group_dn or "").strip(),
    }
    if body.bind_password is not None and body.bind_password != "":
        updates["LDAP_BIND_PASSWORD"] = body.bind_password
    update_env_file(updates)
    return {"status": "success", "message": "LDAP configuration saved"}


@integrations_router.post("/ldap/test")
async def test_ldap(body: LdapTestIn, admin: dict = Depends(require_role("admin"))):
    from ldap3 import Server, Connection, SUBTREE
    from ldap3.core.exceptions import LDAPException
    
    url = body.url.strip()
    bind_pw = body.bind_password if (body.bind_password is not None and body.bind_password != "") else os.environ.get("LDAP_BIND_PASSWORD", "")
    bind_dn = (body.bind_dn or "").strip() or None

    def _do_test():
        try:
            use_ssl = url.startswith("ldaps://")
            tls = None
            if use_ssl:
                import ssl
                from ldap3 import Tls
                tls = Tls(validate=ssl.CERT_NONE)
            server = Server(url, connect_timeout=5, use_ssl=use_ssl, tls=tls)
            conn = Connection(server, user=bind_dn, password=bind_pw, receive_timeout=5)
            if not conn.bind():
                return {"ok": False, "error": f"Bind failed with provided credentials: {conn.result.get('description', 'Unknown error')}"}
            
            flt = (body.user_filter or "").strip() or "(objectClass=*)"
            conn.search(body.base_dn.strip(), flt, SUBTREE, size_limit=3)
            count = len(conn.entries)
            conn.unbind()
            return {"ok": True, "message": f"Successfully connected! Discovered {count} test entry/entries in directory."}
        except LDAPException as exc:
            return {"ok": False, "error": f"LDAP Error: {str(exc)}"}
        except Exception as exc:
            return {"ok": False, "error": f"Connection Error: {str(exc)}"}

    result = await run_in_threadpool(_do_test)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


class SmtpConfigIn(BaseModel):
    host: str
    port: int = 587
    security: str = "starttls"
    username: Optional[str] = ""
    password: Optional[str] = None
    from_address: str

class SmtpTestIn(BaseModel):
    host: str
    port: int = 587
    security: str = "starttls"
    username: Optional[str] = ""
    password: Optional[str] = ""
    from_address: str
    recipient: str


@integrations_router.post("/smtp")
async def save_smtp(body: SmtpConfigIn, admin: dict = Depends(require_role("admin"))):
    updates = {
        "SMTP_HOST": body.host.strip(),
        "SMTP_PORT": str(body.port),
        "SMTP_SECURITY": body.security.strip().lower(),
        "SMTP_USERNAME": (body.username or "").strip(),
        "SMTP_FROM": body.from_address.strip(),
    }
    if body.password is not None and body.password != "":
        updates["SMTP_PASSWORD"] = body.password
    update_env_file(updates)
    return {"status": "success", "message": "SMTP configuration saved"}


@integrations_router.post("/smtp/test")
async def test_smtp(body: SmtpTestIn, admin: dict = Depends(require_role("admin"))):
    host = body.host.strip()
    port = body.port
    security = body.security.strip().lower()
    pw = body.password if (body.password is not None and body.password != "") else os.environ.get("SMTP_PASSWORD", "")
    username = (body.username or "").strip()
    sender = body.from_address.strip()
    recipient = body.recipient.strip()

    def _do_send():
        try:
            msg = EmailMessage()
            msg["From"] = sender
            msg["To"] = recipient
            msg["Subject"] = "Cadence CX — SMTP Test Email"
            msg.set_content("This is a test email sent from Cadence CX to verify your SMTP configuration.")
            
            ctx = ssl.create_default_context()
            smtp = smtplib.SMTP_SSL(host, port, timeout=15, context=ctx) if security == "ssl" else smtplib.SMTP(host, port, timeout=15)
            with smtp as s:
                if security == "starttls":
                    s.starttls(context=ctx)
                if username:
                    s.login(username, pw)
                s.send_message(msg)
            return {"ok": True, "message": f"Test email sent successfully to {recipient}!"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    result = await run_in_threadpool(_do_send)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result
