/**
 * audio recorder component.
 * provides the main interface for starting and stopping voice recording.
 * displays recording state and audio level visualization.
 * features a modern design with animated waveform.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { useWebSocket } from '../hooks/useWebSocket';
import {
  AudioRecorderProps,
  RecordingState,
  TranscriptionResult,
  SVGGenerationResponse,
  ChartGenerationResponse,
} from '../types';

// modern styles with dark theme
const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 'var(--spacing-lg)',
    padding: 'var(--spacing-xl)',
  },
  buttonWrapper: {
    position: 'relative' as const,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // outer glow ring that pulses when recording
  glowRing: {
    position: 'absolute' as const,
    width: '120px',
    height: '120px',
    borderRadius: '50%',
    background: 'var(--gradient-primary)',
    opacity: 0.2,
    animation: 'ripple 2s ease-out infinite',
  },
  button: {
    position: 'relative' as const,
    width: '100px',
    height: '100px',
    borderRadius: '50%',
    border: 'none',
    cursor: 'pointer',
    transition: 'all var(--transition-normal)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: 'var(--shadow-lg)',
    zIndex: 1,
  },
  idleButton: {
    background: 'var(--gradient-primary)',
  },
  recordingButton: {
    background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
    animation: 'glow 2s ease-in-out infinite',
  },
  disabledButton: {
    background: 'var(--color-bg-elevated)',
    cursor: 'not-allowed',
    boxShadow: 'none',
  },
  buttonIcon: {
    width: '32px',
    height: '32px',
    color: 'white',
  },
  stopIcon: {
    width: '28px',
    height: '28px',
    backgroundColor: 'white',
    borderRadius: 'var(--radius-sm)',
  },
  status: {
    fontSize: '0.875rem',
    color: 'var(--color-text-secondary)',
    fontWeight: '500' as const,
  },
  // audio level visualization
  levelContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    height: '40px',
    padding: '0 var(--spacing-md)',
  },
  levelBar: {
    width: '4px',
    backgroundColor: 'var(--color-primary)',
    borderRadius: 'var(--radius-full)',
    transition: 'height 0.1s ease',
  },
  connectionBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--spacing-xs)',
    fontSize: '0.75rem',
    fontWeight: '500' as const,
    padding: 'var(--spacing-xs) var(--spacing-sm)',
    borderRadius: 'var(--radius-full)',
    transition: 'var(--transition-fast)',
  },
  connected: {
    backgroundColor: 'var(--color-success-bg)',
    color: 'var(--color-success)',
    border: '1px solid rgba(16, 185, 129, 0.3)',
  },
  disconnected: {
    backgroundColor: 'var(--color-error-bg)',
    color: 'var(--color-error)',
    border: '1px solid rgba(239, 68, 68, 0.3)',
  },
  connectionDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
  },
};

// microphone icon component
const MicrophoneIcon = () => (
  <svg style={styles.buttonIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </svg>
);

export function AudioRecorder({
  onTranscription,
  onSVGGenerated,
  onChartGenerated,
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
    onChartGenerated: (response: ChartGenerationResponse) => {
      onChartGenerated?.(response);
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
  // use a ref to store the callback to avoid re-running effect when callback reference changes
  const onRecordingStateChangeRef = useRef(onRecordingStateChange);
  useEffect(() => {
    onRecordingStateChangeRef.current = onRecordingStateChange;
  }, [onRecordingStateChange]);

  useEffect(() => {
    onRecordingStateChangeRef.current?.(recordingState);
  }, [recordingState]);

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

  // determine button state
  const getButtonStyle = (state: RecordingState) => {
    switch (state) {
      case 'recording':
        return { ...styles.button, ...styles.recordingButton };
      case 'processing':
        return { ...styles.button, ...styles.disabledButton };
      default:
        return { ...styles.button, ...styles.idleButton };
    }
  };

  // generate audio level bars for visualization
  const renderLevelBars = () => {
    const barCount = 12;
    const bars = [];
    for (let i = 0; i < barCount; i++) {
      // create varied heights based on audio level with some randomness
      const baseHeight = audioLevel * 100;
      const variance = Math.sin(Date.now() / 100 + i) * 20;
      const height = Math.max(10, Math.min(100, baseHeight + variance));

      bars.push(
        <div
          key={i}
          style={{
            ...styles.levelBar,
            height: `${height}%`,
            opacity: 0.4 + (audioLevel * 0.6),
          }}
        />
      );
    }
    return bars;
  };

  const isConnected = connectionState === 'connected';
  const isRecording = recordingState === 'recording';
  const isDisabled = recordingState === 'processing' || !isConnected;

  return (
    <div style={styles.container}>
      {/* connection status badge */}
      <div
        style={{
          ...styles.connectionBadge,
          ...(isConnected ? styles.connected : styles.disconnected),
        }}
      >
        <span
          style={{
            ...styles.connectionDot,
            backgroundColor: isConnected ? 'var(--color-success)' : 'var(--color-error)',
          }}
        />
        {isConnected ? 'connected' : 'disconnected'}
      </div>

      {/* main record button with glow effect */}
      <div style={styles.buttonWrapper}>
        {isRecording && <div style={styles.glowRing} />}
        <button
          onClick={handleRecordClick}
          style={getButtonStyle(recordingState)}
          disabled={isDisabled}
          aria-label={isRecording ? 'stop recording' : 'start recording'}
        >
          {isRecording ? (
            <div style={styles.stopIcon} />
          ) : (
            <MicrophoneIcon />
          )}
        </button>
      </div>

      {/* audio level visualization - visible when recording */}
      {isRecording && (
        <div style={styles.levelContainer}>
          {renderLevelBars()}
        </div>
      )}

      {/* status text */}
      <p style={styles.status}>
        {recordingState === 'recording'
          ? 'listening...'
          : recordingState === 'processing'
          ? 'processing your speech...'
          : 'tap to start recording'}
      </p>
    </div>
  );
}
