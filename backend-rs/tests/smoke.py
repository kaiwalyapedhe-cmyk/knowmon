import json
import time
import urllib.request
import urllib.error
import uuid

BASE = "http://127.0.0.1:8050/api"
results = []


def call(method, path, token=None, body=None, raw=None, ctype="application/json", base=None):
    url = (base or BASE) + path
    data = None
    headers = {}
    if raw is not None:
        data = raw
        headers["Content-Type"] = ctype
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            payload = r.read()
            try:
                return r.status, json.loads(payload)
            except Exception:
                return r.status, payload[:200]
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, json.loads(payload)
        except Exception:
            return e.code, payload[:200]


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {detail}"))


def login(username):
    status, body = call("POST", "/auth/ldap/login", body={"username": username, "password": "devpass"})
    return status, body


def multipart(fields, files):
    boundary = "----cadence" + uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    for k, (fname, content, ctype) in files.items():
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{fname}\"\r\nContent-Type: {ctype}\r\n\r\n".encode()
            + content
            + b"\r\n"
        )
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


status, body = call("GET", "/auth/ldap/config")
check("ldap config enabled", status == 200 and body.get("enabled") is True, body)

status, body = login("admin@jswshakti.in")
check("admin dev login", status == 200 and body.get("role") == "admin" and body.get("token"), body)
admin = body.get("token")

status, body = call("GET", "/me", token=admin)
check("GET /me", status == 200 and body.get("role") == "admin", body)

status, body = call("GET", "/users", token=admin)
check("GET /users (admin)", status == 200 and len(body.get("users", [])) >= 1, body)

status, body = call("GET", "/qa-forms", token=admin)
check("seeded QA forms", status == 200 and len(body) == 2, status)

status, body = call("GET", "/dashboard", token=admin)
check(
    "dashboard kpis",
    status == 200 and body["kpis"]["evaluated"] == 5 and body["kpis"]["articles"] == 4,
    body.get("kpis") if status == 200 else body,
)

status, body = call("GET", "/kb/articles", token=admin)
check("seeded articles", status == 200 and len(body) == 4, status)
status, body = call("GET", "/kb/categories", token=admin)
check("kb categories", status == 200 and "Refunds" in body, body)
status, body = call("GET", "/kb/articles/kb-refund", token=admin)
check("article detail + view count", status == 200 and body.get("views", 0) >= 1, status)

status, body = call("GET", "/public/kb", base="http://127.0.0.1:8050/api")
check("public kb hides non self-service", status == 200 and len(body) == 3, len(body) if status == 200 else body)

status, body = call("GET", "/qa-ops/policies", token=admin)
check("default sampling policy", status == 200 and body and body[0]["id"] == "policy-monthly-coverage", status)

status, body = call("POST", "/qa-ops/sample", token=admin, body={"policy_id": "policy-monthly-coverage"})
check("run sampling creates assignments", status == 200 and body["created"] >= 1, body)
first_assignment = body["assignments"][0]["id"] if status == 200 and body.get("assignments") else None

if first_assignment:
    status, body = call("PATCH", f"/qa-ops/assignments/{first_assignment}", token=admin,
                        body={"status": "completed", "outcome": "confirmed", "note": "looks fine"})
    check("complete assignment (SLA)", status == 200 and body.get("sla") == "met", body)

status, body = call("GET", "/qa-ops/overview", token=admin)
check("qa overview coverage", status == 200 and body["kpis"]["assigned"] >= 1, body["kpis"] if status == 200 else body)

status, body = call("POST", "/qa-ops/sample", token=admin, body={"policy_id": "policy-monthly-coverage"})
check("sampling does not re-assign", status == 200 and body["created"] == 0, body.get("created") if status == 200 else body)

