# Cadence CX backend regression suite: auth/roles, QA forms, AutoQA interactions, dashboard, KB, public help,
# decision trees, training, coaching. Tokens from `python tests/make_test_users.py --ticket` -> /tmp/tokens.json
import json
import os
import time
import uuid

import pytest
import requests
from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv("/app/frontend/.env")
load_dotenv("/app/backend/.env")
BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
TOK = json.load(open("/tmp/tokens.json"))
ADMIN_ID, AGENT_ID = TOK["admin"]["id"], TOK["agent"]["id"]
AUDIO = "/tmp/test_call.mp3"

TRANSCRIPT = ("Agent: Thank you for calling Cadence, this call may be recorded for quality and training purposes. My name is Sam.\n"
              "Customer: Hi, I'd like a refund for my order, it arrived 10 days ago and is unused.\n"
              "Agent: I'm sorry to hear that. May I confirm your full name and order ID?\nCustomer: John Smith, order 4521.\n"
              "Agent: Thanks John, you're verified. I've raised a full refund; you'll see it in 5-7 business days. Anything else?\n"
              "Customer: No, thank you.\nAgent: Thanks for calling, have a great day!")


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


def poll(s, iid, timeout=120):
    end = time.time() + timeout
    d = {}
    while time.time() < end:
        d = s.get(f"{BASE_URL}/api/interactions/{iid}").json()
        if d.get("status") in ("scored", "failed"):
            return d
        time.sleep(4)
    return d


# ---------- Auth & roles ----------
class TestAuthRoles:
    def test_unauth_401(self):
        for path in ["/api/me", "/api/dashboard", "/api/interactions", "/api/kb/articles", "/api/users"]:
            assert requests.get(f"{BASE_URL}{path}").status_code == 401, path

    def test_me_roles(self, admin, agent):
        a = admin.get(f"{BASE_URL}/api/me").json()
        g = agent.get(f"{BASE_URL}/api/me").json()
        assert a["role"] == "admin" and a["user_id"] == ADMIN_ID
        assert g["role"] == "agent" and g["user_id"] == AGENT_ID

    def test_agent_forbidden(self, agent):
        assert agent.get(f"{BASE_URL}/api/users").status_code == 403
        assert agent.get(f"{BASE_URL}/api/people").status_code == 403
        assert agent.post(f"{BASE_URL}/api/qa-forms", json={"name": "TEST_x", "criteria": [{"name": "a"}]}).status_code == 403
        assert agent.post(f"{BASE_URL}/api/kb/articles", json={"title": "TEST_x", "category": "x"}).status_code == 403
        assert agent.post(f"{BASE_URL}/api/coaching", json={"agent_name": "x", "focus": "x"}).status_code == 403
        assert agent.patch(f"{BASE_URL}/api/users/{AGENT_ID}/role", json={"role": "admin"}).status_code == 403

    def test_users_list_and_role_change(self, admin):
        db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
        uid = f"TEST_user_{uuid.uuid4().hex[:8]}"
        db.users.insert_one({"user_id": uid, "email": f"{uid}@example.com", "name": uid, "role": "agent", "env": "preview"})
        try:
            r = admin.get(f"{BASE_URL}/api/users")
            assert r.status_code == 200
            d = r.json()
            assert "admin" in d["roles"] and any(u["user_id"] == uid for u in d["users"])
            r = admin.patch(f"{BASE_URL}/api/users/{uid}/role", json={"role": "team_lead"})
            assert r.status_code == 200 and r.json()["role"] == "team_lead"
            assert next(u for u in admin.get(f"{BASE_URL}/api/users").json()["users"] if u["user_id"] == uid)["role"] == "team_lead"
            assert admin.patch(f"{BASE_URL}/api/users/{uid}/role", json={"role": "superuser"}).status_code == 403
            assert admin.patch(f"{BASE_URL}/api/users/nope_{uid}/role", json={"role": "agent"}).status_code == 404
        finally:
            db.users.delete_one({"user_id": uid})

    def test_demote_last_admin_409(self, admin):
        db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
        n = db.users.count_documents({"role": "admin", "env": {"$in": ["preview", None]}})
        if n > 1:
            pytest.skip(f"{n} admins exist; not demoting real admins")
        assert admin.patch(f"{BASE_URL}/api/users/{ADMIN_ID}/role", json={"role": "agent"}).status_code == 409


