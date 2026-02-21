/**
 * main application component.
 * features a sidebar with session management and main content area.
 * keeps working transcription logic intact.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { AudioRecorder } from './components/AudioRecorder';
import { summarizeUserSpeech } from './services/api';
import PptxGenJS from 'pptxgenjs';
import {
  TranscriptionResult,
  SVGGenerationResponse,
  ChartGenerationResponse,
  RecordingState,
} from './types';

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
}

// interface for a session
interface Session {
  id: number;
  name: string;
  notes: NoteHistoryItem[];
  transcriptionText: string;
}

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

function splitIntoChunks(items: string[], chunkSize: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
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

  // auto-scroll to latest note
  useEffect(() => {
    if (listEndRef.current) {
      listEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
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

      // update captured text length to prevent duplicate text-only notes
      lastCapturedTextLengthRef.current = transcriptionTextRef.current.length;

      if (response.generationMode === 'enhanced') {
        setNotesHistory((prev) => {
          if (prev.length === 0) return [newItem];
          const lastSvgIndex = prev.map(item => item.type).lastIndexOf('svg');
          if (lastSvgIndex === -1) return [...prev, newItem];
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
      // update captured text length to prevent duplicate text-only notes
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

  // handle real-time transcript from browser speech recognition
  const handleRealtimeTranscript = useCallback((text: string, _isFinal: boolean) => {
    setRealtimeTranscript(text);
  }, []);

  // ref to track previous state for transition detection
  const prevRecordingStateRef = useRef<RecordingState>('idle');

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

    // clean up object URL after the popup has had time to load
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  }, [activeSessionId, getSessionContextForExport, notesHistory, sessions]);

  const exportSessionAsPptx = useCallback(async () => {
    const { allSessionSVGs, allUserSpeechTexts } = getSessionContextForExport();
    const activeSession = sessions.find((session) => session.id === activeSessionId);
    const visualizationItems = notesHistory.filter(
      (item) => item.type === 'svg' || item.type === 'chart'
    );

    let llmSummary = 'Summary unavailable.';
    if (allUserSpeechTexts.length > 0) {
      try {
        const summaryResponse = await summarizeUserSpeech(allUserSpeechTexts);
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

      // title slide
      const titleSlide = pptx.addSlide();
      titleSlide.background = { color: 'F8FAFC' };
      titleSlide.addText('PRISM Session Export', {
        x: 0.6,
        y: 0.5,
        w: 12.2,
        h: 0.6,
        fontSize: 30,
        bold: true,
        color: '0F172A',
      });
      titleSlide.addText(
        `Session: ${activeSession?.name ?? `Session ${activeSessionId}`}\n` +
          `Exported: ${new Date().toLocaleString()}\n` +
          `Speech Items: ${allUserSpeechTexts.length}\n` +
          `SVG Items: ${allSessionSVGs.length}\n` +
          `Visualization Items: ${visualizationItems.length}`,
        {
          x: 0.6,
          y: 1.5,
          w: 6.8,
          h: 2.4,
          fontSize: 15,
          color: '334155',
          valign: 'top',
          breakLine: true,
        }
      );

      // speech slides
      if (allUserSpeechTexts.length > 0) {
        const speechChunks = splitIntoChunks(allUserSpeechTexts, 6);
        speechChunks.forEach((chunk, chunkIndex) => {
          const slide = pptx.addSlide();
          slide.addText(
            `User Speech (${chunkIndex + 1}/${speechChunks.length})`,
            {
              x: 0.5,
              y: 0.3,
              w: 12.2,
              h: 0.5,
              fontSize: 22,
              bold: true,
              color: '0F172A',
            }
          );

          const bulletText = chunk
            .map((text, index) => `${index + 1}. ${text}`)
            .join('\n\n');

          slide.addText(bulletText, {
            x: 0.7,
            y: 1.0,
            w: 12.0,
            h: 5.9,
            fontSize: 14,
            color: '1F2937',
            valign: 'top',
            breakLine: true,
          });
        });
      }

      // visualization slides
      for (let i = 0; i < visualizationItems.length; i += 1) {
        const item = visualizationItems[i];
        const slide = pptx.addSlide();
        const timestamp = new Date(item.timestamp).toLocaleString();
        const textSnippet = (item.newTextDelta || item.originalText || '').slice(0, 550);

        slide.addText(
          `${item.type === 'chart' ? 'Chart' : 'SVG'} ${i + 1}/${visualizationItems.length}`,
          {
            x: 0.5,
            y: 0.25,
            w: 12.3,
            h: 0.45,
            fontSize: 20,
            bold: true,
            color: '0F172A',
          }
        );

        slide.addText(
          `Mode: ${item.generationMode || 'unknown'}\n` +
            `Timestamp: ${timestamp}\n\n` +
            `Text:\n${textSnippet}`,
          {
            x: 0.5,
            y: 0.9,
            w: 4.6,
            h: 5.9,
            fontSize: 12,
            color: '334155',
            valign: 'top',
            breakLine: true,
          }
        );

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
            x: 5.2,
            y: 0.9,
            w: 7.7,
            h: 5.9,
          });
        } else {
          slide.addText('Visualization preview unavailable for this item.', {
            x: 5.2,
            y: 2.8,
            w: 7.5,
            h: 0.8,
            fontSize: 15,
            color: '6B7280',
            italic: true,
            align: 'center',
          });
        }
      }

      // summary slide
      const summarySlide = pptx.addSlide();
      summarySlide.background = { color: 'F8FAFC' };
      summarySlide.addText('LLM Summary', {
        x: 0.6,
        y: 0.5,
        w: 12.2,
        h: 0.6,
        fontSize: 28,
        bold: true,
        color: '0F172A',
      });
      summarySlide.addText(llmSummary, {
        x: 0.7,
        y: 1.4,
        w: 12.0,
        h: 5.3,
        fontSize: 16,
        color: '1F2937',
        valign: 'top',
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
      // capture current in-memory session context when user clicks stop recording
      if (prevState === 'recording') {
        const allSessionSVGs = notesHistoryRef.current
          .filter((item) => item.type === 'svg' && typeof item.svg === 'string')
          .map((item) => item.svg as string);

        const allUserSpeechTexts = [
          ...notesHistoryRef.current
            .map((item) => item.newTextDelta || item.originalText)
            .filter((text) => typeof text === 'string' && text.trim().length > 0),
          ...(
            transcriptionTextRef.current.trim().length > 0
              ? [transcriptionTextRef.current]
              : []
          ),
        ];

        console.log('[Session Context @ Stop]', {
          allSessionSVGs,
          allUserSpeechTexts,
        });
      }

      setIsGeneratingSVG(true);
    }

    if (state === 'idle') {
      setIsGeneratingSVG(false);
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
          {canShowExport && (
            <details style={{ position: 'relative' }}>
              <summary
                style={{
                  padding: '10px 14px',
                  borderRadius: '8px',
                  border: `1px solid ${theme.border}`,
                  color: theme.text,
                  cursor: 'pointer',
                  userSelect: 'none',
                  fontSize: '14px',
                  backgroundColor: theme.sidebar,
                }}
              >
                Export
              </summary>
              <div
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 8px)',
                  left: 0,
                  minWidth: '140px',
                  borderRadius: '8px',
                  border: `1px solid ${theme.border}`,
                  backgroundColor: theme.sidebar,
                  boxShadow: '0 6px 20px rgba(0, 0, 0, 0.25)',
                  overflow: 'hidden',
                }}
              >
                <button
                  onClick={(event) => {
                    exportSessionAsTxt();
                    const details = event.currentTarget.closest('details');
                    if (details instanceof HTMLDetailsElement) {
                      details.open = false;
                    }
                  }}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '10px 12px',
                    background: 'transparent',
                    color: theme.text,
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: '14px',
                  }}
                >
                  .txt
                </button>
                <button
                  onClick={(event) => {
                    void exportSessionAsPdf();
                    const details = event.currentTarget.closest('details');
                    if (details instanceof HTMLDetailsElement) {
                      details.open = false;
                    }
                  }}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '10px 12px',
                    background: 'transparent',
                    color: theme.text,
                    border: 'none',
                    borderTop: `1px solid ${theme.border}`,
                    cursor: 'pointer',
                    fontSize: '14px',
                  }}
                >
                  .pdf
                </button>
                <button
                  onClick={(event) => {
                    void exportSessionAsPptx();
                    const details = event.currentTarget.closest('details');
                    if (details instanceof HTMLDetailsElement) {
                      details.open = false;
                    }
                  }}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '10px 12px',
                    background: 'transparent',
                    color: theme.text,
                    border: 'none',
                    borderTop: `1px solid ${theme.border}`,
                    cursor: 'pointer',
                    fontSize: '14px',
                  }}
                >
                  .pptx
                </button>
              </div>
            </details>
          )}

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
