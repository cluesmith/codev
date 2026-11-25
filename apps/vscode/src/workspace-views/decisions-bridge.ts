/**
 * The Decisions panel's Tower calls (Spec 1963): read, rule and image, made by the extension host
 * with this window's Tower connection, and turned into the results the shared Decisions view shows.
 * The mapping is the dashboard's (`apps/web/src/lib/api.ts`), so a card shows the same text in both:
 * - a refusal keeps Tower's `code` and `message`;
 * - not-found on a read is the empty state (no decisions file), with a hint to create one;
 * - "Tower was not reached" and "Tower answered with something else" each say so.
 *
 * Never throws. While this window is not connected to Tower nothing is requested, and each call
 * says it is not connected: the view keeps the last document it read, under that notice.
 * No `vscode` import.
 */

import type { DecisionsRuleRequest } from '@cluesmith/codev-types';
import type { DecisionImageRouteResult, TowerClient } from '@cluesmith/codev-sdk/tower-client';
import type { DecisionRulingResult, DecisionsFetchResult } from '@cluesmith/codev-workspace-views/host';
import type { ConnectionState } from '../connection-manager.js';
import type { DecisionsImagePayload } from './messages.js';

/** What the bridge needs of this window's connection (`ConnectionManager`). */
export interface DecisionsConnection {
  getState(): ConnectionState;
  getClient(): Pick<TowerClient, 'getDecisions' | 'ruleDecision' | 'getDecisionImage'> | null;
  /** The workspace whose decisions file the panel shows. */
  getWorkspacePath(): string | null;
}

export const NOT_CONNECTED_MESSAGE = 'Not connected to Tower.';

/** Appended to Tower's not-found message: how a workspace gets a decisions file. */
export const DECISIONS_INIT_HINT = 'To start one, run afx decisions init in this workspace.';

/**
 * The client's two fixed transport texts. Any other is a raw transport error, which can name Tower's
 * URL or port, and no webview message may carry those: it shows as {@link TRANSPORT_FAILED}.
 */
const SHOWN_TRANSPORT_ERRORS = new Set(['Tower not running', 'Request timeout']);
export const TRANSPORT_FAILED = 'the connection failed';

function unanswered(result: { kind: 'unreachable'; error: string } | { kind: 'unreadable'; status: number }): string {
  if (result.kind === 'unreadable') { return `Unexpected response from Tower (HTTP ${result.status})`; }
  return `Could not reach Tower: ${SHOWN_TRANSPORT_ERRORS.has(result.error) ? result.error : TRANSPORT_FAILED}`;
}

export class DecisionsBridge {
  constructor(private readonly connection: DecisionsConnection) {}

  /** The client and workspace to call, or null while this window is not connected. */
  private target(): { client: NonNullable<ReturnType<DecisionsConnection['getClient']>>; workspacePath: string } | null {
    if (this.connection.getState() !== 'connected') { return null; }
    const client = this.connection.getClient();
    const workspacePath = this.connection.getWorkspacePath();
    if (!client || !workspacePath) { return null; }
    return { client, workspacePath };
  }

  async read(): Promise<DecisionsFetchResult> {
    const target = this.target();
    if (!target) { return { kind: 'error', message: NOT_CONNECTED_MESSAGE }; }
    const result = await target.client.getDecisions(target.workspacePath);
    if (result.kind !== 'verdict') { return { kind: 'error', message: unanswered(result) }; }
    const { verdict } = result;
    if (verdict.ok) { return { kind: 'document', document: verdict.document }; }
    if (verdict.code === 'not-found') { return { kind: 'not-found', message: `${verdict.message} ${DECISIONS_INIT_HINT}` }; }
    return { kind: 'error', message: verdict.message };
  }

  async rule(request: DecisionsRuleRequest): Promise<DecisionRulingResult> {
    const target = this.target();
    if (!target) { return { kind: 'error', message: `${NOT_CONNECTED_MESSAGE} The ruling was not sent.` }; }
    const result = await target.client.ruleDecision(target.workspacePath, request);
    if (result.kind !== 'verdict') { return { kind: 'error', message: unanswered(result) }; }
    const { verdict } = result;
    if (verdict.ok) { return { kind: 'document', document: verdict.document }; }
    return { kind: 'refused', code: verdict.code, message: verdict.message };
  }

  async image(imagePath: string): Promise<DecisionsImagePayload> {
    const target = this.target();
    if (!target) { return { kind: 'not-loaded', message: NOT_CONNECTED_MESSAGE }; }
    const result: DecisionImageRouteResult = await target.client.getDecisionImage(target.workspacePath, imagePath);
    switch (result.kind) {
      case 'image':
        return { kind: 'image', bytes: result.bytes, contentType: result.contentType };
      case 'verdict':
        return { kind: 'not-loaded', message: result.verdict.message };
      default:
        return { kind: 'not-loaded', message: unanswered(result) };
    }
  }
}
