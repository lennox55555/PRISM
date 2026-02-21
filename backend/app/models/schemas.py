"""
Pydantic models for request/response validation.
"""

from enum import Enum
from typing import Optional
from pydantic import BaseModel


class MessageType(str, Enum):
    """WebSocket message types."""

    # Client -> Server
    AUDIO_CHUNK = "audio_chunk"
    START_RECORDING = "start_recording"
    STOP_RECORDING = "stop_recording"

    # Server -> Client
    TRANSCRIPTION_PARTIAL = "transcription_partial"
    TRANSCRIPTION_FINAL = "transcription_final"
    SVG_GENERATED = "svg_generated"
    ERROR = "error"
    STATUS = "status"


class TranscriptionResult(BaseModel):
    """Result from speech-to-text service."""

    text: str
    is_final: bool = False
    confidence: Optional[float] = None
    language: Optional[str] = None


class SVGGenerationRequest(BaseModel):
    """Request to generate SVG from text."""

    text: str
    style: Optional[str] = None
    context: Optional[str] = None


class SVGGenerationResponse(BaseModel):
    """Response containing generated SVG."""

    svg_code: str
    description: str
    original_text: str


class WebSocketMessage(BaseModel):
    """Generic WebSocket message structure."""

    type: MessageType
    data: Optional[dict] = None
    error: Optional[str] = None


class AudioConfig(BaseModel):
    """Audio recording configuration."""

    sample_rate: int = 16000
    channels: int = 1
    encoding: str = "pcm_s16le"
