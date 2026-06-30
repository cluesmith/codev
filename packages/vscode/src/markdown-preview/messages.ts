/**
 * Message protocol for the Codev Markdown Preview (#859, #1107).
 *
 * The preview is a `CustomTextEditor` webview (`webview/main.ts`) talking to the extension host
 * (`preview-provider.ts`) over `postMessage`. These two unions are the two directions of that
 * channel, named here so both ends share one definition and cannot drift.
 *
 * Host-side inbound data is untrusted — it crosses the `postMessage` boundary — so the host still
 * validates the payload fields at runtime before acting. These types document the shape of a
 * well-formed message; they do not vouch that a given runtime value conforms.
 */
import type { ReviewMarker } from '@cluesmith/codev-core/review-markers';

/** Host → webview: push the current document text + parsed markers for rendering. */
export interface HostToWebviewMessage {
  type: 'update';
  content: string;
  markers: ReviewMarker[];
}

/** Webview → host: the canvas's lifecycle + comment-intent messages. */
export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'addComment'; line: number; text: string };
