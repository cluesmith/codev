import { useEffect } from 'react';
import { getSSEEventsUrl } from '../lib/api.js';

type Listener = () => void;

let eventSource: EventSource | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of listeners) fn();
}

function connect(): void {
  if (eventSource) return;
  eventSource = new EventSource(getSSEEventsUrl());
  eventSource.onmessage = () => notify();
  eventSource.onerror = () => {
    // EventSource automatically reconnects on error; no action needed.
  };
}

function disconnect(): void {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

/**
 * Subscribe to SSE events from Tower. The callback fires on every SSE message
 * (including the initial "connected" event sent after reconnection).
 * Uses a shared EventSource singleton — multiple hooks share one connection.
 */
export function useSSE(onEvent: Listener): void {
  useEffect(() => {
    listeners.add(onEvent);
    connect();
    return () => {
      listeners.delete(onEvent);
      if (listeners.size === 0) {
        disconnect();
      }
    };
  }, [onEvent]);
}
