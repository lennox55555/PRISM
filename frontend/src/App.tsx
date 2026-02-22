import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { AudioRecorder } from './components/AudioRecorder';
import { summarizeUserSpeech, SpeechSummaryResponse } from './services/api';
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
  summary?: string;  // stored summary for this version
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
  summary?: string;  // stored summary for this slide
  // version history for enhanced visualizations
  versions?: VisualizationVersion[];
  currentVersionIndex?: number;
  // session ID for grouping visualizations from same prism session
  sessionId?: string;
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
  summary?: string;
}

interface SlideRenderItem extends SlideSourceItem {
  key: string;
  text: string;
  isContinuation: boolean;
  summary?: string;
}

interface SlidePage {
  id: number;
  items: SlideRenderItem[];
}

type NotesMode = 'transcript' | 'summary';
type SummaryStatus = 'idle' | 'updating' | 'ready' | 'error';

interface SummaryLineGroups {
  bulletLines: string[];
  paragraphLines: string[];
}

interface LiveSummaryDebug {
  provider: string;
  model: string;
  fallbackUsed: boolean;
  itemCount: number;
  inputCharacters: number;
  elapsedMs: number;
  updatedAt: Date;
}

function chunkTranscriptForSummary(text: string, maxChunkLength = 320): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return [];
  }

  const sentenceLikeParts = normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const chunks: string[] = [];
  let currentChunk = '';

  for (const part of sentenceLikeParts) {
    const candidate = currentChunk ? `${currentChunk} ${part}` : part;
    if (candidate.length <= maxChunkLength) {
      currentChunk = candidate;
      continue;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }
    currentChunk = part.slice(0, maxChunkLength);
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks.slice(-40);
}

function groupSummaryLines(summary: string): SummaryLineGroups {
  const lines = summary
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const bulletLines: string[] = [];
  const paragraphLines: string[] = [];

  lines.forEach((line) => {
    const match = line.match(/^([*-]|\u2022|\d+[.)])\s+(.+)$/);
    if (match && match[2]) {
      bulletLines.push(match[2].trim());
    } else {
      paragraphLines.push(line);
    }
  });

  return { bulletLines, paragraphLines };
}


function isRenderableSvg(svgCode?: string): boolean {
  if (!svgCode) {
    return false;
  }

  const trimmed = svgCode.trim();
  return /^<svg[\s>]/i.test(trimmed) && /<\/svg>\s*$/i.test(trimmed);
}

function getSessionShortLabel(name: string): string {
  const trimmed = name.trim();
  const initials = trimmed
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0))
    .join('')
    .toUpperCase();
  return initials || 'S';
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

