"""Offline checks: SMTP digest delivery via a local aiosmtpd server and LDAP login via ldap3 MOCK_SYNC."""
import asyncio
import os
import sys

sys.path.insert(0, "/app/backend")
os.environ.update({"SMTP_HOST": "127.0.0.1", "SMTP_PORT": "8025", "SMTP_SECURITY": "none", "SMTP_FROM": "qa@cadence.test",
                   "LDAP_URL": "ldap://mock", "LDAP_BASE_DN": "dc=corp,dc=test", "LDAP_BIND_DN": "cn=svc,dc=corp,dc=test",
                   "LDAP_BIND_PASSWORD": "svcpw", "LDAP_TEAM_LEAD_GROUP_DN": "cn=leads,ou=groups,dc=corp,dc=test"})

from aiosmtpd.controller import Controller  # noqa: E402
from ldap3 import MOCK_SYNC, Connection, Server  # noqa: E402

import ldap_auth  # noqa: E402

MOCK = Server("mock")
_mock_conn = Connection(MOCK, user="cn=svc,dc=corp,dc=test", password="svcpw", client_strategy=MOCK_SYNC)
_mock_conn.strategy.add_entry("cn=svc,dc=corp,dc=test", {"userPassword": "svcpw", "objectClass": "person"})
_mock_conn.strategy.add_entry("uid=tl1,ou=people,dc=corp,dc=test", {
    "uid": "tl1", "userPassword": "lead-pass", "mail": "lead.one@corp.test", "displayName": "Lead One",
    "memberOf": ["cn=leads,ou=groups,dc=corp,dc=test"], "objectClass": "person"})


def mock_connection(user=None, password=None):
    c = Connection(MOCK, user=user, password=password, client_strategy=MOCK_SYNC)
    c.strategy.entries = _mock_conn.strategy.entries
    return c


ldap_auth._connection = mock_connection
received = []


class Handler:
    async def handle_DATA(self, server, session, envelope):
        received.append(envelope)
        return "250 OK"


async def main():
    ok = ldap_auth.ldap_authenticate("tl1", "lead-pass")
    bad = ldap_auth.ldap_authenticate("tl1", "wrong")
    leads = ldap_auth.ldap_team_lead_emails()
    print("LDAP ok:", ok and ok["email"], "| wrong pw rejected:", bad is None, "| leads:", leads)
    import digest
    ctrl = Controller(Handler(), hostname="127.0.0.1", port=8025)
    ctrl.start()
    log = await digest.send_digest("https://example.test", "test")
    ctrl.stop()
    print("digest:", log["status"], log["error"], log["recipients"], "| emails received:", len(received),
          "| to:", received[0].rcpt_tos if received else None)
    await digest.db.digest_logs.delete_one({"id": log["id"]})


asyncio.run(main())
