# Cadence CX iteration 2: call playback (audio storage + segments), bulk import (sheet/audio), score disputes,
# daily QA digest (preview/send/logs/cron), LDAP config/login + LDAP JWT sessions in core.auth_user.
# Tokens from `python tests/make_test_users.py --ticket` -> /tmp/tokens.json
import io
import json
import os
import time
import uuid
from datetime import datetime, timedelta, timezone

import jwt
import openpyxl
import pytest
import requests
from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv("/app/frontend/.env")
load_dotenv("/app/backend/.env")
BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
TOK = json.load(open("/tmp/tokens.json"))
ADMIN_ID, AGENT_ID = TOK["admin"]["id"], TOK["agent"]["id"]
AUDIO = "/tmp/call.mp3"
SEEDED_DISPUTE = "68b74230-cfa9-43ef-aa0a-3e1e9b3cd600"
db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
CREATED = []  # interaction ids created by this module

TRANSCRIPT = ("Agent: Thank you for calling Cadence, this call may be recorded for quality purposes. My name is Sam.\n"
              "Customer: Hi, I'd like a refund for order 4521.\nAgent: May I confirm your full name?\nCustomer: John Smith.\n"
              "Agent: Thanks John, verified. Refund raised, 5-7 business days. Anything else?\nCustomer: No.\nAgent: Have a great day!")


def sess(who):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {TOK[who]['token']}"})
    return s


@pytest.fixture(scope="module")
def admin():
    return sess("admin")


@pytest.fixture(scope="module")
def agent():
    return sess("agent")


@pytest.fixture(scope="module", autouse=True)
def cleanup():
    yield
    for iid in CREATED:
        db.interactions.delete_one({"id": iid})


def poll(s, iid, timeout=150):
    end, d = time.time() + timeout, {}
    while time.time() < end:
        d = s.get(f"{BASE_URL}/api/interactions/{iid}").json()
        if d.get("status") in ("scored", "failed"):
            return d
        time.sleep(4)
    return d


# ---------- Call playback ----------
class TestPlayback:
    def test_seeded_audio_owner_and_staff(self, admin, agent):
        for s in (admin, agent):
            r = s.get(f"{BASE_URL}/api/interactions/{SEEDED_DISPUTE}/audio")
            assert r.status_code == 200 and r.headers["content-type"].startswith("audio/") and len(r.content) > 10000
        d = agent.get(f"{BASE_URL}/api/interactions/{SEEDED_DISPUTE}").json()
        assert d["segments"] and {"start", "end", "text"} <= set(d["segments"][0])

    def test_audio_404_cases(self, admin, agent):
        other = db.interactions.find_one({"agent_id": {"$ne": AGENT_ID}, "audio_path": {"$nin": [None, ""]}}, {"id": 1})
        if other:
            assert agent.get(f"{BASE_URL}/api/interactions/{other['id']}/audio").status_code == 404
        noaudio = db.interactions.find_one({"audio_path": {"$in": [None, ""]}}, {"id": 1})
        assert admin.get(f"{BASE_URL}/api/interactions/{noaudio['id']}/audio").status_code == 404
        assert requests.get(f"{BASE_URL}/api/interactions/{SEEDED_DISPUTE}/audio").status_code == 401

    def test_agent_upload_audio_stored_and_segmented(self, agent):
        if not os.path.exists(AUDIO):
            pytest.skip("no audio")
        with open(AUDIO, "rb") as fh:
            r = agent.post(f"{BASE_URL}/api/interactions", data={"channel": "voice", "form_id": "form-voice", "customer_name": "TEST_cust"},
                           files={"file": ("TEST_call.mp3", fh, "audio/mpeg")})
        assert r.status_code == 200, r.text
        d = r.json()
        CREATED.append(d["id"])
        assert d["agent_id"] == AGENT_ID and d["audio_path"].endswith(".mp3") and d["status"] == "transcribing"
        d = poll(agent, d["id"])
        assert d["status"] == "scored", d.get("error")
        assert len(d["segments"]) > 0 and isinstance(d["segments"][0]["start"], (int, float))
        a = agent.get(f"{BASE_URL}/api/interactions/{d['id']}/audio")
        assert a.status_code == 200 and len(a.content) == os.path.getsize(AUDIO)


