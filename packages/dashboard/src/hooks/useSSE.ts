import { useEffect } from 'react';
import { getSSEEventsUrl } from '../lib/api.js';

type Listener = () => void;

// Singleton EventSource shared across all hooks in this tab.
//
// WHY a singleton: Browsers enforce a 6-connection-per-origin limit for
// HTTP/1.1. Each EventSource holds one persistent connection open. Without
// sharing, every hook that calls useSSE() would open its own connection,
// quickly exhausting the limit (ERR_INSUFFICIENT_RESOURCES) and blocking
// other requests (fetch, WebSocket upgrades, etc.).
//
// VISIBILITY: When the tab is hidden, the SSE connection is closed to free
// the connection slot. With 6+ workspace tabs open, all slots would be
// consumed by SSE, blocking fetches and WebSocket upgrades entirely.
// On tab re-focus, we reconnect and fire a refresh so the UI catches up.
//
// NOTE: Each browser tab gets its own module scope, so each open dashboard
// tab will have one independent EventSource connection.
let eventSource: EventSource | null = null;
const listeners = new Set<Listener>();
let visibilityListenerInstalled = false;

function notify(): void {
  for (const fn of listeners) fn();
}

function connect(): void {
  if (eventSource || typeof EventSource === 'undefined') return;
  if (typeof document !== 'undefined' && document.hidden) return;
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

function handleVisibilityChange(): void {
  if (document.hidden) {
    disconnect();
  } else if (listeners.size > 0) {
    connect();
    // Notify listeners so the UI refreshes after being backgrounded
    notify();
  }
}

function installVisibilityListener(): void {
  if (visibilityListenerInstalled || typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', handleVisibilityChange);
  visibilityListenerInstalled = true;
}

/**
 * Subscribe to SSE events from Tower. The callback fires on every SSE message
 * (including the initial "connected" event sent after reconnection).
 * Uses a shared EventSource singleton — multiple hooks share one connection.
 * Automatically disconnects when the tab is hidden and reconnects on focus.
 */
export function useSSE(onEvent: Listener): void {
  useEffect(() => {
    listeners.add(onEvent);
    installVisibilityListener();
    connect();
    return () => {
      listeners.delete(onEvent);
      if (listeners.size === 0) {
        disconnect();
      }
    };
  }, [onEvent]);
}
