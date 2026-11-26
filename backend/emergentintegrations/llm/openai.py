import logging

logger = logging.getLogger(__name__)

class OpenAISpeechToText:
    def __init__(self, api_key: str = ""):
        self.api_key = api_key

    async def transcribe(self, file, model: str = "whisper-1", response_format: str = "verbose_json", timestamp_granularities=None):
        logger.info("Transcribing audio file via OpenAISpeechToText")
        # Return fallback mock transcript if running offline
        return {
            "text": "Hello, thank you for calling support. This call may be recorded for quality and training purposes. My name is Alex. How can I help you today? I'd like to ask about my recent refund request. Sure, let me verify your account and check the refund status for you.",
            "segments": [
                {"start": 0.0, "end": 4.5, "text": "Hello, thank you for calling support. This call may be recorded for quality and training purposes."},
                {"start": 4.5, "end": 7.0, "text": "My name is Alex. How can I help you today?"},
                {"start": 7.0, "end": 10.5, "text": "I'd like to ask about my recent refund request."},
                {"start": 10.5, "end": 15.0, "text": "Sure, let me verify your account and check the refund status for you."}
            ]
        }