# ---------- Bulk import ----------
class TestBulk:
    def test_bulk_sheet_agent_403(self, agent):
        r = agent.post(f"{BASE_URL}/api/interactions/bulk-sheet", files={"file": ("a.csv", b"agent_name,transcript\nx,y", "text/csv")})
        assert r.status_code == 403
        r = agent.post(f"{BASE_URL}/api/interactions/bulk-audio", data={"form_id": "form-voice"},
                       files={"files": ("a.mp3", b"x", "audio/mpeg")})
        assert r.status_code == 403

    def test_bulk_sheet_csv_rows_and_errors(self, admin):
        csv = ("agent_name,agent_email,channel,customer_name,form,transcript\n"
               f"TEST_Bulk Agent,,chat,TEST_c1,Chat Email & WhatsApp QA,\"{TRANSCRIPT}\"\n"
               ",,chat,TEST_c2,,hello\n"
               "TEST_X,,pigeon,TEST_c3,,hello\n"
               "TEST_Y,,chat,TEST_c4,,\n")
        r = admin.post(f"{BASE_URL}/api/interactions/bulk-sheet", files={"file": ("TEST.csv", csv.encode(), "text/csv")})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["created"] == 1 and len(d["errors"]) == 3
        assert {e["row"] for e in d["errors"]} == {3, 4, 5}
        docs = list(db.interactions.find({"batch_id": d["batch_id"]}, {"_id": 0}))
        CREATED.extend(x["id"] for x in docs)
        assert len(docs) == 1 and docs[0]["agent_name"] == "TEST_Bulk Agent" and docs[0]["channel"] == "chat"
        assert docs[0]["form_id"] == "form-chat"
        s = poll(admin, docs[0]["id"])
        assert s["status"] == "scored", s.get("error")

    def test_bulk_sheet_xlsx_agent_email_link(self, admin):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(["agent_name", "agent_email", "channel", "customer_name", "form", "transcript"])
        ws.append(["ignored", "AGENT.ONE+clerk_test@example.com", "voice", "TEST_x", "form-voice", TRANSCRIPT])
        buf = io.BytesIO()
        wb.save(buf)
        r = admin.post(f"{BASE_URL}/api/interactions/bulk-sheet", files={"file": ("TEST.xlsx", buf.getvalue(), "application/octet-stream")})
        assert r.status_code == 200, r.text
        docs = list(db.interactions.find({"batch_id": r.json()["batch_id"]}, {"_id": 0}))
        CREATED.extend(x["id"] for x in docs)
        assert len(docs) == 1 and docs[0]["agent_id"] == AGENT_ID and docs[0]["form_id"] == "form-voice"

    def test_bulk_sheet_limits(self, admin):
        big = "agent_name,transcript\n" + "".join(f"TEST_{i},hi\n" for i in range(201))
        r = admin.post(f"{BASE_URL}/api/interactions/bulk-sheet", files={"file": ("big.csv", big.encode(), "text/csv")})
        assert r.status_code == 400 and "200" in r.json()["detail"]
        r = admin.post(f"{BASE_URL}/api/interactions/bulk-sheet", files={"file": ("x.txt", b"a,b", "text/plain")})
        assert r.status_code == 400
        r = admin.post(f"{BASE_URL}/api/interactions/bulk-sheet", files={"file": ("x.xlsx", b"garbage", "application/octet-stream")})
        assert r.status_code == 400
        r = admin.post(f"{BASE_URL}/api/interactions/bulk-sheet", files={"file": ("e.csv", b"agent_name,transcript\n", "text/csv")})
        assert r.status_code == 400

    def test_bulk_audio(self, admin):
        if not os.path.exists(AUDIO):
            pytest.skip("no audio")
        audio = open(AUDIO, "rb").read()
        r = admin.post(f"{BASE_URL}/api/interactions/bulk-audio", data={"form_id": "form-voice", "channel": "voice", "agent_id": AGENT_ID},
                       files=[("files", ("TEST_a.mp3", audio, "audio/mpeg")), ("files", ("TEST_bad.txt", b"x", "text/plain"))])
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["created"] == 1 and d["errors"][0]["row"] == "TEST_bad.txt"
        docs = list(db.interactions.find({"batch_id": d["batch_id"]}, {"_id": 0}))
        CREATED.extend(x["id"] for x in docs)
        assert docs[0]["agent_id"] == AGENT_ID and docs[0]["audio_path"]
        r = admin.post(f"{BASE_URL}/api/interactions/bulk-audio", data={"form_id": "form-voice"},
                       files=[("files", (f"f{i}.mp3", b"x", "audio/mpeg")) for i in range(51)])
        assert r.status_code == 400
        r = admin.post(f"{BASE_URL}/api/interactions/bulk-audio", data={"form_id": "form-voice", "agent_id": "nope"},
                       files=[("files", ("f.mp3", b"x", "audio/mpeg"))])
        assert r.status_code == 400


