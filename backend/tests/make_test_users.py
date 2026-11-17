import os, json, sys, urllib.request
from dotenv import load_dotenv
from pymongo import MongoClient
load_dotenv("/app/backend/.env")
SK = os.environ["CLERK_SECRET_KEY"]
db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]


def bapi(path, body=None, method="POST"):
    req = urllib.request.Request("https://api.clerk.com/v1" + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Authorization": "Bearer " + SK, "Content-Type": "application/json", "User-Agent": "emergent-test"})
    return json.load(urllib.request.urlopen(req))


def get_user(email, first, last):
    found = bapi(f"/users?email_address={email}", method="GET")
    if found:
        return found[0]
    return bapi("/users", {"email_address": [email], "password": "Test-pass-12345!", "skip_password_checks": True, "first_name": first, "last_name": last})


out = {}
for key, email, first, last, role in [("admin", "qa.admin+clerk_test@example.com", "Asha", "Admin", "admin"),
                                      ("agent", "agent.one+clerk_test@example.com", "Arjun", "Agent", "agent")]:
    u = get_user(email, first, last)
    db.users.update_one({"user_id": u["id"]}, {"$set": {"role": role, "env": "preview", "email": email, "name": f"{first} {last}"}, "$setOnInsert": {"created_at": "2026-06-01T00:00:00+00:00"}}, upsert=True)
    s = bapi("/sessions", {"user_id": u["id"]})
    tok = bapi(f"/sessions/{s['id']}/tokens", {"expires_in_seconds": 3600})["jwt"]
    out[key] = {"id": u["id"], "token": tok}
    if "--ticket" in sys.argv:
        out[key]["ticket"] = bapi("/sign_in_tokens", {"user_id": u["id"], "expires_in_seconds": 3600})["token"]
json.dump(out, open("/tmp/tokens.json", "w"))
print("ok", {k: v["id"] for k, v in out.items()})
