# Helper for UI testing of LDAP sessions: `python tests/ldap_ui_session.py create` inserts a TEST ldap user and writes a
# signed session token to /tmp/ldap_tok.txt; `python tests/ldap_ui_session.py delete` removes the user.
import os
import sys
from datetime import datetime, timedelta, timezone

import jwt
from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv("/app/backend/.env")
db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
UID = "ldap_test_ui_session"

if sys.argv[1] == "create":
    db.users.update_one({"user_id": UID}, {"$set": {"user_id": UID, "email": "test.ldap.ui@example.com", "name": "TEST Ldap User",
                                                   "role": "agent", "auth": "ldap", "env": "preview"}}, upsert=True)
    tok = jwt.encode({"sub": UID, "iss": "cadence-ldap", "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
                     os.environ["LDAP_JWT_SECRET"], algorithm="HS256")
    open("/tmp/ldap_tok.txt", "w").write(tok)
    print("created")
else:
    print("deleted", db.users.delete_one({"user_id": UID}).deleted_count)
