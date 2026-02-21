/**
 * main application component.
 * assembles all components and manages shared state.
 * features a modern dark theme with gradient accents.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { AudioRecorder } from './components/AudioRecorder';
import { TranscriptionDisplay } from './components/TranscriptionDisplay';
import { SVGRenderer } from './components/SVGRenderer';
import {
  TranscriptionResult,
  SVGGenerationResponse,
  ChartGenerationResponse,
  RecordingState,
} from './types';

// interface for storing visualization history (svg or chart)
interface VisualizationHistoryItem {
  id: number;
  type: 'svg' | 'chart';
  // svg specific
  svg?: string;
  // chart specific
  chartImage?: string;  // base64 png
  chartCode?: string;   // matplotlib code
  chartConfidence?: number;
  // common fields
  description: string;
  originalText: string;
  newTextDelta: string;
  timestamp: Date;
  generationMode?: 'initial' | 'enhanced' | 'new_topic' | 'chart';
  similarityScore?: number | null;
  similarityThreshold?: number;
}

// modern app styles with dark theme
const styles = {
  app: {
    minHeight: '100vh',
    padding: 'var(--spacing-xl)',
    paddingTop: 'var(--spacing-2xl)',
  },
  container: {
    maxWidth: '900px',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 'var(--spacing-xl)',
  },
  header: {
    textAlign: 'center' as const,
    marginBottom: 'var(--spacing-md)',
  },
  titleWrapper: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--spacing-md)',
    marginBottom: 'var(--spacing-sm)',
  },
  logo: {
    width: '48px',
    height: '48px',
    borderRadius: 'var(--radius-md)',
    background: 'var(--gradient-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: 'var(--shadow-glow)',
  },
  title: {
    fontSize: '2.5rem',
    fontWeight: '700' as const,
    background: 'var(--gradient-primary)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    backgroundClip: 'text',
    letterSpacing: '-0.02em',
  },
  subtitle: {
    fontSize: '1.125rem',
    color: 'var(--color-text-secondary)',
    fontWeight: '400' as const,
  },
  content: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 'var(--spacing-lg)',
  },
  error: {
    padding: 'var(--spacing-md) var(--spacing-lg)',
    backgroundColor: 'var(--color-error-bg)',
    color: 'var(--color-error)',
    borderRadius: 'var(--radius-md)',
    fontSize: '0.875rem',
    border: '1px solid rgba(239, 68, 68, 0.3)',
    width: '100%',
    maxWidth: '600px',
    textAlign: 'center' as const,
  },
  statusSection: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 'var(--spacing-sm)',
  },
  visualizationStatus: {
    padding: 'var(--spacing-sm) var(--spacing-lg)',
    borderRadius: 'var(--radius-full)',
    fontSize: '0.875rem',
    fontWeight: '600' as const,
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--spacing-sm)',
    transition: 'var(--transition-normal)',
  },
  visualizationActive: {
    backgroundColor: 'var(--color-success-bg)',
    color: 'var(--color-success)',
    border: '1px solid rgba(16, 185, 129, 0.3)',
  },
  visualizationInactive: {
    backgroundColor: 'var(--color-warning-bg)',
    color: 'var(--color-warning)',
    border: '1px solid rgba(245, 158, 11, 0.3)',
  },
  triggerHint: {
    fontSize: '0.8rem',
    color: 'var(--color-text-muted)',
    textAlign: 'center' as const,
  },
  triggerWord: {
    color: 'var(--color-primary-light)',
    fontWeight: '600' as const,
  },
  svgSection: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--spacing-lg)',
  },
  svgSectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    maxWidth: '700px',
    margin: '0 auto',
    padding: '0 var(--spacing-md)',
  },
  svgSectionTitle: {
    fontSize: '0.875rem',
    fontWeight: '600' as const,
    color: 'var(--color-text-secondary)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  svgCount: {
    fontSize: '0.75rem',
    color: 'var(--color-text-muted)',
    backgroundColor: 'var(--color-bg-elevated)',
    padding: 'var(--spacing-xs) var(--spacing-sm)',
    borderRadius: 'var(--radius-full)',
  },
  svgList: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--spacing-lg)',
    alignItems: 'center',
  },
  svgItem: {
    width: '100%',
    maxWidth: '700px',
    borderRadius: 'var(--radius-lg)',
    overflow: 'hidden',
    backgroundColor: 'var(--color-bg-card)',
    border: '1px solid var(--color-border)',
    boxShadow: 'var(--shadow-md)',
    animation: 'slideUp 0.4s ease',
  },
  svgHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 'var(--spacing-md) var(--spacing-lg)',
    backgroundColor: 'var(--color-bg-elevated)',
    borderBottom: '1px solid var(--color-border)',
  },
  svgTimestamp: {
    fontSize: '0.75rem',
    color: 'var(--color-text-muted)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--spacing-xs)',
  },
  svgDescription: {
    fontSize: '0.875rem',
    color: 'var(--color-text-secondary)',
    flex: 1,
  },
  svgMetaRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--spacing-md)',
    padding: 'var(--spacing-sm) var(--spacing-lg)',
    backgroundColor: 'var(--color-bg-secondary)',
    borderBottom: '1px solid var(--color-border)',
    flexWrap: 'wrap' as const,
  },
  svgBadge: {
    fontSize: '0.7rem',
    fontWeight: '600' as const,
    padding: '2px 8px',
    borderRadius: 'var(--radius-full)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.03em',
  },
  badgeInitial: {
    backgroundColor: 'var(--color-primary)',
    color: 'white',
  },
  badgeEnhanced: {
    backgroundColor: 'var(--color-success-bg)',
    color: 'var(--color-success)',
    border: '1px solid rgba(16, 185, 129, 0.3)',
  },
  badgeNewTopic: {
    backgroundColor: 'var(--color-warning-bg)',
    color: 'var(--color-warning)',
    border: '1px solid rgba(245, 158, 11, 0.3)',
  },
  similarityScore: {
    fontSize: '0.75rem',
    color: 'var(--color-text-muted)',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  originalTextContainer: {
    padding: 'var(--spacing-sm) var(--spacing-lg)',
    backgroundColor: 'var(--color-bg-secondary)',
    borderBottom: '1px solid var(--color-border)',
  },
  originalTextLabel: {
    fontSize: '0.7rem',
    fontWeight: '600' as const,
    color: 'var(--color-text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: '4px',
  },
  originalText: {
    fontSize: '0.8rem',
    color: 'var(--color-text-secondary)',
    lineHeight: '1.5',
    fontStyle: 'italic' as const,
  },
  chartImage: {
    width: '100%',
    height: 'auto',
    display: 'block',
  },
  chartContainer: {
    backgroundColor: 'white',
    padding: 'var(--spacing-md)',
  },
  badgeChart: {
    backgroundColor: 'var(--color-primary)',
    color: 'white',
  },
  chartConfidence: {
    fontSize: '0.75rem',
    color: 'var(--color-text-muted)',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  clearButton: {
    padding: 'var(--spacing-sm) var(--spacing-lg)',
    fontSize: '0.875rem',
    backgroundColor: 'transparent',
    color: 'var(--color-text-secondary)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    transition: 'var(--transition-fast)',
    marginTop: 'var(--spacing-md)',
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    animation: 'pulse 2s infinite',
  },
};

function App() {
  // state for transcription text
  const [transcriptionText, setTranscriptionText] = useState('');
  const [isPartialTranscription, setIsPartialTranscription] = useState(false);

  // state for svg visualizations - now an array
  const [visualizationHistory, setVisualizationHistory] = useState<VisualizationHistoryItem[]>([]);
  const [isGeneratingSVG, setIsGeneratingSVG] = useState(false);

  // state for visualization mode
  const [visualizationActive, setVisualizationActive] = useState(false);
  const [triggerWord, setTriggerWord] = useState('orange');

  // state for errors
  const [error, setError] = useState<string | null>(null);

  // state for recording
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');

  // counter for unique ids
  const idCounterRef = useRef(0);

  // ref for auto-scrolling to latest svg
  const listEndRef = useRef<HTMLDivElement>(null);

  // auto-scroll to latest svg when new one is added
  useEffect(() => {
    if (listEndRef.current) {
      listEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [visualizationHistory]);

  // handle transcription updates from the audio recorder
  const handleTranscription = useCallback((result: TranscriptionResult) => {
    if (result.accumulatedText) {
      setTranscriptionText(result.accumulatedText);
    } else {
      setTranscriptionText((prev) => prev + ' ' + result.text);
    }
    setIsPartialTranscription(!result.isFinal);
    setError(null);

    // check for visualization state in the result
    if (typeof (result as any).visualizationActive === 'boolean') {
      setVisualizationActive((result as any).visualizationActive);
    }
  }, []);

  // handle svg generation results - append to history
  const handleSVGGenerated = useCallback((response: SVGGenerationResponse) => {
    if (response.svg && !response.error) {
      const newItem: VisualizationHistoryItem = {
        id: idCounterRef.current++,
        type: 'svg',
        svg: response.svg,
        description: response.description,
        originalText: response.originalText,
        newTextDelta: response.newTextDelta || response.originalText,
        timestamp: new Date(),
        generationMode: response.generationMode,
        similarityScore: response.similarityScore,
        similarityThreshold: response.similarityThreshold,
      };
      setVisualizationHistory((prev) => [...prev, newItem]);
    }
    setIsGeneratingSVG(false);
    if (response.error) {
      setError(response.error);
    }
  }, []);

  // handle chart generation results - append to history
  const handleChartGenerated = useCallback((response: ChartGenerationResponse) => {
    if (response.image && !response.error) {
      const newItem: VisualizationHistoryItem = {
        id: idCounterRef.current++,
        type: 'chart',
        chartImage: response.image,
        chartCode: response.code,
        chartConfidence: response.chartConfidence,
        description: response.description,
        originalText: response.originalText,
        newTextDelta: response.newTextDelta || response.originalText,
        timestamp: new Date(),
        generationMode: 'chart',
      };
      setVisualizationHistory((prev) => [...prev, newItem]);
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

  // handle status changes (including visualization toggle)
  const handleStatusChange = useCallback((status: string, data?: any) => {
    if (data?.visualization_active !== undefined) {
      setVisualizationActive(data.visualization_active);
    }
    if (data?.trigger_word) {
      setTriggerWord(data.trigger_word);
    }
  }, []);

  // handle recording state changes
  const handleRecordingStateChange = useCallback((state: RecordingState) => {
    setRecordingState(state);

    // clear previous content when starting a new recording
    if (state === 'recording') {
      setTranscriptionText('');
      setVisualizationHistory([]);
      setError(null);
      setVisualizationActive(false);
      idCounterRef.current = 0;
    }

    // show generating state when processing ends
    if (state === 'processing') {
      setIsGeneratingSVG(true);
    }

    // reset visualization state when stopped
    if (state === 'idle') {
      setVisualizationActive(false);
    }
  }, []);

  // clear svg history
  const handleClearHistory = useCallback(() => {
    setVisualizationHistory([]);
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
          <div style={styles.titleWrapper}>
            <div style={styles.logo}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            </div>
            <h1 style={styles.title}>voice to svg</h1>
          </div>
          <p style={styles.subtitle}>
            speak to create real-time visualizations
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
            onChartGenerated={handleChartGenerated}
            onError={handleError}
            onRecordingStateChange={handleRecordingStateChange}
          />

          {/* visualization status indicator - only show when recording */}
          {recordingState === 'recording' && (
            <div style={styles.statusSection}>
              <div
                style={{
                  ...styles.visualizationStatus,
                  ...(visualizationActive
                    ? styles.visualizationActive
                    : styles.visualizationInactive),
                }}
              >
                <span
                  style={{
                    ...styles.statusDot,
                    backgroundColor: visualizationActive ? 'var(--color-success)' : 'var(--color-warning)',
                  }}
                />
                {visualizationActive
                  ? 'visualization active'
                  : 'visualization paused'}
              </div>
              <p style={styles.triggerHint}>
                say "<span style={styles.triggerWord}>{triggerWord}</span>" to {visualizationActive ? 'stop' : 'start'} visualization
              </p>
            </div>
          )}

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
          {visualizationHistory.length > 0 && (
            <div style={styles.svgSection}>
              <div style={styles.svgSectionHeader}>
                <span style={styles.svgSectionTitle}>generated visualizations</span>
                <span style={styles.svgCount}>{visualizationHistory.length} items</span>
              </div>
              <div style={styles.svgList}>
                {visualizationHistory.map((item) => (
                  <div key={item.id} style={styles.svgItem}>
                    {/* header with timestamp */}
                    <div style={styles.svgHeader}>
                      <span style={styles.svgDescription}>{item.description}</span>
                      <span style={styles.svgTimestamp}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10" />
                          <polyline points="12 6 12 12 16 14" />
                        </svg>
                        {formatTime(item.timestamp)}
                      </span>
                    </div>

                    {/* meta row with generation mode and similarity/confidence score */}
                    <div style={styles.svgMetaRow}>
                      {/* generation mode badge */}
                      <span style={{
                        ...styles.svgBadge,
                        ...(item.type === 'chart' ? styles.badgeChart :
                            item.generationMode === 'enhanced' ? styles.badgeEnhanced :
                            item.generationMode === 'new_topic' ? styles.badgeNewTopic :
                            styles.badgeInitial)
                      }}>
                        {item.type === 'chart' ? 'chart' :
                         item.generationMode === 'enhanced' ? 'enhanced' :
                         item.generationMode === 'new_topic' ? 'new topic' :
                         'initial'}
                      </span>

                      {/* chart confidence (for charts) */}
                      {item.type === 'chart' && item.chartConfidence !== undefined && (
                        <span style={styles.chartConfidence}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 20V10" />
                            <path d="M18 20V4" />
                            <path d="M6 20v-4" />
                          </svg>
                          chart confidence: {(item.chartConfidence * 100).toFixed(1)}%
                        </span>
                      )}

                      {/* similarity score (for svgs) */}
                      {item.type === 'svg' && item.similarityScore !== null && item.similarityScore !== undefined && (
                        <span style={styles.similarityScore}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 20V10" />
                            <path d="M18 20V4" />
                            <path d="M6 20v-4" />
                          </svg>
                          similarity: {(item.similarityScore * 100).toFixed(1)}%
                          {item.similarityThreshold && (
                            <span style={{ opacity: 0.6 }}>
                              {' '}(threshold: {(item.similarityThreshold * 100).toFixed(0)}%)
                            </span>
                          )}
                        </span>
                      )}
                    </div>

                    {/* source text */}
                    <div style={styles.originalTextContainer}>
                      <div style={styles.originalTextLabel}>
                        {item.type === 'chart' ? 'chart description' : 'new text (compared for similarity)'}
                      </div>
                      <div style={styles.originalText}>{item.newTextDelta}</div>
                    </div>

                    {/* full context used for generation (if different from delta, only for svgs) */}
                    {item.type === 'svg' && item.originalText !== item.newTextDelta && (
                      <div style={{...styles.originalTextContainer, borderTop: '1px solid var(--color-border)'}}>
                        <div style={styles.originalTextLabel}>full context used</div>
                        <div style={{...styles.originalText, fontSize: '0.75rem', opacity: 0.8}}>{item.originalText}</div>
                      </div>
                    )}

                    {/* render svg or chart image */}
                    {item.type === 'chart' && item.chartImage ? (
                      <div style={styles.chartContainer}>
                        <img
                          src={`data:image/png;base64,${item.chartImage}`}
                          alt={item.description}
                          style={styles.chartImage}
                        />
                      </div>
                    ) : (
                      <SVGRenderer
                        svgCode={item.svg || ''}
                        isLoading={false}
                      />
                    )}
                  </div>
                ))}
                <div ref={listEndRef} />
              </div>
            </div>
          )}

          {/* placeholder when no svgs yet */}
          {visualizationHistory.length === 0 && !isGeneratingSVG && (
            <SVGRenderer
              svgCode=""
              isLoading={false}
            />
          )}

          {/* clear history button */}
          {visualizationHistory.length > 0 && recordingState === 'idle' && (
            <button
              style={styles.clearButton}
              onClick={handleClearHistory}
              onMouseOver={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-primary)';
                e.currentTarget.style.color = 'var(--color-primary-light)';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-border)';
                e.currentTarget.style.color = 'var(--color-text-secondary)';
              }}
            >
              clear history
            </button>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
