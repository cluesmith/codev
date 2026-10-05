/**
 * Host <-> webview message contract for the contextual panel.
 *
 * EXTENSION-LOCAL (see `types.ts`): this crosses only the panel's own `postMessage` boundary. The
 * panel is purely contextual: the host pushes renders, the webview announces it has mounted, and the
 * Code Review body asks the host to run the existing review-queue commands (#1559). There is no
 * navigation.
 */

import type { ModeDescriptor } from './types.js';
import type { AttentionSummary } from '@cluesmith/codev-sdk/builder-helpers';
import type { CodeReviewSummary } from './code-review.js';

/** Host -> webview: render this resolved descriptor. */
export interface RenderMessage {
  type: 'render';
  descriptor: ModeDescriptor;
  /**
   * The Attention roll-up, present only when `descriptor.kind === 'attention'`. Carried alongside
   * the descriptor (not inside it) so `ModeDescriptor` — the pure resolver's output — stays free of
   * overview data. Absent for every other mode.
   */
  attention?: AttentionSummary;
  /** The shown builder's pending review queue + files-to-review, present only when
   *  `descriptor.kind === 'code-review'` (same alongside-the-descriptor rule as `attention`). */
  codeReview?: CodeReviewSummary;
}

export type HostToWebviewMessage = RenderMessage;

/** Webview -> host: the webview has mounted and wants the current descriptor. */
export interface ReadyMessage {
  type: 'ready';
}

/** The review-queue commands the Code Review body can trigger, mapped to their command ids. */
export const REVIEW_ACTION_COMMANDS = {
  submit: 'codev.submitReview',
  discard: 'codev.discardReviewComments',
} as const;

export type ReviewAction = keyof typeof REVIEW_ACTION_COMMANDS;

/** Webview -> host: run a review-queue action for the builder the Code Review body shows. */
export interface ReviewActionMessage {
  type: 'review-action';
  action: ReviewAction;
  builderId: string;
}

export type WebviewToHostMessage = ReadyMessage | ReviewActionMessage;

/** Narrow an untrusted inbound message to `ReadyMessage` (webview->host is lower-trust). */
export function isReadyMessage(message: unknown): message is ReadyMessage {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'ready';
}

/** Narrow an untrusted inbound message to a well-formed `ReviewActionMessage`. */
export function isReviewActionMessage(message: unknown): message is ReviewActionMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const m = message as { type?: unknown; action?: unknown; builderId?: unknown };
  return m.type === 'review-action'
    && typeof m.action === 'string'
    && Object.prototype.hasOwnProperty.call(REVIEW_ACTION_COMMANDS, m.action)
    && typeof m.builderId === 'string'
    && m.builderId.length > 0;
}
