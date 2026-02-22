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
# includes common misrecognitions from speech-to-text
ACTIVATE_WORDS = [
    "prism", "prison", "prisons", "prizm", "présume", "presume",
    "pris", "prysm", "prisim", "priszm", "preson", "presom"
]
# deactivation phrases - includes common variations
DEACTIVATE_PHRASES = [
    "thank you", "thankyou", "thanks", "thank u", "thankful",
    "thanking you", "thank ya", "thanks you", "think you"
]
# legacy single phrase for backwards compatibility
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

        # flag to notify frontend that a new session just started (for clearing text)
        self.just_started_new_session = False

        # session visualization type - "chart" or "svg", determined when generating
        self.session_visualization_type: Optional[str] = None

        # track if we've generated a visualization in this session
        # first generation = "initial", subsequent = "enhanced" (versions on same slide)
        self.has_generated_in_session = False
        # unique session ID to help frontend group all visualizations from same session
        self.visualization_session_id: Optional[str] = None

        # audio buffer for accumulating wav chunks from frontend
        self.audio_chunks: list[bytes] = []
        self.last_svg_generation_time = 0

        # background task for periodic svg generation
        self.processing_task: Optional[asyncio.Task] = None

        # grammar correction tracking
        # stores the corrected version of visualization_text
        self.corrected_visualization_text = ""
        # stores the raw text length that has already been corrected
        self.last_corrected_length = 0

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
            await self._generate_and_send_visualization(force=True)

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
        Background task that generates visualization every 4 seconds.
        Provides intermediate results while user is speaking.
        """
        try:
            while self.is_recording and self.is_connected:
                await asyncio.sleep(1)  # check every second

                current_time = time.time()

                # generate every 4 seconds if visualization is active
                if self.visualization_active:
                    if current_time - self.last_svg_generation_time >= 4:
                        if self.visualization_text.strip():
                            logger.info("[PERIODIC] Generating intermediate visualization...")
                            await self._generate_and_send_visualization()
                            self.last_svg_generation_time = current_time

        except asyncio.CancelledError:
            logger.info("periodic task cancelled")
        except Exception as e:
            logger.error(f"periodic task error: {e}")

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
                text = result.text.strip()
                lower_text_check = text.lower().strip(".,!? ")

                # IMPORTANT: Check for deactivation phrase BEFORE filtering hallucinations
                # "thank you" is a common hallucination but also our deactivation phrase
                is_deactivate_phrase = any(phrase in lower_text_check for phrase in DEACTIVATE_PHRASES)
                if self.visualization_active and is_deactivate_phrase:
                    # This is the deactivation phrase, process it normally
                    logger.info(f"detected deactivation phrase: {text}")
                else:
                    # filter out common whisper hallucinations on silence
                    # NOTE: "thank you" removed from this list - handled above
                    hallucinations = [
                        "you", "thanks for watching",
                        "subscribe", "bye", "goodbye", "the end",
                        "thanks for listening", "see you", "okay",
                        "thank you for watching", "thanks for watching",
                    ]

                    # check if the transcription is just a hallucination
                    if lower_text_check in hallucinations:
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

                    # correct grammar for new text (sentence by sentence)
                    await self._correct_new_sentences()

                # send transcription to client
                # include new_session flag to tell frontend to clear text
                new_session_flag = self.just_started_new_session
                self.just_started_new_session = False  # clear after sending

                await self.send_message_safe(
                    WebSocketMessage(
                        type=MessageType.TRANSCRIPTION_PARTIAL,
                        data={
                            "text": text,
                            "accumulated_text": self.accumulated_text,
                            "visualization_text": self._get_visualization_text_for_generation(),
                            "visualization_active": self.visualization_active,
                            "new_session": new_session_flag,
                            "is_final": False,
                        },
                    ),
                )
                if new_session_flag:
                    logger.info(f"[TRIGGER] Sent new_session=True with transcription")
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
        - "prism" activates visualization OR starts a new session if already active
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

        logger.info(f"[TRIGGER] Processing text: '{text[:100]}...' | visualization_active={self.visualization_active}")

        # check for deactivation phrase first (when visualization is active)
        # uses DEACTIVATE_PHRASES list which includes common speech-to-text variations
        # require at least 6 seconds after activation before allowing deactivation
        # this ensures at least one SVG has time to generate
        deactivate_patterns = DEACTIVATE_PHRASES
        found_deactivate = None

        time_since_activation = time.time() - self.last_svg_generation_time
        can_deactivate = time_since_activation >= 6  # minimum 6 seconds before deactivation

        logger.info(f"[TRIGGER] Time since last generation: {time_since_activation:.1f}s | can_deactivate={can_deactivate}")

        if can_deactivate:
            for pattern in deactivate_patterns:
                if pattern in lower_text:
                    found_deactivate = pattern
                    logger.info(f"[TRIGGER] Found deactivation phrase: '{pattern}'")
                    break

        if self.visualization_active and found_deactivate:
            logger.info(f"[TRIGGER] >>> VISUALIZATION STOPPING (phrase: {found_deactivate}, after {time_since_activation:.1f}s)")

            # IMPORTANT: Generate final visualization BEFORE deactivating
            # This ensures we always produce output even if periodic generation hasn't fired yet
            if self.visualization_text.strip():
                logger.info(f"[TRIGGER] Generating FINAL visualization before deactivation...")
                await self._generate_and_send_visualization(force=True)
                logger.info(f"[TRIGGER] Final visualization generated successfully")

            self.visualization_active = False
            self.just_activated = False
            # Clear visualization text after final generation
            self.visualization_text = ""
            logger.info(f"[TRIGGER] >>> VISUALIZATION STOPPED")

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

            # don't return any text - we don't want to add anything after deactivation
            return ""

        # check for activation words
        # NOW: Also trigger new session if prism is said while already active!
        found_activate = None
        for activate_word in ACTIVATE_WORDS:
            if activate_word in lower_text:
                found_activate = activate_word
                break

        if found_activate:
            was_active = self.visualization_active
            self.visualization_active = True

            # clear for fresh start
            self.visualization_text = ""
            self.last_svg_generation_time = time.time()

            # reset grammar correction tracking
            self.corrected_visualization_text = ""
            self.last_corrected_length = 0

            # reset visualization type - will be determined on generation
            self.session_visualization_type = None
            # reset generation tracking - first generation will be "initial", rest will be "enhanced"
            self.has_generated_in_session = False
            # create unique session ID for this prism->thank you session
            # all visualizations in this session will share this ID for grouping
            self.visualization_session_id = f"session_{int(time.time() * 1000)}"
            # flag to tell frontend to clear text
            self.just_started_new_session = True

            logger.info(f"[TRIGGER] >>> VISUALIZATION STARTED (trigger: {found_activate}, was_active={was_active})")

            # send status update to client
            await self.send_message_safe(
                WebSocketMessage(
                    type=MessageType.STATUS,
                    data={
                        "status": "visualization_toggled",
                        "visualization_active": self.visualization_active,
                        "new_session": True,  # signal that this is a new session
                    },
                ),
            )

            # return text after the trigger word (use "prism" for splitting since prison->prism)
            parts = re.split(r'\bprism\b', lower_text, flags=re.IGNORECASE)
            if len(parts) > 1:
                after_prism = parts[1].strip()
                logger.info(f"[TRIGGER] Text after prism: '{after_prism[:50]}...'")
                return after_prism
            return ""

        # no trigger word found, return original text (with prison->prism replacement)
        logger.info(f"[TRIGGER] No trigger found, returning text as-is")
        return text

    async def _correct_new_sentences(self):
        """
        correct grammar for new sentences that haven't been corrected yet.
        works incrementally - only corrects text added since last correction.
        """
        raw_text = self.visualization_text

        # find text that hasn't been corrected yet
        new_text = raw_text[self.last_corrected_length:].strip()

        if not new_text:
            return

        # check if we have complete sentences (ends with . ! or ?)
        # we only correct complete sentences to avoid partial corrections
        sentence_endings = ['.', '!', '?']
        last_ending_pos = -1

        for ending in sentence_endings:
            pos = new_text.rfind(ending)
            if pos > last_ending_pos:
                last_ending_pos = pos

        if last_ending_pos == -1:
            # no complete sentences yet, wait for more text
            return

        # extract complete sentences to correct
        text_to_correct = new_text[:last_ending_pos + 1].strip()

        if not text_to_correct:
            return

        try:
            # correct the grammar
            corrected = await self.llm_processor.correct_grammar(text_to_correct)

            # append corrected text to our corrected buffer
            if self.corrected_visualization_text:
                self.corrected_visualization_text += " " + corrected
            else:
                self.corrected_visualization_text = corrected

            self.corrected_visualization_text = self.corrected_visualization_text.strip()

            # update the marker for what we've corrected
            self.last_corrected_length = len(raw_text[:self.last_corrected_length]) + last_ending_pos + 1

            logger.info(f"grammar corrected: '{text_to_correct[:50]}...' -> '{corrected[:50]}...'")

        except Exception as e:
            logger.error(f"grammar correction failed: {e}")
            # on error, just use the raw text
            if self.corrected_visualization_text:
                self.corrected_visualization_text += " " + text_to_correct
            else:
                self.corrected_visualization_text = text_to_correct

    def _get_visualization_text_for_generation(self) -> str:
        """
        get the text to use for visualization generation.
        uses corrected text when available, falls back to raw text.
        """
        # combine corrected text with any remaining uncorrected text
        raw_text = self.visualization_text
        uncorrected_portion = raw_text[self.last_corrected_length:].strip()

        if self.corrected_visualization_text:
            if uncorrected_portion:
                return f"{self.corrected_visualization_text} {uncorrected_portion}"
            return self.corrected_visualization_text

        return raw_text

    async def _generate_and_send_visualization(self, force: bool = False):
        """
        Generate ONE visualization from all accumulated text.
        Called only when user says 'thank you' to end the session.
        Each prism->thank you session = one visualization.
        """
        # use grammar-corrected text when available
        current_text = self._get_visualization_text_for_generation().strip()
        if not current_text or not self.is_connected:
            logger.info("No text to visualize or not connected")
            return

        try:
            logger.info(f"[VIZ] Generating visualization for: '{current_text[:100]}...'")

            # detect if this should be a chart or SVG
            is_chart, chart_confidence = await self.chart_generator.is_chart_request(current_text)

            if is_chart:
                logger.info(f"[VIZ] Generating CHART (confidence: {chart_confidence:.2f})")
                await self._generate_and_send_chart(current_text, chart_confidence)
            else:
                logger.info(f"[VIZ] Generating SVG")
                await self._generate_and_send_svg(current_text)

        except Exception as e:
            logger.error(f"visualization generation error: {e}")
            error_svg = self.svg_generator.create_error_svg(str(e))
            await self.send_message_safe(
                WebSocketMessage(
                    type=MessageType.SVG_GENERATED,
                    data={"svg": error_svg, "error": str(e)},
                ),
            )

    async def _generate_and_send_chart(self, text: str, confidence: float):
        """
        Generate a matplotlib chart visualization.
        First generation = "chart" (new slide)
        Subsequent generations = "enhanced" (version on same slide)

        args:
            text: the full text to visualize
            confidence: confidence that this is a chart request
        """
        # determine generation mode
        generation_mode = "chart" if not self.has_generated_in_session else "enhanced"
        logger.info(f"[CHART] Generating chart (mode: {generation_mode}) for: '{text[:50]}...'")

        result = await self.chart_generator.generate_chart(text)

        if result["error"]:
            logger.error(f"chart generation failed: {result['error']}")
            # fall back to svg generation
            await self._generate_and_send_svg(text)
            return

        # mark that we've generated in this session
        self.has_generated_in_session = True

        # send chart to client
        await self.send_message_safe(
            WebSocketMessage(
                type=MessageType.CHART_GENERATED,
                data={
                    "image": result["image"],  # base64 png
                    "code": result["code"],  # matplotlib code
                    "description": result["description"],
                    "original_text": text,
                    "generation_mode": generation_mode,
                    "session_id": self.visualization_session_id,
                    "chart_confidence": round(confidence, 3),
                },
            ),
        )
        logger.info(f"[CHART] Chart generated and sent (mode: {generation_mode})")

    async def _generate_and_send_svg(self, text: str):
        """
        Generate SVG visualization from the text.
        First generation = "initial" (new slide)
        Subsequent generations in same session = "enhanced" (version on same slide)

        args:
            text: the full text to visualize
        """
        try:
            # determine generation mode based on whether we've already generated in this session
            generation_mode = "initial" if not self.has_generated_in_session else "enhanced"
            logger.info(f"[SVG] Generating SVG (mode: {generation_mode}) for: '{text[:80]}...'")

            # generate SVG
            request = SVGGenerationRequest(text=text)
            response = await self.llm_processor.generate_svg(request)

            # mark that we've generated in this session
            self.has_generated_in_session = True

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
                        "original_text": text,
                        "generation_mode": generation_mode,
                        "session_id": self.visualization_session_id,
                    },
                ),
            )
            logger.info(f"[SVG] SVG generated and sent successfully")

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
