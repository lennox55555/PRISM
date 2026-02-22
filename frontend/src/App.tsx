import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { AudioRecorder } from './components/AudioRecorder';
import {
  TranscriptionResult,
  SVGGenerationResponse,
  ChartGenerationResponse,
  RecordingState,
  ConnectionState,
} from './types';

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
}

interface Session {
  id: number;
  name: string;
  notes: NoteHistoryItem[];
  transcriptionText: string;
}

type SlideItemType = NoteHistoryItem['type'] | 'live';

interface SlideSourceItem {
  id: number;
  type: SlideItemType;
  newTextDelta: string;
  generationMode?: NoteHistoryItem['generationMode'];
  similarityScore?: number | null;
  svg?: string;
  chartImage?: string;
  description?: string;
}

interface SlideRenderItem extends SlideSourceItem {
  key: string;
  text: string;
  isContinuation: boolean;
}

interface SlidePage {
  id: number;
  items: SlideRenderItem[];
}

const SLIDE_CHAR_LIMIT = 900;
const VISUAL_CHAR_COST = 520;
const MIN_CHUNK_CHARS = 160;

function isRenderableSvg(svgCode?: string): boolean {
  if (!svgCode) {
    return false;
  }

  const trimmed = svgCode.trim();
  return /^<svg[\s>]/i.test(trimmed) && /<\/svg>\s*$/i.test(trimmed);
}

function takeTextChunk(text: string, maxChars: number): [string, string] {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return [normalized, ''];
  }

  const candidate = normalized.slice(0, maxChars);
  const breakPoint = candidate.lastIndexOf(' ');
  const cutPoint = breakPoint > Math.floor(maxChars * 0.6) ? breakPoint : maxChars;

  return [
    normalized.slice(0, cutPoint).trim(),
    normalized.slice(cutPoint).trim(),
  ];
}

function getSlideItemLabel(item: SlideRenderItem): string {
  if (item.type === 'live') {
    return 'Listening...';
  }
  if (item.type === 'text') {
    return item.isContinuation ? 'Note continued' : 'Note';
  }
  if (item.type === 'chart') {
    return item.isContinuation ? 'Chart note continued' : 'Chart generated';
  }
  if (item.generationMode === 'enhanced') {
    return item.isContinuation ? 'Enhanced visualization continued' : 'Enhanced visualization';
  }
  if (item.generationMode === 'new_topic') {
    return item.isContinuation ? 'New topic continued' : 'New topic detected';
  }
  return item.isContinuation ? 'Visualization continued' : 'Visualization generated';
}

function getSessionShortLabel(name: string): string {
  const trimmed = name.trim();
  return (trimmed.charAt(0) || 'S').toUpperCase();
}