function normalizePrismWord(value: string): string {
  // Preserve transcript content except common misrecognitions of "prism".
  // Handles: prison, prisons, prizm, présume, presume, pris, prysm, prisim, preson, presom
  return value
    .replace(/\bpri(?:son|sions?|zz?m|sim|szm)\b/gi, 'prism')
    .replace(/\bpr[eé]s(?:ume|om)\b/gi, 'prism')
    .replace(/\bprysm\b/gi, 'prism')
    .replace(/\bpres?on\b/gi, 'prism');
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
  const [expandedSessionActions, setExpandedSessionActions] = useState<number | null>(null);
  const [notesMode, setNotesMode] = useState<NotesMode>('transcript');
  const [liveSummary, setLiveSummary] = useState('');
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus>('idle');
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryDebug, setSummaryDebug] = useState<LiveSummaryDebug | null>(null);
  const [pendingNewTopicNavigation, setPendingNewTopicNavigation] = useState(false);
  const [slideAnimationClass, setSlideAnimationClass] = useState<'page-turn-left' | 'page-turn-right' | ''>('');

  const idCounterRef = useRef(0);
  const lastCapturedTextLengthRef = useRef(0);
  const summaryRequestIdRef = useRef(0);
  const lastSummarySourceKeyRef = useRef('');
  const lastSummarizedLengthRef = useRef(0);
  const hasRealtimeTranscriptRef = useRef(false);
  const liveSummaryRef = useRef(liveSummary);
  // Track when we should navigate to a new slide (set when prism is said again after existing slides)
  const shouldNavigateOnNewSlideRef = useRef(false);

  const transcriptionTextRef = useRef(transcriptionText);
  const notesHistoryRef = useRef(notesHistory);

  useEffect(() => {
    transcriptionTextRef.current = transcriptionText;
  }, [transcriptionText]);

  useEffect(() => {
    liveSummaryRef.current = liveSummary;
  }, [liveSummary]);

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

  const summaryInputSegments = useMemo(
    () => chunkTranscriptForSummary(transcriptionText),
    [transcriptionText]
  );
  const summaryInputKey = useMemo(
    () => summaryInputSegments.join('\n'),
    [summaryInputSegments]
  );
  const summaryLineGroups = useMemo(
    () => groupSummaryLines(liveSummary),
    [liveSummary]
  );

  const requestLiveSummary = useCallback(
    async (segments: string[], sourceKey: string) => {
      const requestId = summaryRequestIdRef.current + 1;
      summaryRequestIdRef.current = requestId;
      setSummaryStatus('updating');
      setSummaryError(null);

      try {
        const response: SpeechSummaryResponse = await summarizeUserSpeech(segments);
        if (requestId !== summaryRequestIdRef.current) {
          return;
        }

        const nextSummary = response.summary?.trim() || '- Summary unavailable.';
        setLiveSummary(nextSummary);
        setSummaryStatus('ready');
        setSummaryDebug({
          provider: response.provider || 'unknown',
          model: response.model || 'unknown',
          fallbackUsed: Boolean(response.fallback_used),
          itemCount: response.item_count ?? segments.length,
          inputCharacters: response.input_characters ?? segments.join(' ').length,
          elapsedMs: response.elapsed_ms ?? 0,
          updatedAt: new Date(),
        });
        lastSummarySourceKeyRef.current = sourceKey;
        lastSummarizedLengthRef.current = segments.join(' ').length;

        console.debug('[live-summary] updated', {
          provider: response.provider,
          model: response.model,
          items: response.item_count,
          chars: response.input_characters,
          elapsedMs: response.elapsed_ms,
          fallback: response.fallback_used,
        });
      } catch (summaryRequestError) {
        if (requestId !== summaryRequestIdRef.current) {
          return;
        }

        const message = summaryRequestError instanceof Error
          ? summaryRequestError.message
          : 'Summary generation failed.';
        setSummaryStatus('error');
        setSummaryError(message);
        console.error('[live-summary] request failed:', summaryRequestError);
      }
    },
    []
  );

  useEffect(() => {
    if (notesMode !== 'summary') {
      return;
    }

    const normalizedLength = transcriptionText.trim().length;
    if (!normalizedLength || summaryInputSegments.length === 0) {
      setLiveSummary('');
      setSummaryStatus('idle');
      setSummaryError(null);
      setSummaryDebug(null);
      lastSummarySourceKeyRef.current = '';
      lastSummarizedLengthRef.current = 0;
      return;
    }

    if (summaryInputKey === lastSummarySourceKeyRef.current) {
      return;
    }

    // reduce request volume while recording by requiring meaningful transcript growth.
    const deltaSinceLastSummary = Math.abs(normalizedLength - lastSummarizedLengthRef.current);
    if (recordingState === 'recording' && deltaSinceLastSummary < 40) {
      return;
    }

    const delayMs = recordingState === 'recording' ? 1100 : 300;
    const timeoutId = window.setTimeout(() => {
      void requestLiveSummary(summaryInputSegments, summaryInputKey);
    }, delayMs);

    return () => window.clearTimeout(timeoutId);
  }, [
    notesMode,
    recordingState,
    requestLiveSummary,
    summaryInputKey,
    summaryInputSegments,
    transcriptionText,
  ]);

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
    hasRealtimeTranscriptRef.current = false;
    setIsGeneratingSVG(false);
    setVisualizationActive(false);
    setError(null);
    setActiveSlideIndex(0);
    setLiveSummary('');
    setSummaryStatus('idle');
    setSummaryError(null);
    setSummaryDebug(null);
    idCounterRef.current = 0;
    lastCapturedTextLengthRef.current = 0;
    lastSummarySourceKeyRef.current = '';
    lastSummarizedLengthRef.current = 0;
  }, [activeSessionId, notesHistory, sessions, transcriptionText]);

  const handleDeleteSession = useCallback((sessionId: number, event?: React.MouseEvent) => {
    event?.stopPropagation();

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
        hasRealtimeTranscriptRef.current = false;
        setLiveSummary('');
        setSummaryStatus('idle');
        setSummaryError(null);
        setSummaryDebug(null);
        setActiveSlideIndex(0);
        lastSummarySourceKeyRef.current = '';
        lastSummarizedLengthRef.current = 0;
        return [fallbackSession];
      }

      if (sessionId === activeSessionId) {
        setActiveSessionId(filtered[0].id);
        setNotesHistory(filtered[0].notes);
        setTranscriptionText(filtered[0].transcriptionText);
        hasRealtimeTranscriptRef.current = false;
        setLiveSummary('');
        setSummaryStatus('idle');
        setSummaryError(null);
        setSummaryDebug(null);
        lastSummarySourceKeyRef.current = '';
        lastSummarizedLengthRef.current = 0;
      }

      return filtered;
    });
  }, [activeSessionId]);

  // Clear all local storage data and reset to fresh state
  const handleClearAllData = useCallback(() => {
    if (!window.confirm('Are you sure you want to clear ALL data? This cannot be undone.')) {
      return;
    }

    // Clear localStorage
    localStorage.removeItem(STORAGE_KEY);

    // Reset to fresh state
    const freshSession: Session = {
      id: 1,
      name: 'Session 1',
      notes: [],
      transcriptionText: '',
    };

    setSessions([freshSession]);
    setActiveSessionId(1);
    setNotesHistory([]);
    setTranscriptionText('');
    setRealtimeTranscript('');
    hasRealtimeTranscriptRef.current = false;
    setLiveSummary('');
    setSummaryStatus('idle');
    setSummaryError(null);
    setSummaryDebug(null);
    setActiveSlideIndex(0);
    setHasUnsavedChanges(false);
    lastSummarySourceKeyRef.current = '';
    lastSummarizedLengthRef.current = 0;
    lastCapturedTextLengthRef.current = 0;
    idCounterRef.current = 1;

    console.log('All data cleared from localStorage');
  }, []);

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
      hasRealtimeTranscriptRef.current = false;
      setError(null);
      setIsGeneratingSVG(false);
      setActiveSlideIndex(0);
      setLiveSummary('');
      setSummaryStatus('idle');
      setSummaryError(null);
      setSummaryDebug(null);
      lastSummarySourceKeyRef.current = '';
      lastSummarizedLengthRef.current = 0;
    }
  }, [activeSessionId, notesHistory, sessions, transcriptionText]);

  const handleTranscription = useCallback((result: TranscriptionResult) => {
    // Check if this is a new session - clear text before adding new content
    if ((result as any).new_session) {
      console.log('[TRANSCRIPTION] New session started - clearing text and summary');
      setTranscriptionText('');
      setLiveSummary('');
      setRealtimeTranscript('');
      hasRealtimeTranscriptRef.current = false;
      lastCapturedTextLengthRef.current = 0;
    }

    // If browser realtime transcript is available, never overwrite it with backend chunks.
    const shouldUseBackendText = !hasRealtimeTranscriptRef.current;

    if (shouldUseBackendText) {
      if ((result as any).new_session) {
        // New session - start fresh with just the new text
        setTranscriptionText(normalizePrismWord(result.text || ''));
      } else if (result.accumulatedText) {
        setTranscriptionText(normalizePrismWord(result.accumulatedText));
      } else {
        setTranscriptionText((prev) => `${prev} ${normalizePrismWord(result.text)}`.trim());
      }
    }

    setError(null);

    // Backend sends snake_case: visualization_active
    if (typeof (result as any).visualization_active === 'boolean') {
      console.log('[PRISM] visualization_active received:', (result as any).visualization_active);
      setVisualizationActive((result as any).visualization_active);
    }
  }, []);

  const handleSVGGenerated = useCallback((response: SVGGenerationResponse) => {
    console.log('[SVG] ========== SVG RECEIVED ==========');
    console.log('[SVG] Generation mode:', response.generationMode);
    console.log('[SVG] Session ID:', response.sessionId);
    console.log('[SVG] Original text:', response.originalText?.substring(0, 80) + '...');

    const hasValidSvg = isRenderableSvg(response.svg);
    console.log('[SVG] Has valid SVG:', hasValidSvg);

    if (hasValidSvg && !response.error) {
      const newVersion: VisualizationVersion = {
        svg: response.svg,
        description: response.description,
        newTextDelta: response.newTextDelta || response.originalText,
        timestamp: new Date(),
        generationMode: response.generationMode,
        similarityScore: response.similarityScore,
        summary: liveSummaryRef.current || undefined,
      };

      lastCapturedTextLengthRef.current = transcriptionTextRef.current.length;
      const currentSummary = liveSummaryRef.current || undefined;

      // Check BEFORE state update whether we'll be creating a new slide
      const existingIndex = response.sessionId
        ? notesHistoryRef.current.findIndex(item => item.sessionId === response.sessionId)
        : -1;
      const willCreateNewSlide = existingIndex === -1;

      // Use sessionId to find existing note from same prism session
      setNotesHistory((prev) => {
        // Look for existing note with same sessionId
        const prevExistingIndex = response.sessionId
          ? prev.findIndex(item => item.sessionId === response.sessionId)
          : -1;

        console.log('[SVG] Looking for sessionId:', response.sessionId, 'found at index:', prevExistingIndex);

        if (prevExistingIndex !== -1) {
          // Found existing note with same sessionId - add as version
          console.log('[SVG] >>> ADDING VERSION to existing slide (sessionId match)');
          const updated = [...prev];
          const existingItem = updated[prevExistingIndex];
          const existingVersions = existingItem.versions || [{
            svg: existingItem.svg,
            description: existingItem.description,
            newTextDelta: existingItem.newTextDelta,
            timestamp: existingItem.timestamp,
            generationMode: existingItem.generationMode,
            similarityScore: existingItem.similarityScore,
            summary: existingItem.summary,
          }];

          const newVersions = [...existingVersions, newVersion];
          updated[prevExistingIndex] = {
            ...existingItem,
            svg: response.svg,
            description: response.description,
            newTextDelta: response.newTextDelta || response.originalText,
            generationMode: response.generationMode,
            similarityScore: response.similarityScore,
            similarityThreshold: response.similarityThreshold,
            summary: currentSummary,
            versions: newVersions,
            currentVersionIndex: newVersions.length - 1,
          };
          return updated;
        } else {
          // No existing note with this sessionId - create new slide
          console.log('[SVG] >>> CREATING NEW SLIDE (new sessionId)');
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
            summary: currentSummary,
            versions: [newVersion],
            currentVersionIndex: 0,
            sessionId: response.sessionId,
          };
          return [...prev, newItem];
        }
      });

      // If we created a new slide and should navigate (new prism session with existing slides)
      if (willCreateNewSlide && shouldNavigateOnNewSlideRef.current) {
        console.log('[SVG] Triggering navigation to new slide');
        shouldNavigateOnNewSlideRef.current = false;
        setPendingNewTopicNavigation(true);
      }
    }

    setIsGeneratingSVG(false);

    if (response.error) {
      setError(response.error);
    }
  }, []);

  const handleChartGenerated = useCallback((response: ChartGenerationResponse) => {
    console.log('[CHART] ========== CHART RECEIVED ==========');
    console.log('[CHART] Session ID:', response.sessionId);

    if (response.image && !response.error) {
      const currentSummary = liveSummaryRef.current || undefined;
      const newVersion: VisualizationVersion = {
        chartImage: response.image,
        chartCode: response.code,
        description: response.description,
        newTextDelta: response.newTextDelta || response.originalText,
        timestamp: new Date(),
        generationMode: response.generationMode,
        summary: currentSummary,
      };

      lastCapturedTextLengthRef.current = transcriptionTextRef.current.length;

      // Check BEFORE state update whether we'll be creating a new slide
      const existingIndex = response.sessionId
        ? notesHistoryRef.current.findIndex(item => item.sessionId === response.sessionId)
        : -1;
      const willCreateNewSlide = existingIndex === -1;

      // Use sessionId to find existing note from same prism session
      setNotesHistory((prev) => {
        const prevExistingIndex = response.sessionId
          ? prev.findIndex(item => item.sessionId === response.sessionId)
          : -1;

        console.log('[CHART] Looking for sessionId:', response.sessionId, 'found at index:', prevExistingIndex);

        if (prevExistingIndex !== -1) {
          // Found existing note with same sessionId - add as version
          console.log('[CHART] >>> ADDING VERSION to existing slide');
          const updated = [...prev];
          const existingItem = updated[prevExistingIndex];
          const existingVersions = existingItem.versions || [{
            chartImage: existingItem.chartImage,
            chartCode: existingItem.chartCode,
            description: existingItem.description,
            newTextDelta: existingItem.newTextDelta,
            timestamp: existingItem.timestamp,
            generationMode: existingItem.generationMode,
            summary: existingItem.summary,
          }];

          const newVersions = [...existingVersions, newVersion];
          updated[prevExistingIndex] = {
            ...existingItem,
            chartImage: response.image,
            chartCode: response.code,
            description: response.description,
            newTextDelta: response.newTextDelta || response.originalText,
            generationMode: response.generationMode,
            summary: currentSummary,
            versions: newVersions,
            currentVersionIndex: newVersions.length - 1,
          };
          return updated;
        } else {
          // No existing note with this sessionId - create new slide
          console.log('[CHART] >>> CREATING NEW SLIDE');
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
            generationMode: response.generationMode,
            summary: currentSummary,
            versions: [newVersion],
            currentVersionIndex: 0,
            sessionId: response.sessionId,
          };
          return [...prev, newItem];
        }
      });

      // If we created a new slide and should navigate (new prism session with existing slides)
      if (willCreateNewSlide && shouldNavigateOnNewSlideRef.current) {
        console.log('[CHART] Triggering navigation to new slide');
        shouldNavigateOnNewSlideRef.current = false;
        setPendingNewTopicNavigation(true);
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
    const normalized = normalizePrismWord(text);
    setRealtimeTranscript(normalized);
    if (normalized.trim().length > 0) {
      hasRealtimeTranscriptRef.current = true;
      setTranscriptionText(normalized);
    }
  }, []);

  // Export functionality
  const getSessionForExport = useCallback((sessionId: number) => {
    const targetSession = sessions.find((session) => session.id === sessionId);
    if (!targetSession) {
      return null;
    }

    if (sessionId !== activeSessionId) {
      return {
        session: targetSession,
        notes: targetSession.notes,
        transcriptionText: targetSession.transcriptionText,
      };
    }

    return {
      session: targetSession,
      notes: notesHistory,
      transcriptionText,
    };
  }, [activeSessionId, notesHistory, sessions, transcriptionText]);

  const getSessionContextForExport = useCallback((sessionId = activeSessionId) => {
    const targetData = getSessionForExport(sessionId);
    if (!targetData) {
      return null;
    }

    const { notes, transcriptionText: sessionTranscriptionText } = targetData;

    const allSessionSVGs = notes
      .filter((item) => item.type === 'svg' && typeof item.svg === 'string')
      .map((item) => item.svg as string);

    const allUserSpeechTexts = [
      ...notes
        .map((item) => item.newTextDelta || item.originalText)
        .filter((text) => typeof text === 'string' && text.trim().length > 0),
      ...(sessionTranscriptionText.trim().length > 0 ? [sessionTranscriptionText] : []),
    ];

    return {
      session: targetData.session,
      notes,
      allSessionSVGs,
      allUserSpeechTexts,
    };
  }, [activeSessionId, getSessionForExport]);

  const exportSessionAsTxt = useCallback((sessionId = activeSessionId) => {
    const sessionContext = getSessionContextForExport(sessionId);
    if (!sessionContext) {
      return;
    }
    const { allSessionSVGs, allUserSpeechTexts, session } = sessionContext;

    const exportBody = [
      'PRISM Session Export',
      `Session ID: ${session.id}`,
      `Session Name: ${session.name}`,
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
    a.download = `session-${session.id}-export.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [activeSessionId, getSessionContextForExport]);

  const exportSessionAsPdf = useCallback(async (sessionId = activeSessionId) => {
    const sessionContext = getSessionContextForExport(sessionId);
    if (!sessionContext) {
      return;
    }
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      setError('Unable to open export window. Please allow pop-ups and try again.');
      return;
    }

    printWindow.document.write(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Preparing Export...</title>
          <style>
            body {
              margin: 0;
              min-height: 100vh;
              display: grid;
              place-items: center;
              font-family: Inter, Arial, sans-serif;
              color: #111827;
              background: #ffffff;
            }
          </style>
        </head>
        <body>
          <p>Preparing PDF export...</p>
        </body>
      </html>
    `);
    printWindow.document.close();

    const { allSessionSVGs, allUserSpeechTexts, notes, session } = sessionContext;
    const chartItems = notes.filter(
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
          <title>Session ${session.id} Export</title>
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
          <div class="subtle">Session ID: ${session.id}</div>
          <div class="subtle">Session Name: ${escapeHtml(session.name)}</div>
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

    if (printWindow.closed) {
      setError('Export window was closed before the PDF was ready.');
      return;
    }

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
  }, [activeSessionId, getSessionContextForExport]);

  const exportSessionAsPptx = useCallback(async (sessionId = activeSessionId) => {
    const sessionContext = getSessionContextForExport(sessionId);
    if (!sessionContext) {
      return;
    }
    const { allSessionSVGs, allUserSpeechTexts, notes, session } = sessionContext;
    const visualizationItems = notes.filter(
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
      pptx.title = `Session ${session.id} Export`;
      const palette = {
        bg: 'F8FAFC',
        surface: 'FFFFFF',
        ink: '0F172A',
        muted: '475569',
        accent: '334155',
        accentSoft: 'F1F5F9',
        border: 'E2E8F0',
      };
      const deckName = session.name ?? `Session ${session.id}`;
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

      const fileBase = sanitizeFilename(session.name ?? `session-${session.id}`);
      await pptx.writeFile({ fileName: `${fileBase}-export.pptx` });
    } catch (exportError) {
      console.error('PPTX export failed:', exportError);
      setError('PowerPoint export failed. Please try again.');
    }
  }, [activeSessionId, getSessionContextForExport]);

  const hasSessionExportableData = useCallback((sessionId: number) => {
    return sessions.some((session) => session.id === sessionId);
  }, [sessions]);

  const isExportAvailable = recordingState === 'idle' && !isGeneratingSVG;
  const hasExportableData = hasSessionExportableData(activeSessionId);
  const canShowExport = isExportAvailable && hasExportableData;

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
      hasRealtimeTranscriptRef.current = false;
      setLiveSummary('');
      setSummaryStatus('idle');
      setSummaryError(null);
      setSummaryDebug(null);
      setError(null);
      setVisualizationActive(false);
      // Don't reset idCounterRef or notesHistory to preserve existing notes
      lastCapturedTextLengthRef.current = 0;
      lastSummarySourceKeyRef.current = '';
      lastSummarizedLengthRef.current = 0;
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
      summary: note.summary,
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
    // Each VISUALIZATION gets its own page, text notes are grouped with their visualization
    const pages: SlidePage[] = [];
    let currentTextItems: SlideRenderItem[] = [];

    slideSources.forEach((source) => {
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

      if (hasVisual) {
        if (source.generationMode === 'new_topic') {
          // For new_topic: text spoken before "prism" stays on the previous page
          if (currentTextItems.length > 0) {
            if (pages.length > 0) {
              // Append text to the previous visualization's page
              const lastPage = pages[pages.length - 1];
              pages[pages.length - 1] = {
                ...lastPage,
                items: [...lastPage.items, ...currentTextItems],
              };
            } else {
              // No previous page, create one for the text
              pages.push({
                id: pages.length + 1,
                items: currentTextItems,
              });
            }
            currentTextItems = [];
          }
          // New topic visualization gets its own fresh page
          pages.push({
            id: pages.length + 1,
            items: [item],
          });
        } else {
          // For enhanced, initial, chart: include preceding text notes with the visualization
          pages.push({
            id: pages.length + 1,
            items: [...currentTextItems, item],
          });
          currentTextItems = [];
        }
      } else {
        // Text/live notes accumulate until next visualization
        currentTextItems.push(item);
      }
    });

    // Add remaining text items as a page if any
    if (currentTextItems.length > 0) {
      pages.push({
        id: pages.length + 1,
        items: currentTextItems,
      });
    }

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
      console.log('[PRISM] === NEW PRISM SESSION STARTED ===');
      // CLEAR text and summary for the new prism session - each page gets fresh content
      setTranscriptionText('');
      setLiveSummary('');
      lastCapturedTextLengthRef.current = 0;
      // If there are existing slides, set flag to navigate when the new slide is created
      // (not before, so we don't navigate to the old last slide)
      if (notesHistory.length > 0) {
        console.log('[PRISM] Will navigate to new slide when first visualization is created');
        shouldNavigateOnNewSlideRef.current = true;
      }
    } else if (!visualizationActive && prevVisualizationActiveRef.current) {
      console.log('[PRISM] === PRISM SESSION ENDED (thank you) ===');
    }
    prevVisualizationActiveRef.current = visualizationActive;
  }, [visualizationActive, notesHistory.length]);

  // DON'T auto-advance during a session - removed the auto-advance on totalSlides change
  useEffect(() => {
    previousSlideCountRef.current = totalSlides;
  }, [totalSlides]);

  // Auto-navigate to new page when new prism session starts
  useEffect(() => {
    if (pendingNewTopicNavigation) {
      setPendingNewTopicNavigation(false);
      // Navigate to the last slide (the newly created page) with animation
      const targetIndex = slidePages.length - 1;
      if (targetIndex >= 0) {
        setSlideAnimationClass('page-turn-left');
        setTimeout(() => {
          setActiveSlideIndex(targetIndex);
          setTimeout(() => setSlideAnimationClass(''), 300);
        }, 50);
      }
    }
  }, [pendingNewTopicNavigation, slidePages]);

  const previousSessionIdRef = useRef(activeSessionId);
  useEffect(() => {
    if (previousSessionIdRef.current !== activeSessionId) {
      setActiveSlideIndex(Math.max(totalSlides - 1, 0));
      previousSessionIdRef.current = activeSessionId;
    }
  }, [activeSessionId, totalSlides]);

  const canGoPrev = activeSlideIndex > 0;
  const canGoNext = activeSlideIndex < totalSlides - 1;
  const isSummaryMode = notesMode === 'summary';

  // Handle slide navigation with page turn animation
  const navigateSlide = useCallback((direction: 'prev' | 'next') => {
    const animClass = direction === 'next' ? 'page-turn-left' : 'page-turn-right';
    setSlideAnimationClass(animClass);

    // Update slide index after a brief delay to let the animation start
    setTimeout(() => {
      if (direction === 'next') {
        setActiveSlideIndex((prev) => Math.min(prev + 1, totalSlides - 1));
      } else {
        setActiveSlideIndex((prev) => Math.max(prev - 1, 0));
      }
      // Clear animation class after animation completes
      setTimeout(() => setSlideAnimationClass(''), 300);
    }, 50);
  }, [totalSlides]);

  // Determine if we're viewing the latest slide (which shows live content)
  const isOnLatestSlide = activeSlideIndex === totalSlides - 1;

  // Get the text content from the active slide's items
  const activeSlideText = useMemo(() => {
    if (!activeSlide || activeSlide.items.length === 0) return '';
    return activeSlide.items
      .map(item => item.text)
      .filter(text => text && text !== 'Listening...' && text !== 'Note captured.')
      .join(' ')
      .trim();
  }, [activeSlide]);

  // Get the stored summary from the active slide (for historical slides)
  const activeSlideStoredSummary = useMemo(() => {
    if (!activeSlide || activeSlide.items.length === 0) return '';
    // Find the first item with a stored summary (usually the visualization)
    const itemWithSummary = activeSlide.items.find(item => item.summary);
    return itemWithSummary?.summary || '';
  }, [activeSlide]);

  // Parse stored summary into line groups for display
  const storedSummaryLineGroups = useMemo(
    () => groupSummaryLines(activeSlideStoredSummary),
    [activeSlideStoredSummary]
  );

  // For transcript display:
  // - On latest slide during recording: show live transcript
  // - On historical slides: show ONLY that slide's stored text (never current transcription)
  const transcriptDisplayText = useMemo(() => {
    if (isOnLatestSlide) {
      // Latest slide - show live content
      if (recordingState === 'recording') {
        return realtimeTranscript.trim() || transcriptionText.trim();
      }
      // Not recording but on latest slide - show current transcription
      return transcriptionText.trim();
    }
    // Historical slide - show ONLY that slide's stored text, never current transcription
    return activeSlideText;
  }, [isOnLatestSlide, recordingState, realtimeTranscript, transcriptionText, activeSlideText]);
  const summaryStatusLabel = summaryStatus === 'updating'
    ? 'Updating...'
    : summaryStatus === 'ready'
    ? 'Ready'
    : summaryStatus === 'error'
    ? 'Error'
    : 'Idle';

  return (
    <div className="board-layout">
      <aside className={`board-sidebar ${isSidebarCollapsed ? 'is-collapsed' : ''}`}>
        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => setIsSidebarCollapsed((prev) => !prev)}
          aria-label={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="sidebar-toggle-icon"
          >
            {isSidebarCollapsed ? (
              <polyline points="9 18 15 12 9 6" />
            ) : (
              <polyline points="15 18 9 12 15 6" />
            )}
          </svg>
        </button>

        <button type="button" className="board-new-session" onClick={handleNewSession}>
          <span className="new-session-plus">+</span>
          {!isSidebarCollapsed && <span>New Board</span>}
        </button>

        {false && !isSidebarCollapsed && (
          <details className="export-dropdown sidebar-export-dropdown">
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
        )}

        <div className="board-session-list">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`board-session-item ${session.id === activeSessionId ? 'is-active' : ''} ${expandedSessionActions === session.id ? 'actions-expanded' : ''}`}
              onClick={() => {
                if (expandedSessionActions === session.id) return;
                handleSwitchSession(session.id);
              }}
            >
              <span
                className={`session-label ${expandedSessionActions === session.id ? 'hidden' : ''}`}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  handleRenameSession(session.id);
                }}
                title="Double-click to rename"
              >
                {isSidebarCollapsed ? getSessionShortLabel(session.name) : session.name}
              </span>

              {!isSidebarCollapsed && (
                <div className={`session-actions-slideout ${expandedSessionActions === session.id ? 'is-open' : ''}`}>
                  {expandedSessionActions === session.id ? (
                    <>
                      <button
                        type="button"
                        className="session-action-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedSessionActions(null);
                        }}
                        title="Close"
                        aria-label="Close actions"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M15 18l-6-6 6-6" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="session-action-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRenameSession(session.id);
                          setExpandedSessionActions(null);
                        }}
                        title="Rename"
                        aria-label="Rename session"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="session-action-btn"
                        disabled={
                          !hasSessionExportableData(session.id)
                          || (session.id === activeSessionId && !isExportAvailable)
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          void exportSessionAsPdf(session.id);
                          setExpandedSessionActions(null);
                        }}
                        title="Export PDF"
                        aria-label="Export as PDF"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                          <line x1="12" y1="18" x2="12" y2="12" />
                          <line x1="9" y1="15" x2="15" y2="15" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="session-action-btn"
                        disabled={
                          !hasSessionExportableData(session.id)
                          || (session.id === activeSessionId && !isExportAvailable)
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          void exportSessionAsPptx(session.id);
                          setExpandedSessionActions(null);
                        }}
                        title="Export PPTX"
                        aria-label="Export as PowerPoint"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                          <line x1="8" y1="21" x2="16" y2="21" />
                          <line x1="12" y1="17" x2="12" y2="21" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="session-action-btn session-action-btn-danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedSessionActions(null);
                          handleDeleteSession(session.id, e);
                        }}
                        title="Delete"
                        aria-label="Delete session"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                        </svg>
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="session-actions-trigger"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedSessionActions(session.id);
                      }}
                      aria-label={`Open actions for ${session.name}`}
                      title="Actions"
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <circle cx="5" cy="12" r="2" />
                        <circle cx="12" cy="12" r="2" />
                        <circle cx="19" cy="12" r="2" />
                      </svg>
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="board-sidebar-footer">
          {!isSidebarCollapsed && (
            <>
              <div className="save-status-indicator">
                <span className={`save-status-dot ${hasUnsavedChanges ? 'unsaved' : 'saved'}`} />
                <span className="save-status-text">
                  {hasUnsavedChanges
                    ? 'Unsaved changes'
                    : lastSavedTime
                    ? `Saved ${lastSavedTime.toLocaleTimeString()}`
                    : 'Saved'}
                </span>
                <div className="save-status-actions">
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
                  <button
                    type="button"
                    className="board-clear-all"
                    onClick={handleClearAllData}
                  >
                    Clear All Data
                  </button>
                </div>
              </div>
              <div className="board-brand-row">
                <PrismLogo />
                <p className="board-brand">PRISM</p>
              </div>
            </>
          )}
          {isSidebarCollapsed && (
            <div className="board-brand-row">
              <PrismLogo />
            </div>
          )}
        </div>
      </aside>

      <main className="board-main">
        {error && <div className="board-error">{error}</div>}

        <section className="board-slide">
          <header className="slide-header">
            <div className="slide-mode-row">
              <span>View:</span>
              <select
                className="slide-mode-select"
                value={notesMode}
                onChange={(event) => {
                  const nextMode = event.target.value as NotesMode;
                  setNotesMode(nextMode);
                  if (nextMode === 'transcript') {
                    setSummaryError(null);
                  } else {
                    // force a fresh summary request when switching back to summary mode
                    lastSummarySourceKeyRef.current = '';
                  }
                }}
              >
                <option value="transcript">Live transcript</option>
                <option value="summary">Live summarized notes</option>
              </select>
            </div>

            <div className="slide-count">Slide {Math.min(activeSlideIndex + 1, totalSlides)} / {totalSlides}</div>
          </header>

          <div className={`slide-content ${slideAnimationClass}`}>
            <div className="slide-text-column">
              {isSummaryMode && isOnLatestSlide ? (
                <article className={`slide-summary-card ${recordingState === 'recording' ? 'is-live' : ''}`}>
                  <div className="slide-summary-header">
                    <h3 className="slide-summary-title">Live Summarized Notes</h3>
                    <span className={`slide-summary-status is-${summaryStatus}`}>{summaryStatusLabel}</span>
                  </div>

                  {liveSummary ? (
                    <div className="slide-summary-content">
                      {summaryLineGroups.paragraphLines.map((line, index) => (
                        <p key={`summary-paragraph-${index}`} className="slide-summary-paragraph">
                          {line}
                        </p>
                      ))}
                      {summaryLineGroups.bulletLines.length > 0 && (
                        <ul className="slide-summary-list">
                          {summaryLineGroups.bulletLines.map((line, index) => (
                            <li key={`summary-bullet-${index}`}>{line}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : (
                    <div className="slide-summary-empty">
                      {summaryStatus === 'updating'
                        ? 'Generating summary from live transcript...'
                        : 'Switch to this mode while speaking to see structured notes.'}
                    </div>
                  )}

                  {summaryError && (
                    <div className="slide-summary-error">
                      Summary error: {summaryError}
                    </div>
                  )}

                  {summaryDebug && (
                    <div className="slide-summary-debug">
                      <span>LLM: {summaryDebug.provider}/{summaryDebug.model}</span>
                      <span>Items: {summaryDebug.itemCount}</span>
                      <span>Chars: {summaryDebug.inputCharacters}</span>
                      <span>Latency: {summaryDebug.elapsedMs}ms</span>
                      {summaryDebug.fallbackUsed && <span>Fallback in use</span>}
                    </div>
                  )}
                </article>
              ) : isSummaryMode && !isOnLatestSlide && activeSlideStoredSummary ? (
                <article className="slide-summary-card">
                  <div className="slide-summary-header">
                    <h3 className="slide-summary-title">Slide {activeSlideIndex + 1} Summary</h3>
                    <span className="slide-summary-status is-ready">Saved</span>
                  </div>
                  <div className="slide-summary-content">
                    {storedSummaryLineGroups.paragraphLines.map((line, index) => (
                      <p key={`stored-paragraph-${index}`} className="slide-summary-paragraph">
                        {line}
                      </p>
                    ))}
                    {storedSummaryLineGroups.bulletLines.length > 0 && (
                      <ul className="slide-summary-list">
                        {storedSummaryLineGroups.bulletLines.map((line, index) => (
                          <li key={`stored-bullet-${index}`}>{line}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </article>
              ) : isSummaryMode && !isOnLatestSlide && activeSlideText ? (
                <article className="slide-text-item">
                  <div className="slide-summary-header">
                    <h3 className="slide-summary-title">Slide {activeSlideIndex + 1} Notes</h3>
                    <span className="slide-summary-status is-idle">No Summary</span>
                  </div>
                  <p className="slide-text">{activeSlideText}</p>
                </article>
              ) : transcriptDisplayText ? (
                <article className={`slide-text-item ${recordingState === 'recording' ? 'is-live' : ''}`}>
                  <p className="slide-text">
                    {transcriptDisplayText}
                    {recordingState === 'recording' && (
                      <span className="slide-caret" />
                    )}
                  </p>
                </article>
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
              onClick={() => navigateSlide('prev')}
              aria-label="Previous slide"
            >
              &larr;
            </button>

            <button
              type="button"
              className="slide-nav-button"
              disabled={!canGoNext}
              onClick={() => navigateSlide('next')}
              aria-label="Next slide"
            >
              &rarr;
            </button>
          </footer>
        </section>

        <section className="board-controls">
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

            <div className="control-status-row">
              <span className={`status-dot ${isSummaryMode ? 'is-active' : ''}`} />
              <span className="control-visualization-text">
                {isSummaryMode
                  ? `summary mode: ${summaryStatusLabel.toLowerCase()}`
                  : 'transcript mode: live raw text'}
              </span>
            </div>

            {isSummaryMode && summaryDebug && (
              <div className="control-status-row control-status-row-debug">
                <span className="control-debug-token">{summaryDebug.provider}</span>
                <span className="control-debug-token">{summaryDebug.model}</span>
                <span className="control-debug-token">{summaryDebug.elapsedMs}ms</span>
                <span className="control-debug-token">{summaryDebug.updatedAt.toLocaleTimeString()}</span>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
