# Cadence CX iteration 3: Calibration sessions (blind scoring, spread, close/apply) + Agent self-review.
# Tokens: python tests/make_test_users.py --ticket ; python tests/make_cal_users.py create  (temp qa_auditor + team_lead)
import json
import os
import time

import pytest
import requests
from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv("/app/frontend/.env")
load_dotenv("/app/backend/.env")
BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
TOK = json.load(open("/tmp/tokens.json")) | json.load(open("/tmp/cal_tokens.json"))
IDS = {k: v["id"] for k, v in TOK.items()}
db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
STATE = {"cals": [], "iids": []}
TRANSCRIPT = ("Agent: Thank you for calling Cadence, this call may be recorded. My name is Sam.\n"
              "Customer: I want a refund for order 4521.\nAgent: May I confirm your full name?\nCustomer: John Smith.\n"
              "Agent: Verified. Refund raised, 5-7 business days. Anything else?\nCustomer: No.\nAgent: Have a great day!")


def S(who):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {TOK[who]['token']}"})
    return s


def url(p):
    return f"{BASE_URL}/api{p}"


@pytest.fixture(scope="module", autouse=True)
def cleanup():
    yield
    for c in STATE["cals"]:
        db.calibrations.delete_one({"id": c})
    for i in STATE["iids"]:
        db.interactions.delete_one({"id": i})


@pytest.fixture(scope="module")
def scored_iid():
    """Agent-owned TEST_ interaction, scored by AI."""
    forms = S("admin").get(url("/qa-forms")).json()
    form = next(f for f in forms if f.get("channel") in ("voice", "all"))
    r = S("agent").post(url("/interactions"), data={"channel": "voice", "form_id": form["id"], "customer_name": "TEST_cust",
                                                    "transcript": TRANSCRIPT})
    assert r.status_code == 200, r.text
    iid = r.json()["id"]
    STATE["iids"].append(iid)
    end = time.time() + 150
    while time.time() < end:
        d = S("admin").get(url(f"/interactions/{iid}")).json()
        if d["status"] in ("scored", "failed"):
            break
        time.sleep(4)
    assert d["status"] == "scored", d
    return iid


def full_scores(cal, val, note=""):
    return [{"id": c["id"], "score": val, "note": note} for c in cal["criteria"]]