payload, ctype = multipart(
    {"channel": "voice", "form_id": "form-voice", "agent_name": "Priya Sharma",
     "customer_name": "Test Customer", "transcript": "Agent: This call may be recorded. Customer: I need a refund."},
    {},
)
status, body = call("POST", "/interactions", token=admin, raw=payload, ctype=ctype)
iid = body.get("id") if status == 200 else None
check("create interaction", status == 200 and iid, body)

if iid:
    scored = None
    for _ in range(20):
        time.sleep(0.4)
        s, b = call("GET", f"/interactions/{iid}", token=admin)
        if s == 200 and b.get("status") == "scored":
            scored = b
            break
    check("interaction scored", scored is not None and "overall_score" in (scored or {}),
          (scored or {}).get("status"))

status, body = call("POST", "/kb/articles", token=admin, body={
    "title": "Test article", "category": "Refunds", "summary": "s", "content": "c",
    "tags": ["t"], "review_note": "created in smoke test"})
aid = body.get("id") if status == 200 else None
check("create article draft", status == 200 and body.get("status") == "draft" and body.get("version") == 1, body)

if aid:
    s1, b1 = call("POST", f"/kb/articles/{aid}/submit", token=admin, body={})
    check("submit for review", s1 == 200 and b1.get("status") == "in_review", b1)
    s2, b2 = call("POST", f"/kb/articles/{aid}/approve", token=admin, body={})
    check("approve article", s2 == 200 and b2.get("status") == "approved", b2)
    s3, b3 = call("POST", f"/kb/articles/{aid}/publish", token=admin, body={})
    check("publish article", s3 == 200 and b3.get("status") == "published", b3)
    s4, b4 = call("POST", f"/kb/articles/{aid}/feedback", token=admin, body={"helpful": True})
    check("article feedback", s4 == 200 and b4.get("helpful_count") == 1, b4)
    s5, b5 = call("GET", f"/kb/articles/{aid}/versions", token=admin)
    check("article version snapshots", s5 == 200 and len(b5) >= 2, len(b5) if s5 == 200 else b5)
    s6, b6 = call("GET", f"/kb/articles/{aid}/audit", token=admin)
    check("article audit trail", s6 == 200 and len(b6) >= 4, len(b6) if s6 == 200 else b6)
    s7, b7 = call("POST", f"/kb/articles/{aid}/archive", token=admin, body={})
    check("archive article", s7 == 200 and b7.get("status") == "archived", b7)

status, body = call("GET", "/trees", token=admin)
tree_id = body[0]["id"] if status == 200 and body else None
check("seeded decision tree", status == 200 and tree_id == "tree-refund", status)

status, body = call("POST", "/trees/generate", token=admin, body={"title": "Test", "sop": "Take a refund request and verify the customer before refunding."})
check("generate tree", status == 200 and body.get("nodes"), body.get("detail") if status != 200 else "ok")

status, body = call("GET", "/courses", token=admin)
check("seeded course", status == 200 and body and body[0]["id"] == "course-onboarding", status)
status, body = call("POST", "/courses/course-onboarding/attempt", token=admin, body={"answers": [1, 1, 0, 2]})
check("course attempt scoring", status == 200 and body.get("score") == 100 and body.get("passed") is True, body)

status, body = call("POST", "/coaching", token=admin, body={"agent_name": "Priya Sharma", "focus": "Tone", "action_items": [{"text": "Listen back"}, {"text": "Practice"}]})
coaching_id = body.get("id") if status == 200 else None
check("create coaching", status == 200, body)
if coaching_id:
    status, body = call("PATCH", f"/coaching/{coaching_id}/items/0", token=admin, body={"done": True})
    check("toggle coaching item", status == 200 and body["action_items"][0]["done"] is True, body)

status, body = call("POST", "/calibrations", token=admin, body={"interaction_id": "sample-1", "participant_ids": ["ldap_x"]})
check("calibration rejects unknown participant", status == 400, body)
status, me_id = call("GET", "/me", token=admin)
status, body = call("POST", "/calibrations", token=admin,
                    body={"interaction_id": "sample-1", "participant_ids": [me_id["user_id"]]})
