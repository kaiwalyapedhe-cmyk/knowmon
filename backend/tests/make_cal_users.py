# Temporary extra staff users for calibration tests (qa_auditor + team_lead) via Clerk Backend API.
# Usage: python tests/make_cal_users.py create  -> /tmp/cal_tokens.json ; python tests/make_cal_users.py delete
import json, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from make_test_users import bapi, get_user, db  # noqa: E402  (also refreshes /tmp/tokens.json)

USERS = [("qa", "test.qaaud+clerk_test@example.com", "TEST_Quinn", "Auditor", "qa_auditor"),
         ("tl", "test.tlead+clerk_test@example.com", "TEST_Tara", "Lead", "team_lead")]

if sys.argv[1] == "create":
    out = {}
    for key, email, first, last, role in USERS:
        u = get_user(email, first, last)
        db.users.update_one({"user_id": u["id"]}, {"$set": {"role": role, "env": "preview", "email": email, "name": f"{first} {last}"},
                                                   "$setOnInsert": {"created_at": "2026-06-01T00:00:00+00:00"}}, upsert=True)
        s = bapi("/sessions", {"user_id": u["id"]})
        out[key] = {"id": u["id"], "token": bapi(f"/sessions/{s['id']}/tokens", {"expires_in_seconds": 3600})["jwt"],
                    "ticket": bapi("/sign_in_tokens", {"user_id": u["id"], "expires_in_seconds": 3600})["token"]}
    json.dump(out, open("/tmp/cal_tokens.json", "w"))
    print("created", {k: v["id"] for k, v in out.items()})
else:
    for key, email, *_ in USERS:
        found = bapi("/users?email_address=" + email.replace("+", "%2B"), method="GET")
        for u in found:
            bapi(f"/users/{u['id']}", method="DELETE")
            db.users.delete_one({"user_id": u["id"]})
            print("deleted", u["id"])
