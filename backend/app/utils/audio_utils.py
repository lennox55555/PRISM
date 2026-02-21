"""
audio utility functions and classes.
handles audio format conversion, validation, and processing
for use with speech-to-text services.
"""

import io
import struct
import logging
from enum import Enum
from typing import Optional

logger = logging.getLogger(__name__)


class AudioFormat(Enum):
    """supported audio formats for processing."""

    PCM_S16LE = "pcm_s16le"  # signed 16-bit little-endian pcm
    WAV = "wav"
    WEBM = "webm"
    OGG = "ogg"


class AudioProcessor:
    """
    utility class for audio processing operations.
    handles format conversion, validation, and audio chunk processing
    for real-time transcription workflows.
    """

    def __init__(
        self,
        sample_rate: int = 16000,
        channels: int = 1,
        bits_per_sample: int = 16,
    ):
        """
        initialize the audio processor with audio parameters.

        args:
            sample_rate: audio sample rate in hz (default 16000 for speech)
            channels: number of audio channels (1 for mono, 2 for stereo)
            bits_per_sample: bit depth of audio samples (default 16)
        """
        self.sample_rate = sample_rate
        self.channels = channels
        self.bits_per_sample = bits_per_sample
        self.bytes_per_sample = bits_per_sample // 8

    def create_wav_header(self, data_size: int) -> bytes:
        """
        create a wav file header for raw pcm data.
        constructs a valid wav header that can be prepended to pcm audio.

        args:
            data_size: size of the audio data in bytes

        returns:
            44-byte wav header
        """
        byte_rate = self.sample_rate * self.channels * self.bytes_per_sample
        block_align = self.channels * self.bytes_per_sample

        # wav file structure:
        # - riff chunk descriptor (12 bytes)
        # - fmt sub-chunk (24 bytes)
        # - data sub-chunk header (8 bytes)
        # total: 44 bytes

        header = struct.pack(
            "<4sI4s4sIHHIIHH4sI",
            b"RIFF",  # chunk id
            36 + data_size,  # chunk size
            b"WAVE",  # format
            b"fmt ",  # subchunk1 id
            16,  # subchunk1 size (16 for pcm)
            1,  # audio format (1 = pcm)
            self.channels,  # number of channels
            self.sample_rate,  # sample rate
            byte_rate,  # byte rate
            block_align,  # block align
            self.bits_per_sample,  # bits per sample
            b"data",  # subchunk2 id
            data_size,  # subchunk2 size
        )

        return header

    def pcm_to_wav(self, pcm_data: bytes) -> bytes:
        """
        convert raw pcm audio data to wav format.
        adds a proper wav header to the pcm data.

        args:
            pcm_data: raw pcm audio bytes

        returns:
            wav formatted audio bytes
        """
        header = self.create_wav_header(len(pcm_data))
        return header + pcm_data

    def validate_audio_chunk(self, chunk: bytes) -> bool:
        """
        validate that an audio chunk is properly formatted.
        checks for expected byte alignment and reasonable size.

        args:
            chunk: audio data chunk to validate

        returns:
            true if valid, false otherwise
        """
        if not chunk:
            return False

        # check byte alignment for 16-bit samples
        if len(chunk) % self.bytes_per_sample != 0:
            logger.warning(f"audio chunk not aligned to sample size: {len(chunk)} bytes")
            return False

        return True

    def calculate_duration(self, audio_bytes: bytes) -> float:
        """
        calculate the duration of audio data in seconds.

        args:
            audio_bytes: audio data bytes

        returns:
            duration in seconds
        """
        bytes_per_second = self.sample_rate * self.channels * self.bytes_per_sample
        return len(audio_bytes) / bytes_per_second

    def resample(
        self, audio_data: bytes, target_sample_rate: int
    ) -> bytes:
        """
        resample audio data to a different sample rate.
        uses simple linear interpolation for resampling.
        note: for production use, consider using a proper audio library.

        args:
            audio_data: input audio bytes
            target_sample_rate: desired sample rate

        returns:
            resampled audio bytes
        """
        if target_sample_rate == self.sample_rate:
            return audio_data

        # convert bytes to samples
        num_samples = len(audio_data) // self.bytes_per_sample
        samples = struct.unpack(f"<{num_samples}h", audio_data)

        # calculate resampling ratio
        ratio = target_sample_rate / self.sample_rate
        new_num_samples = int(num_samples * ratio)

        # simple linear interpolation resampling
        resampled = []
        for i in range(new_num_samples):
            # find corresponding position in original samples
            pos = i / ratio
            idx = int(pos)
            frac = pos - idx

            if idx + 1 < num_samples:
                # interpolate between two samples
                sample = int(samples[idx] * (1 - frac) + samples[idx + 1] * frac)
            else:
                sample = samples[idx] if idx < num_samples else 0

            resampled.append(sample)

        # convert back to bytes
        return struct.pack(f"<{len(resampled)}h", *resampled)

    def normalize_audio(
        self, audio_data: bytes, target_level: float = 0.9
    ) -> bytes:
        """
        normalize audio levels to a target maximum amplitude.
        scales all samples so the peak reaches the target level.

        args:
            audio_data: input audio bytes
            target_level: target peak amplitude (0.0 to 1.0)

        returns:
            normalized audio bytes
        """
        # convert bytes to samples
        num_samples = len(audio_data) // self.bytes_per_sample
        samples = list(struct.unpack(f"<{num_samples}h", audio_data))

        # find peak amplitude
        max_amplitude = max(abs(min(samples)), abs(max(samples)))

        if max_amplitude == 0:
            return audio_data

        # calculate scaling factor
        max_possible = 32767  # max value for 16-bit signed
        target_amplitude = max_possible * target_level
        scale = target_amplitude / max_amplitude

        # scale samples
        normalized = [int(sample * scale) for sample in samples]

        # clamp values to prevent overflow
        normalized = [max(-32768, min(32767, s)) for s in normalized]

        return struct.pack(f"<{len(normalized)}h", *normalized)

    def detect_silence(
        self,
        audio_data: bytes,
        threshold: int = 500,
        min_duration: float = 0.5,
    ) -> bool:
        """
        detect if audio chunk is primarily silence.
        used for voice activity detection to avoid processing empty audio.

        args:
            audio_data: audio data to analyze
            threshold: amplitude threshold below which is considered silence
            min_duration: minimum duration in seconds to consider

        returns:
            true if audio appears to be silence
        """
        if self.calculate_duration(audio_data) < min_duration:
            return False

        # convert bytes to samples
        num_samples = len(audio_data) // self.bytes_per_sample
        samples = struct.unpack(f"<{num_samples}h", audio_data)

        # calculate rms amplitude
        rms = (sum(s ** 2 for s in samples) / num_samples) ** 0.5

        return rms < threshold


