/**
 * Host <-> webview message contract for the contextual panel.
 *
 * EXTENSION-LOCAL (see `types.ts`): this crosses only the panel's own `postMessage` boundary,
 * not a package boundary. Phase 3 defines the render/ready pair; Phase 4 extends the
 * webview->host union with navigation (`mode-navigate` / `drill-in`).
 */

import type { ModeDescriptor } from './types.js';

/** Host -> webview: render this resolved descriptor. */
export interface RenderMessage {
  type: 'render';
  descriptor: ModeDescriptor;
}

export type HostToWebviewMessage = RenderMessage;

/** Webview -> host: the webview has mounted and wants the current descriptor. */
export interface ReadyMessage {
  type: 'ready';
}

export type WebviewToHostMessage = ReadyMessage;

/** Narrow an untrusted inbound message to `ReadyMessage` (webview->host is lower-trust). */
export function isReadyMessage(message: unknown): message is ReadyMessage {
  return isRecord(message) && message['type'] === 'ready';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
