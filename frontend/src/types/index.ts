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
  error?: string;
}

// recording state for the audio recorder component
export type RecordingState = 'idle' | 'recording' | 'processing' | 'error';

// websocket connection state
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

// callback types for websocket events
export interface WebSocketCallbacks {
  onTranscription?: (result: TranscriptionResult) => void;
  onSVGGenerated?: (response: SVGGenerationResponse) => void;
  onError?: (error: string) => void;
  onStatusChange?: (status: string) => void;
  onConnectionChange?: (state: ConnectionState) => void;
}

// props for the audio recorder component
export interface AudioRecorderProps {
  onTranscription?: (result: TranscriptionResult) => void;
  onSVGGenerated?: (response: SVGGenerationResponse) => void;
  onError?: (error: string) => void;
  onRecordingStateChange?: (state: RecordingState) => void;
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
