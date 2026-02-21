/**
 * audio recorder component.
 * provides the main interface for starting and stopping voice recording.
 * displays recording state and audio level visualization.
 * this is the primary interaction point for users.
 */

import { useCallback, useEffect } from 'react';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { useWebSocket } from '../hooks/useWebSocket';
import {
  AudioRecorderProps,
  RecordingState,
  TranscriptionResult,
  SVGGenerationResponse,
} from '../types';

// styles for the component - your team can replace with proper styling
const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: '1rem',
    padding: '2rem',
  },
  button: {
    padding: '1rem 2rem',
    fontSize: '1.25rem',
    fontWeight: 'bold' as const,
    border: 'none',
    borderRadius: '0.5rem',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    minWidth: '200px',
  },
  recordButton: {
    backgroundColor: '#ef4444',
    color: 'white',
  },
  recordingButton: {
    backgroundColor: '#dc2626',
    color: 'white',
    animation: 'pulse 1.5s infinite',
  },
  disabledButton: {
    backgroundColor: '#9ca3af',
    color: 'white',
    cursor: 'not-allowed',
  },
  status: {
    fontSize: '0.875rem',
    color: '#6b7280',
  },
  levelMeter: {
    width: '200px',
    height: '8px',
    backgroundColor: '#e5e7eb',
    borderRadius: '4px',
    overflow: 'hidden',
  },
  levelFill: {
    height: '100%',
    backgroundColor: '#10b981',
    transition: 'width 0.1s ease',
  },
  connectionStatus: {
    fontSize: '0.75rem',
    padding: '0.25rem 0.5rem',
    borderRadius: '9999px',
  },
  connected: {
    backgroundColor: '#d1fae5',
    color: '#059669',
  },
  disconnected: {
    backgroundColor: '#fee2e2',
    color: '#dc2626',
  },
};

export function AudioRecorder({
  onTranscription,
  onSVGGenerated,
  onError,
  onRecordingStateChange,
}: AudioRecorderProps) {
  // websocket connection for real-time communication
  const {
    connectionState,
    startRecording: wsStartRecording,
    stopRecording: wsStopRecording,
    sendAudioChunk,
  } = useWebSocket({
    onTranscription: (result: TranscriptionResult) => {
      onTranscription?.(result);
    },
    onSVGGenerated: (response: SVGGenerationResponse) => {
      onSVGGenerated?.(response);
    },
    onError: (error: string) => {
      onError?.(error);
    },
  });

  // audio recorder for capturing microphone input
  const {
    recordingState,
    startRecording: micStartRecording,
    stopRecording: micStopRecording,
    audioLevel,
  } = useAudioRecorder({
    onAudioData: (audioBase64: string) => {
      // send audio chunk to websocket
      sendAudioChunk(audioBase64);
    },
    onError: (error: string) => {
      onError?.(error);
    },
  });

  // notify parent of recording state changes
  useEffect(() => {
    onRecordingStateChange?.(recordingState);
  }, [recordingState, onRecordingStateChange]);

  // handle record button click
  const handleRecordClick = useCallback(async () => {
    if (recordingState === 'recording') {
      // stop recording
      micStopRecording();
      wsStopRecording();
    } else if (recordingState === 'idle') {
      // start recording
      wsStartRecording();
      await micStartRecording();
    }
  }, [
    recordingState,
    micStartRecording,
    micStopRecording,
    wsStartRecording,
    wsStopRecording,
  ]);

  // determine button state and text
  const getButtonConfig = (state: RecordingState) => {
    switch (state) {
      case 'recording':
        return {
          text: 'Stop Recording',
          style: { ...styles.button, ...styles.recordingButton },
          disabled: false,
        };
      case 'processing':
        return {
          text: 'Processing...',
          style: { ...styles.button, ...styles.disabledButton },
          disabled: true,
        };
      case 'error':
        return {
          text: 'Error - Try Again',
          style: { ...styles.button, ...styles.recordButton },
          disabled: false,
        };
      default:
        return {
          text: 'Start Recording',
          style: { ...styles.button, ...styles.recordButton },
          disabled: connectionState !== 'connected',
        };
    }
  };

  const buttonConfig = getButtonConfig(recordingState);
  const isConnected = connectionState === 'connected';

  return (
    <div style={styles.container}>
      {/* connection status indicator */}
      <div
        style={{
          ...styles.connectionStatus,
          ...(isConnected ? styles.connected : styles.disconnected),
        }}
      >
        {isConnected ? 'Connected' : 'Disconnected'}
      </div>

      {/* main record button */}
      <button
        onClick={handleRecordClick}
        style={buttonConfig.style}
        disabled={buttonConfig.disabled}
        aria-label={
          recordingState === 'recording' ? 'stop recording' : 'start recording'
        }
      >
        {buttonConfig.text}
      </button>

      {/* audio level meter - visible when recording */}
      {recordingState === 'recording' && (
        <div style={styles.levelMeter}>
          <div
            style={{
              ...styles.levelFill,
              width: `${audioLevel * 100}%`,
            }}
          />
        </div>
      )}

      {/* status text */}
      <p style={styles.status}>
        {recordingState === 'recording'
          ? 'listening...'
          : recordingState === 'processing'
          ? 'processing your speech...'
          : 'click to start recording'}
      </p>
    </div>
  );
}
