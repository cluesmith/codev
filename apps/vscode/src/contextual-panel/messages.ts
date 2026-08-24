/**
 * Host <-> webview message contract for the contextual panel.
 *
 * EXTENSION-LOCAL (see `types.ts`): this crosses only the panel's own `postMessage` boundary, not a
 * package boundary. webview->host messages are lower-trust, so `parseNavigation` validates field
 * *values* (mode against the ModeKind set; builderId against the known-builders set) — an unknown
 * type or an invalid value is ignored.
 */

import { isModeKind } from './pills.js';
import type { ModeDescriptor, ModeKind } from './types.js';

/** Host -> webview: render this resolved descriptor (with the summary builder-id stub, if any). */
export interface RenderMessage {
  type: 'render';
  descriptor: ModeDescriptor;
  summary?: { builderIds: string[] };
}

export type HostToWebviewMessage = RenderMessage;

export interface ReadyMessage {
  type: 'ready';
}

/** Webview -> host: navigate to a mode (its summary / contextual view). */
export interface NavigateMessage {
  type: 'mode-navigate';
  mode: ModeKind;
}

/** Webview -> host: drill from a summary row into a specific builder's detail. */
export interface DrillInMessage {
  type: 'drill-in';
  mode: ModeKind;
  builderId: string;
}

export type WebviewToHostMessage = ReadyMessage | NavigateMessage | DrillInMessage;

/** Narrow an untrusted inbound message to `ReadyMessage`. */
export function isReadyMessage(message: unknown): message is ReadyMessage {
  return isRecord(message) && message['type'] === 'ready';
}

/**
 * Validate an untrusted navigation message. Returns the typed message, or null for anything whose
 * type or field values are not recognized (unknown type, non-mode `mode`, or an unknown `builderId`).
 */
export function parseNavigation(
  message: unknown,
  isKnownBuilder: (id: string) => boolean,
): NavigateMessage | DrillInMessage | null {
  if (!isRecord(message)) {
    return null;
  }
  if (message['type'] === 'mode-navigate' && isModeKind(message['mode'])) {
    return { type: 'mode-navigate', mode: message['mode'] };
  }
  if (
    message['type'] === 'drill-in' &&
    isModeKind(message['mode']) &&
    typeof message['builderId'] === 'string' &&
    isKnownBuilder(message['builderId'])
  ) {
    return { type: 'drill-in', mode: message['mode'], builderId: message['builderId'] };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
