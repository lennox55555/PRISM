import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { AudioRecorder } from './components/AudioRecorder';
import { summarizeUserSpeech } from './services/api';
import PptxGenJS from 'pptxgenjs';
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


function isRenderableSvg(svgCode?: string): boolean {
  if (!svgCode) {
    return false;
  }

  const trimmed = svgCode.trim();
  return /^<svg[\s>]/i.test(trimmed) && /<\/svg>\s*$/i.test(trimmed);
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
  const used = new Set(values.filter((v) => Number.isInteger(v) && v > 0));
  let candidate = 1;
  while (used.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

function getNextSessionName(sessions: Session[]): string {
  const usedNumbers = sessions
    .map((s) => {
      const match = s.name.match(/^Session\s+(\d+)$/i);
      return match ? Number(match[1]) : null;
    })
    .filter((v): v is number => v !== null);
  return `Session ${getLowestUnusedPositiveNumber(usedNumbers)}`;
}

function getNextSessionId(sessions: Session[]): number {
  return getLowestUnusedPositiveNumber(sessions.map((s) => s.id));
}

// PRISM Logo component
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeFilename(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'session';
}

async function svgMarkupToPngDataUrl(
  svgMarkup: string,
  width = 1600,
  height = 900
): Promise<string> {
  let normalizedSvg = svgMarkup.trim();

  // Remove export-time animation styles so we don't capture an initial hidden frame.
  normalizedSvg = normalizedSvg.replace(
    /<style[\s\S]*?@keyframes\s+(fadeIn|scaleIn|slideIn)[\s\S]*?<\/style>/gi,
    ''
  );
  normalizedSvg = normalizedSvg.replace(/\sstyle\s*=\s*["'][^"']*animation:[^"']*["']/gi, '');

  if (!/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(normalizedSvg)) {
    normalizedSvg = normalizedSvg.replace(
      /<svg\b/i,
      '<svg xmlns="http://www.w3.org/2000/svg"'
    );
  }

  normalizedSvg = normalizedSvg.replace(/<svg\b([^>]*)>/i, (_match, attrs: string) => {
    const cleanedAttrs = attrs
      .replace(/\swidth\s*=\s*["'][^"']*["']/i, '')
      .replace(/\sheight\s*=\s*["'][^"']*["']/i, '');

    const hasViewBox = /viewBox\s*=/.test(cleanedAttrs);
    const viewBoxAttr = hasViewBox ? '' : ` viewBox="0 0 ${width} ${height}"`;

    return `<svg${cleanedAttrs}${viewBoxAttr} width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet">`;
  });

  const blob = new Blob([normalizedSvg], {
    type: 'image/svg+xml;charset=utf-8',
  });
  const svgUrl = URL.createObjectURL(blob);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load SVG for PPTX conversion'));
      img.src = svgUrl;
    });

    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error('Loaded SVG has zero dimensions for PPTX conversion');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      throw new Error('Canvas context unavailable for SVG conversion');
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

const STORAGE_KEY = 'prism-sessions';

// Helper to deserialize sessions from localStorage (converts date strings back to Date objects)
function deserializeSessions(json: string): { sessions: Session[]; maxId: number } {
  try {
    const data = JSON.parse(json);
    let maxId = 1;
    const sessions = data.map((session: Session) => {
      if (session.id > maxId) maxId = session.id;
      return {
        ...session,
        notes: session.notes.map((note: NoteHistoryItem) => ({
          ...note,
          timestamp: new Date(note.timestamp),
          versions: note.versions?.map((v: VisualizationVersion) => ({
            ...v,
            timestamp: new Date(v.timestamp),
          })),
        })),
      };
    });
    return { sessions, maxId };
  } catch {
    return { sessions: [{ id: 1, name: 'Session 1', notes: [], transcriptionText: '' }], maxId: 1 };
  }
}

// Load initial state from localStorage
function loadInitialSessions(): { sessions: Session[]; maxId: number } {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    return deserializeSessions(stored);
  }
  return { sessions: [{ id: 1, name: 'Session 1', notes: [], transcriptionText: '' }], maxId: 1 };
}

function App() {
  // Initialize sessions from localStorage
  const [sessions, setSessions] = useState<Session[]>(() => {
    const { sessions } = loadInitialSessions();
    return sessions;
  });
  const [activeSessionId, setActiveSessionId] = useState(() => {
    const { sessions } = loadInitialSessions();
    return sessions.length > 0 ? sessions[0].id : 1;
  });
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  // Initialize transcription and notes from the active session in localStorage
  const [transcriptionText, setTranscriptionText] = useState(() => {
    const { sessions } = loadInitialSessions();
    const activeSession = sessions.length > 0 ? sessions[0] : null;
    return activeSession?.transcriptionText || '';
  });
  const [realtimeTranscript, setRealtimeTranscript] = useState('');
  const [notesHistory, setNotesHistory] = useState<NoteHistoryItem[]>(() => {
    const { sessions } = loadInitialSessions();
    const activeSession = sessions.length > 0 ? sessions[0] : null;
    return activeSession?.notes || [];
  });
  const [isGeneratingSVG, setIsGeneratingSVG] = useState(false);
  const [visualizationActive, setVisualizationActive] = useState(false);
  const [triggerWord] = useState('prism');
  const [deactivatePhrase] = useState('thank you');
  const [error, setError] = useState<string | null>(null);
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [lastSavedTime, setLastSavedTime] = useState<Date | null>(null);

  const idCounterRef = useRef(0);
  const lastCapturedTextLengthRef = useRef(0);

  const transcriptionTextRef = useRef(transcriptionText);
  const notesHistoryRef = useRef(notesHistory);

  useEffect(() => {
    transcriptionTextRef.current = transcriptionText;
  }, [transcriptionText]);

  // Track if notes have been loaded initially
  const notesInitializedRef = useRef(false);

  useEffect(() => {
    notesHistoryRef.current = notesHistory;
    // Mark as unsaved when notes change (but not on initial load)
    if (notesInitializedRef.current) {
      setHasUnsavedChanges(true);
    } else if (notesHistory.length > 0) {
      notesInitializedRef.current = true;
    }
  }, [notesHistory]);

  useEffect(() => {
    // Mark as unsaved when transcription changes
    if (transcriptionText.length > 0) {
      setHasUnsavedChanges(true);
    }
  }, [transcriptionText]);

  // Track if we're currently saving to avoid marking as unsaved immediately after save
  const isSavingRef = useRef(false);

  // Mark as unsaved when sessions change (skip initial load and saves)
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (isSavingRef.current) {
      isSavingRef.current = false;
      return;
    }
    setHasUnsavedChanges(true);
  }, [sessions]);

  // Manual save function - syncs current working data to sessions before saving
  const saveToLocalStorage = useCallback(() => {
    try {
      // First, update the active session with current working data
      const updatedSessions = sessions.map((session) =>
        session.id === activeSessionId
          ? {
              ...session,
              notes: notesHistoryRef.current,
              transcriptionText: transcriptionTextRef.current,
            }
          : session
      );
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedSessions));
      // Mark that we're saving so the effect doesn't mark as unsaved
      isSavingRef.current = true;
      // Also update the sessions state to keep it in sync
      setSessions(updatedSessions);
      setHasUnsavedChanges(false);
      setLastSavedTime(new Date());
    } catch (err) {
      console.warn('Failed to save sessions to localStorage:', err);
      setError('Failed to save. Please try again.');
    }
  }, [sessions, activeSessionId]);

  // Keyboard shortcut for save (Ctrl+S / Cmd+S)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveToLocalStorage();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveToLocalStorage]);

  // Auto-save when recording stops (idle state) to prevent data loss
  const prevRecordingStateForSaveRef = useRef<RecordingState>('idle');
  useEffect(() => {
    const wasRecording = prevRecordingStateForSaveRef.current === 'recording';
    const isNowIdle = recordingState === 'idle';

    if (wasRecording && isNowIdle && hasUnsavedChanges) {
      saveToLocalStorage();
    }

    prevRecordingStateForSaveRef.current = recordingState;
  }, [recordingState, hasUnsavedChanges, saveToLocalStorage]);

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
    const nextId = getNextSessionId(sessions);
    const nextName = getNextSessionName(sessions);

    setSessions((prev) => prev.map((session) => (
      session.id === activeSessionId
        ? { ...session, notes: notesHistory, transcriptionText }
        : session
    )));

    const newSession: Session = {
      id: nextId,
      name: nextName,
      notes: [],
      transcriptionText: '',
    };

    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
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

  const handleDeleteSession = useCallback((sessionId: number, event: React.MouseEvent) => {
    event.stopPropagation();

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
      }

      return filtered;
    });
  }, [activeSessionId]);

  const handleRenameSession = useCallback((sessionId: number) => {
    const target = sessions.find((s) => s.id === sessionId);
    if (!target) return;

    const newName = window.prompt('Rename session', target.name);
    if (newName && newName.trim()) {
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, name: newName.trim() } : s))
      );
    }
  }, [sessions]);

  const handleSwitchSession = useCallback((sessionId: number) => {
    setSessions((prev) => prev.map((session) => (
      session.id === activeSessionId
        ? { ...session, notes: notesHistory, transcriptionText }
        : session
    )));

    const targetSession = sessions.find((session) => session.id === sessionId);
    if (targetSession) {
      setActiveSessionId(sessionId);
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
      const newVersion: VisualizationVersion = {
        svg: response.svg,
        description: response.description,
        newTextDelta: response.newTextDelta || response.originalText,
        timestamp: new Date(),
        generationMode: response.generationMode,
        similarityScore: response.similarityScore,
      };

      lastCapturedTextLengthRef.current = transcriptionTextRef.current.length;

      if (response.generationMode === 'enhanced') {
        // add to existing visualization's version history
        setNotesHistory((prev) => {
          if (prev.length === 0) {
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
            currentVersionIndex: newVersions.length - 1,
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

      lastCapturedTextLengthRef.current = transcriptionTextRef.current.length;

      if (response.generationMode === 'enhanced') {
        // add to existing chart's version history
        setNotesHistory((prev) => {
          if (prev.length === 0) {
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
            currentVersionIndex: newVersions.length - 1,
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

  const handleError = useCallback((errorMessage: string) => {
    setError(errorMessage);
    setIsGeneratingSVG(false);
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
          svg: version.svg,
          chartImage: version.chartImage,
          chartCode: version.chartCode,
          description: version.description,
          newTextDelta: version.newTextDelta,
          generationMode: version.generationMode,
          similarityScore: version.similarityScore,
          currentVersionIndex: newIndex,
        };
      });
    });
  }, []);

  const handleRealtimeTranscript = useCallback((text: string, _isFinal: boolean) => {
    setRealtimeTranscript(text);
  }, []);

  // Export functionality
  const getSessionContextForExport = useCallback(() => {
    const allSessionSVGs = notesHistory
      .filter((item) => item.type === 'svg' && typeof item.svg === 'string')
      .map((item) => item.svg as string);

    const allUserSpeechTexts = [
      ...notesHistory
        .map((item) => item.newTextDelta || item.originalText)
        .filter((text) => typeof text === 'string' && text.trim().length > 0),
      ...(transcriptionText.trim().length > 0 ? [transcriptionText] : []),
    ];

    return {
      allSessionSVGs,
      allUserSpeechTexts,
    };
  }, [notesHistory, transcriptionText]);

  const exportSessionAsTxt = useCallback(() => {
    const { allSessionSVGs, allUserSpeechTexts } = getSessionContextForExport();
    const activeSession = sessions.find((session) => session.id === activeSessionId);

    const exportBody = [
      'PRISM Session Export',
      `Session ID: ${activeSessionId}`,
      `Session Name: ${activeSession?.name ?? 'Unknown Session'}`,
      `Exported At: ${new Date().toISOString()}`,
      '',
      'allSessionSVGs:',
      JSON.stringify(allSessionSVGs, null, 2),
      '',
      'allUserSpeechTexts:',
      JSON.stringify(allUserSpeechTexts, null, 2),
      '',
    ].join('\n');

    const blob = new Blob([exportBody], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `session-${activeSessionId}-export.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [activeSessionId, getSessionContextForExport, sessions]);

  const exportSessionAsPdf = useCallback(async () => {
    const { allSessionSVGs, allUserSpeechTexts } = getSessionContextForExport();
    const activeSession = sessions.find((session) => session.id === activeSessionId);
    const chartItems = notesHistory.filter(
      (item) => item.type === 'chart' && typeof item.chartImage === 'string'
    );
    let llmSummary = 'Summary unavailable.';

    if (allUserSpeechTexts.length > 0) {
      try {
        const summaryResponse = await summarizeUserSpeech(allUserSpeechTexts);
        if (summaryResponse.summary && summaryResponse.summary.trim().length > 0) {
          llmSummary = summaryResponse.summary.trim();
        }
      } catch (summaryError) {
        console.warn('summary generation failed for PDF export:', summaryError);
      }
    }

    const speechItemsHtml =
      allUserSpeechTexts.length > 0
        ? allUserSpeechTexts
            .map(
              (text, index) => `
                <section class="card">
                  <h3>Speech ${index + 1}</h3>
                  <p>${escapeHtml(text)}</p>
                </section>
              `
            )
            .join('')
        : '<p class="empty">No user speech captured.</p>';

    const svgItemsHtml =
      allSessionSVGs.length > 0
        ? allSessionSVGs
            .map(
              (svg, index) => `
                <section class="card visualization-card">
                  <h3>SVG ${index + 1}</h3>
                  <div class="viz-container">
                    <div class="viz-svg">${svg}</div>
                  </div>
                </section>
              `
            )
            .join('')
        : '<p class="empty">No SVG visualizations captured.</p>';

    const chartItemsHtml =
      chartItems.length > 0
        ? chartItems
            .map((item, index) => {
              const textSnippet = escapeHtml(item.newTextDelta || item.originalText || '');
              const description = item.description ? escapeHtml(item.description) : '';
              const timestamp = new Date(item.timestamp).toLocaleString();

              return `
                <section class="card visualization-card">
                  <h3>Chart ${index + 1}</h3>
                  <div class="meta">
                    <div><strong>Timestamp:</strong> ${escapeHtml(timestamp)}</div>
                    <div><strong>Confidence:</strong> ${
                      typeof item.chartConfidence === 'number'
                        ? `${(item.chartConfidence * 100).toFixed(0)}%`
                        : 'n/a'
                    }</div>
                  </div>
                  <p><strong>Text:</strong> ${textSnippet}</p>
                  ${description ? `<p><strong>Description:</strong> ${description}</p>` : ''}
                  <div class="viz-container">
                    <img class="viz-image" src="data:image/png;base64,${item.chartImage}" alt="Chart ${index + 1}" />
                  </div>
                </section>
              `;
            })
            .join('')
        : '<p class="empty">No chart visualizations captured.</p>';

    const html = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Session ${activeSessionId} Export</title>
          <style>
            * { box-sizing: border-box; }
            body {
              margin: 0;
              padding: 28px;
              font-family: Inter, Arial, sans-serif;
              color: #111827;
              background: #ffffff;
              line-height: 1.5;
            }
            h1 { margin: 0 0 6px; font-size: 24px; }
            h2 { margin: 26px 0 12px; font-size: 18px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
            h3 { margin: 0 0 8px; font-size: 14px; }
            p { margin: 0 0 10px; white-space: pre-wrap; word-break: break-word; }
            .subtle { color: #4b5563; font-size: 12px; }
            .card {
              border: 1px solid #d1d5db;
              border-radius: 10px;
              padding: 12px;
              margin-bottom: 10px;
              page-break-inside: avoid;
              break-inside: avoid;
            }
            .meta {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 8px;
              margin-bottom: 8px;
              font-size: 12px;
              color: #374151;
            }
            .viz-container {
              margin-top: 10px;
              border: 1px solid #e5e7eb;
              border-radius: 8px;
              padding: 8px;
              background: #fafafa;
              min-height: 220px;
            }
            .viz-image {
              width: 100%;
              height: auto;
              display: block;
            }
            .viz-svg svg {
              width: 100% !important;
              height: auto !important;
              display: block;
            }
            .empty { color: #6b7280; font-style: italic; }
            .summary {
              margin-top: 12px;
              font-size: 12px;
              color: #374151;
            }
            @media print {
              body { padding: 14mm; }
            }
          </style>
        </head>
        <body>
          <h1>PRISM Session Export</h1>
          <div class="subtle">Session ID: ${activeSessionId}</div>
          <div class="subtle">Session Name: ${escapeHtml(activeSession?.name ?? 'Unknown Session')}</div>
          <div class="subtle">Exported At: ${escapeHtml(new Date().toISOString())}</div>
          <div class="summary">
            <div><strong>Speech Items:</strong> ${allUserSpeechTexts.length}</div>
            <div><strong>SVG Items:</strong> ${allSessionSVGs.length}</div>
            <div><strong>Chart Items:</strong> ${chartItems.length}</div>
          </div>

          <h2>User Speech / Text</h2>
          ${speechItemsHtml}

          <h2>SVG Visualizations</h2>
          ${svgItemsHtml}

          <h2>Chart Visualizations</h2>
          ${chartItemsHtml}

          <h2>LLM Summary</h2>
          <section class="card">
            <p>${escapeHtml(llmSummary)}</p>
          </section>

          <script>
            window.addEventListener('load', () => {
              setTimeout(() => {
                window.print();
              }, 350);
            });
          </script>
        </body>
      </html>
    `;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);
    const printWindow = window.open(blobUrl, '_blank');
    if (!printWindow) {
      setError('Unable to open export window. Please allow pop-ups and try again.');
      URL.revokeObjectURL(blobUrl);
      return;
    }

    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  }, [activeSessionId, getSessionContextForExport, notesHistory, sessions]);

  const exportSessionAsPptx = useCallback(async () => {
    const { allSessionSVGs, allUserSpeechTexts } = getSessionContextForExport();
    const activeSession = sessions.find((session) => session.id === activeSessionId);
    const visualizationItems = notesHistory.filter(
      (item) => item.type === 'svg' || item.type === 'chart'
    );
    const cleanSpeechTexts = allUserSpeechTexts
      .map((text) => text.replace(/\s+/g, ' ').trim())
      .filter((text) => text.length > 0);

    let llmSummary = 'Summary unavailable.';
    if (cleanSpeechTexts.length > 0) {
      try {
        const summaryResponse = await summarizeUserSpeech(cleanSpeechTexts);
        if (summaryResponse.summary && summaryResponse.summary.trim().length > 0) {
          llmSummary = summaryResponse.summary.trim();
        }
      } catch (summaryError) {
        console.warn('summary generation failed for PPTX export:', summaryError);
      }
    }

    try {
      const pptx = new PptxGenJS();
      pptx.layout = 'LAYOUT_WIDE';
      pptx.author = 'PRISM';
      pptx.company = 'PRISM';
      pptx.subject = 'Voice Session Export';
      pptx.title = `Session ${activeSessionId} Export`;
      const palette = {
        bg: 'F8FAFC',
        surface: 'FFFFFF',
        ink: '0F172A',
        muted: '475569',
        accent: '334155',
        accentSoft: 'F1F5F9',
        border: 'E2E8F0',
      };
      const deckName = activeSession?.name ?? `Session ${activeSessionId}`;
      const exportedAt = new Date().toLocaleString();
      let slideNumber = 0;

      const addSlideChrome = (slide: ReturnType<typeof pptx.addSlide>, title: string, subtitle?: string) => {
        slideNumber += 1;
        slide.background = { color: palette.bg };
        slide.addShape('rect', {
          x: 0,
          y: 0,
          w: 13.33,
          h: 0.95,
          fill: { color: palette.accent },
          line: { color: palette.accent, width: 0 },
        });
        slide.addText(title, {
          x: 0.55,
          y: 0.20,
          w: 9.4,
          h: 0.45,
          fontFace: 'Aptos Display',
          fontSize: 24,
          bold: true,
          color: 'FFFFFF',
          fit: 'shrink',
        });
        if (subtitle) {
          slide.addText(subtitle, {
            x: 0.55,
            y: 0.64,
            w: 9.8,
            h: 0.22,
            fontFace: 'Aptos',
            fontSize: 11,
            color: 'E0E7FF',
            fit: 'shrink',
          });
        }

        slide.addText(`${deckName}  •  Slide ${slideNumber}`, {
          x: 9.5,
          y: 0.26,
          w: 3.3,
          h: 0.24,
          fontFace: 'Aptos',
          fontSize: 11,
          color: 'E0E7FF',
          align: 'right',
          fit: 'shrink',
        });

        slide.addShape('rect', {
          x: 0.45,
          y: 7.1,
          w: 12.4,
          h: 0.02,
          fill: { color: palette.border },
          line: { color: palette.border, width: 0 },
        });
      };

      const addMetricCard = (
        slide: ReturnType<typeof pptx.addSlide>,
        label: string,
        value: string,
        x: number
      ) => {
        slide.addShape('roundRect', {
          x,
          y: 2.6,
          w: 2.9,
          h: 1.3,
          fill: { color: palette.surface },
          line: { color: palette.border, width: 1.2 },
          shadow: { type: 'outer', color: 'BFC7DB', blur: 2, angle: 45, offset: 1, opacity: 0.2 },
        });
        slide.addText(label, {
          x: x + 0.2,
          y: 2.82,
          w: 2.5,
          h: 0.26,
          fontFace: 'Aptos',
          fontSize: 11,
          color: '64748B',
          align: 'center',
          fit: 'shrink',
        });
        slide.addText(value, {
          x: x + 0.2,
          y: 3.08,
          w: 2.5,
          h: 0.46,
          fontFace: 'Aptos Display',
          fontSize: 26,
          bold: true,
          color: palette.ink,
          align: 'center',
          fit: 'shrink',
        });
      };

      // title slide
      const titleSlide = pptx.addSlide();
      addSlideChrome(titleSlide, 'PRISM Session Export', `Exported ${exportedAt}`);
      titleSlide.addText(deckName, {
        x: 0.62,
        y: 1.4,
        w: 8.6,
        h: 0.7,
        fontFace: 'Aptos Display',
        fontSize: 38,
        bold: true,
        color: palette.ink,
        fit: 'shrink',
      });
      titleSlide.addText(
        'Voice notes, generated visuals, and an LLM summary organized for presentation.',
        {
          x: 0.65,
          y: 2.1,
          w: 8.2,
          h: 0.55,
          fontFace: 'Aptos',
          fontSize: 15,
          color: palette.muted,
          fit: 'shrink',
        }
      );
      addMetricCard(titleSlide, 'Speech Segments', `${cleanSpeechTexts.length}`, 0.65);
      addMetricCard(titleSlide, 'SVG Outputs', `${allSessionSVGs.length}`, 3.8);
      addMetricCard(titleSlide, 'Visual Items', `${visualizationItems.length}`, 6.95);

      // speech slides
      if (cleanSpeechTexts.length > 0) {
        const numberedSpeech = cleanSpeechTexts.map(
          (text, index) => `${index + 1}. ${text}`
        );
        const maxOverviewSlides = 2;
        const maxCharsPerSlide = 3200;
        const speechOverviewPages: string[] = [];
        let currentPage = '';

        for (let i = 0; i < numberedSpeech.length; i += 1) {
          const entry = numberedSpeech[i];
          const candidate = currentPage ? `${currentPage}\n\n${entry}` : entry;

          if (candidate.length <= maxCharsPerSlide) {
            currentPage = candidate;
            continue;
          }

          if (speechOverviewPages.length < maxOverviewSlides - 1) {
            speechOverviewPages.push(currentPage);
            currentPage = entry;
            continue;
          }

          const remainingEntries = numberedSpeech.length - i;
          if (currentPage.length > 0) {
            currentPage += `\n\n…plus ${remainingEntries} more entries in session history.`;
          } else {
            currentPage = `${entry}\n\n…plus ${Math.max(0, remainingEntries - 1)} more entries in session history.`;
          }
          break;
        }

        if (currentPage.length > 0) {
          speechOverviewPages.push(currentPage);
        }

        speechOverviewPages.forEach((pageText, pageIndex) => {
          const slide = pptx.addSlide();
          slideNumber += 1;
          slide.background = { color: 'FFFFFF' };

          slide.addText('Captured User Speech', {
            x: 0.65,
            y: 0.46,
            w: 8.6,
            h: 0.52,
            fontFace: 'Aptos Display',
            fontSize: 30,
            bold: true,
            color: palette.ink,
            fit: 'shrink',
          });
          slide.addText(`Overview ${pageIndex + 1} of ${speechOverviewPages.length}`, {
            x: 0.67,
            y: 0.97,
            w: 4.6,
            h: 0.25,
            fontFace: 'Aptos',
            fontSize: 12,
            color: palette.muted,
            fit: 'shrink',
          });
          slide.addText(`${deckName}  •  Slide ${slideNumber}`, {
            x: 9.15,
            y: 0.62,
            w: 3.5,
            h: 0.3,
            fontFace: 'Aptos',
            fontSize: 11,
            color: '94A3B8',
            align: 'right',
            fit: 'shrink',
          });
          slide.addShape('line', {
            x: 0.65,
            y: 1.22,
            w: 12.0,
            h: 0,
            line: { color: palette.border, width: 1 },
          });

          slide.addShape('rect', {
            x: 0.65,
            y: 1.52,
            w: 12.0,
            h: 5.32,
            fill: { color: 'F8FAFC' },
            line: { color: palette.border, width: 1 },
          });
          slide.addText('Session Speech Overview', {
            x: 0.96,
            y: 1.8,
            w: 5.2,
            h: 0.3,
            fontFace: 'Aptos',
            fontSize: 13,
            bold: true,
            color: palette.muted,
          });
          slide.addText(pageText, {
            x: 0.96,
            y: 2.18,
            w: 11.2,
            h: 4.5,
            fontFace: 'Aptos',
            fontSize: 19,
            color: palette.ink,
            valign: 'top',
            fit: 'shrink',
            breakLine: true,
          });
        });
      }

      // visualization slides
      for (let i = 0; i < visualizationItems.length; i += 1) {
        const item = visualizationItems[i];
        const slide = pptx.addSlide();
        addSlideChrome(
          slide,
          `${item.type === 'chart' ? 'Chart' : 'SVG'} Visualization`,
          `Item ${i + 1} of ${visualizationItems.length}`
        );

        const timestamp = new Date(item.timestamp).toLocaleString();
        const textSnippet = (item.newTextDelta || item.originalText || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 420);

        // left metadata panel
        slide.addShape('roundRect', {
          x: 0.62,
          y: 1.18,
          w: 4.25,
          h: 5.58,
          fill: { color: palette.surface },
          line: { color: palette.border, width: 1 },
        });
        slide.addText('Metadata', {
          x: 0.9,
          y: 1.42,
          w: 3.4,
          h: 0.3,
          fontFace: 'Aptos',
          fontSize: 14,
          bold: true,
          color: palette.accent,
        });
        slide.addText(`Type: ${item.type.toUpperCase()}`, {
          x: 0.9,
          y: 1.78,
          w: 3.65,
          h: 0.34,
          fontFace: 'Aptos',
          fontSize: 13,
          color: palette.muted,
          fit: 'shrink',
        });
        slide.addText(`Mode: ${(item.generationMode || 'unknown').replace(/_/g, ' ')}`, {
          x: 0.9,
          y: 2.14,
          w: 3.65,
          h: 0.34,
          fontFace: 'Aptos',
          fontSize: 13,
          color: palette.muted,
          fit: 'shrink',
        });
        slide.addText(`Time: ${timestamp}`, {
          x: 0.9,
          y: 2.50,
          w: 3.65,
          h: 0.52,
          fontFace: 'Aptos',
          fontSize: 13,
          color: palette.muted,
          fit: 'shrink',
        });
        slide.addText('Prompt Excerpt', {
          x: 0.9,
          y: 3.08,
          w: 3.4,
          h: 0.34,
          fontFace: 'Aptos',
          fontSize: 14,
          bold: true,
          color: palette.accent,
        });
        slide.addText(textSnippet || 'No source text available.', {
          x: 0.9,
          y: 3.5,
          w: 3.65,
          h: 2.96,
          fontFace: 'Aptos',
          fontSize: 18,
          color: palette.ink,
          valign: 'top',
          breakLine: true,
          fit: 'shrink',
        });

        // right visualization panel
        slide.addShape('roundRect', {
          x: 5.12,
          y: 1.18,
          w: 7.55,
          h: 5.58,
          fill: { color: palette.surface },
          line: { color: palette.border, width: 1 },
        });

        let imageData = '';
        if (item.type === 'chart' && item.chartImage) {
          imageData = `data:image/png;base64,${item.chartImage}`;
        } else if (item.type === 'svg' && item.svg) {
          try {
            imageData = await svgMarkupToPngDataUrl(item.svg);
          } catch (conversionError) {
            console.warn('SVG to PNG conversion failed for PPTX:', conversionError);
          }
        }

        if (imageData) {
          slide.addImage({
            data: imageData,
            x: 5.3,
            y: 1.34,
            w: 7.18,
            h: 5.22,
          });
        } else {
          slide.addShape('roundRect', {
            x: 5.72,
            y: 3.0,
            w: 6.65,
            h: 1.8,
            fill: { color: palette.accentSoft },
            line: { color: palette.border, width: 1 },
          });
          slide.addText('Visualization preview unavailable for this item.', {
            x: 5.9,
            y: 3.58,
            w: 6.2,
            h: 0.56,
            fontFace: 'Aptos',
            fontSize: 20,
            color: palette.muted,
            align: 'center',
            fit: 'shrink',
          });
        }
      }

      // summary slide
      const summarySlide = pptx.addSlide();
      addSlideChrome(summarySlide, 'LLM Session Summary', 'Generated from captured speech');
      summarySlide.addShape('roundRect', {
        x: 0.62,
        y: 1.25,
        w: 12.05,
        h: 5.95,
        fill: { color: palette.surface },
        line: { color: palette.border, width: 1 },
      });
      summarySlide.addText('Executive Readout', {
        x: 0.92,
        y: 1.52,
        w: 11.3,
        h: 0.38,
        fontFace: 'Aptos',
        fontSize: 14,
        bold: true,
        color: palette.accent,
      });
      summarySlide.addText(llmSummary, {
        x: 0.92,
        y: 1.95,
        w: 11.3,
        h: 5.0,
        fontFace: 'Aptos',
        fontSize: 25,
        color: palette.ink,
        valign: 'top',
        fit: 'shrink',
        breakLine: true,
      });

      const fileBase = sanitizeFilename(activeSession?.name ?? `session-${activeSessionId}`);
      await pptx.writeFile({ fileName: `${fileBase}-export.pptx` });
    } catch (exportError) {
      console.error('PPTX export failed:', exportError);
      setError('PowerPoint export failed. Please try again.');
    }
  }, [activeSessionId, getSessionContextForExport, notesHistory, sessions]);

  const hasExportableData =
    notesHistory.length > 0 || transcriptionText.trim().length > 0;
  const canShowExport =
    recordingState === 'idle' && !isGeneratingSVG && hasExportableData;

  const prevRecordingStateRef = useRef<RecordingState>('idle');

  const handleRecordingStateChange = useCallback((state: RecordingState) => {
    const prevState = prevRecordingStateRef.current;

    if (prevState === state) {
      return;
    }

    prevRecordingStateRef.current = state;
    setRecordingState(state);

    if (state === 'recording' && prevState !== 'recording') {
      // Don't clear notesHistory - keep existing notes when starting new recording
      // Notes are only cleared when explicitly creating a new session
      setTranscriptionText('');
      setRealtimeTranscript('');
      setError(null);
      setVisualizationActive(false);
      // Don't reset idCounterRef or notesHistory to preserve existing notes
      lastCapturedTextLengthRef.current = 0;
      // Don't reset activeSlideIndex to stay on current slide
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
    // Create one slide per item - each visualization gets its own page
    const pages: SlidePage[] = [];

    slideSources.forEach((source, index) => {
      const hasVisual = source.type === 'chart'
        || (source.type === 'svg' && isRenderableSvg(source.svg));
      let text = source.newTextDelta.trim();

      if (!text) {
        text = hasVisual
          ? 'Visualization generated from your latest notes.'
          : source.type === 'live'
          ? 'Listening...'
          : 'Note captured.';
      }

      const item: SlideRenderItem = {
        ...source,
        key: `${source.id}-0`,
        text,
        svg: source.svg,
        chartImage: source.chartImage,
        isContinuation: false,
      };

      // Each item gets its own page/slide
      pages.push({
        id: index + 1,
        items: [item],
      });
    });

    // Always have at least one empty page
    if (pages.length === 0) {
      pages.push({ id: 1, items: [] });
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
    // only clamp if current index is out of bounds
    setActiveSlideIndex((prev) => Math.min(prev, Math.max(totalSlides - 1, 0)));
  }, [totalSlides]);

  // track visualization session changes - only advance slide when NEW prism session starts
  const prevVisualizationActiveRef = useRef(visualizationActive);
  useEffect(() => {
    // detect transition: visualization was OFF, now ON (new prism session started)
    if (visualizationActive && !prevVisualizationActiveRef.current) {
      // new visualization session started - go to latest slide
      setActiveSlideIndex(Math.max(totalSlides - 1, 0));
    }
    prevVisualizationActiveRef.current = visualizationActive;
  }, [visualizationActive, totalSlides]);

  // DON'T auto-advance during a session - removed the auto-advance on totalSlides change
  useEffect(() => {
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
    <div className="board-layout">
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
              <span
                className="session-label"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  handleRenameSession(session.id);
                }}
                title="Double-click to rename"
              >
                {isSidebarCollapsed ? getSessionShortLabel(session.name) : session.name}
              </span>
              <button
                type="button"
                className="session-delete"
                onClick={(event) => handleDeleteSession(session.id, event)}
                aria-label={`Delete ${session.name}`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
              </button>
            </div>
          ))}
        </div>

        <div className="board-sidebar-footer">
          {!isSidebarCollapsed && (
            <>
              <details className="export-dropdown">
                <summary className={`board-footer-link ${!canShowExport ? 'disabled' : ''}`}>
                  Export
                </summary>
                <div className="export-dropdown-menu">
                  <button
                    type="button"
                    disabled={!canShowExport}
                    onClick={(event) => {
                      exportSessionAsTxt();
                      const details = event.currentTarget.closest('details');
                      if (details instanceof HTMLDetailsElement) {
                        details.open = false;
                      }
                    }}
                  >
                    .txt
                  </button>
                  <button
                    type="button"
                    disabled={!canShowExport}
                    onClick={(event) => {
                      void exportSessionAsPdf();
                      const details = event.currentTarget.closest('details');
                      if (details instanceof HTMLDetailsElement) {
                        details.open = false;
                      }
                    }}
                  >
                    .pdf
                  </button>
                  <button
                    type="button"
                    disabled={!canShowExport}
                    onClick={(event) => {
                      void exportSessionAsPptx();
                      const details = event.currentTarget.closest('details');
                      if (details instanceof HTMLDetailsElement) {
                        details.open = false;
                      }
                    }}
                  >
                    .pptx
                  </button>
                </div>
              </details>
              <div className="save-status-indicator">
                <span className={`save-status-dot ${hasUnsavedChanges ? 'unsaved' : 'saved'}`} />
                <span className="save-status-text">
                  {hasUnsavedChanges
                    ? 'Unsaved changes'
                    : lastSavedTime
                    ? `Saved ${lastSavedTime.toLocaleTimeString()}`
                    : 'Saved'}
                </span>
                {hasUnsavedChanges && (
                  <button
                    type="button"
                    className="save-button"
                    onClick={saveToLocalStorage}
                    title="Save (Ctrl+S / Cmd+S)"
                  >
                    Save
                  </button>
                )}
              </div>
              <div className="board-brand-row">
                <PrismLogo />
                <p className="board-brand">PRISM</p>
              </div>
              <button type="button" className="board-footer-link">Settings</button>
              <button type="button" className="board-footer-link">Updates & FAQ</button>
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

              {/* Version navigation arrows for visualizations with multiple versions */}
              {(() => {
                const originalItem = notesHistory.find(n => n.id === activeVisual?.id);
                if (!originalItem?.versions || originalItem.versions.length <= 1) return null;
                const currentIdx = originalItem.currentVersionIndex ?? originalItem.versions.length - 1;
                const totalVersions = originalItem.versions.length;
                return (
                  <div className="version-nav">
                    <button
                      type="button"
                      className="version-nav-button"
                      disabled={currentIdx === 0}
                      onClick={() => handleVersionChange(originalItem.id, 'prev')}
                      aria-label="Previous version"
                    >
                      &larr;
                    </button>
                    <span className="version-nav-label">
                      {currentIdx + 1} / {totalVersions}
                    </span>
                    <button
                      type="button"
                      className="version-nav-button"
                      disabled={currentIdx === totalVersions - 1}
                      onClick={() => handleVersionChange(originalItem.id, 'next')}
                      aria-label="Next version"
                    >
                      &rarr;
                    </button>
                  </div>
                );
              })()}
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
          <div className="control-start-text">
            <p>Click To Start</p>
            <p className="control-subtext">
              {recordingState === 'idle' ? 'voice capture' : 'live transcription'}
            </p>
          </div>

          <div className="control-recorder-wrap">
            <AudioRecorder
              onTranscription={handleTranscription}
              onSVGGenerated={handleSVGGenerated}
              onChartGenerated={handleChartGenerated}
              onError={handleError}
              onRecordingStateChange={handleRecordingStateChange}
              onRealtimeTranscript={handleRealtimeTranscript}
              compact
            />
          </div>

          <div className="control-statuses">
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
