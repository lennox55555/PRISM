/**
 * custom hook for managing websocket connections.
 * handles connection lifecycle, message parsing, and automatic reconnection.
 * provides a clean interface for sending and receiving websocket messages.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ConnectionState,
  MessageType,
  TranscriptionResult,
  SVGGenerationResponse,
  ChartGenerationResponse,
  WebSocketCallbacks,
} from '../types';

// websocket url for the audio endpoint
const WS_URL = `ws://${window.location.hostname}:8000/ws/audio`;

interface UseWebSocketOptions extends WebSocketCallbacks {
  // automatically reconnect on disconnect
  autoReconnect?: boolean;
  // delay between reconnection attempts in ms
  reconnectDelay?: number;
  // maximum number of reconnection attempts
  maxReconnectAttempts?: number;
}

interface UseWebSocketReturn {
  // current connection state
  connectionState: ConnectionState;
  // send a message through the websocket
  sendMessage: (message: Record<string, unknown>) => void;
  // start a new recording session
  startRecording: () => void;
  // stop the current recording session
  stopRecording: () => void;
  // send an audio chunk (base64 encoded)
  sendAudioChunk: (audioBase64: string) => void;
  // manually connect to the websocket
  connect: () => void;
  // manually disconnect from the websocket
  disconnect: () => void;
}

export function useWebSocket(
  options: UseWebSocketOptions = {}
): UseWebSocketReturn {
  const {
    autoReconnect = true,
    reconnectDelay = 3000,
    maxReconnectAttempts = 5,
    onTranscription,
    onSVGGenerated,
    onChartGenerated,
    onError,
    onStatusChange,
    onConnectionChange,
  } = options;

  // connection state
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('disconnected');

  // refs for values that shouldn't trigger re-renders
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isUnmountedRef = useRef(false);
  const isConnectingRef = useRef(false);

  // store callbacks in refs to avoid dependency issues
  const callbacksRef = useRef({
    onTranscription,
    onSVGGenerated,
    onChartGenerated,
    onError,
    onStatusChange,
    onConnectionChange,
  });

  // update callbacks ref when they change
  useEffect(() => {
    callbacksRef.current = {
      onTranscription,
      onSVGGenerated,
      onChartGenerated,
      onError,
      onStatusChange,
      onConnectionChange,
    };
  }, [onTranscription, onSVGGenerated, onChartGenerated, onError, onStatusChange, onConnectionChange]);

  // update connection state and notify callback
  const updateConnectionState = useCallback((state: ConnectionState) => {
    if (isUnmountedRef.current) return;
    setConnectionState(state);
    callbacksRef.current.onConnectionChange?.(state);
  }, []);

  // handle incoming websocket messages
  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const message = JSON.parse(event.data);
      const { type, data, error } = message;

      switch (type) {
        case MessageType.TRANSCRIPTION_PARTIAL:
        case MessageType.TRANSCRIPTION_FINAL:
          if (data) {
            const result: TranscriptionResult = {
              text: data.text || '',
              accumulatedText: data.accumulated_text,
              isFinal: type === MessageType.TRANSCRIPTION_FINAL,
            };
            callbacksRef.current.onTranscription?.(result);
          }
          break;

        case MessageType.SVG_GENERATED:
          if (data) {
            const response: SVGGenerationResponse = {
              svg: data.svg || '',
              description: data.description || '',
              originalText: data.original_text || '',
              newTextDelta: data.new_text_delta || '',
              error: data.error,
              generationMode: data.generation_mode,
              similarityScore: data.similarity_score,
              similarityThreshold: data.similarity_threshold,
            };
            callbacksRef.current.onSVGGenerated?.(response);
          }
          break;

        case MessageType.CHART_GENERATED:
          if (data) {
            const response: ChartGenerationResponse = {
              image: data.image || '',
              code: data.code || '',
              description: data.description || '',
              originalText: data.original_text || '',
              newTextDelta: data.new_text_delta || '',
              error: data.error,
              generationMode: 'chart',
              chartConfidence: data.chart_confidence,
            };
            callbacksRef.current.onChartGenerated?.(response);
          }
          break;

        case MessageType.STATUS:
          if (data?.status) {
            callbacksRef.current.onStatusChange?.(data.status);
          }
          break;

        case MessageType.ERROR:
          if (error) {
            callbacksRef.current.onError?.(error);
          }
          break;

        default:
          console.warn('unknown message type:', type);
      }
    } catch (e) {
      console.error('failed to parse websocket message:', e);
    }
  }, []);

  // connect to the websocket server
  const connect = useCallback(() => {
    // don't connect if already connected, connecting, or unmounted
    if (isUnmountedRef.current || isConnectingRef.current) {
      return;
    }

    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    isConnectingRef.current = true;
    updateConnectionState('connecting');

    try {
      const ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        if (isUnmountedRef.current) {
          ws.close();
          return;
        }
        console.log('websocket connected');
        isConnectingRef.current = false;
        reconnectAttemptsRef.current = 0;
        updateConnectionState('connected');
      };

      ws.onmessage = handleMessage;

      ws.onerror = (error) => {
        console.error('websocket error:', error);
        isConnectingRef.current = false;
        if (!isUnmountedRef.current) {
          updateConnectionState('error');
          // don't show error message to user - connection status badge is sufficient
        }
      };

      ws.onclose = (event) => {
        console.log('websocket closed:', event.code, event.reason);
        isConnectingRef.current = false;
        wsRef.current = null;

        if (isUnmountedRef.current) {
          return;
        }

        updateConnectionState('disconnected');

        // attempt reconnection if enabled and not unmounted
        if (
          autoReconnect &&
          !isUnmountedRef.current &&
          reconnectAttemptsRef.current < maxReconnectAttempts
        ) {
          reconnectAttemptsRef.current++;
          console.log(
            `reconnecting in ${reconnectDelay}ms (attempt ${reconnectAttemptsRef.current})`
          );
          reconnectTimeoutRef.current = setTimeout(() => {
            if (!isUnmountedRef.current) {
              connect();
            }
          }, reconnectDelay);
        }
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('failed to create websocket:', error);
      isConnectingRef.current = false;
      updateConnectionState('error');
    }
  }, [autoReconnect, reconnectDelay, maxReconnectAttempts, handleMessage, updateConnectionState]);

  // disconnect from the websocket server
  const disconnect = useCallback(() => {
    // clear any pending reconnection
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = undefined;
    }

    isConnectingRef.current = false;

    // close the websocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    if (!isUnmountedRef.current) {
      updateConnectionState('disconnected');
    }
  }, [updateConnectionState]);

  // send a message through the websocket
  const sendMessage = useCallback((message: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.warn('cannot send message: websocket not connected');
    }
  }, []);

  // convenience method to start recording
  const startRecording = useCallback(() => {
    sendMessage({ type: MessageType.START_RECORDING });
  }, [sendMessage]);

  // convenience method to stop recording
  const stopRecording = useCallback(() => {
    sendMessage({ type: MessageType.STOP_RECORDING });
  }, [sendMessage]);

  // convenience method to send audio chunk
  const sendAudioChunk = useCallback(
    (audioBase64: string) => {
      sendMessage({
        type: MessageType.AUDIO_CHUNK,
        data: audioBase64,
      });
    },
    [sendMessage]
  );

  // connect on mount, disconnect on unmount
  useEffect(() => {
    isUnmountedRef.current = false;
    connect();

    return () => {
      isUnmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []); // empty dependency array - only run on mount/unmount

  return {
    connectionState,
    sendMessage,
    startRecording,
    stopRecording,
    sendAudioChunk,
    connect,
    disconnect,
  };
}
