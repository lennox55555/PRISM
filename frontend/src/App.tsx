/**
 * main application component.
 * features a sidebar with session management and main content area.
 * keeps working transcription logic intact.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { AudioRecorder } from './components/AudioRecorder';
import {
  TranscriptionResult,
  SVGGenerationResponse,
  ChartGenerationResponse,
  RecordingState,
} from './types';

// interface for a single version of a visualization
interface VisualizationVersion {
  svg?: string;
  chartImage?: string;
  chartCode?: string;
  description?: string;
  newTextDelta: string;
  timestamp: Date;
  generationMode?: 'initial' | 'enhanced' | 'new_topic' | 'chart' | 'text';
  similarityScore?: number | null;
}

// interface for storing notes history (text-only, svg, or chart)
interface NoteHistoryItem {
  id: number;
  type: 'text' | 'svg' | 'chart';
  svg?: string;
  chartImage?: string;
  chartCode?: string;
  chartConfidence?: number;
  description?: string;
  originalText: string;
  newTextDelta: string;
  timestamp: Date;
  generationMode?: 'initial' | 'enhanced' | 'new_topic' | 'chart' | 'text';
  similarityScore?: number | null;
  similarityThreshold?: number;
  // version history for enhanced visualizations
  versions?: VisualizationVersion[];
  currentVersionIndex?: number;
}

// interface for a session
interface Session {
  id: number;
  name: string;
  notes: NoteHistoryItem[];
  transcriptionText: string;
}

function App() {
  // ==================== SESSION MANAGEMENT ====================
  const [sessions, setSessions] = useState<Session[]>([
    { id: 1, name: 'Session 1', notes: [], transcriptionText: '' }
  ]);
  const [activeSessionId, setActiveSessionId] = useState(1);
  const sessionCounterRef = useRef(1);

  // theme state
  const [isDarkMode, setIsDarkMode] = useState(true);

  // ==================== ORIGINAL WORKING STATE ====================
  const [transcriptionText, setTranscriptionText] = useState('');
  const [realtimeTranscript, setRealtimeTranscript] = useState('');
  const [notesHistory, setNotesHistory] = useState<NoteHistoryItem[]>([]);
  const [isGeneratingSVG, setIsGeneratingSVG] = useState(false);
  const [visualizationActive, setVisualizationActive] = useState(false);
  const [triggerWord] = useState('prism');
  const [deactivatePhrase] = useState('thank you');
  const [error, setError] = useState<string | null>(null);
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const idCounterRef = useRef(0);
  const listEndRef = useRef<HTMLDivElement>(null);
  // track last captured text length for creating text-only notes
  const lastCapturedTextLengthRef = useRef(0);

  // refs for session saving (avoid dependency cycles in callbacks)
  const transcriptionTextRef = useRef(transcriptionText);
  const notesHistoryRef = useRef(notesHistory);

  // keep refs in sync with state
  useEffect(() => {
    transcriptionTextRef.current = transcriptionText;
  }, [transcriptionText]);

  useEffect(() => {
    notesHistoryRef.current = notesHistory;
  }, [notesHistory]);

  // track previous notes count to detect new items vs updates
  const prevNotesCountRef = useRef(0);

  // auto-scroll to latest note only when NEW items are added (not on version changes)
  useEffect(() => {
    if (listEndRef.current && notesHistory.length > prevNotesCountRef.current) {
      listEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
    prevNotesCountRef.current = notesHistory.length;
  }, [notesHistory]);

  // create text-only notes periodically when recording but visualization is off
  useEffect(() => {
    if (recordingState !== 'recording') {
      return;
    }

    const interval = setInterval(() => {
      // only create text notes when visualization is OFF
      if (visualizationActive) {
        return;
      }

      const currentText = transcriptionTextRef.current;
      const lastLength = lastCapturedTextLengthRef.current;
      const newText = currentText.slice(lastLength).trim();

      // only create note if there's substantial new text (at least 10 chars)
      if (newText.length >= 10) {
        const newNote: NoteHistoryItem = {
          id: idCounterRef.current++,
          type: 'text',
          originalText: currentText,
          newTextDelta: newText,
          timestamp: new Date(),
          generationMode: 'text',
        };
        setNotesHistory(prev => [...prev, newNote]);
        lastCapturedTextLengthRef.current = currentText.length;
      }
    }, 5000); // check every 5 seconds

    return () => clearInterval(interval);
  }, [recordingState, visualizationActive]);

  // ==================== SESSION HANDLERS ====================
  const handleNewSession = useCallback(() => {
    // Save current session first
    setSessions(prev => prev.map(s =>
      s.id === activeSessionId
        ? { ...s, notes: notesHistory, transcriptionText }
        : s
    ));

    sessionCounterRef.current += 1;
    const newSession: Session = {
      id: sessionCounterRef.current,
      name: `Session ${sessionCounterRef.current}`,
      notes: [],
      transcriptionText: '',
    };
    setSessions(prev => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
    setNotesHistory([]);
    setTranscriptionText('');
    idCounterRef.current = 0;
  }, [activeSessionId, notesHistory, transcriptionText]);

  const handleDeleteSession = useCallback((sessionId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions(prev => {
      const filtered = prev.filter(s => s.id !== sessionId);
      if (filtered.length === 0) {
        const newSession: Session = {
          id: 1,
          name: 'Session 1',
          notes: [],
          transcriptionText: '',
        };
        sessionCounterRef.current = 1;
        setActiveSessionId(1);
        setNotesHistory([]);
        setTranscriptionText('');
        return [newSession];
      }
      if (sessionId === activeSessionId) {
        setActiveSessionId(filtered[0].id);
        setNotesHistory(filtered[0].notes);
        setTranscriptionText(filtered[0].transcriptionText);
      }
      return filtered;
    });
  }, [activeSessionId]);

  const handleSwitchSession = useCallback((sessionId: number) => {
    // Save current session
    setSessions(prev => prev.map(s =>
      s.id === activeSessionId
        ? { ...s, notes: notesHistory, transcriptionText }
        : s
    ));

    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      setActiveSessionId(sessionId);
      setNotesHistory(session.notes);
      setTranscriptionText(session.transcriptionText);
    }
  }, [activeSessionId, notesHistory, transcriptionText, sessions]);

  // ==================== TRANSCRIPTION CALLBACK ====================
  const handleTranscription = useCallback((result: TranscriptionResult) => {
    // replace "prison" with "prism" (common misrecognition)
    const cleanText = (text: string) => text.replace(/\bprison\b/gi, 'prism');

    if (result.accumulatedText) {
      setTranscriptionText(cleanText(result.accumulatedText));
    } else {
      setTranscriptionText((prev) => prev + ' ' + cleanText(result.text));
    }
    setError(null);

    if (typeof (result as any).visualizationActive === 'boolean') {
      setVisualizationActive((result as any).visualizationActive);
    }
  }, []);

  const handleSVGGenerated = useCallback((response: SVGGenerationResponse) => {
    if (response.svg && !response.error) {
      const newVersion: VisualizationVersion = {
        svg: response.svg,
        description: response.description,
        newTextDelta: response.newTextDelta || response.originalText,
        timestamp: new Date(),
        generationMode: response.generationMode,
        similarityScore: response.similarityScore,
      };

      // update captured text length to prevent duplicate text-only notes
      lastCapturedTextLengthRef.current = transcriptionTextRef.current.length;

      if (response.generationMode === 'enhanced') {
        // add to existing visualization's version history
        setNotesHistory((prev) => {
          if (prev.length === 0) {
            // no previous items, create new with version history
            return [{
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
              versions: [newVersion],
              currentVersionIndex: 0,
            }];
          }

          const lastSvgIndex = prev.map(item => item.type).lastIndexOf('svg');
          if (lastSvgIndex === -1) {
            // no previous SVG, create new
            return [...prev, {
              id: idCounterRef.current++,
              type: 'svg' as const,
              svg: response.svg,
              description: response.description,
              originalText: response.originalText,
              newTextDelta: response.newTextDelta || response.originalText,
              timestamp: new Date(),
              generationMode: response.generationMode,
              similarityScore: response.similarityScore,
              similarityThreshold: response.similarityThreshold,
              versions: [newVersion],
              currentVersionIndex: 0,
            }];
          }

          // add new version to existing SVG item
          const updated = [...prev];
          const existingItem = updated[lastSvgIndex];
          const existingVersions = existingItem.versions || [{
            svg: existingItem.svg,
            description: existingItem.description,
            newTextDelta: existingItem.newTextDelta,
            timestamp: existingItem.timestamp,
            generationMode: existingItem.generationMode,
            similarityScore: existingItem.similarityScore,
          }];

          const newVersions = [...existingVersions, newVersion];
          updated[lastSvgIndex] = {
            ...existingItem,
            svg: response.svg,
            description: response.description,
            newTextDelta: response.newTextDelta || response.originalText,
            generationMode: response.generationMode,
            similarityScore: response.similarityScore,
            similarityThreshold: response.similarityThreshold,
            versions: newVersions,
            currentVersionIndex: newVersions.length - 1, // show latest by default
          };
          return updated;
        });
      } else {
        // new topic or initial - create new item with version history
        const newItem: NoteHistoryItem = {
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
          versions: [newVersion],
          currentVersionIndex: 0,
        };
        setNotesHistory((prev) => [...prev, newItem]);
      }
    }
    setIsGeneratingSVG(false);
    if (response.error) {
      setError(response.error);
    }
  }, []);

  const handleChartGenerated = useCallback((response: ChartGenerationResponse) => {
    if (response.image && !response.error) {
      const newVersion: VisualizationVersion = {
        chartImage: response.image,
        chartCode: response.code,
        description: response.description,
        newTextDelta: response.newTextDelta || response.originalText,
        timestamp: new Date(),
        generationMode: response.generationMode,
      };

      // update captured text length to prevent duplicate text-only notes
      lastCapturedTextLengthRef.current = transcriptionTextRef.current.length;

      if (response.generationMode === 'enhanced') {
        // add to existing chart's version history
        setNotesHistory((prev) => {
          if (prev.length === 0) {
            // no previous items, create new with version history
            return [{
              id: idCounterRef.current++,
              type: 'chart',
              chartImage: response.image,
              chartCode: response.code,
              chartConfidence: response.chartConfidence,
              description: response.description,
              originalText: response.originalText,
              newTextDelta: response.newTextDelta || response.originalText,
              timestamp: new Date(),
              generationMode: response.generationMode,
              versions: [newVersion],
              currentVersionIndex: 0,
            }];
          }

          const lastChartIndex = prev.map(item => item.type).lastIndexOf('chart');
          if (lastChartIndex === -1) {
            // no previous chart, create new
            return [...prev, {
              id: idCounterRef.current++,
              type: 'chart' as const,
              chartImage: response.image,
              chartCode: response.code,
              chartConfidence: response.chartConfidence,
              description: response.description,
              originalText: response.originalText,
              newTextDelta: response.newTextDelta || response.originalText,
              timestamp: new Date(),
              generationMode: response.generationMode,
              versions: [newVersion],
              currentVersionIndex: 0,
            }];
          }

          // add new version to existing chart item
          const updated = [...prev];
          const existingItem = updated[lastChartIndex];
          const existingVersions = existingItem.versions || [{
            chartImage: existingItem.chartImage,
            chartCode: existingItem.chartCode,
            description: existingItem.description,
            newTextDelta: existingItem.newTextDelta,
            timestamp: existingItem.timestamp,
            generationMode: existingItem.generationMode,
          }];

          const newVersions = [...existingVersions, newVersion];
          updated[lastChartIndex] = {
            ...existingItem,
            chartImage: response.image,
            chartCode: response.code,
            description: response.description,
            newTextDelta: response.newTextDelta || response.originalText,
            generationMode: response.generationMode,
            versions: newVersions,
            currentVersionIndex: newVersions.length - 1, // show latest by default
          };
          return updated;
        });
      } else {
        // initial chart - create new item with version history
        const newItem: NoteHistoryItem = {
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
          versions: [newVersion],
          currentVersionIndex: 0,
        };
        setNotesHistory((prev) => [...prev, newItem]);
      }
    }
    setIsGeneratingSVG(false);
    if (response.error) {
      setError(response.error);
    }
  }, []);

  // navigate between visualization versions (works for both SVGs and charts)
  const handleVersionChange = useCallback((itemId: number, direction: 'prev' | 'next') => {
    setNotesHistory((prev) => {
      return prev.map((item) => {
        if (item.id !== itemId || !item.versions || item.versions.length <= 1) {
          return item;
        }

        const currentIndex = item.currentVersionIndex ?? item.versions.length - 1;
        let newIndex: number;

        if (direction === 'prev') {
          newIndex = Math.max(0, currentIndex - 1);
        } else {
          newIndex = Math.min(item.versions.length - 1, currentIndex + 1);
        }

        if (newIndex === currentIndex) return item;

        const version = item.versions[newIndex];
        return {
          ...item,
          // SVG properties
          svg: version.svg,
          // Chart properties
          chartImage: version.chartImage,
          chartCode: version.chartCode,
          // Common properties
          description: version.description,
          newTextDelta: version.newTextDelta,
          generationMode: version.generationMode,
          similarityScore: version.similarityScore,
          currentVersionIndex: newIndex,
        };
      });
    });
  }, []);

  const handleError = useCallback((errorMessage: string) => {
    setError(errorMessage);
    setIsGeneratingSVG(false);
  }, []);

  // handle real-time transcript from browser speech recognition
  const handleRealtimeTranscript = useCallback((text: string, _isFinal: boolean) => {
    setRealtimeTranscript(text);
  }, []);

  // ref to track previous state for transition detection
  const prevRecordingStateRef = useRef<RecordingState>('idle');

  const handleRecordingStateChange = useCallback((state: RecordingState) => {
    const prevState = prevRecordingStateRef.current;

    // only update if state actually changed
    if (prevState === state) {
      return;
    }

    prevRecordingStateRef.current = state;
    setRecordingState(state);

    // only clear on transition TO recording (not if already recording)
    if (state === 'recording' && prevState !== 'recording') {
      setTranscriptionText('');
      setRealtimeTranscript('');
      setNotesHistory([]);
      setError(null);
      setVisualizationActive(false);
      idCounterRef.current = 0;
      lastCapturedTextLengthRef.current = 0;
    }

    if (state === 'processing') {
      setIsGeneratingSVG(true);
    }

    if (state === 'idle') {
      setVisualizationActive(false);
      // Save session when recording stops (use refs to avoid dependency cycles)
      setSessions(prev => prev.map(s =>
        s.id === activeSessionId
          ? { ...s, notes: notesHistoryRef.current, transcriptionText: transcriptionTextRef.current }
          : s
      ));
    }
  }, [activeSessionId]);

  // ==================== THEME COLORS ====================
  const theme = {
    bg: isDarkMode ? '#1a1a1a' : '#ffffff',
    sidebar: isDarkMode ? '#242424' : '#f5f5f5',
    sidebarHover: isDarkMode ? '#333333' : '#e8e8e8',
    text: isDarkMode ? '#ffffff' : '#1a1a1a',
    textSecondary: isDarkMode ? '#a0a0a0' : '#666666',
    border: isDarkMode ? '#333333' : '#e0e0e0',
    accent: '#4ade80',
  };

  return (
    <div style={{
      display: 'flex',
      minHeight: '100vh',
      backgroundColor: theme.bg,
      color: theme.text,
      fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      {/* ==================== SIDEBAR ==================== */}
      <aside style={{
        width: '260px',
        backgroundColor: theme.sidebar,
        borderRight: `1px solid ${theme.border}`,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}>
        {/* New Board Button */}
        <button
          onClick={handleNewSession}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '12px 16px',
            margin: '12px',
            backgroundColor: 'transparent',
            border: `1px solid ${theme.border}`,
            borderRadius: '8px',
            color: theme.text,
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 500,
          }}
        >
          <span style={{ fontSize: '18px' }}>+</span>
          New Board
        </button>

        {/* Sessions List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px' }}>
          {sessions.map(session => (
            <div
              key={session.id}
              onClick={() => handleSwitchSession(session.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 12px',
                marginBottom: '4px',
                backgroundColor: session.id === activeSessionId ? theme.sidebarHover : 'transparent',
                borderRadius: '6px',
                cursor: 'pointer',
              }}
            >
              <span style={{ fontSize: '14px' }}>{session.name}</span>
              <button
                onClick={(e) => handleDeleteSession(session.id, e)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: theme.textSecondary,
                  cursor: 'pointer',
                  padding: '4px',
                  display: 'flex',
                  opacity: 0.6,
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
              </button>
            </div>
          ))}
        </div>

        {/* Bottom Section */}
        <div style={{ padding: '16px', borderTop: `1px solid ${theme.border}` }}>
          <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '16px' }}>Board</h2>
          <button
            onClick={() => setIsDarkMode(!isDarkMode)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 0',
              background: 'none',
              border: 'none',
              color: theme.accent,
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {isDarkMode ? (
                <><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></>
              ) : (
                <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
              )}
            </svg>
            {isDarkMode ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
      </aside>

      {/* ==================== MAIN CONTENT ==================== */}
      <main style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        padding: '32px 48px',
        overflowY: 'auto',
      }}>
        {/* Error Display */}
        {error && (
          <div style={{
            padding: '12px 16px',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            color: '#ef4444',
            borderRadius: '8px',
            marginBottom: '24px',
          }}>
            {error}
          </div>
        )}

        {/* Notes History */}
        <div style={{ flex: 1, marginTop: '24px' }}>
          {notesHistory.map((item, index) => {
            const isLatest = index === notesHistory.length - 1 && recordingState === 'recording';
            return (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  gap: '32px',
                  marginBottom: '32px',
                  alignItems: 'flex-start',
                  padding: isLatest ? '16px' : '0',
                  backgroundColor: isLatest ? (isDarkMode ? 'rgba(74, 222, 128, 0.1)' : 'rgba(74, 222, 128, 0.15)') : 'transparent',
                  border: isLatest ? `1px solid ${theme.accent}` : 'none',
                  borderRadius: isLatest ? '8px' : '0',
                }}
              >
                {/* Text on left */}
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: '16px', lineHeight: 1.7, marginBottom: '8px' }}>
                    {item.newTextDelta}
                  </p>
                  <p style={{ fontSize: '14px', color: item.type === 'text' ? theme.textSecondary : theme.accent }}>
                    {item.type === 'text' ? 'Note' :
                     item.generationMode === 'enhanced' ? 'Enhanced visualization' :
                     item.generationMode === 'new_topic' ? 'New topic detected' :
                     item.type === 'chart' ? 'Chart generated' : 'Initial visualization'}
                  </p>
                  {item.similarityScore != null && (
                    <p style={{ fontSize: '12px', color: theme.textSecondary }}>
                      Similarity: {(item.similarityScore * 100).toFixed(0)}%
                    </p>
                  )}
                </div>

                {/* Visualization on right - only show if there's a visualization */}
                {(item.type === 'chart' || item.type === 'svg') && (
                  <div style={{ width: '280px', flexShrink: 0 }}>
                    {item.type === 'chart' && item.chartImage ? (
                      <img
                        src={`data:image/png;base64,${item.chartImage}`}
                        alt={item.description || 'Chart'}
                        style={{ width: '100%', borderRadius: '8px' }}
                      />
                    ) : item.svg ? (
                      <div
                        style={{ width: '100%', borderRadius: '8px', overflow: 'hidden', backgroundColor: '#f0f0f0' }}
                        dangerouslySetInnerHTML={{ __html: item.svg }}
                      />
                    ) : null}

                    {/* Version navigation arrows - show for SVGs and charts with multiple versions */}
                    {(item.type === 'svg' || item.type === 'chart') && item.versions && item.versions.length > 1 && (
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '16px',
                        marginTop: '8px',
                        padding: '8px',
                      }}>
                        <button
                          onClick={() => handleVersionChange(item.id, 'prev')}
                          disabled={(item.currentVersionIndex ?? item.versions!.length - 1) === 0}
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: (item.currentVersionIndex ?? item.versions!.length - 1) === 0 ? 'not-allowed' : 'pointer',
                            opacity: (item.currentVersionIndex ?? item.versions!.length - 1) === 0 ? 0.3 : 1,
                            padding: '4px 8px',
                            color: theme.text,
                            display: 'flex',
                            alignItems: 'center',
                          }}
                          title="Previous version"
                        >
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M15 18l-6-6 6-6" />
                          </svg>
                        </button>

                        <span style={{ fontSize: '12px', color: theme.textSecondary }}>
                          {(item.currentVersionIndex ?? item.versions!.length - 1) + 1} / {item.versions!.length}
                        </span>

                        <button
                          onClick={() => handleVersionChange(item.id, 'next')}
                          disabled={(item.currentVersionIndex ?? item.versions!.length - 1) === item.versions!.length - 1}
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: (item.currentVersionIndex ?? item.versions!.length - 1) === item.versions!.length - 1 ? 'not-allowed' : 'pointer',
                            opacity: (item.currentVersionIndex ?? item.versions!.length - 1) === item.versions!.length - 1 ? 0.3 : 1,
                            padding: '4px 8px',
                            color: theme.text,
                            display: 'flex',
                            alignItems: 'center',
                          }}
                          title="Next version"
                        >
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 18l6-6-6-6" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Live transcript as the current note being typed */}
          {recordingState === 'recording' && realtimeTranscript && (
            <div
              style={{
                display: 'flex',
                gap: '32px',
                marginBottom: '32px',
                alignItems: 'flex-start',
                padding: '16px',
                backgroundColor: isDarkMode ? 'rgba(74, 222, 128, 0.1)' : 'rgba(74, 222, 128, 0.15)',
                border: `1px solid ${theme.accent}`,
                borderRadius: '8px',
              }}
            >
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: '16px', lineHeight: 1.7, marginBottom: '8px' }}>
                  {realtimeTranscript}
                  <span style={{
                    display: 'inline-block',
                    width: '2px',
                    height: '1em',
                    backgroundColor: theme.accent,
                    marginLeft: '4px',
                    animation: 'pulse 1s infinite',
                    verticalAlign: 'text-bottom',
                  }} />
                </p>
                <p style={{ fontSize: '14px', color: theme.accent }}>
                  Listening...
                </p>
              </div>
            </div>
          )}
          <div ref={listEndRef} />
        </div>

        {/* Loading indicator */}
        {isGeneratingSVG && (
          <div style={{ textAlign: 'center', color: theme.accent, padding: '20px' }}>
            Generating visualization...
          </div>
        )}

        {/* Bottom Controls */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '24px',
          padding: '24px 0',
          marginTop: 'auto',
          borderTop: `1px solid ${theme.border}`,
        }}>
          {/* Audio Recorder - ORIGINAL COMPONENT (key for working transcription) */}
          <AudioRecorder
            onTranscription={handleTranscription}
            onSVGGenerated={handleSVGGenerated}
            onChartGenerated={handleChartGenerated}
            onError={handleError}
            onRecordingStateChange={handleRecordingStateChange}
            onRealtimeTranscript={handleRealtimeTranscript}
          />

          {/* Recording Status */}
          {recordingState === 'recording' && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '14px',
              color: theme.textSecondary,
            }}>
              <span style={{
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                backgroundColor: visualizationActive ? theme.accent : '#f59e0b',
                animation: 'pulse 2s infinite',
              }} />
              {visualizationActive ? `Visualizing - say "${deactivatePhrase}" to stop` : `Say "${triggerWord}" to visualize`}
            </div>
          )}
        </div>
      </main>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}

export default App;