# ---------- Disputes ----------
class TestDisputes:
    def test_dispute_full_flow(self, admin, agent):
        r = agent.post(f"{BASE_URL}/api/interactions", data={"channel": "chat", "form_id": "form-chat" if db.qa_forms.find_one({"id": "form-chat"}) else "form-voice",
                                                            "transcript": TRANSCRIPT, "customer_name": "TEST_disp"})
        assert r.status_code == 200, r.text
        iid = r.json()["id"]
        CREATED.append(iid)
        assert agent.post(f"{BASE_URL}/api/interactions/{iid}/dispute", json={"reason": "not scored yet"}).status_code == 400
        d = poll(agent, iid)
        assert d["status"] == "scored"
        orig = d["overall_score"]
        cid = d["criteria_results"][0]["id"]
        # others cannot raise
        assert admin.post(f"{BASE_URL}/api/interactions/{iid}/dispute", json={"reason": "admin tries"}).status_code == 404
        assert agent.post(f"{BASE_URL}/api/interactions/{iid}/dispute", json={"reason": "x"}).status_code == 422
        r = agent.post(f"{BASE_URL}/api/interactions/{iid}/dispute", json={"reason": "TEST_ I verified", "criterion_ids": [cid, "bogus"]})
        assert r.status_code == 200 and r.json()["criterion_ids"] == [cid] and r.json()["score_at_dispute"] == orig
        assert agent.post(f"{BASE_URL}/api/interactions/{iid}/dispute", json={"reason": "TEST_ again"}).status_code == 409
        assert any(x["id"] == iid for x in agent.get(f"{BASE_URL}/api/disputes?status=open").json())
        assert any(x["id"] == iid for x in admin.get(f"{BASE_URL}/api/disputes?status=open").json())
        assert admin.get(f"{BASE_URL}/api/dashboard").json()["kpis"]["open_disputes"] >= 1
        # resolve
        assert agent.post(f"{BASE_URL}/api/interactions/{iid}/dispute/resolve", json={"decision": "accepted", "new_score": 99}).status_code == 403
        assert admin.post(f"{BASE_URL}/api/interactions/{iid}/dispute/resolve", json={"decision": "accepted"}).status_code == 400
        assert admin.post(f"{BASE_URL}/api/interactions/{iid}/dispute/resolve", json={"decision": "accepted", "new_score": 101}).status_code == 422
        assert admin.post(f"{BASE_URL}/api/interactions/{iid}/dispute/resolve", json={"decision": "maybe"}).status_code == 400
        r = admin.post(f"{BASE_URL}/api/interactions/{iid}/dispute/resolve", json={"decision": "accepted", "new_score": 91.25, "note": "TEST_ ok"})
        assert r.status_code == 200, r.text
        g = agent.get(f"{BASE_URL}/api/interactions/{iid}").json()
        assert g["overall_score"] == 91.2 or g["overall_score"] == 91.3
        assert g["original_score"] == orig and g["auto_failed"] is False and g["dispute"]["status"] == "resolved"
        assert any(x["id"] == iid for x in agent.get(f"{BASE_URL}/api/disputes?status=resolved").json())
        assert admin.post(f"{BASE_URL}/api/interactions/{iid}/dispute/resolve", json={"decision": "rejected"}).status_code == 409
        # second dispute -> rejected keeps score, original_score stays the first one
        assert agent.post(f"{BASE_URL}/api/interactions/{iid}/dispute", json={"reason": "TEST_ second"}).status_code == 200
        assert admin.post(f"{BASE_URL}/api/interactions/{iid}/dispute/resolve", json={"decision": "rejected"}).status_code == 200
        g2 = admin.get(f"{BASE_URL}/api/interactions/{iid}").json()
        assert g2["overall_score"] == g["overall_score"] and g2["original_score"] == orig and g2["dispute"]["decision"] == "rejected"

    def test_disputes_scoped(self, agent):
        for x in agent.get(f"{BASE_URL}/api/disputes").json():
            assert x["agent_id"] == AGENT_ID


