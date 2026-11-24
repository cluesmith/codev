/**
 * The host ↔ webview contract of the Work and Decisions panels (Spec 1963).
 *
 * The webviews never contact Tower: every read and action is a message to the extension host,
 * which makes the Tower call with its own connection and posts the result back. A request carries
 * a `requestId` the reply echoes, so the webview can match replies to requests it still waits on.
 *
 * Webview → host messages are untrusted: the host acts on one only after its `is*Message` guard
 * accepts it. Pure types and guards, no `vscode` import, so the webview bundle shares them.
 */

import type { DecisionsRuleRequest } from '@cluesmith/codev-types';
import type { DecisionRulingResult, DecisionsFetchResult } from '@cluesmith/codev-workspace-views/host';

/** The Decisions panel's webview type, as its serializer and restore know it. */
export const DECISIONS_VIEW_TYPE = 'codev.decisions';

// ── Webview → host ──────────────────────────────────────────────────────────

/** The webview has mounted: the host answers with the panel's visibility. */
export interface ReadyMessage {
  type: 'ready';
}

/** Read the workspace's decisions document. */
export interface DecisionsReadMessage {
  type: 'decisions/read';
  requestId: number;
}

/** Write the owner's ruling. */
export interface DecisionsRuleMessage {
  type: 'decisions/rule';
  requestId: number;
  request: DecisionsRuleRequest;
}

/** Load an image an item names by its workspace path, as written in the item. */
export interface DecisionsImageMessage {
  type: 'decisions/image';
  requestId: number;
  path: string;
}

/** Open a link in the user's browser. The host opens only http(s) URLs. */
export interface OpenExternalMessage {
  type: 'open-external';
  url: string;
}

export type DecisionsWebviewMessage =
  | ReadyMessage
  | DecisionsReadMessage
  | DecisionsRuleMessage
  | DecisionsImageMessage
  | OpenExternalMessage;

// ── Host → webview ──────────────────────────────────────────────────────────

/**
 * Whether the panel is on screen. A retained, hidden webview still reports
 * `document.visibilityState === 'visible'`, so the panel's own visibility comes from the host.
 */
export interface VisibilityMessage {
  type: 'visibility';
  visible: boolean;
}

export interface DecisionsReadResultMessage {
  type: 'decisions/read-result';
  requestId: number;
  result: DecisionsFetchResult;
}

export interface DecisionsRuleResultMessage {
  type: 'decisions/rule-result';
  requestId: number;
  result: DecisionRulingResult;
}

/** An image as the host delivers it: its bytes and type, which the webview shows as an object URL. */
export type DecisionsImagePayload =
  | { kind: 'image'; bytes: Uint8Array; contentType: string }
  | { kind: 'not-loaded'; message: string };

export interface DecisionsImageResultMessage {
  type: 'decisions/image-result';
  requestId: number;
  result: DecisionsImagePayload;
}

export type DecisionsHostMessage =
  | VisibilityMessage
  | DecisionsReadResultMessage
  | DecisionsRuleResultMessage
  | DecisionsImageResultMessage;

// ── Guards (webview → host is untrusted) ────────────────────────────────────

/** The longest image path or URL a webview may send; item markdown never needs more. */
export const MAX_WEBVIEW_STRING = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_WEBVIEW_STRING;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

export function isReadyMessage(message: unknown): message is ReadyMessage {
  return isRecord(message) && message.type === 'ready';
}

export function isDecisionsReadMessage(message: unknown): message is DecisionsReadMessage {
  return isRecord(message) && message.type === 'decisions/read' && isRequestId(message.requestId);
}

/**
 * A ruling request of the shape Tower's rule route takes: a non-empty `id` and `fingerprint`,
 * and `word` and `comment` strings when present. Tower checks the content.
 */
function isRuleRequest(value: unknown): value is DecisionsRuleRequest {
  return isRecord(value)
    && typeof value.id === 'string' && value.id.length > 0
    && typeof value.fingerprint === 'string' && value.fingerprint.length > 0
    && isOptionalString(value.word)
    && isOptionalString(value.comment);
}

export function isDecisionsRuleMessage(message: unknown): message is DecisionsRuleMessage {
  return isRecord(message) && message.type === 'decisions/rule'
    && isRequestId(message.requestId) && isRuleRequest(message.request);
}

export function isDecisionsImageMessage(message: unknown): message is DecisionsImageMessage {
  return isRecord(message) && message.type === 'decisions/image'
    && isRequestId(message.requestId) && isBoundedString(message.path) && !message.path.includes('\0');
}

/** The message's shape only: whether its URL may be opened is `security.ts`'s decision. */
export function isOpenExternalMessage(message: unknown): message is OpenExternalMessage {
  return isRecord(message) && message.type === 'open-external' && isBoundedString(message.url);
}

/** Only the fields Tower's rule route reads, so nothing else a webview adds is forwarded. */
export function ruleRequestOf(message: DecisionsRuleMessage): DecisionsRuleRequest {
  const { id, fingerprint, word, comment } = message.request;
  const request: DecisionsRuleRequest = { id, fingerprint };
  if (word !== undefined) { request.word = word; }
  if (comment !== undefined) { request.comment = comment; }
  return request;
}