class AudioChunkAccumulator:
    """
    accumulates audio chunks until a minimum duration is reached.
    useful for batching audio for apis that work better with longer segments.
    """

    def __init__(
        self,
        min_duration: float = 0.5,
        sample_rate: int = 16000,
        bytes_per_sample: int = 2,
    ):
        """
        initialize the accumulator.

        args:
            min_duration: minimum duration in seconds before yielding
            sample_rate: audio sample rate
            bytes_per_sample: bytes per audio sample
        """
        self.min_duration = min_duration
        self.sample_rate = sample_rate
        self.bytes_per_sample = bytes_per_sample
        self.buffer = io.BytesIO()

        # calculate minimum bytes needed
        self.min_bytes = int(min_duration * sample_rate * bytes_per_sample)

    def add_chunk(self, chunk: bytes) -> Optional[bytes]:
        """
        add a chunk to the buffer.
        returns accumulated audio if minimum duration is reached.

        args:
            chunk: audio chunk to add

        returns:
            accumulated audio bytes if ready, none otherwise
        """
        self.buffer.write(chunk)

        if self.buffer.tell() >= self.min_bytes:
            return self.flush()

        return None

    def flush(self) -> bytes:
        """
        flush all accumulated audio from the buffer.
        returns the accumulated data and resets the buffer.

        returns:
            all accumulated audio bytes
        """
        self.buffer.seek(0)
        data = self.buffer.read()
        self.buffer = io.BytesIO()
        return data

    def reset(self):
        """clear the buffer without returning data."""
        self.buffer = io.BytesIO()
