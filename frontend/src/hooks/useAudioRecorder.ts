/**
 * custom hook for audio recording functionality.
 * captures raw pcm audio using web audio api for reliable transcription.
 * designed to work with the websocket hook for real-time streaming.
 */

import { useCallback, useRef, useState } from 'react';
import { RecordingState } from '../types';

interface UseAudioRecorderOptions {
  // callback when new audio data is available (base64 encoded wav)
  onAudioData?: (audioBase64: string) => void;
  // callback when recording state changes
  onStateChange?: (state: RecordingState) => void;
  // callback when an error occurs
  onError?: (error: string) => void;
  // interval for sending audio chunks in ms
  chunkInterval?: number;
}

interface UseAudioRecorderReturn {
  // current recording state
  recordingState: RecordingState;
  // start recording audio
  startRecording: () => Promise<void>;
  // stop recording audio
  stopRecording: () => void;
  // check if microphone is available
  checkMicrophoneAccess: () => Promise<boolean>;
  // current audio level (0-1) for visualization
  audioLevel: number;
}

/**
 * convert float32 audio samples to 16-bit pcm
 */
function floatTo16BitPCM(float32Array: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/**
 * create a wav file from pcm data
 */
function createWavFile(pcmData: ArrayBuffer, sampleRate: number): ArrayBuffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.byteLength;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // riff header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // audio format (pcm)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // copy pcm data
  const pcmView = new Uint8Array(pcmData);
  const wavView = new Uint8Array(buffer);
  wavView.set(pcmView, headerSize);

  return buffer;
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * convert arraybuffer to base64
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function useAudioRecorder(
  options: UseAudioRecorderOptions = {}
): UseAudioRecorderReturn {
  const {
    onAudioData,
    onStateChange,
    onError,
    chunkInterval = 3000, // send chunks every 3 seconds to match backend
  } = options;

  // state
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [audioLevel, setAudioLevel] = useState(0);

  // refs for recording resources
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const animationFrameRef = useRef<number>();
  const audioBufferRef = useRef<Float32Array[]>([]);
  const chunkIntervalRef = useRef<ReturnType<typeof setInterval>>();
  const isRecordingRef = useRef(false);

  // update state and notify callback
  const updateState = useCallback(
    (state: RecordingState) => {
      setRecordingState(state);
      onStateChange?.(state);
    },
    [onStateChange]
  );

  // report error and update state
  const reportError = useCallback(
    (message: string) => {
      console.error('audio recorder error:', message);
      onError?.(message);
      updateState('error');
    },
    [onError, updateState]
  );

  // process and send accumulated audio
  const processAndSendAudio = useCallback(() => {
    if (audioBufferRef.current.length === 0) return;

    // combine all audio chunks
    const totalLength = audioBufferRef.current.reduce((acc, chunk) => acc + chunk.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of audioBufferRef.current) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    audioBufferRef.current = []; // clear buffer

    // skip if too short (less than 0.5 seconds)
    const sampleRate = audioContextRef.current?.sampleRate || 44100;
    if (combined.length < sampleRate * 0.5) {
      return;
    }

    // convert to 16-bit pcm then to wav
    const pcmData = floatTo16BitPCM(combined);
    const wavData = createWavFile(pcmData, sampleRate);
    const base64 = arrayBufferToBase64(wavData);

    onAudioData?.(base64);
  }, [onAudioData]);

  // update audio level visualization
  const updateAudioLevel = useCallback(() => {
    if (!analyserRef.current || !isRecordingRef.current) return;

    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(dataArray);

    // calculate average level
    const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    const level = average / 255;
    setAudioLevel(level);

    // continue animation loop while recording
    if (isRecordingRef.current) {
      animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
    }
  }, []);

  // check if microphone access is available
  const checkMicrophoneAccess = useCallback(async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      return true;
    } catch {
      return false;
    }
  }, []);

  // start recording audio
  const startRecording = useCallback(async () => {
    try {
      updateState('recording');
      isRecordingRef.current = true;
      audioBufferRef.current = [];

      // request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      // set up audio context
      audioContextRef.current = new AudioContext();
      const source = audioContextRef.current.createMediaStreamSource(stream);

      // set up analyser for level monitoring
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      source.connect(analyserRef.current);

      // set up script processor to capture raw audio
      // using 4096 buffer size for good balance between latency and performance
      const bufferSize = 4096;
      processorRef.current = audioContextRef.current.createScriptProcessor(
        bufferSize,
        1, // input channels
        1  // output channels
      );

      processorRef.current.onaudioprocess = (event) => {
        if (!isRecordingRef.current) return;

        const inputData = event.inputBuffer.getChannelData(0);
        // make a copy of the data since the buffer will be reused
        audioBufferRef.current.push(new Float32Array(inputData));
      };

      source.connect(processorRef.current);
      processorRef.current.connect(audioContextRef.current.destination);

      // start audio level animation
      animationFrameRef.current = requestAnimationFrame(updateAudioLevel);

      // set up interval to send chunks
      chunkIntervalRef.current = setInterval(processAndSendAudio, chunkInterval);

    } catch (error) {
      isRecordingRef.current = false;
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        reportError('microphone access denied');
      } else if (error instanceof DOMException && error.name === 'NotFoundError') {
        reportError('no microphone found');
      } else {
        reportError(`failed to start recording: ${error}`);
      }
    }
  }, [chunkInterval, updateState, reportError, processAndSendAudio, updateAudioLevel]);

  // stop recording audio
  const stopRecording = useCallback(() => {
    isRecordingRef.current = false;
    updateState('processing');

    // clear chunk interval
    if (chunkIntervalRef.current) {
      clearInterval(chunkIntervalRef.current);
      chunkIntervalRef.current = undefined;
    }

    // cancel animation frame
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    // send any remaining audio
    processAndSendAudio();

    // disconnect and close audio nodes
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    // stop all tracks in the media stream
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    // close audio context
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // reset audio level
    setAudioLevel(0);

    // update state after brief delay
    setTimeout(() => {
      updateState('idle');
    }, 500);
  }, [updateState, processAndSendAudio]);

  return {
    recordingState,
    startRecording,
    stopRecording,
    checkMicrophoneAccess,
    audioLevel,
  };
}
