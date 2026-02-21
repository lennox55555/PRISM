"""
rest api router for non-streaming operations.
provides endpoints for svg generation, audio file upload,
and other operations that don't require websocket connections.
"""

import base64
import logging
from typing import Optional

from fastapi import APIRouter, File, UploadFile, HTTPException
from pydantic import BaseModel

from app.services.speech_to_text import SpeechToTextService
from app.services.llm_processor import LLMProcessor
from app.services.svg_generator import SVGGenerator
from app.models.schemas import (
    SVGGenerationRequest,
    SVGGenerationResponse,
    TranscriptionResult,
)

logger = logging.getLogger(__name__)
router = APIRouter()


class TextToSVGRequest(BaseModel):
    """request body for text to svg generation endpoint."""

    text: str
    style: Optional[str] = None
    context: Optional[str] = None


class TranscribeAndGenerateRequest(BaseModel):
    """request body for combined transcription and svg generation."""

    audio_base64: str
    style: Optional[str] = None


class TranscribeAndGenerateResponse(BaseModel):
    """response for combined transcription and svg generation."""

    transcription: str
    svg_code: str
    description: str


class SpeechSummaryRequest(BaseModel):
    """request body for speech summary generation."""

    texts: list[str]


class SpeechSummaryResponse(BaseModel):
    """response body for speech summary generation."""

    summary: str
    item_count: int


@router.post("/text-to-svg", response_model=SVGGenerationResponse)
async def text_to_svg(request: TextToSVGRequest):
    """
    generate an svg visualization from text description.
    this endpoint accepts a text prompt and returns the generated svg.

    args:
        request: text to svg generation request

    returns:
        svg generation response with svg code and metadata
    """
    try:
        llm_processor = LLMProcessor()
        svg_generator = SVGGenerator()

        # create svg generation request
        svg_request = SVGGenerationRequest(
            text=request.text,
            style=request.style,
            context=request.context,
        )

        # generate svg using llm
        response = await llm_processor.generate_svg(svg_request)

        # process and sanitize the svg
        processed_svg = svg_generator.process_svg(
            response.svg_code,
            sanitize=True,
            responsive=True,
        )

        return SVGGenerationResponse(
            svg_code=processed_svg,
            description=response.description,
            original_text=response.original_text,
        )

    except Exception as e:
        logger.error(f"text to svg generation failed: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"svg generation failed: {str(e)}",
        )


@router.post("/transcribe", response_model=TranscriptionResult)
async def transcribe_audio(file: UploadFile = File(...)):
    """
    transcribe an uploaded audio file to text.
    accepts wav, mp3, webm, and other common audio formats.

    args:
        file: uploaded audio file

    returns:
        transcription result with text and metadata
    """
    try:
        # read the uploaded file
        audio_data = await file.read()

        if not audio_data:
            raise HTTPException(
                status_code=400,
                detail="empty audio file",
            )

        stt_service = SpeechToTextService()
        result = await stt_service.transcribe_file(audio_data)

        return result

    except Exception as e:
        logger.error(f"transcription failed: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"transcription failed: {str(e)}",
        )


@router.post("/transcribe-and-generate", response_model=TranscribeAndGenerateResponse)
async def transcribe_and_generate(request: TranscribeAndGenerateRequest):
    """
    combined endpoint that transcribes audio and generates svg.
    takes base64 encoded audio, transcribes it, and generates a visualization.

    args:
        request: contains base64 audio and optional style

    returns:
        combined transcription and svg result
    """
    try:
        # decode base64 audio
        try:
            audio_data = base64.b64decode(request.audio_base64)
        except Exception:
            raise HTTPException(
                status_code=400,
                detail="invalid base64 audio data",
            )

        # transcribe audio
        stt_service = SpeechToTextService()
        transcription = await stt_service.transcribe_file(audio_data)

        if not transcription.text.strip():
            raise HTTPException(
                status_code=400,
                detail="no speech detected in audio",
            )

        # generate svg from transcription
        llm_processor = LLMProcessor()
        svg_generator = SVGGenerator()

        svg_request = SVGGenerationRequest(
            text=transcription.text,
            style=request.style,
        )

        svg_response = await llm_processor.generate_svg(svg_request)

        # process svg
        processed_svg = svg_generator.process_svg(
            svg_response.svg_code,
            sanitize=True,
            responsive=True,
        )

        return TranscribeAndGenerateResponse(
            transcription=transcription.text,
            svg_code=processed_svg,
            description=svg_response.description,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"transcribe and generate failed: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"processing failed: {str(e)}",
        )


@router.post("/summarize-speech", response_model=SpeechSummaryResponse)
async def summarize_speech(request: SpeechSummaryRequest):
    """
    summarize a list of user speech/text segments with a small llm model.
    """
    try:
        cleaned_texts = [text.strip() for text in request.texts if text and text.strip()]
        if not cleaned_texts:
            raise HTTPException(
                status_code=400,
                detail="no speech text provided",
            )

        llm_processor = LLMProcessor()
        summary = await llm_processor.generate_brief_summary(cleaned_texts)

        return SpeechSummaryResponse(
            summary=summary,
            item_count=len(cleaned_texts),
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"speech summary generation failed: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"summary generation failed: {str(e)}",
        )


@router.post("/validate-svg")
async def validate_svg(svg_code: str):
    """
    validate svg code and return sanitized version.
    useful for checking svg validity before rendering.

    args:
        svg_code: svg code string to validate

    returns:
        validation result with sanitized svg
    """
    svg_generator = SVGGenerator()

    is_valid = svg_generator.validate_svg(svg_code)

    if not is_valid:
        raise HTTPException(
            status_code=400,
            detail="invalid svg code",
        )

    sanitized = svg_generator.process_svg(
        svg_code,
        sanitize=True,
        responsive=True,
    )

    return {
        "valid": True,
        "sanitized_svg": sanitized,
    }


@router.get("/placeholder-svg")
async def get_placeholder_svg(message: str = "loading..."):
    """
    get a placeholder svg for loading states.

    args:
        message: message to display in the placeholder

    returns:
        placeholder svg code
    """
    svg_generator = SVGGenerator()
    placeholder = svg_generator.create_placeholder_svg(message)

    return {"svg": placeholder}