class TestCalibration:
    def test_agent_forbidden(self):
        assert S("agent").get(url("/calibrations")).status_code == 403
        assert S("agent").post(url("/calibrations"), json={"interaction_id": "sample-1", "participant_ids": [IDS["admin"]]}).status_code == 403

    def test_create_validation(self, scored_iid):
        a = S("admin")
        assert a.post(url("/calibrations"), json={"interaction_id": scored_iid, "participant_ids": [IDS["agent"]]}).status_code == 400
        assert a.post(url("/calibrations"), json={"interaction_id": scored_iid, "participant_ids": ["nope"]}).status_code == 400
        assert a.post(url("/calibrations"), json={"interaction_id": scored_iid, "participant_ids": []}).status_code == 422
        assert a.post(url("/calibrations"), json={"interaction_id": "missing", "participant_ids": [IDS["qa"]]}).status_code == 404

    def test_full_flow(self, scored_iid):
        tl = S("tl")
        r = tl.post(url("/calibrations"), json={"interaction_id": scored_iid, "title": "TEST_cal", "due": "2026-12-01",
                                                "participant_ids": [IDS["tl"], IDS["qa"]]})
        assert r.status_code == 200, r.text
        cal = r.json()
        cid = cal["id"]
        STATE["cals"].append(cid)
        assert cal["status"] == "open" and cal["title"] == "TEST_cal" and cal["created_by"] == IDS["tl"]
        assert len(cal["criteria"]) > 0 and all("ai_score" in c for c in cal["criteria"])
        # list visibility
        assert cid in [c["id"] for c in S("qa").get(url("/calibrations")).json()]
        assert cid in [c["id"] for c in S("admin").get(url("/calibrations")).json()]
        # admin is not a participant -> can view, cannot score
        assert S("admin").post(url(f"/calibrations/{cid}/score"), json={"criteria": full_scores(cal, 50)}).status_code == 403
        # tl scores first
        r = tl.post(url(f"/calibrations/{cid}/score"), json={"criteria": full_scores(cal, 80, "TEST_tl")})
        assert r.status_code == 200, r.text
        assert r.json()["submitted"] is True and r.json()["submitted_count"] == 1
        # qa blind
        v = S("qa").get(url(f"/calibrations/{cid}")).json()
        assert v["revealed"] is False and v["scores"] == [] and v["submitted"] is False and v["submitted_count"] == 1
        STATE["blind_spread"] = v["spread"]
        # missing criterion -> 400
        bad = full_scores(cal, 70)[1:]
        assert S("qa").post(url(f"/calibrations/{cid}/score"), json={"criteria": bad}).status_code == 400
        assert S("qa").post(url(f"/calibrations/{cid}/score"), json={"criteria": full_scores(cal, 101)}).status_code == 422
        r = S("qa").post(url(f"/calibrations/{cid}/score"), json={"criteria": full_scores(cal, 40)})
        assert r.status_code == 200
        v = r.json()
        assert v["revealed"] is True and len(v["scores"]) == 2
        mine = next(s for s in v["scores"] if s["user_id"] == IDS["qa"])
        assert mine["overall"] == 40
        for c in cal["criteria"]:
            exp = max(80, 40, c["ai_score"]) - min(80, 40, c["ai_score"])
            assert v["spread"][c["id"]] == pytest.approx(exp, abs=0.11)
        # resubmit replaces
        r = S("qa").post(url(f"/calibrations/{cid}/score"), json={"criteria": full_scores(cal, 60)})
        v = r.json()
        assert len(v["scores"]) == 2 and next(s for s in v["scores"] if s["user_id"] == IDS["qa"])["overall"] == 60
        # non-owner participant cannot close
        assert S("qa").post(url(f"/calibrations/{cid}/close"), json={"criteria": full_scores(cal, 70)}).status_code == 403
        assert tl.post(url(f"/calibrations/{cid}/close"), json={"criteria": full_scores(cal, 70)[1:]}).status_code == 400
        before = S("admin").get(url(f"/interactions/{scored_iid}")).json()
        # owner closes with apply
        final = [{"id": c["id"], "score": 100 if i == 0 else 50, "note": "TEST_agreed"} for i, c in enumerate(cal["criteria"])]
        r = tl.post(url(f"/calibrations/{cid}/close"), json={"criteria": final, "note": "TEST_guidance", "apply_to_interaction": True})
        assert r.status_code == 200, r.text
        v = r.json()
        assert v["status"] == "closed" and v["final"]["note"] == "TEST_guidance" and v["final"]["applied"] is True
        tw = sum(c["weight"] for c in cal["criteria"])
        exp = round((cal["criteria"][0]["weight"] * 100 + sum(c["weight"] * 50 for c in cal["criteria"][1:])) / tw, 1)
        assert v["final"]["overall"] == exp
        it = S("admin").get(url(f"/interactions/{scored_iid}")).json()
        assert it["overall_score"] == exp and it["auto_failed"] is False
        assert it["original_score"] == before.get("original_score", before["overall_score"])
        assert it["criteria_results"][0]["score"] == 100 if it["criteria_results"][0]["id"] == cal["criteria"][0]["id"] else True
        # closed -> 409
        assert S("qa").post(url(f"/calibrations/{cid}/score"), json={"criteria": full_scores(cal, 60)}).status_code == 409
        assert tl.post(url(f"/calibrations/{cid}/close"), json={"criteria": final}).status_code == 409

    def test_blind_spread_not_leaked(self):
        """Blind participant should not receive spread (it reveals others' scores)."""
        assert not STATE.get("blind_spread"), f"spread leaked to blind viewer: {STATE.get('blind_spread')}"

    def test_visibility_non_participant(self, scored_iid):
        r = S("admin").post(url("/calibrations"), json={"interaction_id": scored_iid, "participant_ids": [IDS["admin"]]})
        cid = r.json()["id"]
        STATE["cals"].append(cid)
        assert cid not in [c["id"] for c in S("qa").get(url("/calibrations")).json()]
        assert S("qa").get(url(f"/calibrations/{cid}")).status_code == 404
        assert S("qa").post(url(f"/calibrations/{cid}/score"), json={"criteria": []}).status_code == 404


class TestSelfReview:
    def test_self_review_flow(self, scored_iid):
        body = {"reflection": "TEST_reflect", "notes": [{"t": 9.5, "text": "later"}, {"t": 1.2, "text": "early"}]}
        r = S("agent").put(url(f"/interactions/{scored_iid}/self-review"), json=body)
        assert r.status_code == 200, r.text
        assert [n["t"] for n in r.json()["notes"]] == [1.2, 9.5]
        it = S("admin").get(url(f"/interactions/{scored_iid}")).json()
        assert it["self_review"]["reflection"] == "TEST_reflect" and it["self_review"]["notes"][0]["text"] == "early"
        lst = S("agent").get(url("/interactions")).json()
        assert next(i for i in lst if i["id"] == scored_iid).get("self_review")

    def test_others_404(self, scored_iid):
        body = {"reflection": "x", "notes": []}
        assert S("admin").put(url(f"/interactions/{scored_iid}/self-review"), json=body).status_code == 404
        assert S("tl").put(url(f"/interactions/{scored_iid}/self-review"), json=body).status_code == 404

    def test_validation(self, scored_iid):
        assert S("agent").put(url(f"/interactions/{scored_iid}/self-review"), json={"notes": [{"t": -1, "text": "a"}]}).status_code == 422
        assert S("agent").put(url(f"/interactions/{scored_iid}/self-review"), json={"notes": [{"t": 1, "text": ""}]}).status_code == 422

    def test_unscored_400(self):
        forms = S("admin").get(url("/qa-forms")).json()
        r = S("agent").post(url("/interactions"), data={"channel": "chat", "form_id": forms[0]["id"], "transcript": TRANSCRIPT})
        iid = r.json()["id"]
        STATE["iids"].append(iid)
        r = S("agent").put(url(f"/interactions/{iid}/self-review"), json={"reflection": "x", "notes": []})
        assert r.status_code == 400


class TestRegression:
    @pytest.mark.parametrize("path", ["/dashboard", "/disputes", "/interactions", "/qa-forms", "/coaching", "/digest/preview"])
    def test_admin_gets(self, path):
        r = S("admin").get(url(path))
        assert r.status_code == 200, (path, r.status_code, r.text[:200])
