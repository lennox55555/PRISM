"""
websocket router for real-time audio streaming and svg generation.
handles bidirectional communication between the frontend and backend
for live transcription and visualization updates.
"""

import asyncio
import base64
import json
import logging
import time
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.speech_to_text import SpeechToTextService
from app.services.llm_processor import LLMProcessor
from app.services.svg_generator import SVGGenerator
from app.models.schemas import (
    MessageType,
    WebSocketMessage,
    SVGGenerationRequest,
)

logger = logging.getLogger(__name__)
router = APIRouter()


class ConnectionManager:
    """
    manages websocket connections for the application.
    handles connection lifecycle and message broadcasting.
    """

    def __init__(self):
        """initialize the connection manager with empty connection list."""
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        """
        accept a new websocket connection.

        args:
            websocket: the websocket connection to accept
        """
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"websocket connected. total connections: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        """
        remove a websocket connection from the active list.

        args:
            websocket: the websocket connection to remove
        """
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        logger.info(f"websocket disconnected. total connections: {len(self.active_connections)}")

    async def send_message(self, websocket: WebSocket, message: WebSocketMessage):
        """
        send a message to a specific websocket connection.

        args:
            websocket: target websocket
            message: message to send
        """
        try:
            await websocket.send_json(message.model_dump())
        except Exception as e:
            logger.error(f"failed to send message: {e}")

    async def broadcast(self, message: WebSocketMessage):
        """
        broadcast a message to all connected clients.

        args:
            message: message to broadcast
        """
        for connection in self.active_connections:
            await connection.send_json(message.model_dump())


# global connection manager instance
manager = ConnectionManager()


class AudioSessionHandler:
    """
    handles a single audio recording session.
    manages the pipeline from audio input to svg output,
    coordinating between speech-to-text, llm, and svg services.
    generates svg visualizations every 10 seconds during recording.
    """

    def __init__(self, websocket: WebSocket):
        """
        initialize a new audio session.

        args:
            websocket: the websocket connection for this session
        """
        self.websocket = websocket
        self.stt_service = SpeechToTextService()
        self.llm_processor = LLMProcessor()
        self.svg_generator = SVGGenerator()

        # session state
        self.is_recording = False
        self.is_connected = True
        self.accumulated_text = ""

        # audio buffer for accumulating wav chunks from frontend
        self.audio_chunks: list[bytes] = []
        self.last_svg_generation_time = 0

        # timing configuration (in seconds)
        self.svg_generation_interval = 3  # generate svg every 3 seconds

        # background task for periodic svg generation
        self.processing_task: Optional[asyncio.Task] = None

    async def send_message_safe(self, message: WebSocketMessage):
        """
        safely send a message, catching errors if connection is closed.
        """
        if not self.is_connected:
            return
        try:
            await manager.send_message(self.websocket, message)
        except Exception as e:
            logger.warning(f"failed to send message (connection may be closed): {e}")
            self.is_connected = False

    async def start_recording(self):
        """
        initialize a new recording session.
        resets all buffers and state for a fresh recording.
        starts the periodic svg generation task.
        """
        self.is_recording = True
        self.accumulated_text = ""
        self.audio_chunks = []
        self.last_svg_generation_time = time.time()
        self.stt_service.reset()

        # start background task for periodic svg generation
        self.processing_task = asyncio.create_task(self._periodic_svg_generation())

        await self.send_message_safe(
            WebSocketMessage(
                type=MessageType.STATUS,
                data={"status": "recording_started"},
            ),
        )
        logger.info("recording session started")

    async def stop_recording(self):
        """
        finalize the recording session.
        generates the final svg from accumulated text.
        """
        self.is_recording = False

        # cancel the background processing task
        if self.processing_task:
            self.processing_task.cancel()
            try:
                await self.processing_task
            except asyncio.CancelledError:
                pass

        # generate final svg from accumulated text
        if self.accumulated_text.strip():
            await self._generate_and_send_svg()

        await self.send_message_safe(
            WebSocketMessage(
                type=MessageType.STATUS,
                data={"status": "recording_stopped"},
            ),
        )
        logger.info("recording session stopped")

    def disconnect(self):
        """mark session as disconnected to stop sending messages."""
        self.is_connected = False
        self.is_recording = False

    async def process_audio_chunk(self, audio_data: bytes):
        """
        process an incoming audio chunk.
        the frontend sends wav audio every 3 seconds, so we transcribe immediately.

        args:
            audio_data: wav audio bytes from the client
        """
        if not self.is_recording or not self.is_connected:
            return

        # transcribe immediately since frontend sends complete wav chunks
        await self._transcribe_audio(audio_data)

    async def _periodic_svg_generation(self):
        """
        background task that periodically generates svg.
        runs while recording is active.
        """
        try:
            while self.is_recording and self.is_connected:
                await asyncio.sleep(1)  # check every second

                current_time = time.time()

                # check if it's time to generate svg
                if current_time - self.last_svg_generation_time >= self.svg_generation_interval:
                    if self.accumulated_text.strip():
                        await self._generate_and_send_svg()
                        self.last_svg_generation_time = current_time

        except asyncio.CancelledError:
            logger.info("periodic svg generation task cancelled")
        except Exception as e:
            logger.error(f"periodic svg generation error: {e}")

    async def _transcribe_audio(self, audio_data: bytes):
        """
        transcribe the provided wav audio data.

        args:
            audio_data: wav audio bytes from the client
        """
        if not self.is_connected:
            return

        try:
            # skip if too small (likely no real audio)
            if len(audio_data) < 1000:
                return

            # transcribe the wav audio
            result = await self.stt_service.transcribe_file(audio_data)

            if result.text and result.text.strip():
                # filter out common whisper hallucinations on silence
                text = result.text.strip()
                hallucinations = [
                    "you", "thank you", "thanks for watching",
                    "subscribe", "bye", "goodbye", "the end",
                    "thanks for listening", "see you", "okay",
                    "thank you for watching", "thanks for watching",
                ]

                # check if the transcription is just a hallucination
                lower_text = text.lower().strip(".,!? ")
                if lower_text in hallucinations:
                    logger.info(f"filtered out likely hallucination: {text}")
                    return

                # check for repeated single words (another hallucination pattern)
                words = text.lower().split()
                if len(words) > 2 and len(set(words)) == 1:
                    logger.info(f"filtered out repeated word hallucination: {text}")
                    return

                self.accumulated_text += " " + text
                self.accumulated_text = self.accumulated_text.strip()

                # send transcription to client
                await self.send_message_safe(
                    WebSocketMessage(
                        type=MessageType.TRANSCRIPTION_PARTIAL,
                        data={
                            "text": text,
                            "accumulated_text": self.accumulated_text,
                            "is_final": False,
                        },
                    ),
                )
                logger.info(f"transcribed: {text}")

        except Exception as e:
            logger.error(f"transcription error: {e}")
            await self.send_message_safe(
                WebSocketMessage(
                    type=MessageType.ERROR,
                    error=f"transcription failed: {str(e)}",
                ),
            )

    async def _generate_and_send_svg(self):
        """
        generate svg from the accumulated transcription text.
        sends the generated svg to the client.
        """
        if not self.accumulated_text.strip() or not self.is_connected:
            return

        try:
            logger.info(f"generating svg for: {self.accumulated_text[:50]}...")

            # create svg generation request
            request = SVGGenerationRequest(text=self.accumulated_text.strip())

            # generate svg using llm
            response = await self.llm_processor.generate_svg(request)

            # process and sanitize the svg
            processed_svg = self.svg_generator.process_svg(
                response.svg_code,
                sanitize=True,
                responsive=True,
            )

            # add animation for smooth appearance
            animated_svg = self.svg_generator.wrap_svg_for_animation(
                processed_svg, animation_type="fade"
            )

            # send to client
            await self.send_message_safe(
                WebSocketMessage(
                    type=MessageType.SVG_GENERATED,
                    data={
                        "svg": animated_svg,
                        "description": response.description,
                        "original_text": response.original_text,
                    },
                ),
            )
            logger.info("svg generated and sent")

        except Exception as e:
            logger.error(f"svg generation error: {e}")
            error_svg = self.svg_generator.create_error_svg(str(e))
            await self.send_message_safe(
                WebSocketMessage(
                    type=MessageType.SVG_GENERATED,
                    data={"svg": error_svg, "error": str(e)},
                ),
            )


@router.websocket("/audio")
async def audio_websocket(websocket: WebSocket):
    """
    main websocket endpoint for audio streaming.
    handles the complete pipeline from audio input to svg output.
    transcribes audio every 3 seconds and generates svg every 10 seconds.

    client messages:
    - {"type": "start_recording"}: begin a new recording session
    - {"type": "audio_chunk", "data": "<base64_audio>"}: send audio data
    - {"type": "stop_recording"}: end the recording session

    server messages:
    - {"type": "status", "data": {...}}: status updates
    - {"type": "transcription_partial", "data": {...}}: interim transcription
    - {"type": "transcription_final", "data": {...}}: final transcription
    - {"type": "svg_generated", "data": {...}}: generated svg
    - {"type": "error", "error": "..."}: error messages
    """
    await manager.connect(websocket)
    session = AudioSessionHandler(websocket)

    try:
        while True:
            # receive message from client
            raw_message = await websocket.receive_text()

            try:
                message = json.loads(raw_message)
                message_type = message.get("type")

                if message_type == MessageType.START_RECORDING.value:
                    await session.start_recording()

                elif message_type == MessageType.STOP_RECORDING.value:
                    await session.stop_recording()

                elif message_type == MessageType.AUDIO_CHUNK.value:
                    # decode base64 audio data
                    audio_b64 = message.get("data", "")
                    if audio_b64:
                        audio_data = base64.b64decode(audio_b64)
                        await session.process_audio_chunk(audio_data)

                else:
                    logger.warning(f"unknown message type: {message_type}")

            except json.JSONDecodeError as e:
                logger.error(f"invalid json message: {e}")
                await manager.send_message(
                    websocket,
                    WebSocketMessage(
                        type=MessageType.ERROR,
                        error="invalid json message",
                    ),
                )

    except WebSocketDisconnect:
        logger.info("client disconnected")
    except Exception as e:
        logger.error(f"websocket error: {e}")
    finally:
        # mark session as disconnected to stop background tasks
        session.disconnect()
        if session.processing_task:
            session.processing_task.cancel()
            try:
                await session.processing_task
            except asyncio.CancelledError:
                pass
        manager.disconnect(websocket)


@router.websocket("/text-to-svg")
async def text_to_svg_websocket(websocket: WebSocket):
    """
    websocket endpoint for text-to-svg generation without audio.
    useful for testing or when text input is preferred.

    client messages:
    - {"text": "description", "style": "optional_style"}: generate svg

    server messages:
    - {"type": "svg_generated", "data": {...}}: generated svg
    - {"type": "error", "error": "..."}: error messages
    """
    await manager.connect(websocket)
    llm_processor = LLMProcessor()
    svg_generator = SVGGenerator()

    try:
        while True:
            raw_message = await websocket.receive_text()

            try:
                message = json.loads(raw_message)
                text = message.get("text", "")
                style = message.get("style")

                if not text:
                    await manager.send_message(
                        websocket,
                        WebSocketMessage(
                            type=MessageType.ERROR,
                            error="text is required",
                        ),
                    )
                    continue

                # generate svg
                request = SVGGenerationRequest(text=text, style=style)
                response = await llm_processor.generate_svg(request)

                # process svg
                processed_svg = svg_generator.process_svg(
                    response.svg_code,
                    sanitize=True,
                    responsive=True,
                )

                await manager.send_message(
                    websocket,
                    WebSocketMessage(
                        type=MessageType.SVG_GENERATED,
                        data={
                            "svg": processed_svg,
                            "description": response.description,
                            "original_text": response.original_text,
                        },
                    ),
                )

            except json.JSONDecodeError:
                await manager.send_message(
                    websocket,
                    WebSocketMessage(
                        type=MessageType.ERROR,
                        error="invalid json",
                    ),
                )

    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket)