function getLowestUnusedPositiveNumber(values: number[]): number {
  const used = new Set(values.filter((value) => Number.isInteger(value) && value > 0));
  let candidate = 1;
  while (used.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

function getNextSessionName(sessions: Session[]): string {
  const usedNumbers = sessions
    .map((session) => {
      const match = session.name.match(/^Session\s+(\d+)$/i);
      return match ? Number(match[1]) : null;
    })
    .filter((value): value is number => value !== null && Number.isInteger(value) && value > 0);

  return `Session ${getLowestUnusedPositiveNumber(usedNumbers)}`;
}

function getNextSessionId(sessions: Session[]): number {
  return getLowestUnusedPositiveNumber(sessions.map((session) => session.id));
}

const THEME_STORAGE_KEY = 'board-ui-theme';

const PrismLogo = () => (
  <svg className="board-logo" viewBox="0 0 120 72" aria-hidden="true">
    <path
      d="M52 12L14 60h76L52 12z"
      fill="none"
      stroke="#f0f0f0"
      strokeWidth="8"
      strokeLinejoin="round"
    />
    <path d="M4 42L92 58 84 72 0 48z" fill="#3ad54f" />
    <path d="M30 36L102 52 84 72 20 50z" fill="#8ced63" />
  </svg>
);

function App() {
  const [isLightMode, setIsLightMode] = useState(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'light';
  });

  const [sessions, setSessions] = useState<Session[]>([
    { id: 1, name: 'Session 1', notes: [], transcriptionText: '' },
  ]);
  const [activeSessionId, setActiveSessionId] = useState(1);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [openSessionMenuId, setOpenSessionMenuId] = useState<number | null>(null);

  const [transcriptionText, setTranscriptionText] = useState('');
  const [realtimeTranscript, setRealtimeTranscript] = useState('');
  const [notesHistory, setNotesHistory] = useState<NoteHistoryItem[]>([]);
  const [isGeneratingSVG, setIsGeneratingSVG] = useState(false);
  const [visualizationActive, setVisualizationActive] = useState(false);
  const [triggerWord] = useState('prism');
  const [deactivatePhrase] = useState('thank you');
  const [error, setError] = useState<string | null>(null);
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);

  const idCounterRef = useRef(0);
  const lastCapturedTextLengthRef = useRef(0);
  const sessionMenuRef = useRef<HTMLDivElement | null>(null);

  const transcriptionTextRef = useRef(transcriptionText);
  const notesHistoryRef = useRef(notesHistory);

  useEffect(() => {
    transcriptionTextRef.current = transcriptionText;
  }, [transcriptionText]);

  useEffect(() => {
    notesHistoryRef.current = notesHistory;
  }, [notesHistory]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_STORAGE_KEY, isLightMode ? 'light' : 'dark');
    }
  }, [isLightMode]);

  useEffect(() => {
    if (openSessionMenuId === null) {
      return;
    }

    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (sessionMenuRef.current && !sessionMenuRef.current.contains(target)) {
        setOpenSessionMenuId(null);
      }
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
  }, [openSessionMenuId]);

  useEffect(() => {
    if (recordingState !== 'recording') {
      return;
    }

    const interval = setInterval(() => {
      if (visualizationActive) {
        return;
      }

      const currentText = transcriptionTextRef.current;
      const lastLength = lastCapturedTextLengthRef.current;
      const newText = currentText.slice(lastLength).trim();

      if (newText.length >= 10) {
        const newNote: NoteHistoryItem = {
          id: idCounterRef.current++,
          type: 'text',
          originalText: currentText,
          newTextDelta: newText,
          timestamp: new Date(),
          generationMode: 'text',
        };
        setNotesHistory((prev) => [...prev, newNote]);
        lastCapturedTextLengthRef.current = currentText.length;
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [recordingState, visualizationActive]);

  const handleNewSession = useCallback(() => {
    const nextSessionId = getNextSessionId(sessions);
    const nextSessionName = getNextSessionName(sessions);

    setSessions((prev) => prev.map((session) => (
      session.id === activeSessionId
        ? { ...session, notes: notesHistory, transcriptionText }
        : session
    )));

    const newSession: Session = {
      id: nextSessionId,
      name: nextSessionName,
      notes: [],
      transcriptionText: '',
    };

    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
    setOpenSessionMenuId(null);
    setNotesHistory([]);
    setTranscriptionText('');
    setRealtimeTranscript('');
    setIsGeneratingSVG(false);
    setVisualizationActive(false);
    setError(null);
    setActiveSlideIndex(0);
    idCounterRef.current = 0;
    lastCapturedTextLengthRef.current = 0;
  }, [activeSessionId, notesHistory, sessions, transcriptionText]);

  const handleDeleteSession = useCallback((sessionId: number) => {
    setOpenSessionMenuId(null);
    setSessions((prev) => {
      const filtered = prev.filter((session) => session.id !== sessionId);

      if (filtered.length === 0) {
        const fallbackSession: Session = {
          id: 1,
          name: 'Session 1',
          notes: [],
          transcriptionText: '',
        };
        setActiveSessionId(1);
        setNotesHistory([]);
        setTranscriptionText('');
        setRealtimeTranscript('');
        setActiveSlideIndex(0);
        return [fallbackSession];
      }

      if (sessionId === activeSessionId) {
        setActiveSessionId(filtered[0].id);
        setNotesHistory(filtered[0].notes);
        setTranscriptionText(filtered[0].transcriptionText);
        setRealtimeTranscript('');
        setError(null);
        setIsGeneratingSVG(false);
        setActiveSlideIndex(0);
      }

      return filtered;
    });
  }, [activeSessionId]);

  const handleRenameSession = useCallback((sessionId: number) => {
    const target = sessions.find((session) => session.id === sessionId);
    if (!target || typeof window === 'undefined') {
      return;
    }

    const renamed = window.prompt('Rename session', target.name);
    if (renamed === null) {
      setOpenSessionMenuId(null);
      return;
    }

    const trimmedName = renamed.trim();
    if (!trimmedName) {
      setOpenSessionMenuId(null);
      return;
    }

    setSessions((prev) => prev.map((session) => (
      session.id === sessionId ? { ...session, name: trimmedName } : session
    )));
    setOpenSessionMenuId(null);
  }, [sessions]);

  const handleTempPdf = useCallback(() => {
    setOpenSessionMenuId(null);
  }, []);

  const handleSwitchSession = useCallback((sessionId: number) => {
    setSessions((prev) => prev.map((session) => (
      session.id === activeSessionId
        ? { ...session, notes: notesHistory, transcriptionText }
        : session
    )));

    const targetSession = sessions.find((session) => session.id === sessionId);
    if (targetSession) {
      setActiveSessionId(sessionId);
      setOpenSessionMenuId(null);
      setNotesHistory(targetSession.notes);
      setTranscriptionText(targetSession.transcriptionText);
      setRealtimeTranscript('');
      setError(null);
      setIsGeneratingSVG(false);
      setActiveSlideIndex(0);
    }
  }, [activeSessionId, notesHistory, sessions, transcriptionText]);

  const handleTranscription = useCallback((result: TranscriptionResult) => {
    const cleanText = (text: string) => text.replace(/\bprison\b/gi, 'prism');

    if (result.accumulatedText) {
      setTranscriptionText(cleanText(result.accumulatedText));
    } else {
      setTranscriptionText((prev) => `${prev} ${cleanText(result.text)}`.trim());
    }

    setError(null);

    if (typeof (result as any).visualizationActive === 'boolean') {
      setVisualizationActive((result as any).visualizationActive);
    }
  }, []);

  const handleSVGGenerated = useCallback((response: SVGGenerationResponse) => {
    const hasValidSvg = isRenderableSvg(response.svg);

    if (hasValidSvg && !response.error) {
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
      };

      lastCapturedTextLengthRef.current = transcriptionTextRef.current.length;

      if (response.generationMode === 'enhanced') {
        setNotesHistory((prev) => {
          if (prev.length === 0) {
            return [newItem];
          }

          const lastSvgIndex = prev.map((item) => item.type).lastIndexOf('svg');
          if (lastSvgIndex === -1) {
            return [...prev, newItem];
          }

          const updated = [...prev];
          updated[lastSvgIndex] = { ...newItem, id: prev[lastSvgIndex].id };
          return updated;
        });
      } else {
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
      };

      lastCapturedTextLengthRef.current = transcriptionTextRef.current.length;
      setNotesHistory((prev) => [...prev, newItem]);
    }

    setIsGeneratingSVG(false);

    if (response.error) {
      setError(response.error);
    }
  }, []);

  const handleError = useCallback((errorMessage: string) => {
    setError(errorMessage);
    setIsGeneratingSVG(false);
  }, []);

  const handleRealtimeTranscript = useCallback((text: string, _isFinal: boolean) => {
    setRealtimeTranscript(text);
  }, []);

  const prevRecordingStateRef = useRef<RecordingState>('idle');

  const handleRecordingStateChange = useCallback((state: RecordingState) => {
    const prevState = prevRecordingStateRef.current;

    if (prevState === state) {
      return;
    }

    prevRecordingStateRef.current = state;
    setRecordingState(state);

    if (state === 'recording' && prevState !== 'recording') {
      setTranscriptionText('');
      setRealtimeTranscript('');
      setNotesHistory([]);
      setError(null);
      setVisualizationActive(false);
      idCounterRef.current = 0;
      lastCapturedTextLengthRef.current = 0;
      setActiveSlideIndex(0);
    }

    if (state === 'processing') {
      setIsGeneratingSVG(true);
    }

    if (state === 'idle') {
      setVisualizationActive(false);
      setSessions((prev) => prev.map((session) => (
        session.id === activeSessionId
          ? {
              ...session,
              notes: notesHistoryRef.current,
              transcriptionText: transcriptionTextRef.current,
            }
          : session
      )));
    }
  }, [activeSessionId]);

  const slideSources = useMemo<SlideSourceItem[]>(() => {
    const historyItems: SlideSourceItem[] = notesHistory.map((note) => ({
      id: note.id,
      type: note.type,
      newTextDelta: note.newTextDelta,
      generationMode: note.generationMode,
      similarityScore: note.similarityScore,
      svg: note.svg,
      chartImage: note.chartImage,
      description: note.description,
    }));

    const liveText = realtimeTranscript.trim();
    if (recordingState === 'recording' && liveText) {
      historyItems.push({
        id: -1,
        type: 'live',
        newTextDelta: liveText,
        generationMode: 'text',
      });
    }

    return historyItems;
  }, [notesHistory, realtimeTranscript, recordingState]);

  const slidePages = useMemo<SlidePage[]>(() => {
    const pages: SlidePage[] = [];
    let currentItems: SlideRenderItem[] = [];
    let usedChars = 0;

    const pushPage = () => {
      pages.push({
        id: pages.length + 1,
        items: currentItems,
      });
      currentItems = [];
      usedChars = 0;
    };

    slideSources.forEach((source) => {
      const hasVisual = source.type === 'chart'
        || (source.type === 'svg' && isRenderableSvg(source.svg));
      let remainingText = source.newTextDelta.trim();

      if (!remainingText) {
        remainingText = hasVisual
          ? 'Visualization generated from your latest notes.'
          : source.type === 'live'
          ? 'Listening...'
          : 'Note captured.';
      }

      let chunkIndex = 0;

      while (remainingText.length > 0) {
        const visualCost = hasVisual && chunkIndex === 0 ? VISUAL_CHAR_COST : 0;
        const room = SLIDE_CHAR_LIMIT - usedChars - visualCost;

        if (room < MIN_CHUNK_CHARS && currentItems.length > 0) {
          pushPage();
          continue;
        }

        const [chunk, remainder] = takeTextChunk(remainingText, Math.max(room, MIN_CHUNK_CHARS));
        const safeChunk = chunk || remainingText;

        currentItems.push({
          ...source,
          key: `${source.id}-${chunkIndex}-${pages.length}`,
          text: safeChunk,
          svg: chunkIndex === 0 ? source.svg : undefined,
          chartImage: chunkIndex === 0 ? source.chartImage : undefined,
          isContinuation: chunkIndex > 0,
        });

        usedChars += Math.max(safeChunk.length, MIN_CHUNK_CHARS) + visualCost;
        remainingText = remainder;
        chunkIndex += 1;

        if (remainingText.length > 0) {
          pushPage();
        }
      }
    });

    if (currentItems.length > 0 || pages.length === 0) {
      pushPage();
    }

    return pages;
  }, [slideSources]);

  const totalSlides = slidePages.length;
  const activeSlide = slidePages[activeSlideIndex] || slidePages[Math.max(totalSlides - 1, 0)];
  const activeVisual = activeSlide?.items
    .filter((item) => item.type === 'chart' || (item.type === 'svg' && isRenderableSvg(item.svg)))
    .slice(-1)[0];

  const previousSlideCountRef = useRef(totalSlides);
  useEffect(() => {
    setActiveSlideIndex((prev) => Math.min(prev, Math.max(totalSlides - 1, 0)));
  }, [totalSlides]);

  useEffect(() => {
    if (totalSlides > previousSlideCountRef.current) {
      setActiveSlideIndex(totalSlides - 1);
    }
    previousSlideCountRef.current = totalSlides;
  }, [totalSlides]);

  const previousSessionIdRef = useRef(activeSessionId);
  useEffect(() => {
    if (previousSessionIdRef.current !== activeSessionId) {
      setActiveSlideIndex(Math.max(totalSlides - 1, 0));
      previousSessionIdRef.current = activeSessionId;
    }
  }, [activeSessionId, totalSlides]);

  const canGoPrev = activeSlideIndex > 0;
  const canGoNext = activeSlideIndex < totalSlides - 1;
  const slideMode = 'notes';

  return (
    <div className={`board-layout ${isLightMode ? 'is-light' : ''}`}>
      <aside className={`board-sidebar ${isSidebarCollapsed ? 'is-collapsed' : ''}`}>
        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => setIsSidebarCollapsed((prev) => !prev)}
          aria-label={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {isSidebarCollapsed ? '>' : '<'}
        </button>

        <button type="button" className="board-new-session" onClick={handleNewSession}>
          <span className="new-session-plus">+</span>
          {!isSidebarCollapsed && <span>New Board</span>}
        </button>

        <div className="board-session-list">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`board-session-item ${session.id === activeSessionId ? 'is-active' : ''}`}
              onClick={() => handleSwitchSession(session.id)}
            >
              <span className="session-label">
                {isSidebarCollapsed ? getSessionShortLabel(session.name) : session.name}
              </span>
              {!isSidebarCollapsed && (
                <div
                  className="session-actions"
                  ref={openSessionMenuId === session.id ? sessionMenuRef : undefined}
                >
                  <button
                    type="button"
                    className="session-menu-trigger"
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenSessionMenuId((prev) => (prev === session.id ? null : session.id));
                    }}
                    aria-label={`Open menu for ${session.name}`}
                  >
                    ⋮
                  </button>

                  {openSessionMenuId === session.id && (
                    <div
                      className="session-menu"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="session-menu-item"
                        onClick={() => handleRenameSession(session.id)}
                      >
                        <span className="session-menu-icon" aria-hidden="true">✎</span>
                        <span>Rename</span>
                      </button>
                      <button
                        type="button"
                        className="session-menu-item"
                        onClick={handleTempPdf}
                      >
                        <span className="session-menu-icon" aria-hidden="true">📄</span>
                        <span>Temp PDF</span>
                      </button>
                      <button
                        type="button"
                        className="session-menu-item is-delete"
                        onClick={() => handleDeleteSession(session.id)}
                      >
                        <span className="session-menu-icon" aria-hidden="true">🗑</span>
                        <span>Delete</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="board-sidebar-footer">
          <div className="board-brand-row">
            <PrismLogo />
            {!isSidebarCollapsed && (
              <>
                <p className="board-brand">PRISM</p>
              </>
            )}
          </div>
          {!isSidebarCollapsed && (
            <>
              <button
                type="button"
                className="board-footer-link"
                onClick={() => setIsLightMode((prev) => !prev)}
              >
                <span className="board-footer-icon" aria-hidden="true">
                  {isLightMode ? '☾' : '☀'}
                </span>
                <span>{isLightMode ? 'Dark Mode' : 'Light Mode'}</span>
              </button>
              <button type="button" className="board-footer-link">
                <span className="board-footer-icon" aria-hidden="true">↗</span>
                <span>Updates & FAQ</span>
              </button>
            </>
          )}
        </div>
      </aside>

      <main className="board-main">
        {error && <div className="board-error">{error}</div>}

        <section className="board-slide">
          <header className="slide-header">
            <div className="slide-mode-row">
              <span>Mode:</span>
              <select className="slide-mode-select" value={slideMode} disabled>
                <option value="notes">Notes</option>
              </select>
            </div>

            <div className="slide-count">Slide {Math.min(activeSlideIndex + 1, totalSlides)} / {totalSlides}</div>
          </header>

          <div className="slide-content">
            <div className="slide-text-column">
              {activeSlide && activeSlide.items.length > 0 ? (
                activeSlide.items.map((item) => (
                  <article
                    key={item.key}
                    className={`slide-text-item ${item.type === 'live' ? 'is-live' : ''}`}
                  >
                    <p className="slide-text">
                      {item.text}
                      {item.type === 'live' && recordingState === 'recording' && (
                        <span className="slide-caret" />
                      )}
                    </p>

                    <div className="slide-meta-row">
                      <span>{getSlideItemLabel(item)}</span>
                      {item.similarityScore != null && (
                        <span>Similarity {(item.similarityScore * 100).toFixed(0)}%</span>
                      )}
                    </div>
                  </article>
                ))
              ) : (
                <div className="slide-empty">Notes will appear here as soon as recording starts.</div>
              )}
            </div>

            <div className="slide-visual-column">
              {activeVisual?.type === 'chart' && activeVisual.chartImage ? (
                <img
                  className="slide-visual-image"
                  src={`data:image/png;base64,${activeVisual.chartImage}`}
                  alt={activeVisual.description || 'Generated chart'}
                />
              ) : activeVisual?.type === 'svg' && activeVisual.svg ? (
                <div
                  className="slide-visual-svg"
                  dangerouslySetInnerHTML={{ __html: activeVisual.svg }}
                />
              ) : (
                <div className="slide-visual-placeholder">
                  {isGeneratingSVG
                    ? 'Generating visualization...'
                    : 'Visual output for this slide appears here.'}
                </div>
              )}
            </div>
          </div>

          <footer className="slide-footer">
            <button
              type="button"
              className="slide-nav-button"
              disabled={!canGoPrev}
              onClick={() => setActiveSlideIndex((prev) => Math.max(prev - 1, 0))}
              aria-label="Previous slide"
            >
              &larr;
            </button>

            <button
              type="button"
              className="slide-nav-button"
              disabled={!canGoNext}
              onClick={() => setActiveSlideIndex((prev) => Math.min(prev + 1, totalSlides - 1))}
              aria-label="Next slide"
            >
              &rarr;
            </button>
          </footer>
        </section>

        <section className="board-controls">
          <div className="control-start-text" aria-hidden="true" />

          <div className="control-recorder-wrap">
            <AudioRecorder
              onTranscription={handleTranscription}
              onSVGGenerated={handleSVGGenerated}
              onChartGenerated={handleChartGenerated}
              onError={handleError}
              onRecordingStateChange={handleRecordingStateChange}
              onRealtimeTranscript={handleRealtimeTranscript}
              onConnectionStateChange={setConnectionState}
              compact
            />
          </div>

          <div className="control-statuses">
            <div className="control-status-row">
              <span className={`status-dot ${connectionState === 'connected' ? 'is-active' : ''}`} />
              <span>{connectionState === 'connected' ? 'connected' : 'disconnected'}</span>
            </div>

            <div className="control-status-row">
              <span className={`status-dot ${visualizationActive ? 'is-active' : ''}`} />
              <span className={`control-visualization-text ${visualizationActive ? 'is-alert' : ''}`}>
                {visualizationActive
                  ? `say "${deactivatePhrase}" to end visualization instructions`
                  : `say "${triggerWord}" to visualize`}
              </span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