# ---------- QA forms ----------
class TestQAForms:
    def test_form_crud(self, admin):
        body = {"name": "TEST_form", "channel": "voice", "criteria": [
            {"name": "Greeting", "weight": 2, "type": "scale"}, {"name": "Verify", "weight": 1, "type": "binary", "auto_fail": True}]}
        r = admin.post(f"{BASE_URL}/api/qa-forms", json=body)
        assert r.status_code == 200
        f = r.json()
        try:
            assert f["criteria"][1]["auto_fail"] is True and f["criteria"][0]["weight"] == 2 and f["criteria"][1]["id"]
            assert any(x["id"] == f["id"] for x in admin.get(f"{BASE_URL}/api/qa-forms").json())
            body["name"] = "TEST_form2"
            r = admin.put(f"{BASE_URL}/api/qa-forms/{f['id']}", json=body)
            assert r.status_code == 200 and r.json()["name"] == "TEST_form2"
            assert admin.post(f"{BASE_URL}/api/qa-forms", json={"name": "TEST_e", "criteria": []}).status_code == 400
        finally:
            assert admin.delete(f"{BASE_URL}/api/qa-forms/{f['id']}").status_code == 200
        assert admin.delete(f"{BASE_URL}/api/qa-forms/{f['id']}").status_code == 404


# ---------- Interactions / AutoQA ----------
class TestInteractions:
    created = []

    def test_validation(self, admin):
        u = f"{BASE_URL}/api/interactions"
        assert admin.post(u, data={"channel": "fax", "form_id": "form-voice", "agent_name": "x", "transcript": "hi"}).status_code == 400
        assert admin.post(u, data={"channel": "voice", "form_id": "form-voice", "agent_name": "x"}).status_code == 400
        assert admin.post(u, data={"channel": "voice", "form_id": "nope", "agent_name": "x", "transcript": "hi"}).status_code == 404
        assert admin.post(u, data={"channel": "voice", "form_id": "form-voice", "agent_name": "x"},
                          files={"file": ("a.txt", b"abc")}).status_code == 400

    def test_text_scoring_and_autofail_and_agent_scope(self, admin, agent):
        # auto-fail form with an impossible criterion
        form = admin.post(f"{BASE_URL}/api/qa-forms", json={"name": "TEST_autofail", "channel": "voice", "criteria": [
            {"name": "Greeting", "type": "scale"},
            {"name": "Says secret word", "description": "Agent must say the exact word 'xylophone-banana'. Fail if not said.",
             "type": "binary", "auto_fail": True}]}).json()
        try:
            r1 = admin.post(f"{BASE_URL}/api/interactions", data={"channel": "voice", "form_id": "form-voice",
                            "agent_name": "TEST_Agent", "customer_name": "TEST_Cust", "transcript": TRANSCRIPT})
            assert r1.status_code == 200 and r1.json()["status"] == "scoring"
            r2 = admin.post(f"{BASE_URL}/api/interactions", data={"channel": "voice", "form_id": form["id"],
                            "agent_name": "TEST_Agent", "transcript": TRANSCRIPT})
            # agent submits own; agent_id in body must be ignored
            r3 = agent.post(f"{BASE_URL}/api/interactions", data={"channel": "chat", "form_id": "form-chat",
                            "agent_id": ADMIN_ID, "agent_name": "Spoof", "transcript": TRANSCRIPT})
            assert r3.status_code == 200 and r3.json()["agent_id"] == AGENT_ID and r3.json()["agent_name"] != "Spoof"
            ids = [r1.json()["id"], r2.json()["id"], r3.json()["id"]]
            TestInteractions.created += ids
            t0 = time.time()
            d1 = poll(admin, ids[0])
            print("scoring took", round(time.time() - t0), "s")
            assert d1["status"] == "scored", d1.get("error")
            assert isinstance(d1["overall_score"], (int, float)) and len(d1["criteria_results"]) == 6
            assert d1["sentiment"] in ("positive", "neutral", "negative") and 1 <= float(d1["csat_predicted"]) <= 5
            assert isinstance(d1["compliance_flags"], list) and isinstance(d1["recommended_article_ids"], list)
            print("score", d1["overall_score"], "recs", d1["recommended_article_ids"], "auto", d1["auto_failed"])
            d2 = poll(admin, ids[1])
            assert d2["status"] == "scored", d2.get("error")
            assert d2["auto_failed"] is True and d2["overall_score"] == 0
            # agent scope
            agent_list = agent.get(f"{BASE_URL}/api/interactions").json()
            assert all(i["agent_id"] == AGENT_ID for i in agent_list) and any(i["id"] == ids[2] for i in agent_list)
            assert agent.get(f"{BASE_URL}/api/interactions/{ids[0]}").status_code == 404
            assert agent.get(f"{BASE_URL}/api/interactions/{ids[2]}").status_code == 200
            assert agent.post(f"{BASE_URL}/api/interactions/{ids[2]}/rescore").status_code == 403
            assert agent.delete(f"{BASE_URL}/api/interactions/{ids[2]}").status_code == 403
        finally:
            admin.delete(f"{BASE_URL}/api/qa-forms/{form['id']}")

    def test_audio_transcription(self, admin):
        if not os.path.exists(AUDIO):
            pytest.skip("no audio")
        with open(AUDIO, "rb") as f:
            r = admin.post(f"{BASE_URL}/api/interactions", data={"channel": "voice", "form_id": "form-voice", "agent_name": "TEST_Audio"},
                           files={"file": ("call.mp3", f, "audio/mpeg")})
        assert r.status_code == 200 and r.json()["status"] == "transcribing" and r.json()["source"] == "audio"
        TestInteractions.created.append(r.json()["id"])
        d = poll(admin, r.json()["id"], 150)
        assert d["status"] == "scored", d.get("error")
        assert "refund" in d["transcript"].lower()

    def test_cleanup(self, admin):
        for i in TestInteractions.created:
            assert admin.delete(f"{BASE_URL}/api/interactions/{i}").status_code == 200
            assert admin.get(f"{BASE_URL}/api/interactions/{i}").status_code == 404


