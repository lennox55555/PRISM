"""
speech to text service module.
handles real-time audio transcription using various providers.
supports openai whisper, google speech-to-text, and deepgram.
this module is designed to be provider-agnostic with a common interface.
"""

import io
import logging
from abc import ABC, abstractmethod
from typing import AsyncGenerator, Optional

from app.config import get_settings
from app.models.schemas import TranscriptionResult

logger = logging.getLogger(__name__)
settings = get_settings()


class BaseSpeechToText(ABC):
    """
    abstract base class for speech-to-text providers.
    all providers must implement these methods to ensure
    consistent behavior across different transcription services.
    """

    @abstractmethod
    async def transcribe_chunk(self, audio_data: bytes) -> TranscriptionResult:
        """
        transcribe a single chunk of audio data.
        used for real-time streaming transcription.

        args:
            audio_data: raw audio bytes in pcm format

        returns:
            transcription result with text and metadata
        """
        pass

    @abstractmethod
    async def transcribe_stream(
        self, audio_stream: AsyncGenerator[bytes, None]
    ) -> AsyncGenerator[TranscriptionResult, None]:
        """
        transcribe a continuous stream of audio data.
        yields partial results as they become available.

        args:
            audio_stream: async generator yielding audio chunks

        yields:
            transcription results as they are processed
        """
        pass

    @abstractmethod
    async def transcribe_file(self, audio_file: bytes) -> TranscriptionResult:
        """
        transcribe a complete audio file.
        used for batch processing or when full audio is available.

        args:
            audio_file: complete audio file bytes

        returns:
            final transcription result
        """
        pass


class OpenAIWhisperService(BaseSpeechToText):
    """
    openai whisper implementation for speech-to-text.
    uses the openai api for transcription which provides
    high accuracy across multiple languages.
    """

    def __init__(self):
        """
        initialize the openai whisper service.
        sets up the openai client with api key from settings.
        """
        try:
            from openai import AsyncOpenAI

            self.client = AsyncOpenAI(api_key=settings.openai_api_key)
            self.model = "whisper-1"
        except ImportError:
            logger.warning("openai package not installed, whisper service unavailable")
            self.client = None

        # buffer for accumulating audio chunks for batch processing
        self.audio_buffer = io.BytesIO()

    async def transcribe_chunk(self, audio_data: bytes) -> TranscriptionResult:
        """
        transcribe a chunk of audio using whisper api.
        note: whisper api works best with complete utterances,
        so this method buffers audio and transcribes when sufficient data is available.
        """
        if not self.client:
            return TranscriptionResult(text="", is_final=False)

        # add chunk to buffer
        self.audio_buffer.write(audio_data)

        # check if we have enough data to transcribe (at least 0.5 seconds at 16khz)
        min_bytes = settings.sample_rate * 2 * 0.5  # 16-bit audio = 2 bytes per sample
        if self.audio_buffer.tell() < min_bytes:
            return TranscriptionResult(text="", is_final=False)

        # transcribe buffered audio
        return await self._transcribe_buffer()

    async def _transcribe_buffer(self) -> TranscriptionResult:
        """
        internal method to transcribe the current audio buffer.
        resets the buffer after transcription.
        """
        self.audio_buffer.seek(0)
        audio_bytes = self.audio_buffer.read()
        self.audio_buffer = io.BytesIO()  # reset buffer

        return await self.transcribe_file(audio_bytes)

    async def transcribe_stream(
        self, audio_stream: AsyncGenerator[bytes, None]
    ) -> AsyncGenerator[TranscriptionResult, None]:
        """
        transcribe streaming audio by accumulating chunks.
        whisper doesn't support true streaming, so we batch chunks
        and transcribe periodically for pseudo-real-time results.
        """
        async for chunk in audio_stream:
            result = await self.transcribe_chunk(chunk)
            if result.text:
                yield result

        # transcribe any remaining buffered audio
        if self.audio_buffer.tell() > 0:
            final_result = await self._transcribe_buffer()
            final_result.is_final = True
            yield final_result

    async def transcribe_file(self, audio_file: bytes) -> TranscriptionResult:
        """
        transcribe a complete audio file using whisper api.
        the audio is sent as a file to the openai api.
        supports webm, wav, mp3, and other common formats.
        """
        if not self.client:
            return TranscriptionResult(
                text="[whisper service not configured]", is_final=True
            )

        try:
            # detect audio format from magic bytes
            # webm starts with 0x1A45DFA3, wav starts with RIFF
            filename = "audio.webm"  # default to webm since that's what browser sends
            if audio_file[:4] == b"RIFF":
                filename = "audio.wav"
            elif audio_file[:3] == b"ID3" or audio_file[:2] == b"\xff\xfb":
                filename = "audio.mp3"

            # create a file-like object for the api
            audio_io = io.BytesIO(audio_file)
            audio_io.name = filename

            response = await self.client.audio.transcriptions.create(
                model=self.model,
                file=audio_io,
                response_format="json",
                language="en",  # Force English transcription
            )

            return TranscriptionResult(
                text=response.text,
                is_final=True,
                language=getattr(response, "language", None),
            )

        except Exception as e:
            logger.error(f"whisper transcription error: {e}")
            return TranscriptionResult(text="", is_final=True)


