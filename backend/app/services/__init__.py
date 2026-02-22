"""
services module - contains all business logic services.
each service is responsible for a specific domain:
- speech_to_text: handles audio transcription
- llm_processor: processes text through language models
- svg_generator: creates svg visualizations from llm output
- chart_generator: creates matplotlib chart visualizations
"""

# Use lazy imports to avoid circular dependencies and allow graceful degradation
# if LangChain is not installed
def __getattr__(name):
    """Lazy import of service classes."""
    if name == "SpeechToTextService":
        from app.services.speech_to_text import SpeechToTextService
        return SpeechToTextService
    elif name == "LLMProcessor":
        from app.services.llm_processor import LLMProcessor
        return LLMProcessor
    elif name == "SVGGenerator":
        from app.services.svg_generator import SVGGenerator
        return SVGGenerator
    elif name == "ChartGenerator":
        from app.services.chart_generator import ChartGenerator
        return ChartGenerator
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

__all__ = [
    "SpeechToTextService",
    "LLMProcessor",
    "SVGGenerator",
    "ChartGenerator",
]
