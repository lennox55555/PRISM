/**
 * api service for rest endpoint communication.
 * provides functions for non-websocket api calls to the backend.
 */

// base url for api requests, uses vite proxy in development
const API_BASE_URL = '/api';

// error class for api errors
export class APIError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
    this.name = 'APIError';
  }
}

// generic fetch wrapper with error handling
async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new APIError(
      errorData.detail || 'api request failed',
      response.status
    );
  }

  return response.json();
}

// request body for text to svg endpoint
export interface TextToSVGRequest {
  text: string;
  style?: string;
  context?: string;
}

// response from text to svg endpoint
export interface TextToSVGResponse {
  svg_code: string;
  description: string;
  original_text: string;
}

/**
 * generate an svg visualization from text description.
 * sends a post request to the text-to-svg endpoint.
 */
export async function generateSVGFromText(
  request: TextToSVGRequest
): Promise<TextToSVGResponse> {
  return apiFetch<TextToSVGResponse>('/text-to-svg', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

// response from transcription endpoint
export interface TranscriptionResponse {
  text: string;
  is_final: boolean;
  confidence?: number;
  language?: string;
}

/**
 * transcribe an audio file.
 * sends the audio file as multipart form data.
 */
export async function transcribeAudio(
  audioFile: Blob
): Promise<TranscriptionResponse> {
  const formData = new FormData();
  formData.append('file', audioFile, 'audio.wav');

  const response = await fetch(`${API_BASE_URL}/transcribe`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new APIError(
      errorData.detail || 'transcription failed',
      response.status
    );
  }

  return response.json();
}

// response from combined endpoint
export interface TranscribeAndGenerateResponse {
  transcription: string;
  svg_code: string;
  description: string;
}

/**
 * combined endpoint that transcribes audio and generates svg.
 * takes base64 encoded audio and returns both transcription and svg.
 */
export async function transcribeAndGenerate(
  audioBase64: string,
  style?: string
): Promise<TranscribeAndGenerateResponse> {
  return apiFetch<TranscribeAndGenerateResponse>('/transcribe-and-generate', {
    method: 'POST',
    body: JSON.stringify({
      audio_base64: audioBase64,
      style,
    }),
  });
}

/**
 * get a placeholder svg for loading states.
 */
export async function getPlaceholderSVG(
  message = 'loading...'
): Promise<{ svg: string }> {
  return apiFetch<{ svg: string }>(
    `/placeholder-svg?message=${encodeURIComponent(message)}`
  );
}

/**
 * health check endpoint.
 */
export async function healthCheck(): Promise<{ status: string }> {
  const response = await fetch('/health');
  return response.json();
}
