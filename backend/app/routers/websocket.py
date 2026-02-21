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
from app.services.chart_generator import ChartGenerator
from app.models.schemas import (
    MessageType,
    WebSocketMessage,
    SVGGenerationRequest,
)

logger = logging.getLogger(__name__)
router = APIRouter()

# trigger word to activate visualization
# "prison" is included as it's often misheard for "prism"
ACTIVATE_WORDS = ["prism", "prison"]
# deactivation phrase to stop visualization
DEACTIVATE_PHRASE = "thank you"


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
    generates svg visualizations every 3 seconds during recording.
    uses topic similarity detection to enhance or create new visualizations.
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
        self.chart_generator = ChartGenerator()

        # session state
        self.is_recording = False
        self.is_connected = True
        self.accumulated_text = ""

        # visualization state - controlled by trigger word
        self.visualization_active = False
        self.visualization_text = ""  # text accumulated since visualization started
        self.just_activated = False  # flag to prevent immediate deactivation in same chunk

        # topic tracking for intelligent visualization updates
        # stores the text that was used for the last svg generation
        self.last_svg_text = ""
        # stores the full context used for the last svg (for enhanced mode)
        self.last_svg_context = ""
        # stores the actual svg code from the last generation (for enhancement)
        self.last_svg_code = ""
        # stores the length of text at last svg generation (to extract delta)
        self.last_text_length = 0
        # similarity threshold for determining if topics match (0-1)
        # lower = more lenient (topics considered similar more often)
        self.similarity_threshold = 0.50

        # audio buffer for accumulating wav chunks from frontend
        self.audio_chunks: list[bytes] = []
        self.last_svg_generation_time = 0

        # timing configuration (in seconds)
        self.svg_generation_interval = 5  # generate svg every 5 seconds

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
        visualization starts paused until trigger word is spoken.
        """
        self.is_recording = True
        self.accumulated_text = ""
        self.visualization_active = False
        self.visualization_text = ""
        # reset topic tracking for new session
        self.last_svg_text = ""
        self.last_svg_context = ""
        self.last_svg_code = ""
        self.last_text_length = 0
        self.audio_chunks = []
        self.last_svg_generation_time = time.time()
        self.stt_service.reset()

        # start background task for periodic svg generation
        self.processing_task = asyncio.create_task(self._periodic_svg_generation())

        await self.send_message_safe(
            WebSocketMessage(
                type=MessageType.STATUS,
                data={
                    "status": "recording_started",
                    "visualization_active": False,
                    "activate_word": "prism",
                    "deactivate_phrase": DEACTIVATE_PHRASE,
                },
            ),
        )
        logger.info(f"recording session started. say 'prism' to start, '{DEACTIVATE_PHRASE}' to stop")

    async def stop_recording(self):
        """
        finalize the recording session.
        generates the final svg if visualization was active.
        """
        self.is_recording = False

        # cancel the background processing task
        if self.processing_task:
            self.processing_task.cancel()
            try:
                await self.processing_task
            except asyncio.CancelledError:
                pass

        # generate final svg if visualization was active and has text
        if self.visualization_active and self.visualization_text.strip():
            await self._generate_and_send_visualization()

        self.visualization_active = False

        await self.send_message_safe(
            WebSocketMessage(
                type=MessageType.STATUS,
                data={
                    "status": "recording_stopped",
                    "visualization_active": False,
                },
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
        runs while recording is active and visualization is enabled.
        """
        try:
            while self.is_recording and self.is_connected:
                await asyncio.sleep(1)  # check every second

                current_time = time.time()

                # only generate svg if visualization is active
                if self.visualization_active:
                    if current_time - self.last_svg_generation_time >= self.svg_generation_interval:
                        if self.visualization_text.strip():
                            await self._generate_and_send_visualization()
                            self.last_svg_generation_time = current_time

        except asyncio.CancelledError:
            logger.info("periodic svg generation task cancelled")
        except Exception as e:
            logger.error(f"periodic svg generation error: {e}")

    async def _transcribe_audio(self, audio_data: bytes):
        """
        transcribe the provided wav audio data.
        detects trigger word to toggle visualization on/off.

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

                # check for trigger word to toggle visualization
                text_to_add = await self._process_trigger_word(text)

                # add to accumulated text (full transcription)
                self.accumulated_text += " " + text
                self.accumulated_text = self.accumulated_text.strip()

                # add to visualization text if active and we have text to add
                if self.visualization_active and text_to_add:
                    self.visualization_text += " " + text_to_add
                    self.visualization_text = self.visualization_text.strip()

                # send transcription to client
                await self.send_message_safe(
                    WebSocketMessage(
                        type=MessageType.TRANSCRIPTION_PARTIAL,
                        data={
                            "text": text,
                            "accumulated_text": self.accumulated_text,
                            "visualization_text": self.visualization_text,
                            "visualization_active": self.visualization_active,
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

    async def _process_trigger_word(self, text: str) -> str:
        """
        check for activation/deactivation words and update visualization state.
        - "prism" or "prison" activates visualization (when off)
        - "thank you" deactivates visualization (when on)
        returns the text with trigger words removed and "prison" replaced with "prism".

        args:
            text: transcribed text to check

        returns:
            text to add to visualization (with trigger words removed)
        """
        import re
        lower_text = text.lower()

        # replace "prison" with "prism" in the original text for display
        text = re.sub(r'\bprison\b', 'prism', text, flags=re.IGNORECASE)
        lower_text = text.lower()

        # check for deactivation phrase first (when visualization is active)
        # also check for "thankyou" without space as speech recognition sometimes merges it
        # require at least 6 seconds after activation before allowing deactivation
        # this ensures at least one SVG has time to generate
        deactivate_patterns = [DEACTIVATE_PHRASE, "thankyou", "thanks"]
        found_deactivate = None

        time_since_activation = time.time() - self.last_svg_generation_time
        can_deactivate = time_since_activation >= 6  # minimum 6 seconds before deactivation

        if can_deactivate:
            for pattern in deactivate_patterns:
                if pattern in lower_text:
                    found_deactivate = pattern
                    break

        if self.visualization_active and found_deactivate:
            self.visualization_active = False
            self.just_activated = False
            logger.info(f"visualization STOPPED (deactivation phrase: {found_deactivate}, after {time_since_activation:.1f}s)")

            # send status update to client
            await self.send_message_safe(
                WebSocketMessage(
                    type=MessageType.STATUS,
                    data={
                        "status": "visualization_toggled",
                        "visualization_active": self.visualization_active,
                    },
                ),
            )

            # return text before the deactivation phrase
            parts = lower_text.split(found_deactivate)
            if len(parts) > 0:
                return parts[0].strip()
            return ""

        # check for activation words (when visualization is not active)
        if not self.visualization_active:
            for activate_word in ACTIVATE_WORDS:
                if activate_word in lower_text:
                    self.visualization_active = True
                    # starting visualization - clear previous visualization text and topic tracking
                    self.visualization_text = ""
                    # reset all topic tracking for fresh visualization session
                    self.last_svg_text = ""
                    self.last_svg_context = ""
                    self.last_svg_code = ""
                    self.last_text_length = 0
                    self.last_svg_generation_time = time.time()
                    logger.info(f"visualization STARTED (trigger word: {activate_word})")

                    # send status update to client
                    await self.send_message_safe(
                        WebSocketMessage(
                            type=MessageType.STATUS,
                            data={
                                "status": "visualization_toggled",
                                "visualization_active": self.visualization_active,
                            },
                        ),
                    )

                    # return text after the trigger word (use "prism" for splitting since prison->prism)
                    parts = re.split(r'\bprism\b', lower_text, flags=re.IGNORECASE)
                    if len(parts) > 1:
                        return parts[1].strip()
                    return ""

        # no trigger word found, return original text (with prison->prism replacement)
        return text

    async def _generate_and_send_visualization(self):
        """
        generate visualization from the text (svg or chart).
        first checks if the request is for a chart/analytical visualization.
        - charts: always generate new (no similarity check), use matplotlib
        - svg: use topic similarity to enhance or create new visualizations
        sends the result to the client.
        """
        current_text = self.visualization_text.strip()
        if not current_text or not self.is_connected:
            return

        try:
            # extract only the NEW text since last generation
            new_text_delta = current_text[self.last_text_length:].strip()

            # if no new text, skip generation
            if not new_text_delta and self.last_svg_text:
                logger.info("no new text since last generation, skipping")
                return

            # use full text if this is the first generation
            if not new_text_delta:
                new_text_delta = current_text

            # check if this is a chart/analytical visualization request
            is_chart, chart_confidence = await self.chart_generator.is_chart_request(new_text_delta)

            if is_chart:
                # generate chart - always new, no similarity check
                await self._generate_and_send_chart(new_text_delta, current_text, chart_confidence)
            else:
                # generate svg with similarity checking
                await self._generate_and_send_svg(new_text_delta, current_text)

        except Exception as e:
            logger.error(f"visualization generation error: {e}")
            error_svg = self.svg_generator.create_error_svg(str(e))
            await self.send_message_safe(
                WebSocketMessage(
                    type=MessageType.SVG_GENERATED,
                    data={"svg": error_svg, "error": str(e)},
                ),
            )

    async def _generate_and_send_chart(self, new_text_delta: str, current_text: str, confidence: float):
        """
        generate a matplotlib chart visualization.
        charts always generate fresh - no similarity checking.

        args:
            new_text_delta: the new text to visualize
            current_text: full accumulated text
            confidence: confidence that this is a chart request
        """
        logger.info(f"generating chart (confidence: {confidence:.2f}) for: {new_text_delta[:50]}...")

        # generate the chart
        result = await self.chart_generator.generate_chart(new_text_delta)

        if result["error"]:
            logger.error(f"chart generation failed: {result['error']}")
            # fall back to svg generation
            await self._generate_and_send_svg(new_text_delta, current_text)
            return

        # update tracking (charts reset the context since they're always new)
        self.last_svg_text = new_text_delta
        self.last_text_length = len(current_text)
        self.last_svg_context = new_text_delta

        # send chart to client
        await self.send_message_safe(
            WebSocketMessage(
                type=MessageType.CHART_GENERATED,
                data={
                    "image": result["image"],  # base64 png
                    "code": result["code"],  # matplotlib code
                    "description": result["description"],
                    "original_text": new_text_delta,
                    "new_text_delta": new_text_delta,
                    "generation_mode": "chart",
                    "chart_confidence": round(confidence, 3),
                },
            ),
        )
        logger.info("chart generated and sent")

    async def _generate_and_send_svg(self, new_text_delta: str, current_text: str):
        """
        generate svg visualization with topic similarity checking.
        compares the new text delta against previous visualization
        to determine whether to enhance or create new.

        args:
            new_text_delta: the new text to compare/visualize
            current_text: full accumulated text
        """
        try:
            # track similarity info for the response
            similarity_score = None
            generation_mode = "initial"

            # check if we have a previous visualization to compare against
            if self.last_svg_text:
                # compare ONLY the new delta against the previous svg text
                is_similar, similarity_score = await self.llm_processor.check_topic_similarity(
                    self.last_svg_text,
                    new_text_delta,
                    threshold=self.similarity_threshold
                )

                logger.info(
                    f"comparing new delta: '{new_text_delta[:50]}...' "
                    f"vs previous: '{self.last_svg_text[:50]}...' "
                    f"= {similarity_score:.3f}"
                )

                if is_similar:
                    # topics are similar - enhance the visualization
                    # pass the previous svg code so llm can see and modify it
                    logger.info(
                        f"topic similar (score: {similarity_score:.3f}), "
                        f"enhancing visualization with previous svg code"
                    )
                    response = await self.llm_processor.generate_enhanced_svg(
                        previous_text=self.last_svg_context,
                        new_text=new_text_delta,
                        previous_svg=self.last_svg_code,  # pass the actual svg code
                    )
                    generation_mode = "enhanced"
                    self.last_svg_context = current_text
                else:
                    # topics are different - create fresh visualization
                    logger.info(
                        f"topic changed (score: {similarity_score:.3f}), "
                        f"generating new visualization for new topic"
                    )
                    request = SVGGenerationRequest(text=new_text_delta)
                    response = await self.llm_processor.generate_svg(request)
                    generation_mode = "new_topic"
                    self.last_svg_context = new_text_delta
                    self.last_svg_code = ""  # clear previous svg for new topic
            else:
                # no previous visualization - create initial one
                logger.info(f"generating initial svg for: {current_text[:50]}...")
                request = SVGGenerationRequest(text=current_text)
                response = await self.llm_processor.generate_svg(request)
                generation_mode = "initial"
                self.last_svg_context = current_text

            # update tracking for next comparison
            self.last_svg_text = new_text_delta
            self.last_text_length = len(current_text)
            # store the raw svg code for use in future enhancements
            self.last_svg_code = response.svg_code

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

            # send to client with full text and similarity info
            await self.send_message_safe(
                WebSocketMessage(
                    type=MessageType.SVG_GENERATED,
                    data={
                        "svg": animated_svg,
                        "description": response.description,
                        "original_text": response.original_text,
                        "new_text_delta": new_text_delta,  # the new text being compared
                        "generation_mode": generation_mode,
                        "similarity_score": round(similarity_score, 3) if similarity_score is not None else None,
                        "similarity_threshold": self.similarity_threshold,
                    },
                ),
            )
            logger.info(f"svg generated and sent (mode: {generation_mode}, similarity: {similarity_score})")

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
