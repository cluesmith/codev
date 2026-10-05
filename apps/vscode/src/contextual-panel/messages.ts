/**
 * Host <-> webview message contract for the contextual panel.
 *
 * EXTENSION-LOCAL (see `types.ts`): this crosses only the panel's own `postMessage` boundary. The
 * panel is purely contextual: the host pushes renders, the webview announces it has mounted, and the
 * review-queue body asks the host to run the existing review-queue commands or open a commented file
 * (#1559). There is no panel navigation (no pills, no selection).
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
  /** The shown builder's review queue, present only for `code-review` and `builder-inspector`
   *  (same alongside-the-descriptor rule as `attention`). */
  codeReview?: CodeReviewSummary;
  /** The queue key `codeReview` belongs to (the overview builder id). Review actions address it;
   *  in Builder Inspector mode it differs from the descriptor's terminal builder id. */
  reviewBuilderId?: string;
}

export type HostToWebviewMessage = RenderMessage;

/** Webview -> host: the webview has mounted and wants the current descriptor. */
export interface ReadyMessage {
  type: 'ready';
}

/** The review-queue actions the panel can trigger, mapped to their command ids. Submit passes
 *  `pendingOnly`: the panel offers Re-send / Mark Delivered as their own buttons, not a prompt. */
export const REVIEW_ACTION_COMMANDS = {
  submit: 'codev.submitReview',
  discard: 'codev.discardReviewComments',
  resend: 'codev.resendReview',
  markDelivered: 'codev.markReviewDelivered',
} as const;

export type ReviewAction = keyof typeof REVIEW_ACTION_COMMANDS;

/** Webview -> host: run a review-queue action for the builder the panel shows. */
export interface ReviewActionMessage {
  type: 'review-action';
  action: ReviewAction;
  builderId: string;
}

/** Webview -> host: open a commented file (at a line) for the builder the panel shows. */
export interface OpenLocationMessage {
  type: 'open-location';
  builderId: string;
  relPath: string;
  /** 1-based; absent for a whole-file reference. */
  line?: number;
}

export type WebviewToHostMessage = ReadyMessage | ReviewActionMessage | OpenLocationMessage;

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

/** Narrow an untrusted inbound message to a well-formed `OpenLocationMessage`. */
export function isOpenLocationMessage(message: unknown): message is OpenLocationMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const m = message as { type?: unknown; builderId?: unknown; relPath?: unknown; line?: unknown };
  return m.type === 'open-location'
    && typeof m.builderId === 'string'
    && m.builderId.length > 0
    && typeof m.relPath === 'string'
    && m.relPath.length > 0
    && (m.line === undefined || (typeof m.line === 'number' && Number.isInteger(m.line) && m.line > 0));
}
