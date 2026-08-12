import { useEffect } from 'react';
import { WEB_KEY_HEADER } from '@cluesmith/codev-types';
import { getSSEEventsUrl, getWebKey } from '../lib/api.js';

type Listener = () => void;

// Singleton SSE connection shared across all hooks in this tab.
//
// WHY fetch+ReadableStream instead of EventSource: the browser `EventSource`
// cannot set request headers, so it cannot carry the `codev-web-key` header the
// Tower API now requires (advisory GHSA-xvjp-7748-v88v). A `fetch` streamed
// through a `ReadableStream` sends the header and parses the same `data: {...}`
// SSE wire format.
//
// WHY a singleton: browsers enforce a 6-connection-per-origin limit for
// HTTP/1.1. Each stream holds one persistent connection; without sharing, every
// hook that calls useSSE() would open its own, exhausting the limit and blocking
// other requests (fetch, WebSocket upgrades).
//
// VISIBILITY: when the tab is hidden the connection is aborted to free the slot;
// on re-focus it reconnects and fires a refresh so the UI catches up.
//
// NOTE: each browser tab gets its own module scope, so each open dashboard tab
// has one independent connection.
const listeners = new Set<Listener>();
let controller: AbortController | null = null;
let visibilityListenerInstalled = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  for (const fn of listeners) fn();
}

function connect(): void {
  if (controller || typeof fetch === 'undefined') return;
  if (typeof document !== 'undefined' && document.hidden) return;
  const ctrl = new AbortController();
  controller = ctrl;
  streamEvents(ctrl);
}

async function streamEvents(ctrl: AbortController): Promise<void> {
  const headers: Record<string, string> = {};
  const key = getWebKey();
  if (key) headers[WEB_KEY_HEADER] = key;

  try {
    const response = await fetch(getSSEEventsUrl(), { headers, signal: ctrl.signal });
    if (!response.ok || !response.body) {
      // Non-200 (e.g. 401 without a key, or 503 at capacity) does not stream —
      // schedule a manual retry with jitter.
      if (controller === ctrl) {
        disconnect();
        scheduleReconnect();
      }
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; keep any partial trailing frame.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        if (/^data:/m.test(frame)) notify();
      }
    }
  } catch {
    // Aborted (disconnect) or a network error — fall through to reconnect below.
  }

  // The stream ended or errored; if this is still the live connection, retry.
  if (controller === ctrl) {
    disconnect();
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer || listeners.size === 0) return;
  const jitter = 2000 + Math.floor(Math.random() * 3000); // 2-5s
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, jitter);
}

function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (controller) {
    controller.abort();
    controller = null;
  }
}

function handleVisibilityChange(): void {
  if (document.hidden) {
    disconnect();
  } else if (listeners.size > 0) {
    connect();
    // Notify listeners so the UI refreshes after being backgrounded.
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
 * (including the initial "connected" event sent after reconnection). Multiple
 * hooks share one streamed connection. Automatically disconnects when the tab
 * is hidden and reconnects on focus.
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