# ---------- Dashboard ----------
class TestDashboard:
    def test_dashboard(self, admin, agent):
        d = admin.get(f"{BASE_URL}/api/dashboard").json()
        for k in ["kpis", "sentiment", "trend", "criteria", "leaderboard", "top_searches", "top_articles", "channels"]:
            assert k in d
        assert d["kpis"]["evaluated"] >= 5 and d["leaderboard"]
        g = agent.get(f"{BASE_URL}/api/dashboard").json()
        assert g["top_searches"] == [] and all(r["agent_name"] for r in g["leaderboard"])


# ---------- Knowledge base ----------
class TestKB:
    def test_search_logged_and_filter(self, admin):
        q = f"refund"
        r = admin.get(f"{BASE_URL}/api/kb/articles", params={"q": q})
        assert r.status_code == 200 and any(a["id"] == "kb-refund" for a in r.json())
        r = admin.get(f"{BASE_URL}/api/kb/articles", params={"category": "Billing"})
        assert all(a["category"] == "Billing" for a in r.json()) and r.json()
        assert "Refunds" in admin.get(f"{BASE_URL}/api/kb/categories").json()
        ts = admin.get(f"{BASE_URL}/api/dashboard").json()["top_searches"]
        assert any(t["q"] == "refund" for t in ts)

    def test_article_crud(self, admin):
        body = {"title": "TEST_Article", "category": "TEST_Cat", "content": "hello", "self_service": True,
                "steps": [{"title": "Step one", "body": "do it", "image_url": "https://example.com/a.png"}], "tags": ["t"]}
        a = admin.post(f"{BASE_URL}/api/kb/articles", json=body).json()
        try:
            g = admin.get(f"{BASE_URL}/api/kb/articles/{a['id']}").json()
            assert g["steps"][0]["image_url"] == "https://example.com/a.png"
            body["title"] = "TEST_Article2"
            assert admin.put(f"{BASE_URL}/api/kb/articles/{a['id']}", json=body).json()["title"] == "TEST_Article2"
            assert requests.get(f"{BASE_URL}/api/public/kb/{a['id']}").status_code == 200
        finally:
            assert admin.delete(f"{BASE_URL}/api/kb/articles/{a['id']}").status_code == 200
        assert admin.get(f"{BASE_URL}/api/kb/articles/{a['id']}").status_code == 404

    def test_ask_sse(self, agent):
        r = agent.post(f"{BASE_URL}/api/kb/ask", json={"question": "How do I process a refund after 45 days?"}, stream=True, timeout=120)
        assert r.status_code == 200 and "text/event-stream" in r.headers["content-type"]
        evs = [json.loads(l[6:]) for l in r.iter_lines(decode_unicode=True) if l and l.startswith("data: ")]
        assert evs[0]["type"] == "sources" and any(s["id"] == "kb-refund" for s in evs[0]["sources"])
        text = "".join(e["text"] for e in evs if e["type"] == "delta")
        assert not [e for e in evs if e["type"] == "error"], evs
        assert len(text) > 20 and evs[-1]["type"] == "done"
        print("ANSWER:", text[:200])


