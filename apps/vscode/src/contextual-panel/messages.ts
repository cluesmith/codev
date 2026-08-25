/**
 * Host <-> webview message contract for the contextual panel.
 *
 * EXTENSION-LOCAL (see `types.ts`): this crosses only the panel's own `postMessage` boundary. The
 * panel is purely contextual, so the only messages are the host pushing a render and the webview
 * announcing it has mounted — there is no navigation.
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
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'ready';
}
