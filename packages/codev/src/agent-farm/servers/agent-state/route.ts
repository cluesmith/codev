/**
 * `POST /api/agent-lifecycle`: the one write-only agent-state route (Spec 1595,
 * Constraint 16).
 *
 * An agent's lifecycle reporter posts one `AgentLifecycleEvent` per harness hook.
 * The route validates it strictly against the contract and its limits, resolves
 * the launch identity to the agent Tower knows, applies it to the in-memory
 * store, and answers an empty 204. It writes nothing else: no PTY, no mailbox,
 * no database. There is no read route; state is served on the overview.
 *
 * Auth is the existing `isRequestAllowed` choke point in `handleRequest`; this
 * route is not on the public allowlist. A rejection is a 4xx carrying only an
 * error code. The reporter ignores every response.
 */

import type http from 'node:http';
import { isAbsolute } from 'node:path';
import type {
  AgentLaunchIdentity,
  AgentLifecycleEvent,
  AgentLifecycleEventName,
  NeedsInputDetail,
} from '@cluesmith/codev-types';
import { readBody } from '../../utils/server-utils.js';
import type { AgentStateStore } from './store.js';
import type { ResolvedAgent } from './identity.js';

/** Request body cap, in bytes. */
export const MAX_LIFECYCLE_BODY_BYTES = 8192;
export const MAX_PATH_LENGTH = 4096;
export const MAX_NAME_LENGTH = 128;
export const MAX_SESSION_ID_LENGTH = 128;
export const MAX_TOOL_LENGTH = 64;
export const MAX_SUMMARY_LENGTH = 200;

const EVENT_NAMES: ReadonlySet<string> = new Set<AgentLifecycleEventName>([
  'session-started',
  'turn-started',
  'tool-activity',
  'needs-input',
  'turn-ended',
]);
const NEEDS_INPUT_KINDS: ReadonlySet<string> = new Set<NeedsInputDetail['kind']>(['permission', 'question', 'other']);
const EVENT_KEYS: ReadonlySet<string> = new Set(['agent', 'sessionId', 'event', 'at', 'needsInput', 'backgroundWork']);
const BUILDER_KEYS: ReadonlySet<string> = new Set(['kind', 'worktreePath']);
const ARCHITECT_KEYS: ReadonlySet<string> = new Set(['kind', 'workspacePath', 'name']);
const DETAIL_KEYS: ReadonlySet<string> = new Set(['kind', 'tool', 'summary']);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export interface AgentLifecycleDeps {
  store: AgentStateStore;
  resolve: (identity: AgentLaunchIdentity) => ResolvedAgent | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isPlainText(value: unknown, maxLength: number): value is string {
  return isBoundedString(value, maxLength) && !CONTROL_CHARACTERS.test(value);
}

function isAbsolutePath(value: unknown): value is string {
  return isPlainText(value, MAX_PATH_LENGTH) && isAbsolute(value);
}

function parseIdentity(value: unknown): AgentLaunchIdentity | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'builder') {
    if (!hasOnlyKeys(value, BUILDER_KEYS) || !isAbsolutePath(value.worktreePath)) return null;
    return { kind: 'builder', worktreePath: value.worktreePath };
  }
  if (value.kind === 'architect') {
    if (!hasOnlyKeys(value, ARCHITECT_KEYS) || !isAbsolutePath(value.workspacePath)) return null;
    if (!isPlainText(value.name, MAX_NAME_LENGTH)) return null;
    return { kind: 'architect', workspacePath: value.workspacePath, name: value.name };
  }
  return null;
}

function parseDetail(value: unknown): NeedsInputDetail | null {
  if (!isRecord(value) || !hasOnlyKeys(value, DETAIL_KEYS)) return null;
  if (typeof value.kind !== 'string' || !NEEDS_INPUT_KINDS.has(value.kind)) return null;
  const detail: NeedsInputDetail = { kind: value.kind as NeedsInputDetail['kind'] };
  if (value.tool !== undefined) {
    if (!isPlainText(value.tool, MAX_TOOL_LENGTH)) return null;
    detail.tool = value.tool;
  }
  if (value.summary !== undefined) {
    if (!isPlainText(value.summary, MAX_SUMMARY_LENGTH)) return null;
    detail.summary = value.summary;
  }
  return detail;
}

/**
 * Validate a parsed body against the `AgentLifecycleEvent` contract, or `null`.
 * Strict: unknown keys anywhere are rejected, `needsInput` is accepted only on a
 * `needs-input` event and `backgroundWork` only on `turn-ended`.
 */
export function parseLifecycleEvent(value: unknown): AgentLifecycleEvent | null {
  if (!isRecord(value) || !hasOnlyKeys(value, EVENT_KEYS)) return null;
  const agent = parseIdentity(value.agent);
  if (agent === null) return null;
  if (!isPlainText(value.sessionId, MAX_SESSION_ID_LENGTH)) return null;
  if (typeof value.event !== 'string' || !EVENT_NAMES.has(value.event)) return null;
  if (typeof value.at !== 'number' || !Number.isFinite(value.at) || value.at <= 0) return null;

  const event: AgentLifecycleEvent = {
    agent,
    sessionId: value.sessionId,
    event: value.event as AgentLifecycleEventName,
    at: value.at,
  };
  if (value.needsInput !== undefined) {
    if (event.event !== 'needs-input') return null;
    const detail = parseDetail(value.needsInput);
    if (detail === null) return null;
    event.needsInput = detail;
  }
  if (value.backgroundWork !== undefined) {
    if (event.event !== 'turn-ended' || typeof value.backgroundWork !== 'boolean') return null;
    event.backgroundWork = value.backgroundWork;
  }
  return event;
}

function reject(res: http.ServerResponse, status: number, code: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: code }));
}

/** Handle one lifecycle report. Auth has already passed in `handleRequest`. */
export async function handleAgentLifecycle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AgentLifecycleDeps,
): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req, MAX_LIFECYCLE_BODY_BYTES);
  } catch (err) {
    if (err instanceof Error && err.message === 'Request body too large') {
      reject(res, 413, 'BODY_TOO_LARGE');
    } else {
      reject(res, 400, 'UNREADABLE_BODY');
    }
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    reject(res, 400, 'INVALID_JSON');
    return;
  }

  const event = parseLifecycleEvent(parsed);
  if (event === null) {
    reject(res, 400, 'INVALID_EVENT');
    return;
  }

  const agent = deps.resolve(event.agent);
  if (agent === null) {
    reject(res, 404, 'UNKNOWN_AGENT');
    return;
  }

  if (deps.store.apply(agent.workspacePath, agent.agentId, event) === 'future') {
    reject(res, 400, 'AT_IN_FUTURE');
    return;
  }

  res.writeHead(204);
  res.end();
}