cal_id = body.get("id") if status == 200 else None
check("create calibration", status == 200 and cal_id, body)
if cal_id:
    crit = [{"id": c["id"], "score": (100 if c["type"] == "binary" else c["ai_score"]), "note": ""}
            for c in body["criteria"]]
    status, body = call("POST", f"/calibrations/{cal_id}/score", token=admin, body={"criteria": crit})
    check("calibration scoring", status == 200 and body.get("submitted") is True, body)
    status, body = call("POST", f"/calibrations/{cal_id}/close", token=admin,
                        body={"criteria": crit, "note": "agreed", "apply_to_interaction": False})
    check("close calibration", status == 200 and body.get("status") == "closed", body)

status, body = call("GET", "/digest/preview", token=admin)
check("digest preview", status == 200 and "stats" in body and "html" in body, status)
status, body = call("GET", "/digest/logs", token=admin)
check("digest logs", status == 200, status)
status, body = call("GET", "/integrations", token=admin)
check("integrations config", status == 200 and body["ldap"]["enabled"] is True and "smtp" in body, body)

status, body = call("GET", "/qa-ops/score-history/sample-1", token=admin)
check("score history endpoint", status == 200, status)

status, body = login("agent.person@jswshakti.in")
agent = body.get("token")
check("non-admin dev login", status == 200 and body.get("role") == "agent", body.get("role"))
status, body = call("GET", "/users", token=agent)
check("agent blocked from /users", status == 403, status)
status, body = call("GET", "/me")
check("unauthenticated /me is 401", status == 401, status)
status, body = call("POST", "/users", token=agent, body={"name": "x", "email": "x@y.z"})
check("agent cannot create users", status == 403, status)
status, body = call("POST", "/users", token=admin, body={"name": "Local Agent", "email": "local.agent@jswshakti.in",
                                                         "role": "agent", "password": "secret123"})
check("admin creates local user", status == 200 and body.get("has_password") is True, body)
created_user = body.get("user_id") if status == 200 else None
if created_user:
    status, body = call("POST", "/auth/ldap/login", body={"username": "local.agent@jswshakti.in", "password": "secret123"})
    check("local password login", status == 200 and body.get("role") == "agent", body)
    status, body = call("DELETE", f"/users/{created_user}", token=admin)
    check("delete local user", status == 200, body)

status, body = call("GET", "/kb/articles/nope", token=admin)
check("unknown article 404", status == 404, status)

# multipart: audio upload path
payload, ctype = multipart({"channel": "voice", "form_id": "form-voice", "agent_name": "Rahul Verma"},
                           {"file": ("call.wav", b"RIFF" + b"\x00" * 2048, "audio/wav")})
status, body = call("POST", "/interactions", token=admin, raw=payload, ctype=ctype)
audio_id = body.get("id") if status == 200 else None
check("upload audio interaction", status == 200 and audio_id and body.get("source") == "audio", body)
if audio_id:
    scored = None
    for _ in range(20):
        time.sleep(0.4)
        s, b = call("GET", f"/interactions/{audio_id}", token=admin)
        if s == 200 and b.get("status") in ("scored", "failed"):
            scored = b
            break
    check("audio interaction transcribed + scored",
          (scored or {}).get("status") == "scored" and (scored or {}).get("segments"),
          (scored or {}).get("status"))

# bulk spreadsheet import
csv_body = "channel,agent_name,transcript\nchat,Anita Desai,Agent: hello\nemail,Rahul Verma,Agent: hi\n".encode()
payload, ctype = multipart({"form_id": "form-chat"}, {"file": ("rows.csv", csv_body, "text/csv")})
status, body = call("POST", "/interactions/bulk-sheet", token=admin, raw=payload, ctype=ctype)
check("bulk CSV import", status == 200 and body.get("created") == 2 and not body.get("errors"), body)

passed = sum(1 for _, ok, _ in results if ok)
print(f"\n{passed}/{len(results)} checks passed")
