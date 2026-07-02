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
  | { type: 'addComment'; line: number; text: string }
  // Edit/delete a marker by its own physical file line (#1055). `expectedAuthor`/`expectedBodyPrefix`
  // are the card's rendered author + body for the host's optimistic-concurrency check: if the marker
  // at `markerLine` no longer matches (the file changed between click and write), the host refuses
  // the write and refreshes rather than mutating a different marker.
  | { type: 'editComment'; markerLine: number; expectedAuthor: string; expectedBodyPrefix: string; newBody: string }
  | { type: 'deleteComment'; markerLine: number; expectedAuthor: string; expectedBodyPrefix: string };
