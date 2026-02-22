/**
 * audio recorder component.
 * provides the main interface for starting and stopping voice recording.
 * displays recording state and audio level visualization.
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

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 'var(--spacing-lg)',
    padding: 'var(--spacing-xl)',
  },
  compactContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  buttonWrapper: {
    position: 'relative' as const,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glowRing: {
    position: 'absolute' as const,
    width: '96px',
    height: '96px',
    borderRadius: '50%',
    background: 'rgba(125, 220, 101, 0.35)',
    animation: 'ripple 1.8s ease-out infinite',
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
  compactButton: {
    width: '78px',
    height: '78px',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.28)',
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
  compactIdleButton: {
    background: '#f4f4f4',
    color: '#1f1f1f',
    border: '1px solid #d4d4d4',
  },
  compactRecordingButton: {
    background: '#ffffff',
    color: '#1f1f1f',
    border: '2px solid #7ddc65',
    animation: 'glow 1.6s ease-in-out infinite',
  },
  compactDisabledButton: {
    background: '#b4b4b4',
    color: '#6f6f6f',
    cursor: 'not-allowed',
    boxShadow: 'none',
    border: '1px solid #9d9d9d',
  },
  buttonIcon: {
    width: '32px',
    height: '32px',
  },
  stopIcon: {
    width: '28px',
    height: '28px',
    backgroundColor: 'white',
    borderRadius: 'var(--radius-sm)',
  },
  compactStopIcon: {
    width: '24px',
    height: '24px',
    backgroundColor: '#1f1f1f',
    borderRadius: '8px',
  },
  status: {
    fontSize: '0.875rem',
    color: 'var(--color-text-secondary)',
    fontWeight: '500' as const,
  },
  levelContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    height: '40px',
    padding: '0 var(--spacing-md)',
  },
  compactLevelContainer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    height: '40px',
    minWidth: '130px',
    padding: '0 10px',
    borderRadius: '999px',
    backgroundColor: 'rgba(0, 0, 0, 0.22)',
  },
  compactLevelPlaceholder: {
    fontSize: '0.78rem',
    color: 'rgba(255, 255, 255, 0.82)',
    letterSpacing: '0.02em',
  },
  levelBar: {
    width: '4px',
    backgroundColor: 'var(--color-primary)',
    borderRadius: 'var(--radius-full)',
    transition: 'height 0.1s ease',
  },
  compactLevelBar: {
    width: '4px',
    backgroundColor: '#7ddc65',
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

const MicrophoneIcon = ({ color }: { color: string }) => (
  <svg
    style={{ ...styles.buttonIcon, color }}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
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
  onRealtimeTranscript,
  onConnectionStateChange,
  onStatusChange,
  compact = false,
}: AudioRecorderProps) {
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
    onStatusChange: (status: string, data?: { visualization_active?: boolean; new_session?: boolean }) => {
      onStatusChange?.(status, data);
    },
  });

  const {
    recordingState,
    startRecording: micStartRecording,
    stopRecording: micStopRecording,
    audioLevel,
  } = useAudioRecorder({
    onAudioData: (audioBase64: string) => {
      sendAudioChunk(audioBase64);
    },
    onError: (error: string) => {
      onError?.(error);
    },
    onRealtimeTranscript: (text: string, isFinal: boolean) => {
      onRealtimeTranscript?.(text, isFinal);
    },
  });

  const onRecordingStateChangeRef = useRef(onRecordingStateChange);
  useEffect(() => {
    onRecordingStateChangeRef.current = onRecordingStateChange;
  }, [onRecordingStateChange]);

  useEffect(() => {
    onRecordingStateChangeRef.current?.(recordingState);
  }, [recordingState]);

  const onConnectionStateChangeRef = useRef(onConnectionStateChange);
  useEffect(() => {
    onConnectionStateChangeRef.current = onConnectionStateChange;
  }, [onConnectionStateChange]);

  useEffect(() => {
    onConnectionStateChangeRef.current?.(connectionState);
  }, [connectionState]);

  const handleRecordClick = useCallback(async () => {
    if (recordingState === 'recording') {
      micStopRecording();
      wsStopRecording();
    } else if (recordingState === 'idle') {
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

  const getButtonStyle = (state: RecordingState) => {
    if (!compact) {
      switch (state) {
        case 'recording':
          return { ...styles.button, ...styles.recordingButton };
        case 'processing':
          return { ...styles.button, ...styles.disabledButton };
        default:
          return { ...styles.button, ...styles.idleButton };
      }
    }

    switch (state) {
      case 'recording':
        return {
          ...styles.button,
          ...styles.compactButton,
          ...styles.compactRecordingButton,
        };
      case 'processing':
        return {
          ...styles.button,
          ...styles.compactButton,
          ...styles.compactDisabledButton,
        };
      default:
        return {
          ...styles.button,
          ...styles.compactButton,
          ...styles.compactIdleButton,
        };
    }
  };

  const renderLevelBars = (isCompact: boolean) => {
    const barCount = isCompact ? 10 : 12;
    const bars = [];

    for (let i = 0; i < barCount; i += 1) {
      const baseHeight = audioLevel * 100;
      const variance = Math.sin(Date.now() / 100 + i) * 20;
      const height = Math.max(10, Math.min(100, baseHeight + variance));

      bars.push(
        <div
          key={i}
          style={{
            ...(isCompact ? styles.compactLevelBar : styles.levelBar),
            height: `${height}%`,
            opacity: 0.4 + (audioLevel * 0.6),
          }}
        />,
      );
    }

    return bars;
  };

  const isConnected = connectionState === 'connected';
  const isRecording = recordingState === 'recording';
  const isDisabled = recordingState === 'processing' || !isConnected;

  if (compact) {
    return (
      <div style={styles.compactContainer}>
        <div style={styles.buttonWrapper}>
          {isRecording && <div style={styles.glowRing} />}
          <button
            onClick={handleRecordClick}
            style={getButtonStyle(recordingState)}
            disabled={isDisabled}
            aria-label={isRecording ? 'stop recording' : 'start recording'}
          >
            {isRecording ? (
              <div style={styles.compactStopIcon} />
            ) : (
              <MicrophoneIcon color="#1f1f1f" />
            )}
          </button>
        </div>

        <div style={styles.compactLevelContainer}>
          {isRecording ? (
            renderLevelBars(true)
          ) : (
            <span style={styles.compactLevelPlaceholder}>audio visualizer</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
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
            <MicrophoneIcon color="white" />
          )}
        </button>
      </div>

      {isRecording && (
        <div style={styles.levelContainer}>
          {renderLevelBars(false)}
        </div>
      )}

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