# ---------- Public self-service ----------
class TestPublic:
    def test_public_kb(self):
        r = requests.get(f"{BASE_URL}/api/public/kb")
        assert r.status_code == 200
        ids = [a["id"] for a in r.json()]
        assert "kb-refund" in ids and "kb-disclosure" not in ids and all(a["self_service"] for a in r.json())
        assert requests.get(f"{BASE_URL}/api/public/kb/kb-disclosure").status_code == 404
        assert requests.get(f"{BASE_URL}/api/public/kb/kb-refund").status_code == 200

    def test_public_ask(self):
        r = requests.post(f"{BASE_URL}/api/public/ask", json={"question": "How do I reset my password?"}, stream=True, timeout=120)
        assert r.status_code == 200
        evs = [json.loads(l[6:]) for l in r.iter_lines(decode_unicode=True) if l and l.startswith("data: ")]
        assert all(s["id"] != "kb-disclosure" for s in evs[0]["sources"])
        assert "".join(e.get("text", "") for e in evs if e["type"] == "delta")
        assert requests.post(f"{BASE_URL}/api/public/ask", json={"question": "x"}).status_code == 422


# ---------- Decision trees ----------
class TestTrees:
    def test_tree_crud_and_validation(self, admin, agent):
        assert any(t["id"] == "tree-refund" for t in agent.get(f"{BASE_URL}/api/trees").json())
        assert agent.post(f"{BASE_URL}/api/trees/tree-refund/run").status_code == 200
        body = {"title": "TEST_Tree", "start_node": "a", "nodes": [
            {"id": "a", "title": "A", "options": [{"label": "go", "next": "b"}]}, {"id": "b", "title": "B", "options": []}]}
        bad = {**body, "nodes": [{"id": "a", "title": "A", "options": [{"label": "go", "next": "zzz"}]}]}
        assert admin.post(f"{BASE_URL}/api/trees", json=bad).status_code == 400
        assert admin.post(f"{BASE_URL}/api/trees", json={**body, "start_node": "q"}).status_code == 400
        assert agent.post(f"{BASE_URL}/api/trees", json=body).status_code == 403
        t = admin.post(f"{BASE_URL}/api/trees", json=body).json()
        try:
            assert admin.put(f"{BASE_URL}/api/trees/{t['id']}", json=bad).status_code == 400
            body["title"] = "TEST_Tree2"
            assert admin.put(f"{BASE_URL}/api/trees/{t['id']}", json=body).json()["title"] == "TEST_Tree2"
        finally:
            assert admin.delete(f"{BASE_URL}/api/trees/{t['id']}").status_code == 200

    def test_generate_tree(self, admin):
        sop = ("Password reset SOP: First verify the customer's registered email and last 4 phone digits. If verification fails, "
               "stop and ask them to call back. If verified, check if account is locked; if locked, unlock it in admin console. "
               "Then send reset link, valid 15 minutes.")
        r = admin.post(f"{BASE_URL}/api/trees/generate", json={"title": "TEST_GenTree", "sop": sop}, timeout=120)
        assert r.status_code == 200, r.text
        t = r.json()
        ids = {n["id"] for n in t["nodes"]}
        assert t["start_node"] in ids and len(t["nodes"]) >= 3
        assert admin.delete(f"{BASE_URL}/api/trees/{t['id']}").status_code == 200