class MockSpeechToText(BaseSpeechToText):
    """
    mock implementation for testing and development.
    returns predefined responses without actual transcription.
    useful for frontend development without api costs.
    """

    async def transcribe_chunk(self, audio_data: bytes) -> TranscriptionResult:
        """return mock partial transcription."""
        return TranscriptionResult(
            text="processing audio...",
            is_final=False,
            confidence=0.95,
        )

    async def transcribe_stream(
        self, audio_stream: AsyncGenerator[bytes, None]
    ) -> AsyncGenerator[TranscriptionResult, None]:
        """yield mock transcription results."""
        chunk_count = 0
        async for _ in audio_stream:
            chunk_count += 1
            if chunk_count % 10 == 0:
                yield TranscriptionResult(
                    text=f"transcribed chunk {chunk_count}",
                    is_final=False,
                )

        yield TranscriptionResult(
            text="mock transcription complete",
            is_final=True,
        )

    async def transcribe_file(self, audio_file: bytes) -> TranscriptionResult:
        """return mock file transcription."""
        return TranscriptionResult(
            text="this is a mock transcription of the audio file",
            is_final=True,
            confidence=0.99,
        )


class SpeechToTextService:
    """
    main speech-to-text service that delegates to the configured provider.
    acts as a factory and facade for different stt implementations.
    the provider is selected based on the stt_provider setting.
    """

    def __init__(self, provider: Optional[str] = None):
        """
        initialize the speech-to-text service with the specified provider.

        args:
            provider: provider name, defaults to settings.stt_provider
        """
        provider = provider or settings.stt_provider
        self.provider = self._get_provider(provider)

    def _get_provider(self, provider_name: str) -> BaseSpeechToText:
        """
        factory method to instantiate the appropriate provider.

        args:
            provider_name: name of the provider to use

        returns:
            instance of the speech-to-text provider
        """
        providers = {
            "openai_whisper": OpenAIWhisperService,
            "mock": MockSpeechToText,
            # add more providers here as needed:
            # "google": GoogleSpeechToText,
            # "deepgram": DeepgramSpeechToText,
        }

        provider_class = providers.get(provider_name, MockSpeechToText)
        logger.info(f"initializing speech-to-text provider: {provider_name}")
        return provider_class()

    async def transcribe_chunk(self, audio_data: bytes) -> TranscriptionResult:
        """delegate chunk transcription to the configured provider."""
        return await self.provider.transcribe_chunk(audio_data)

    async def transcribe_stream(
        self, audio_stream: AsyncGenerator[bytes, None]
    ) -> AsyncGenerator[TranscriptionResult, None]:
        """delegate stream transcription to the configured provider."""
        async for result in self.provider.transcribe_stream(audio_stream):
            yield result

    async def transcribe_file(self, audio_file: bytes) -> TranscriptionResult:
        """delegate file transcription to the configured provider."""
        return await self.provider.transcribe_file(audio_file)

    def reset(self):
        """
        reset the provider state.
        useful for clearing buffers between recording sessions.
        """
        if hasattr(self.provider, "audio_buffer"):
            self.provider.audio_buffer = io.BytesIO()
