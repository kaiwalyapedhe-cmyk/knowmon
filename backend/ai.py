import json
import os
import re
import uuid

from emergentintegrations.llm.chat import LlmChat, StreamDone, TextDelta, UserMessage
from emergentintegrations.llm.openai import OpenAISpeechToText

MODEL = ("anthropic", "claude-opus-5-5")


def _chat(system: str) -> LlmChat:
    return LlmChat(api_key=os.environ["EMERGENT_LLM_KEY"], session_id=str(uuid.uuid4()),
                   system_message=system).with_model(*MODEL)


async def ask_json(system: str, prompt: str):
    text = await _chat(system + " Respond with ONLY valid JSON. No prose, no code fences.").send_message(UserMessage(text=prompt))
    m = re.search(r"[\[{].*[\]}]", text, re.S)
    return json.loads(m.group(0) if m else text)


async def stream_text(system: str, prompt: str):
    async for ev in _chat(system).stream_message(UserMessage(text=prompt)):
        if isinstance(ev, TextDelta):
            yield ev.content
        elif isinstance(ev, StreamDone):
            break


def _get(o, k):
    return o.get(k) if isinstance(o, dict) else getattr(o, k, None)


async def transcribe(path: str) -> tuple:
    stt = OpenAISpeechToText(api_key=os.environ["EMERGENT_LLM_KEY"])
    with open(path, "rb") as f:
        r = await stt.transcribe(file=f, model="whisper-1", response_format="verbose_json", timestamp_granularities=["segment"])
    segments = [{"start": round(float(_get(s, "start") or 0), 2), "end": round(float(_get(s, "end") or 0), 2),
                 "text": (_get(s, "text") or "").strip()} for s in (_get(r, "segments") or [])]
    return _get(r, "text") or "", segments


SCORE_SYSTEM = ("You are an expert contact-centre quality auditor (AutoQA). You evaluate customer interactions "
                "strictly against the supplied QA form, detect compliance risks, sentiment and predicted CSAT.")


async def score_interaction(form: dict, transcript: str, channel: str, articles: list) -> dict:
    criteria = [{"id": c["id"], "name": c["name"], "description": c.get("description", ""), "type": c.get("type", "scale")}
                for c in form["criteria"]]
    catalog = [{"id": a["id"], "title": a["title"], "category": a.get("category", "")} for a in articles]
    prompt = f"""Channel: {channel}
QA form criteria (type 'binary' = pass/fail scored 0 or 100, 'scale' = 0-100):
{json.dumps(criteria)}

Knowledge base catalog (recommend articles the agent should review or could have used):
{json.dumps(catalog)}

Transcript:
\"\"\"{transcript[:30000]}\"\"\"

Return JSON with exactly these keys:
{{"criteria":[{{"id":"<criterion id>","score":0-100,"passed":true/false,"reason":"short evidence-based reason"}}],
"sentiment":"positive|neutral|negative","sentiment_score":-1.0 to 1.0,"csat_predicted":1-5,
"customer_intent":"short phrase","summary":"2-3 sentence summary",
"compliance_flags":[{{"issue":"...","severity":"high|medium|low","quote":"exact quote from transcript"}}],
"strengths":["..."],"improvements":["specific coaching action"],"recommended_article_ids":["kb id"]}}"""
    r = await ask_json(SCORE_SYSTEM, prompt)
    by_id = {c.get("id"): c for c in r.get("criteria", [])}
    results, total_w, total, auto_failed = [], 0.0, 0.0, False
    for c in form["criteria"]:
        got = by_id.get(c["id"], {})
        score = max(0.0, min(100.0, float(got.get("score", 0))))
        passed = bool(got.get("passed", score >= 60))
        if c.get("auto_fail") and not passed:
            auto_failed = True
        w = float(c.get("weight", 1))
        total_w += w
        total += score * w
        results.append({"id": c["id"], "name": c["name"], "weight": w, "type": c.get("type", "scale"),
                        "auto_fail": c.get("auto_fail", False), "score": round(score, 1), "passed": passed,
                        "reason": got.get("reason", "")})
    overall = 0.0 if auto_failed else round(total / total_w, 1) if total_w else 0.0
    valid_ids = {a["id"] for a in articles}
    return {
        "criteria_results": results, "overall_score": overall, "auto_failed": auto_failed,
        "sentiment": r.get("sentiment", "neutral"), "sentiment_score": r.get("sentiment_score", 0),
        "csat_predicted": r.get("csat_predicted", 3), "customer_intent": r.get("customer_intent", ""),
        "summary": r.get("summary", ""), "compliance_flags": r.get("compliance_flags", []),
        "strengths": r.get("strengths", []), "improvements": r.get("improvements", []),
        "recommended_article_ids": [i for i in r.get("recommended_article_ids", []) if i in valid_ids],
    }


ANSWER_SYSTEM = ("You are a knowledge assistant for contact-centre agents. Answer ONLY from the provided knowledge "
                 "articles, concisely, with numbered steps when relevant. Cite article titles in [brackets]. "
                 "If the articles don't cover it, say so plainly. Use plain text only: no markdown, no asterisks or # headings.")


PUBLIC_SYSTEM = ("You are a friendly customer self-service assistant. Speak directly to the customer in second person, "
                 "answer ONLY from the provided help articles, give simple numbered steps they can do themselves, and never "
                 "mention internal agent procedures. If the articles don't cover it, suggest contacting support. "
                 "Use plain text only: no markdown, no asterisks or # headings.")


def answer_prompt(question: str, articles: list) -> str:
    docs = "\n\n".join(
        f"### {a['title']} ({a.get('category', '')})\n{a.get('content', '')}\n" +
        "\n".join(f"Step {i + 1}: {s['title']} - {s.get('body', '')}" for i, s in enumerate(a.get("steps", [])))
        for a in articles) or "(no matching articles)"
    return f"Knowledge articles:\n{docs}\n\nQuestion: {question}"


async def generate_tree(title: str, sop: str) -> dict:
    prompt = f"""Convert this SOP into an interactive decision tree for live agents. Title: {title}
SOP:
\"\"\"{sop[:20000]}\"\"\"
Return JSON: {{"start_node":"n1","nodes":[{{"id":"n1","title":"short step title","text":"what to check / ask",
"script":"exact words agent can say (optional)","options":[{{"label":"answer/branch","next":"n2"}}]}}]}}
End nodes have an empty options list. Use 4-12 nodes. Every 'next' must reference an existing node id."""
    return await ask_json("You design cognitive decision trees from standard operating procedures.", prompt)


async def generate_quiz(content: str, count: int) -> list:
    prompt = f"""Create {count} multiple-choice assessment questions for new contact-centre hires from this material:
\"\"\"{content[:20000]}\"\"\"
Return a JSON array: [{{"question":"...","options":["a","b","c","d"],"answer_index":0,"explanation":"why"}}]"""
    r = await ask_json("You write clear, fair training assessments.", prompt)
    return r if isinstance(r, list) else r.get("questions", [])