# ---------- Training ----------
class TestTraining:
    def test_course_and_attempt(self, admin, agent):
        c = agent.get(f"{BASE_URL}/api/courses/course-onboarding").json()
        assert all("answer_index" not in q and "explanation" not in q for q in c["quiz"])
        assert all("answer_index" not in q for co in agent.get(f"{BASE_URL}/api/courses").json() for q in co["quiz"])
        assert "answer_index" in admin.get(f"{BASE_URL}/api/courses/course-onboarding").json()["quiz"][0]
        assert agent.post(f"{BASE_URL}/api/courses/course-onboarding/attempt", json={"answers": [1]}).status_code == 400
        r = agent.post(f"{BASE_URL}/api/courses/course-onboarding/attempt", json={"answers": [1, 1, 0, 0]})
        assert r.status_code == 200
        d = r.json()
        assert d["score"] == 75 and d["passed"] is True and len(d["review"]) == 4 and d["review"][3]["answer_index"] == 2
        mine = agent.get(f"{BASE_URL}/api/attempts").json()
        assert any(a["id"] == d["id"] for a in mine) and all(a["user_id"] == AGENT_ID for a in mine)
        db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
        db.attempts.delete_one({"id": d["id"]})

    def test_course_crud_and_genquiz(self, admin, agent):
        assert agent.post(f"{BASE_URL}/api/courses", json={"title": "TEST_x"}).status_code == 403
        c = admin.post(f"{BASE_URL}/api/courses", json={"title": "TEST_Course", "lessons": [{"title": "L1", "article_id": "kb-refund"}],
                       "quiz": [{"question": "q", "options": ["a", "b"], "answer_index": 0}]}).json()
        try:
            r = admin.put(f"{BASE_URL}/api/courses/{c['id']}", json={"title": "TEST_Course2", "lessons": [], "quiz": []})
            assert r.json()["title"] == "TEST_Course2"
        finally:
            assert admin.delete(f"{BASE_URL}/api/courses/{c['id']}").status_code == 200
        r = admin.post(f"{BASE_URL}/api/courses/generate-quiz", json={"content": "Refunds within 30 days are full. 31-60 days 15% fee. After 60 days store credit.", "count": 3}, timeout=120)
        assert r.status_code == 200, r.text
        qs = r.json()
        assert len(qs) == 3 and all(len(q["options"]) >= 2 and isinstance(q["answer_index"], int) for q in qs)


# ---------- Coaching ----------
class TestCoaching:
    def test_coaching_flow(self, admin, agent):
        body = {"agent_id": AGENT_ID, "agent_name": "Arjun Agent", "interaction_id": "sample-2", "focus": "TEST_Verification",
                "action_items": [{"text": "Verify first"}, {"text": "Read kb"}], "article_ids": ["kb-refund"], "course_ids": ["course-onboarding"]}
        c = admin.post(f"{BASE_URL}/api/coaching", json=body).json()
        other = admin.post(f"{BASE_URL}/api/coaching", json={**body, "agent_id": "", "agent_name": "TEST_Other"}).json()  # unknown agent_id now 400 (validated)
        try:
            mine = agent.get(f"{BASE_URL}/api/coaching").json()
            assert any(x["id"] == c["id"] for x in mine) and all(x["agent_id"] == AGENT_ID for x in mine)
            r = agent.patch(f"{BASE_URL}/api/coaching/{c['id']}/items/0", json={"done": True})
            assert r.status_code == 200 and r.json()["action_items"][0]["done"] is True
            assert agent.patch(f"{BASE_URL}/api/coaching/{other['id']}/items/0", json={"done": True}).status_code == 404
            assert agent.patch(f"{BASE_URL}/api/coaching/{c['id']}/items/9", json={"done": True}).status_code == 404
            assert agent.put(f"{BASE_URL}/api/coaching/{c['id']}", json=body).status_code == 403
            assert agent.delete(f"{BASE_URL}/api/coaching/{c['id']}").status_code == 403
            r = admin.put(f"{BASE_URL}/api/coaching/{c['id']}", json={**body, "status": "completed"})
            assert r.json()["status"] == "completed"
        finally:
            assert admin.delete(f"{BASE_URL}/api/coaching/{c['id']}").status_code == 200
            assert admin.delete(f"{BASE_URL}/api/coaching/{other['id']}").status_code == 200
