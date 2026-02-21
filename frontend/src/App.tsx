/**
 * main application component.
 * assembles all components and manages shared state.
 * this is a minimal implementation for your team to build upon.
 */

import { useState, useCallback } from 'react';
import { AudioRecorder } from './components/AudioRecorder';
import { TranscriptionDisplay } from './components/TranscriptionDisplay';
import { SVGRenderer } from './components/SVGRenderer';
import {
  TranscriptionResult,
  SVGGenerationResponse,
  RecordingState,
} from './types';

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
};

function App() {
  // state for transcription text
  const [transcriptionText, setTranscriptionText] = useState('');
  const [isPartialTranscription, setIsPartialTranscription] = useState(false);

  // state for svg visualization
  const [svgCode, setSvgCode] = useState('');
  const [isGeneratingSVG, setIsGeneratingSVG] = useState(false);

  // state for errors
  const [error, setError] = useState<string | null>(null);

  // state for recording
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');

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

  // handle svg generation results
  const handleSVGGenerated = useCallback((response: SVGGenerationResponse) => {
    setSvgCode(response.svg);
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
      setSvgCode('');
      setError(null);
    }

    // show generating state when processing ends
    if (state === 'processing') {
      setIsGeneratingSVG(true);
    }
  }, []);

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

          {/* svg visualization display */}
          <SVGRenderer
            svgCode={svgCode}
            isLoading={isGeneratingSVG}
            error={error || undefined}
          />
        </main>
      </div>
    </div>
  );
}

export default App;
