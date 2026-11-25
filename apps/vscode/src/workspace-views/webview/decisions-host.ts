/**
 * The Decisions view's host inside the VS Code webview (Spec 1963): every read, ruling and image is
 * a message to the extension host, which makes the Tower call and posts the result back. Nothing
 * here contacts Tower or anywhere else; the webview's CSP has no `connect-src`.
 *
 * - Each request carries a `requestId`; its reply resolves the request's promise. A reply for no
 *   pending request (a duplicate, or one for an image the view stopped waiting for) is ignored.
 * - Never rejects, as the view's host contract requires.
 * - An image the view aborts stops waiting at once and resolves as not loaded; the view ignores a
 *   result after its abort anyway.
 * - `showImage` opens the panel's own full-size view (a webview cannot open browser tabs);
 *   `openExternal` asks the host, which opens only http(s) URLs.
 *
 * One instance per webview, passed to the view on every render: the view keys image loads on it.
 */

import type { DecisionsRuleRequest } from '@cluesmith/codev-types';
import type {
  DecisionImageResult,
  DecisionRulingResult,
  DecisionsFetchResult,
  DecisionsViewHost,
} from '@cluesmith/codev-workspace-views/host';
import type {
  DecisionsHostMessage,
  DecisionsImagePayload,
  DecisionsWebviewMessage,
} from '../messages.js';

type Reply = Exclude<DecisionsHostMessage, { type: 'visibility' }>;

/** A full-size image the panel shows over the view. */
export interface FullSizeImage {
  src: string;
  alt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const REPLY_TYPES: ReadonlySet<string> = new Set(['decisions/read-result', 'decisions/rule-result', 'decisions/image-result']);

/** A reply from the host, by its shape. The result inside is the host's, which the view renders. */
function isReply(message: unknown): message is Reply {
  return isRecord(message) && typeof message.type === 'string' && REPLY_TYPES.has(message.type)
    && typeof message.requestId === 'number' && isRecord(message.result) && typeof message.result.kind === 'string';
}

/** A visibility message from the host, or null. */
export function visibilityOf(message: unknown): boolean | null {
  if (isRecord(message) && message.type === 'visibility' && typeof message.visible === 'boolean') {
    return message.visible;
  }
  return null;
}

export class WebviewDecisionsHost implements DecisionsViewHost {
  private nextRequestId = 0;
  private readonly pending = new Map<number, (reply: Reply) => void>();

  constructor(
    private readonly post: (message: DecisionsWebviewMessage) => void,
    private readonly onShowImage: (image: FullSizeImage) => void,
  ) {}

  /** Deliver a message from the extension host. Anything that is not a pending request's reply is ignored. */
  receive(message: unknown): void {
    if (!isReply(message)) { return; }
    const resolve = this.pending.get(message.requestId);
    if (!resolve) { return; }
    this.pending.delete(message.requestId);
    resolve(message);
  }

  read(): Promise<DecisionsFetchResult> {
    return this.request<DecisionsFetchResult>(
      requestId => ({ type: 'decisions/read', requestId }),
      reply => (reply.type === 'decisions/read-result' ? reply.result : { kind: 'error', message: mismatch(reply) }),
    );
  }

  rule(request: DecisionsRuleRequest): Promise<DecisionRulingResult> {
    return this.request<DecisionRulingResult>(
      requestId => ({ type: 'decisions/rule', requestId, request }),
      reply => (reply.type === 'decisions/rule-result' ? reply.result : { kind: 'error', message: mismatch(reply) }),
    );
  }

  image(path: string, signal: AbortSignal): Promise<DecisionImageResult> {
    const aborted: DecisionImageResult = { kind: 'not-loaded', message: 'The image is no longer shown.' };
    if (signal.aborted) { return Promise.resolve(aborted); }
    let requestId = -1;
    const result = this.request<DecisionImageResult>(
      id => {
        requestId = id;
        return { type: 'decisions/image', requestId: id, path };
      },
      reply => (reply.type === 'decisions/image-result' ? imageResult(reply.result) : { kind: 'not-loaded', message: mismatch(reply) }),
    );
    return new Promise(resolve => {
      // On abort the request's resolver leaves `pending`, so `result` can never settle; with that
      // resolver gone nothing references `result`, and it is collected with its `then` below.
      const onAbort = () => {
        this.pending.delete(requestId);
        resolve(aborted);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void result.then(value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      });
    });
  }

  openExternal(url: string): void {
    this.post({ type: 'open-external', url });
  }

  showImage(image: FullSizeImage): void {
    this.onShowImage(image);
  }

  private request<T>(message: (requestId: number) => DecisionsWebviewMessage, toResult: (reply: Reply) => T): Promise<T> {
    const requestId = this.nextRequestId++;
    return new Promise<T>(resolve => {
      this.pending.set(requestId, reply => resolve(toResult(reply)));
      this.post(message(requestId));
    });
  }
}

/** A workspace image as the view takes it: a `Blob` of the bytes the host delivered. */
function imageResult(payload: DecisionsImagePayload): DecisionImageResult {
  if (payload.kind === 'not-loaded') { return payload; }
  return { kind: 'image', blob: new Blob([payload.bytes as Uint8Array<ArrayBuffer>], { type: payload.contentType }) };
}

/** A reply of the wrong type for its request: a host bug, shown where the result would be. */
function mismatch(reply: Reply): string {
  return `The extension answered this request with ${reply.type}.`;
}
