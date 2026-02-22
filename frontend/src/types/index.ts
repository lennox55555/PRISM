/**
 * type definitions for the voice to svg visualization frontend.
 * these types mirror the backend schemas for type safety across the stack.
 */

// websocket message types matching the backend enum
export enum MessageType {
  // client to server
  AUDIO_CHUNK = 'audio_chunk',
  START_RECORDING = 'start_recording',
  STOP_RECORDING = 'stop_recording',

  // server to client
  TRANSCRIPTION_PARTIAL = 'transcription_partial',
  TRANSCRIPTION_FINAL = 'transcription_final',
  SVG_GENERATED = 'svg_generated',
  CHART_GENERATED = 'chart_generated',
  ERROR = 'error',
  STATUS = 'status',
}

// websocket message structure
export interface WebSocketMessage {
  type: MessageType;
  data?: Record<string, unknown>;
  error?: string;
}

// transcription result from the backend
export interface TranscriptionResult {
  text: string;
  accumulatedText?: string;
  isFinal: boolean;
  confidence?: number;
  language?: string;
}

// svg generation response from the backend
export interface SVGGenerationResponse {
  svg: string;
  description: string;
  originalText: string;
  newTextDelta?: string;  // the new text that was compared for similarity
  error?: string;
  generationMode?: 'initial' | 'enhanced' | 'new_topic' | 'chart';
  similarityScore?: number | null;
  similarityThreshold?: number;
  sessionId?: string;  // unique ID for grouping visualizations from same prism session
}

// chart generation response from the backend (matplotlib)
export interface ChartGenerationResponse {
  image: string;  // base64 png image
  code: string;   // matplotlib python code
  description: string;
  originalText: string;
  newTextDelta?: string;
  error?: string;
  generationMode: 'chart' | 'enhanced';
  chartConfidence?: number;
  sessionId?: string;  // unique ID for grouping visualizations from same prism session
}

// recording state for the audio recorder component
export type RecordingState = 'idle' | 'recording' | 'processing' | 'error';

// websocket connection state
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

// callback types for websocket events
export interface WebSocketCallbacks {
  onTranscription?: (result: TranscriptionResult) => void;
  onSVGGenerated?: (response: SVGGenerationResponse) => void;
  onChartGenerated?: (response: ChartGenerationResponse) => void;
  onError?: (error: string) => void;
  onStatusChange?: (status: string, data?: { visualization_active?: boolean; new_session?: boolean }) => void;
  onConnectionChange?: (state: ConnectionState) => void;
}

// props for the audio recorder component
export interface AudioRecorderProps {
  onTranscription?: (result: TranscriptionResult) => void;
  onSVGGenerated?: (response: SVGGenerationResponse) => void;
  onChartGenerated?: (response: ChartGenerationResponse) => void;
  onError?: (error: string) => void;
  onRecordingStateChange?: (state: RecordingState) => void;
  onRealtimeTranscript?: (text: string, isFinal: boolean) => void;
  onConnectionStateChange?: (state: ConnectionState) => void;
  compact?: boolean;
}

// props for the transcription display component
export interface TranscriptionDisplayProps {
  text: string;
  isPartial?: boolean;
}

// props for the svg renderer component
export interface SVGRendererProps {
  svgCode: string;
  isLoading?: boolean;
  error?: string;
}