# ---------- Digest ----------
class TestDigest:
    def test_preview_and_recipients(self, admin, agent):
        uid = f"TEST_tl_{uuid.uuid4().hex[:8]}"
        db.users.insert_one({"user_id": uid, "email": f"{uid}@example.com", "name": "TEST TL", "role": "team_lead", "env": "preview"})
        try:
            r = admin.get(f"{BASE_URL}/api/digest/preview")
            assert r.status_code == 200
            d = r.json()
            assert f"{uid}@example.com".lower() in d["recipients"]
            assert "qa.admin+clerk_test@example.com" not in d["recipients"]
            assert d["smtp_configured"] is False and d["ldap_enabled"] is False
            assert "<div" in d["html"] and {"evaluated", "avg_score", "flags", "open_disputes"} <= set(d["stats"])
        finally:
            db.users.delete_one({"user_id": uid})
        assert agent.get(f"{BASE_URL}/api/digest/preview").status_code == 403
        assert agent.get(f"{BASE_URL}/api/digest/logs").status_code == 403
        assert agent.post(f"{BASE_URL}/api/digest/send").status_code == 403

    def test_send_without_smtp_logs_failure(self, admin):
        r = admin.post(f"{BASE_URL}/api/digest/send")
        assert r.status_code == 200
        d = r.json()
        assert d["status"] == "failed" and "SMTP is not configured" in d["error"]
        logs = admin.get(f"{BASE_URL}/api/digest/logs").json()
        assert logs[0]["id"] == d["id"] and "_id" not in logs[0]

    def test_cron(self):
        url = f"{BASE_URL}/api/cron/digest"
        sec = os.environ["WEBHOOK_CRON_SECRET"]
        assert requests.post(url, json={}).status_code == 401
        assert requests.post(url, json={}, headers={"Authorization": "Bearer wrong"}).status_code == 401
        h = {"Authorization": f"Bearer {sec}"}
        assert requests.post(url, data="notjson", headers={**h, "Content-Type": "application/json"}).status_code == 400
        assert requests.post(url, json={}, headers=h).status_code == 400
        rid = f"TEST_run_{uuid.uuid4().hex}"
        r1 = requests.post(url, json={}, headers={**h, "X-Webhook-Id": rid})
        assert r1.status_code == 200 and r1.json()["status"] == "accepted"
        r2 = requests.post(url, json={}, headers={**h, "X-Webhook-Id": rid})
        assert r2.status_code == 200 and r2.json()["status"] == "duplicate"
        time.sleep(3)
        log = db.digest_logs.find_one({"run_id": rid})
        assert log and log["trigger"] == "schedule" and log["status"] == "failed"
        db.cron_runs.delete_one({"run_id": rid})


# ---------- LDAP ----------
class TestLdap:
    def test_config_and_login_disabled(self):
        assert requests.get(f"{BASE_URL}/api/auth/ldap/config").json() == {"enabled": False}
        assert requests.post(f"{BASE_URL}/api/auth/ldap/login", json={"username": "a", "password": "b"}).status_code == 404

    def test_ldap_jwt_session(self):
        uid = f"ldap_test{uuid.uuid4().hex[:8]}"
        db.users.insert_one({"user_id": uid, "email": f"{uid}@example.com", "name": "TEST LDAP", "role": "agent", "auth": "ldap", "env": "preview"})
        try:
            exp = datetime.now(timezone.utc) + timedelta(hours=1)
            tok = jwt.encode({"sub": uid, "iss": "cadence-ldap", "exp": exp}, os.environ["LDAP_JWT_SECRET"], algorithm="HS256")
            r = requests.get(f"{BASE_URL}/api/me", headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200 and r.json()["user_id"] == uid and r.json()["role"] == "agent"
            assert requests.get(f"{BASE_URL}/api/interactions", headers={"Authorization": f"Bearer {tok}"}).status_code == 200
            forged = jwt.encode({"sub": uid, "iss": "cadence-ldap", "exp": exp}, "wrong-secret", algorithm="HS256")
            assert requests.get(f"{BASE_URL}/api/me", headers={"Authorization": f"Bearer {forged}"}).status_code == 401
            expired = jwt.encode({"sub": uid, "iss": "cadence-ldap", "exp": datetime.now(timezone.utc) - timedelta(minutes=1)},
                                 os.environ["LDAP_JWT_SECRET"], algorithm="HS256")
            assert requests.get(f"{BASE_URL}/api/me", headers={"Authorization": f"Bearer {expired}"}).status_code == 401
            ghost = jwt.encode({"sub": "ldap_ghost_nobody", "iss": "cadence-ldap", "exp": exp}, os.environ["LDAP_JWT_SECRET"], algorithm="HS256")
            assert requests.get(f"{BASE_URL}/api/me", headers={"Authorization": f"Bearer {ghost}"}).status_code == 401
            assert requests.get(f"{BASE_URL}/api/users", headers={"Authorization": f"Bearer {tok}"}).status_code == 403
        finally:
            db.users.delete_one({"user_id": uid})
