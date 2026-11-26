import asyncio
import json
import logging
from typing import AsyncGenerator

logger = logging.getLogger(__name__)

class UserMessage:
    def __init__(self, text: str = ""):
        self.text = text

class TextDelta:
    def __init__(self, content: str = ""):
        self.content = content

class StreamDone:
    pass

class LlmChat:
    def __init__(self, api_key: str = "", session_id: str = "", system_message: str = ""):
        self.api_key = api_key
        self.session_id = session_id
        self.system_message = system_message
        self.provider = "anthropic"
        self.model = "claude-opus-5-5"

    def with_model(self, provider: str, model: str):
        self.provider = provider
        self.model = model
        return self

    async def send_message(self, message: UserMessage) -> str:
        prompt = message.text
        sys_msg = self.system_message.lower()

        # If scoring an interaction
        if "autoqa" in sys_msg or "score" in sys_msg or "rubric" in sys_msg:
            return json.dumps({
                "overall_score": 88,
                "sentiment": "positive",
                "predicted_csat": 4.5,
                "auto_failed": False,
                "auto_fail_reason": None,
                "summary": "Agent handled the inquiry professionally and followed standard SOP.",
                "strengths": ["Clear greeting and courteous tone", "Followed identity verification"],
                "improvements": ["Ensure mandatory disclosure is delivered early"],
                "compliance_flags": [],
                "criteria_scores": [],
                "recommended_articles": []
            })
        
        # If generating quiz
        if "quiz" in sys_msg:
            return json.dumps([
                {
                    "question": "What is the standard refund window for eligible products?",
                    "options": ["15 days", "30 days", "60 days", "90 days"],
                    "answer_index": 1,
                    "explanation": "Customers are eligible for a full refund within 30 days."
                }
            ])

        # If generating decision tree
        if "decision tree" in sys_msg or "tree" in sys_msg:
            return json.dumps({
                "title": "Generated Workflow Tree",
                "description": "Auto-generated decision tree from SOP",
                "category": "General",
                "start_node": "n1",
                "nodes": [
                    {
                        "id": "n1",
                        "title": "Verify Customer",
                        "text": "Ask customer for account verification details.",
                        "script": "Could you please confirm your registered account name?",
                        "options": [{"label": "Verified", "next": "n2"}, {"label": "Failed", "next": "n3"}]
                    },
                    {
                        "id": "n2",
                        "title": "Resolve Request",
                        "text": "Proceed with resolving the user request according to SOP.",
                        "script": "Thank you for confirming. I can now process your request.",
                        "options": []
                    },
                    {
                        "id": "n3",
                        "title": "Security Rejection",
                        "text": "Inform user that account cannot be verified.",
                        "script": "For security reasons, we cannot continue without verification.",
                        "options": []
                    }
                ]
            })

        return json.dumps({"status": "ok", "message": "Cadence CX AI processed request successfully."})

    async def stream_message(self, message: UserMessage) -> AsyncGenerator:
        content = "Based on Cadence CX Knowledge Base, customer refunds are processed within 5-7 business days."
        for word in content.split(" "):
            yield TextDelta(content=word + " ")
            await asyncio.sleep(0.02)
        yield StreamDone()
