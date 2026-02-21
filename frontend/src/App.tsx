/**
 * main application component.
 * assembles all components and manages shared state.
 * this is a minimal implementation for your team to build upon.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { AudioRecorder } from './components/AudioRecorder';
import { TranscriptionDisplay } from './components/TranscriptionDisplay';
import { SVGRenderer } from './components/SVGRenderer';
import {
  TranscriptionResult,
  SVGGenerationResponse,
  RecordingState,
} from './types';

// interface for storing svg history
interface SVGHistoryItem {
  id: number;
  svg: string;
  description: string;
  timestamp: Date;
}

// basic app styles - your team will replace these
const styles = {
  app: {
    minHeight: '100vh',
    backgroundColor: '#f3f4f6',
    padding: '2rem',
  },
  container: {
    maxWidth: '800px',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: '2rem',
  },
  header: {
    textAlign: 'center' as const,
  },
  title: {
    fontSize: '2rem',
    fontWeight: 'bold' as const,
    color: '#1f2937',
    marginBottom: '0.5rem',
  },
  subtitle: {
    fontSize: '1rem',
    color: '#6b7280',
  },
  content: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: '1.5rem',
  },
  error: {
    padding: '1rem',
    backgroundColor: '#fee2e2',
    color: '#dc2626',
    borderRadius: '0.5rem',
    fontSize: '0.875rem',
  },
  svgList: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '1rem',
  },
  svgItem: {
    width: '100%',
    borderRadius: '0.5rem',
    overflow: 'hidden',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  },
  svgTimestamp: {
    fontSize: '0.75rem',
    color: '#9ca3af',
    padding: '0.5rem',
    backgroundColor: '#f9fafb',
    borderBottom: '1px solid #e5e7eb',
  },
  clearButton: {
    padding: '0.5rem 1rem',
    fontSize: '0.875rem',
    backgroundColor: '#6b7280',
    color: 'white',
    border: 'none',
    borderRadius: '0.25rem',
    cursor: 'pointer',
    marginTop: '1rem',
  },
};

function App() {
  // state for transcription text
  const [transcriptionText, setTranscriptionText] = useState('');
  const [isPartialTranscription, setIsPartialTranscription] = useState(false);

  // state for svg visualizations - now an array
  const [svgHistory, setSvgHistory] = useState<SVGHistoryItem[]>([]);
  const [isGeneratingSVG, setIsGeneratingSVG] = useState(false);

  // state for errors
  const [error, setError] = useState<string | null>(null);

  // state for recording
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');

  // counter for unique ids
  const idCounterRef = useRef(0);

  // ref for auto-scrolling to latest svg
  const svgListEndRef = useRef<HTMLDivElement>(null);

  // auto-scroll to latest svg when new one is added
  useEffect(() => {
    if (svgListEndRef.current) {
      svgListEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [svgHistory]);

  // handle transcription updates from the audio recorder
  const handleTranscription = useCallback((result: TranscriptionResult) => {
    if (result.accumulatedText) {
      setTranscriptionText(result.accumulatedText);
    } else {
      setTranscriptionText((prev) => prev + ' ' + result.text);
    }
    setIsPartialTranscription(!result.isFinal);
    setError(null);
  }, []);

  // handle svg generation results - append to history
  const handleSVGGenerated = useCallback((response: SVGGenerationResponse) => {
    if (response.svg && !response.error) {
      const newItem: SVGHistoryItem = {
        id: idCounterRef.current++,
        svg: response.svg,
        description: response.description,
        timestamp: new Date(),
      };
      setSvgHistory((prev) => [...prev, newItem]);
    }
    setIsGeneratingSVG(false);
    if (response.error) {
      setError(response.error);
    }
  }, []);

  // handle errors from any component
  const handleError = useCallback((errorMessage: string) => {
    setError(errorMessage);
    setIsGeneratingSVG(false);
  }, []);

  // handle recording state changes
  const handleRecordingStateChange = useCallback((state: RecordingState) => {
    setRecordingState(state);

    // clear previous content when starting a new recording
    if (state === 'recording') {
      setTranscriptionText('');
      setSvgHistory([]);
      setError(null);
      idCounterRef.current = 0;
    }

    // show generating state when processing ends
    if (state === 'processing') {
      setIsGeneratingSVG(true);
    }
  }, []);

  // clear svg history
  const handleClearHistory = useCallback(() => {
    setSvgHistory([]);
  }, []);

  // format timestamp for display
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div style={styles.app}>
      <div style={styles.container}>
        {/* header section */}
        <header style={styles.header}>
          <h1 style={styles.title}>voice to svg</h1>
          <p style={styles.subtitle}>
            speak to create visualizations
          </p>
        </header>

        {/* main content */}
        <main style={styles.content}>
          {/* error display */}
          {error && <div style={styles.error}>{error}</div>}

          {/* audio recorder with button */}
          <AudioRecorder
            onTranscription={handleTranscription}
            onSVGGenerated={handleSVGGenerated}
            onError={handleError}
            onRecordingStateChange={handleRecordingStateChange}
          />

          {/* transcription display - shows text as user speaks */}
          <TranscriptionDisplay
            text={transcriptionText}
            isPartial={isPartialTranscription}
          />

          {/* loading indicator for svg generation */}
          {isGeneratingSVG && (
            <SVGRenderer
              svgCode=""
              isLoading={true}
            />
          )}

          {/* svg visualization history */}
          {svgHistory.length > 0 && (
            <div style={styles.svgList}>
              {svgHistory.map((item) => (
                <div key={item.id} style={styles.svgItem}>
                  <div style={styles.svgTimestamp}>
                    {formatTime(item.timestamp)} - {item.description}
                  </div>
                  <SVGRenderer
                    svgCode={item.svg}
                    isLoading={false}
                  />
                </div>
              ))}
              <div ref={svgListEndRef} />
            </div>
          )}

          {/* placeholder when no svgs yet */}
          {svgHistory.length === 0 && !isGeneratingSVG && (
            <SVGRenderer
              svgCode=""
              isLoading={false}
            />
          )}

          {/* clear history button */}
          {svgHistory.length > 0 && recordingState === 'idle' && (
            <button style={styles.clearButton} onClick={handleClearHistory}>
              clear history
            </button>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
