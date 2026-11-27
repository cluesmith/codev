/**
 * Tower API Client
 *
 * Provides a client for interacting with the Tower daemon.
 * Handles authentication and common API operations.
 *
 * Environment-agnostic (issue #1189): runs unmodified in browser, Node, and
 * React Native. Auth and transport arrive as injected adapters; there is no
 * disk, environment, or fetch-implementation assumption in this module. Node
 * consumers that want the local-key default compose it themselves (the CLI
 * wrapper in packages/codev injects `ensureLocalKey`; the VS Code extension
 * injects its SecretStorage-cached reader; `@cluesmith/codev-sdk/node` offers
 * the read-only reader for standalone Node controllers).
 */

import type { DashboardState, OverviewData, IssueView, PRView, IssueSearchResponse, ResolvedWorktreeConfig, ResolvedActivityHooks, TowerVersionInfo, CommandRequest, CanvasCommand, CanvasCommandRequest, CanvasCommandResult, CanvasCommandClientResult, CanvasCommandErrorCode, DecisionsDocument, DecisionsReadResponse, DecisionsRefusalCode, DecisionsRuleRequest, DecisionsRuleResponse, SetWorkspaceAddressNameRequest, SetWorkspaceAddressNameResponse, AddressBookResponse, PeerSwitchRequest, PeerSwitchResponse, PeerGrantsResponse, PeerGrantRequest, PeerGrantResponse, PeerRevokeRequest, PeerRevokeResponse, PeerLimitsResponse, PeerTowersResponse, RemoteSendAnswer, RemoteSendRefusal, REMOTE_HELD_ON_FAULT_ERROR, REMOTE_REFUSED_ERROR, MAX_REQUEST_BODY_BYTES } from '@cluesmith/codev-types';
import { DEFAULT_TOWER_PORT } from './constants.js';
import { isRemoteAddress, parseAddress } from './address.js';
import { parseSseText, type SseEnvelope } from './sse.js';

/*
 * `getOverview` returns `OverviewData`, so the subpath carries the contract
 * with the client (issue #1357). `export type` only — erased at build, keeping
 * the zero-runtime-deps posture; the import-boundary test pins the form.
 */
export type { OverviewData } from '@cluesmith/codev-types';

const REQUEST_TIMEOUT_MS = 10000;

/**
 * How long a send to another Tower may take to answer (Spec 1967). The sending Tower may
 * fetch its peer list to resolve the name, wait for a relay call ahead of this one, and make
 * this one, each bounded by its own 20-second timeout; the margin covers the rest.
 */
const REMOTE_SEND_TIMEOUT_MS = 65_000;

/** `POST /api/send`'s code for a refused send to another Tower; the value itself, as the SDK carries no runtime import. */
const REMOTE_REFUSED: typeof REMOTE_REFUSED_ERROR = 'REMOTE_REFUSED';

/** The largest request body Tower reads; mirrored the same way. Past it, Tower drops the request unanswered. */
const TOWER_MAX_REQUEST_BYTES: typeof MAX_REQUEST_BODY_BYTES = 1_048_576;

/** `sendMessage`'s code for a send it did not make: its request is larger than Tower reads. */
const REQUEST_TOO_LARGE = 'REQUEST_TOO_LARGE';

/** `POST /api/send`'s code for a message stored and held on the sending Tower but not sent now; mirrored the same way. */
const REMOTE_HELD_ON_FAULT: typeof REMOTE_HELD_ON_FAULT_ERROR = 'REMOTE_HELD_ON_FAULT';

/** Is `to` an address that names a Tower? Text that is not an address is not, and Tower refuses it. */
function namesATower(to: string): boolean {
  const parsed = parseAddress(to);
  return parsed.ok && isRemoteAddress(parsed.address);
}

/** The refusal fields of a `REMOTE_REFUSED` answer, each only if it has its type. */
function readRemoteRefusal(body: Record<string, unknown> | undefined): RemoteSendRefusal | undefined {
  if (body === undefined) return undefined;
  const { refusedBy, reason, retryAfterSec, mailboxId, peer, detail } = body;
  if (refusedBy !== 'this-tower' && refusedBy !== 'cloud' && refusedBy !== 'peer') return undefined;
  if (typeof reason !== 'string') return undefined;
  return {
    refusedBy,
    reason,
    retryAfterSec: typeof retryAfterSec === 'number' ? retryAfterSec : null,
    mailboxId: typeof mailboxId === 'string' ? mailboxId : null,
    peer: typeof peer === 'string' ? peer : null,
    detail: typeof detail === 'string' ? detail : null,
  };
}

/** The `remote` part of an answer from a send to another Tower, each field only if it has its type. */
function readRemoteAnswer(remote: unknown): RemoteSendAnswer | undefined {
  if (typeof remote !== 'object' || remote === null) return undefined;
  const { peer, heldWhere, ahead, duplicate, detail } = remote as Record<string, unknown>;
  if (typeof peer !== 'string') return undefined;
  return {
    peer,
    ...(heldWhere === 'recipient' || heldWhere === 'this-tower' ? { heldWhere } : {}),
    ...(typeof ahead === 'number' ? { ahead } : {}),
    ...(typeof duplicate === 'boolean' ? { duplicate } : {}),
    ...(typeof detail === 'string' ? { detail } : {}),
  };
}

/**
 * The command-relay route. Mirrors `COMMAND_ROUTE` in `@cluesmith/codev-types`
 * (the provider side) rather than importing it: the sdk's zero-runtime-deps
 * contract keeps codev-types type-only, and the mirror is one string literal.
 * Recorded in issue #1189; the boundary test enforces the type-only rule.
 */
export const COMMAND_ROUTE = '/api/command';

/**
 * The canvas command channel (spec 1401). Mirrored from `@cluesmith/codev-types` for the same
 * reason as `COMMAND_ROUTE` above.
 *
 * Separate from the command relay on purpose: that one broadcasts a verb and answers `ok`
 * regardless, while this one resolves a single target view and reports which — or that none is
 * open, which is the whole point of the channel.
 */
export const CANVAS_COMMAND_ROUTE = '/api/canvas/command';
/** Host-side view lifecycle: register, heartbeat, unregister. */
export const CANVAS_VIEWS_ROUTE = '/api/canvas/views';

/**
 * The failure codes Tower itself can answer with. Mirrored from `CanvasCommandErrorCode` (the
 * sdk keeps codev-types type-only), and pinned to it by the assertion below so a code added to
 * the contract cannot silently go unrecognized here — an unrecognized code is treated as an
 * unreadable answer, which would turn a real Tower verdict into a spurious `unreachable`.
 */
const CANVAS_WIRE_ERROR_CODES = ['no-canvas', 'invalid-request'] as const;

/** Fails to instantiate unless the mirror above covers the contract exactly. */
type AssertTrue<T extends true> = T;
type _WireCodesMatchContract = AssertTrue<
  [Exclude<CanvasCommandErrorCode, (typeof CANVAS_WIRE_ERROR_CODES)[number]>] extends [never]
    ? true
    : false
>;

/**
 * Validate a canvas command response against the wire contract.
 *
 * Checking only for an `ok` field would let `{ok:true}` with no target, or a failure carrying an
 * unknown code, pass through as a typed result — the caller would then read `target.viewId` off
 * undefined, or switch on a code that is not in its union. A response we cannot fully verify is
 * not a verdict, so it is reported as unreadable instead.
 */
function parseCanvasCommandResult(body: unknown): CanvasCommandResult | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;

  if (raw.ok === true) {
    const target = raw.target as Record<string, unknown> | undefined;
    if (!target || typeof target !== 'object') return null;
    if (typeof target.viewId !== 'string' || typeof target.file !== 'string') return null;
    return { ok: true, target: { viewId: target.viewId, file: target.file } };
  }

  if (raw.ok === false) {
    if (typeof raw.code !== 'string') return null;
    if (!(CANVAS_WIRE_ERROR_CODES as readonly string[]).includes(raw.code)) return null;
    let error = 'Canvas command failed';
    if (typeof raw.error === 'string') error = raw.error;
    return { ok: false, code: raw.code as CanvasCommandErrorCode, error };
  }

  return null;
}

// ── Types ──────────────────────────────────────────────────────

/**
 * All terminal kinds Tower can host. Used wherever a terminal is created or
 * enumerated. `'dev'` is the ephemeral dev-server PTY spawned by `afx dev`;
 * it is intentionally kept out of SQLite by the runtime filter at
 * `tower-routes.ts` (search for `['builder', 'shell'].includes(body.type)`).
 */
export type TerminalType = 'architect' | 'builder' | 'shell' | 'dev';

export interface TowerWorkspace {
  path: string;
  name: string;
  active: boolean;
  proxyUrl: string;
  terminals: number;
}

export interface TowerWorkspaceStatus {
  path: string;
  name: string;
  active: boolean;
  terminals: Array<{
    type: TerminalType;
    id: string;
    label: string;
    url: string;
    active: boolean;
    /**
     * Spec 786 Phase 5: when `type === 'architect'`, the architect's stable
     * name (`'main'` or a sibling). Older clients ignore this field.
     */
    architectName?: string;
    /**
     * Spec 786 Phase 5: live process ID from Tower's in-memory `PtySession`,
     * surfaced for `afx status`. Not persisted in `state.db.architect` (the
     * row stores `pid: 0` — see state.ts:79, :103), so this field is only
     * available when Tower is running.
     */
    pid?: number;
    /**
     * Spec 786 Phase 5: port assigned to the architect terminal, if any.
     * Same Tower-only constraint as `pid`.
     */
    port?: number;
    /**
     * Spec 786 Phase 5: the actual PtySession id. The `id` field above
     * carries the tab identifier (`'architect'` or `'architect:<name>'`) per
     * Spec 761's deep-link convention; this field exposes the underlying
     * session id so consumers like `afx status` can show it for terminal-
     * attach correlation. Optional for backward compat with older clients
     * that only emit `id`.
     */
    terminalId?: string;
  }>;
}

export interface TowerHealth {
  status: 'healthy' | 'degraded';
  /**
   * Readiness (#997): true once the startup terminal-session reconcile has
   * completed. Distinct from `status` (process liveness) — after a Tower
   * restart, `/api/state` only reflects the full role→terminalId mapping once
   * `ready` is true. Optional for back-compat with older Tower builds that
   * predate the field.
   */
  ready?: boolean;
  uptime: number;
  activeWorkspaces: number;
  totalWorkspaces: number;
  memoryUsage: number;
  /**
   * Issue #1227: total RSS (KB) of every shellper process in this Tower
   * instance's scope plus their direct children — the real OS-level memory
   * cost of the process fleet, as opposed to `memoryUsage` (Tower's own V8
   * heap). Includes not-yet-swept husks, since the point is surfacing the
   * true cost regardless of registration state. Omitted (not `undefined`)
   * when the underlying `ps` scan or DB read fails — a fleet-accounting
   * hiccup never fails `/health` itself. Optional for back-compat with older
   * Tower builds that predate the field.
   */
  fleetRssKb?: number;
  /**
   * Issue #1227: count of in-scope shellper processes not currently tracked
   * in `terminal_sessions` — a lighter, ungated signal than the husk-sweep
   * predicate (no childless/aged requirement), purely informational. Same
   * omit-on-failure and back-compat notes as `fleetRssKb`.
   */
  unregisteredShellperCount?: number;
  timestamp: string;
}

/**
 * One `/health` probe, classified (#1901). `not-running`: the connection was refused, so
 * nothing is listening. `unresponsive`: something accepted the connection but did not answer
 * healthily; `error` carries the reason.
 */
export type TowerHealthProbe =
  | { state: 'running'; health: TowerHealth }
  | { state: 'not-running' }
  | { state: 'unresponsive'; error: string };

/** Issue #1227: a shellper the husk sweep would reap (or has reaped). */
export interface HuskCandidate {
  pid: number;
  rssKb: number;
  /** Milliseconds since the shellper process started, or null if undeterminable. */
  ageMs: number | null;
}

export interface HuskPreview {
  candidates: HuskCandidate[];
  /** The grace period (ms) that gated this preview — same value the sweep itself uses. */
  graceMs: number;
}

export interface HuskSweepResult {
  swept: number;
  pids: number[];
}

export interface TowerTunnelStatus {
  registered: boolean;
  state: string;
  uptime: number | null;
  towerId: string | null;
  /** The cloud's slug: the routing identity in `/t/<slug>/` (Issue #1871). */
  towerName: string | null;
  displayName?: string | null;
  serverUrl: string | null;
  accessUrl: string | null;
  /** Set when the cloud rejected the key after it had connected (Issue #1871). */
  deregisteredAt?: string;
  /**
   * Why the cloud connection is down, while it is: the last attempt's failure, e.g. the
   * remote-messaging switch unreadable from global.db (Spec 1967). `null` when connected.
   * Absent from a Tower that predates it.
   */
  lastFailure?: string | null;
}

export interface TowerStatus {
  instances?: Array<{ workspaceName: string; running: boolean; terminals: unknown[] }>;
}

export interface TowerTerminal {
  id: string;
  pid: number;
  cols: number;
  rows: number;
  label: string;
  status: 'running' | 'exited';
  createdAt: string;
  wsPath: string;
  /**
   * Epoch ms of the last PTY output (Spec 1273). Lets a client measure output
   * quiescence — an agent mid-turn emits continuously, so a stretch with no
   * advance means the turn ended. Optional: terminals served by an older Tower
   * omit it, and a consumer that needs it must say so rather than assume 0.
   */
  lastDataAt?: number;
  /**
   * Whether input can actually reach the process right now (Spec 1273).
   *
   * Distinct from `status`, and they disagree in the case that matters: a
   * session whose shellper connection died reports `status: 'running'` while
   * every write to it is dropped (#1198). Optional for the same reason
   * `lastDataAt` is — an older Tower omits it, and a consumer that needs it
   * must handle absence rather than assume `false`.
   */
  writable?: boolean;
}

// ── Client Options ─────────────────────────────────────────────

/**
 * The answer of a decisions route (Spec 1819), or why there was none. Never thrown:
 * - `verdict`: Tower answered with a decisions body, a document or a refusal with its `code` and
 *   `message`, whatever the HTTP status;
 * - `unreachable`: no answer at all (Tower down, a timeout, a reset);
 * - `unreadable`: an answer that is not a decisions body, such as a 401's plain text.
 */
export type DecisionsRouteResult<T> =
  | { kind: 'verdict'; status: number; verdict: T }
  | { kind: 'unreachable'; error: string }
  | { kind: 'unreadable'; status: number };

/** A decisions route's refusal: its machine `code` and the message the owner reads. */
export interface DecisionsRefusal {
  ok: false;
  code: DecisionsRefusalCode;
  message: string;
}

/**
 * The answer of the decisions image route (#1938): the image's bytes and type, Tower's refusal,
 * or why there was none (as in {@link DecisionsRouteResult}). Never thrown.
 */
export type DecisionImageRouteResult =
  | { kind: 'image'; bytes: Uint8Array; contentType: string }
  | { kind: 'verdict'; status: number; verdict: DecisionsRefusal }
  | { kind: 'unreachable'; error: string }
  | { kind: 'unreadable'; status: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A decisions refusal body, or null. */
function asDecisionsRefusal(body: unknown): DecisionsRefusal | null {
  if (isRecord(body) && body.ok === false && typeof body.code === 'string' && typeof body.message === 'string') {
    return { ok: false, code: body.code as DecisionsRefusalCode, message: body.message };
  }
  return null;
}

/**
 * A decisions document or refusal body, checked as far as the dashboard checks it (the document's
 * `version` and `items`), or null.
 */
function asDecisionsVerdict(body: unknown): DecisionsReadResponse | null {
  if (isRecord(body) && body.ok === true) {
    const doc = body['document'];
    if (isRecord(doc) && typeof doc.version === 'string' && Array.isArray(doc.items)) {
      return { ok: true, document: doc as unknown as DecisionsDocument };
    }
    return null;
  }
  return asDecisionsRefusal(body);
}

export interface TowerClientOptions {
  port?: number;
  host?: string;
  /**
   * Injectable auth key provider. Defaults to no auth (requests carry no
   * `codev-tower-key` header). Consumers entitled to the local key inject a
   * reader; see the module header for the per-environment profiles.
   */
  getAuthKey?: () => string | null;
  /**
   * Injectable transport (the test seam and the environment seam). Defaults
   * to the global fetch, which exists in browsers, Node 18+, and React Native.
   */
  fetchFn?: typeof fetch;
  /**
   * How long one request may wait for Tower's answer, in ms. Defaults to 10 000. A test against
   * a deliberately stalled server sets it short (#1901).
   */
  requestTimeoutMs?: number;
}

// ── Client ─────────────────────────────────────────────────────

import { encodeWorkspacePath } from './workspace.js';

/**
 * Whether a fetch failure was a refused TCP connection: nothing was listening, so the
 * request provably never reached Tower. Node's fetch reports it as `fetch failed` with the
 * `ECONNREFUSED` on `err.cause`, which a check of `err.message` alone never sees (#1950).
 *
 * `localhost` resolves to both `::1` and `127.0.0.1`, and when every address fails Node's cause
 * is an AggregateError whose `code` is copied from the FIRST attempt only. So each attempt is
 * judged (#1901): the connection counts as refused when at least one attempt was refused and
 * every other one also failed before reaching a server (an unreachable `::1` on a machine with
 * broken IPv6, say). A refused `::1` must not mask a `127.0.0.1` that was reached and then
 * failed, such as a reset.
 */
const NEVER_REACHED_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);

function isConnectionRefused(err: unknown): boolean {
  if (!(err instanceof Error)) return String(err).includes('ECONNREFUSED');
  const cause = (err as { cause?: { code?: unknown; message?: unknown; errors?: unknown } }).cause;
  if (Array.isArray(cause?.errors) && cause.errors.length > 0) {
    const codes = cause.errors.map((attempt) => (attempt as { code?: unknown } | null)?.code);
    return codes.includes('ECONNREFUSED') && codes.every((code) => typeof code === 'string' && NEVER_REACHED_CODES.has(code));
  }
  return (
    err.message.includes('ECONNREFUSED') ||
    cause?.code === 'ECONNREFUSED' ||
    (typeof cause?.message === 'string' && cause.message.includes('ECONNREFUSED'))
  );
}

/**
 * Extract a human-facing error string from a Tower error response body (#1333).
 *
 * Tower error responses carry a machine `error` code and, for many cases, a
 * human-readable `message` explaining *why* (e.g. the builder spoofing guard:
 * "builder <id> may only address its own spawning architect"). The previous
 * extraction preferred the bare code and discarded the message, so the CLI
 * surfaced an opaque `NOT_FOUND` with no reason. Surface the descriptive
 * message when present, keeping the code as a parenthetical suffix so both the
 * human reason and the machine code reach the caller. Falls back to the code
 * alone, then to the raw (non-JSON) body text.
 */
function extractTowerError(text: string): string {
  try {
    const json = JSON.parse(text) as { error?: unknown; message?: unknown };
    const code = typeof json.error === 'string' ? json.error : undefined;
    const detail = typeof json.message === 'string' ? json.message : undefined;
    return detail && code && detail !== code
      ? `${detail} (${code})`
      : detail || code || text;
  } catch {
    return text;
  }
}

/**
 * The machine-readable code of a Tower error body (`{ error: 'REFUSED', message }`), when
 * it has one. {@link extractTowerError} folds the code into the text for people; a caller
 * that must act on WHICH failure it was reads this, and never matches the text.
 */
function extractTowerErrorCode(text: string): string | undefined {
  try {
    const json = JSON.parse(text) as { error?: unknown };
    return typeof json.error === 'string' ? json.error : undefined;
  } catch {
    return undefined;
  }
}

/** A Tower error body as an object, when it is one. */
function extractTowerErrorBody(text: string): Record<string, unknown> | undefined {
  try {
    const json: unknown = JSON.parse(text);
    return typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True for the answer a Tower gives to a route it does not have: its catch-all 404, which
 * is plain text and so carries no code. Asked only of routes whose own 404s carry one
 * (or that never answer 404), where it means the Tower is older than this client.
 */
function isUnknownRoute(result: { status: number; errorCode?: string }): boolean {
  return result.status === 404 && result.errorCode === undefined;
}

/** What {@link TowerClient.request} returns. */
export interface TowerRequestResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  errorCode?: string;
  /** A failed answer's body, when it was a JSON object. */
  errorBody?: Record<string, unknown>;
  connectionRefused?: boolean;
}

/** A refused or unanswered call to a peer route (Spec 1967). */
export interface PeerRouteFailure {
  ok: false;
  /** The HTTP status; 0 when no answer came. */
  status: number;
  error: string;
  errorCode?: string;
  /** The Tower has no peer routes: it is older than this client. */
  unknownRoute?: true;
  /** Nothing is listening on the Tower's port. */
  notRunning?: true;
}

/** What a peer route call returns. */
export type PeerRouteResult<T> = { ok: true; result: T } | PeerRouteFailure;

export class TowerClient {
  private readonly baseUrl: string;
  private readonly getAuthKey: () => string | null;
  private readonly fetchFn: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(portOrOptions?: number | TowerClientOptions) {
    let options: TowerClientOptions;
    if (typeof portOrOptions === 'number') {
      options = { port: portOrOptions };
    } else {
      options = portOrOptions ?? {};
    }
    const host = options.host ?? 'localhost';
    const port = options.port ?? DEFAULT_TOWER_PORT;
    this.baseUrl = `http://${host}:${port}`;
    this.getAuthKey = options.getAuthKey ?? (() => null);
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /**
   * `connectionRefused` is set only when the connection was refused: the request provably
   * never reached Tower, so resending it cannot duplicate anything (#1950). A timeout or a
   * reset leaves it unset — that request may have arrived.
   */
  async request<T>(
    path: string,
    options: RequestInit = {},
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<TowerRequestResult<T>> {
    try {
      const authKey = this.getAuthKey();
      const headers: Record<string, string> = {
        ...options.headers as Record<string, string>,
        'Content-Type': 'application/json',
      };
      if (authKey) {
        headers['codev-tower-key'] = authKey;
      }

      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...options,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const text = await response.text();
        const error = extractTowerError(text);
        const errorCode = extractTowerErrorCode(text);
        const errorBody = extractTowerErrorBody(text);
        return {
          ok: false,
          status: response.status,
          error,
          ...(errorCode === undefined ? {} : { errorCode }),
          ...(errorBody === undefined ? {} : { errorBody }),
        };
      }

      if (response.status === 204) {
        return { ok: true, status: 204 };
      }

      const data = (await response.json()) as T;
      return { ok: true, status: response.status, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isConnectionRefused(err)) {
        return { ok: false, status: 0, error: 'Tower not running', connectionRefused: true };
      }
      if (message.includes('timeout')) {
        return { ok: false, status: 0, error: 'Request timeout' };
      }
      // Node's fetch says only `fetch failed`; the reason (ECONNRESET, …) is on the cause (#1901).
      const causeCode = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
      return { ok: false, status: 0, error: typeof causeCode === 'string' ? `${message}: ${causeCode}` : message };
    }
  }

  /**
   * Probe `/health` once and say why it failed, not just that it did (#1901). Only a refused
   * connection means nothing is listening; a timeout, a reset, an error status or an unreadable
   * body all come from something that accepted the connection, which under load is usually a
   * live Tower whose event loop is starved. Retrying, and wording the result for a person, is
   * the caller's policy.
   */
  async probeHealth(): Promise<TowerHealthProbe> {
    const result = await this.request<TowerHealth>('/health');
    if (result.ok && result.data?.status === 'healthy') return { state: 'running', health: result.data };
    if (result.connectionRefused) return { state: 'not-running' };
    if (result.status === 0) return { state: 'unresponsive', error: result.error ?? 'no response' };
    if (!result.ok) return { state: 'unresponsive', error: `HTTP ${result.status}: ${result.error}` };
    return { state: 'unresponsive', error: `reported status ${JSON.stringify(result.data?.status)}` };
  }

  async isRunning(): Promise<boolean> {
    return (await this.probeHealth()).state === 'running';
  }

  async getHealth(): Promise<TowerHealth | null> {
    const result = await this.request<TowerHealth>('/health');
    return result.ok ? result.data! : null;
  }

  /**
   * Probe the *running* Tower process's version (#983, `GET /api/version`).
   *
   * Returns the raw request result rather than a bare `TowerVersionInfo | null`
   * so the caller can tell the cases apart: `status === 404` means the Tower is
   * too old to expose the endpoint (a divergence signal in its own right),
   * while `status === 0` means unreachable. Keeping that distinction here would
   * bake preflight policy into the wire client — the VS Code preflight owns the
   * interpretation.
   */
  async getVersion(): Promise<{ ok: boolean; status: number; data?: TowerVersionInfo; error?: string }> {
    return this.request<TowerVersionInfo>('/api/version');
  }

  /**
   * Issue #1227: preview which shellpers the husk sweep would reap, without
   * killing anything. Backs `afx tower sweep-husks`'s default (no-flags) mode.
   */
  async findHuskCandidates(): Promise<HuskPreview | null> {
    const result = await this.request<HuskPreview>('/api/shellpers/husks');
    return result.ok ? result.data! : null;
  }

  /**
   * Issue #1227: actually reap the current husk candidates. Backs `afx tower
   * sweep-husks --apply`.
   */
  async sweepHusks(): Promise<HuskSweepResult | null> {
    const result = await this.request<HuskSweepResult>('/api/shellpers/husks/sweep', { method: 'POST' });
    return result.ok ? result.data! : null;
  }

  async listWorkspaces(): Promise<TowerWorkspace[]> {
    const result = await this.request<{ workspaces: TowerWorkspace[] }>('/api/workspaces');
    return result.ok ? result.data!.workspaces : [];
  }

  async activateWorkspace(
    workspacePath: string
  ): Promise<{ ok: boolean; adopted?: boolean; error?: string }> {
    const encoded = encodeWorkspacePath(workspacePath);
    const result = await this.request<{ success: boolean; adopted?: boolean; error?: string }>(
      `/api/workspaces/${encoded}/activate`,
      { method: 'POST' }
    );

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return {
      ok: result.data?.success ?? true,
      adopted: result.data?.adopted,
      error: result.data?.error,
    };
  }

  /**
   * Register a new named architect terminal in an active workspace (Spec 755).
   *
   * Without `name`, Tower auto-assigns the next available `architect-<N>`
   * (smallest unused integer ≥ 2). With `name`, the value is validated against
   * `[a-z][a-z0-9-]*` (max 64 chars) and rejected with a 4xx if the name is
   * already in use or malformed.
   */
  async addArchitect(
    workspacePath: string,
    name?: string,
  ): Promise<{ ok: boolean; name?: string; terminalId?: string; error?: string }> {
    const encoded = encodeWorkspacePath(workspacePath);
    // Spec 755: distinguish `undefined` (auto-number) from `""` (server
    // must reject as invalid). Truthiness check would swallow the empty
    // string and silently auto-number — wrong. Send the name iff it was
    // explicitly supplied.
    const body = name === undefined ? {} : { name };
    const result = await this.request<{ success: boolean; name?: string; terminalId?: string; error?: string }>(
      `/api/workspaces/${encoded}/architects`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return {
      ok: result.data?.success ?? false,
      name: result.data?.name,
      terminalId: result.data?.terminalId,
      error: result.data?.error,
    };
  }

  /**
   * Spec 786: remove a named sibling architect from a workspace.
   *
   * REST: `DELETE /api/workspaces/:encoded/architects/:name`. The name is URI-
   * encoded in the path. `main` is rejected server-side (and validated
   * client-side by the CLI before this call). Removing an architect with
   * in-flight builders is permitted — those builders fall back to `main`
   * routing via the existing `tower-messages.ts:336` chain (OQ-A).
   */
  async removeArchitect(
    workspacePath: string,
    name: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const encodedWorkspace = encodeWorkspacePath(workspacePath);
    const encodedName = encodeURIComponent(name);
    const result = await this.request<{ success: boolean; error?: string }>(
      `/api/workspaces/${encodedWorkspace}/architects/${encodedName}`,
      { method: 'DELETE' },
    );

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return {
      ok: result.data?.success ?? false,
      error: result.data?.error,
    };
  }

  async deactivateWorkspace(
    workspacePath: string
  ): Promise<{ ok: boolean; stopped?: number[]; error?: string; status?: number; connectionRefused?: boolean }> {
    const encoded = encodeWorkspacePath(workspacePath);
    const result = await this.request<{ success: boolean; stopped?: number[]; error?: string }>(
      `/api/workspaces/${encoded}/deactivate`,
      { method: 'POST' }
    );

    if (!result.ok) {
      // `status` 0 without `connectionRefused` means Tower took the request and never answered,
      // so the caller cannot know whether it deactivated (#1901).
      return { ok: false, error: result.error, status: result.status, connectionRefused: result.connectionRefused };
    }

    return {
      ok: result.data?.success ?? true,
      stopped: result.data?.stopped,
      error: result.data?.error,
    };
  }

  /**
   * Set a workspace's explicit address name, or clear it with `null` (Spec 1940). A refusal
   * carries Tower's reason in `error` and its code (`INVALID_NAME`, `RESERVED_NAME`,
   * `NAME_TAKEN`, `NOT_FOUND`) in `errorCode`. `unknownRoute` is set when the Tower has no
   * such route at all: it is older than this client.
   */
  async setWorkspaceAddressName(
    workspacePath: string,
    name: string | null,
  ): Promise<
    | { ok: true; result: SetWorkspaceAddressNameResponse }
    | { ok: false; error: string; errorCode?: string; unknownRoute?: true }
  > {
    const encoded = encodeWorkspacePath(workspacePath);
    const body: SetWorkspaceAddressNameRequest = { name };
    const result = await this.request<SetWorkspaceAddressNameResponse>(
      `/api/workspaces/${encoded}/address-name`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!result.ok || result.data === undefined) {
      const failure = { ok: false as const, error: result.error ?? `Tower answered ${result.status}` };
      if (isUnknownRoute(result)) return { ...failure, unknownRoute: true };
      return result.errorCode === undefined ? failure : { ...failure, errorCode: result.errorCode };
    }
    return { ok: true, result: result.data };
  }

  /**
   * Every workspace on this Tower and its agents, as addresses for `caller` (Spec 1940):
   * the caller's workspace and sender id, as `sendMessage` gives them. A caller that
   * gives neither is treated as a sender outside every workspace. `unknownRoute` is set
   * when the Tower has no address book at all: it is older than this client.
   */
  async getAddressBook(
    caller: { workspace?: string; from?: string } = {},
  ): Promise<{ ok: true; result: AddressBookResponse } | { ok: false; error: string; unknownRoute?: true; unanswered?: true }> {
    const query = new URLSearchParams();
    if (caller.workspace !== undefined) query.set('workspace', caller.workspace);
    if (caller.from !== undefined) query.set('from', caller.from);
    const text = query.toString();
    const result = await this.request<AddressBookResponse>(`/api/address-book${text === '' ? '' : `?${text}`}`);
    if (!result.ok || result.data === undefined) {
      const failure = { ok: false as const, error: result.error ?? `Tower answered ${result.status}` };
      if (isUnknownRoute(result)) return { ...failure, unknownRoute: true };
      // No HTTP answer at all (timeout, reset, refused): says nothing about which Tower it is (#1901).
      return result.status === 0 ? { ...failure, unanswered: true } : failure;
    }
    return { ok: true, result: result.data };
  }

  // ── Peers: the remote-messaging switch and grants (Spec 1967) ──

  /**
   * One call to a `/api/peer/…` route. A refusal carries Tower's reason in `error` and its
   * code in `errorCode` (see `PeerSwitchResponse` and its neighbours in codev-types for the
   * codes). `unknownRoute` is set when the Tower has no peer routes at all: it is older than
   * this client. `notRunning` is set when nothing answered on the Tower's port.
   */
  private async peerCall<T>(path: string, init: RequestInit = {}): Promise<PeerRouteResult<T>> {
    const result = await this.request<T>(path, init);
    if (result.ok && result.data !== undefined) return { ok: true, result: result.data };
    const failure: PeerRouteFailure = { ok: false, status: result.status, error: result.error ?? `Tower answered ${result.status}` };
    if (result.connectionRefused) return { ...failure, notRunning: true };
    if (isUnknownRoute(result)) return { ...failure, unknownRoute: true };
    return result.errorCode === undefined ? failure : { ...failure, errorCode: result.errorCode };
  }

  private peerPost<T>(path: string, method: 'POST' | 'PUT', body: unknown): Promise<PeerRouteResult<T>> {
    return this.peerCall<T>(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** The remote-messaging switch. */
  getPeerSwitch(): Promise<PeerRouteResult<PeerSwitchResponse>> {
    return this.peerCall<PeerSwitchResponse>('/api/peer/switch');
  }

  /** Turn remote messaging on or off. Tower refuses `on` unless `humanApproved` is true. */
  setPeerSwitch(request: PeerSwitchRequest): Promise<PeerRouteResult<PeerSwitchResponse>> {
    return this.peerPost<PeerSwitchResponse>('/api/peer/switch', 'PUT', request);
  }

  /** This Tower's grants, or one peer's (named by a tower-ref). */
  getPeerGrants(tower?: string): Promise<PeerRouteResult<PeerGrantsResponse>> {
    const query = tower === undefined ? '' : `?${new URLSearchParams({ tower }).toString()}`;
    return this.peerCall<PeerGrantsResponse>(`/api/peer/grants${query}`);
  }

  /** Add grants. Tower refuses unless `humanApproved` is true. */
  addPeerGrants(request: PeerGrantRequest): Promise<PeerRouteResult<PeerGrantResponse>> {
    return this.peerPost<PeerGrantResponse>('/api/peer/grants', 'POST', request);
  }

  /** Remove grants: those named, or every grant for the peer when none are. */
  revokePeerGrants(request: PeerRevokeRequest): Promise<PeerRouteResult<PeerRevokeResponse>> {
    return this.peerPost<PeerRevokeResponse>('/api/peer/grants/revoke', 'POST', request);
  }

  /** The limits this Tower enforces itself, and Codev Cloud's as its last peer list gave them. */
  getPeerLimits(): Promise<PeerRouteResult<PeerLimitsResponse>> {
    return this.peerCall<PeerLimitsResponse>('/api/peer/limits');
  }

  /** My other Towers: Tower asks Codev Cloud, within its call budget, and answers from its cache otherwise. */
  getPeerTowers(): Promise<PeerRouteResult<PeerTowersResponse>> {
    return this.peerCall<PeerTowersResponse>('/api/peer/towers');
  }

  async getWorkspaceStatus(workspacePath: string): Promise<TowerWorkspaceStatus | null> {
    const encoded = encodeWorkspacePath(workspacePath);
    const result = await this.request<TowerWorkspaceStatus>(`/api/workspaces/${encoded}/status`);
    return result.ok ? result.data! : null;
  }

  async getOverview(workspacePath?: string): Promise<OverviewData | null> {
    const query = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : '';
    const result = await this.request<OverviewData>(`/api/overview${query}`);
    return result.ok ? result.data! : null;
  }

  /**
   * Fetch a single issue's title/body/state/comments via Tower's
   * forge-backed GET /api/issue. Returns null if the issue can't be
   * resolved (forge unavailable, bad number) so callers can degrade.
   */
  async getIssue(issueNumber: string, workspacePath?: string): Promise<IssueView | null> {
    const params = new URLSearchParams({ number: issueNumber });
    if (workspacePath) { params.set('workspace', workspacePath); }
    const result = await this.request<IssueView>(`/api/issue?${params.toString()}`);
    return result.ok ? result.data! : null;
  }

  /**
   * Fetch a single PR's title/state/url via Tower's forge-backed
   * GET /api/pr — the PR counterpart of getIssue. Returns null if the PR
   * can't be resolved (forge unavailable, bad number) so callers can
   * degrade.
   */
  async getPR(prNumber: string, workspacePath?: string): Promise<PRView | null> {
    const params = new URLSearchParams({ number: prNumber });
    if (workspacePath) { params.set('workspace', workspacePath); }
    const result = await this.request<PRView>(`/api/pr?${params.toString()}`);
    return result.ok ? result.data! : null;
  }

  /**
   * Fetch the searchable issue dataset (incl. body) from Tower's
   * GET /api/issue-search. Powers the VSCode "Search Backlog" panel,
   * which filters/sorts the returned rows host-side. `state` selects the
   * issue set (default `open` = the sidebar backlog; `closed`/`all` lift
   * the PR-exclusion). Returns null on transport failure so callers degrade.
   */
  async searchIssues(
    workspacePath?: string,
    state?: 'open' | 'closed' | 'all',
  ): Promise<IssueSearchResponse | null> {
    const params = new URLSearchParams();
    if (workspacePath) { params.set('workspace', workspacePath); }
    if (state) { params.set('state', state); }
    const qs = params.toString();
    const result = await this.request<IssueSearchResponse>(
      `/api/issue-search${qs ? `?${qs}` : ''}`,
    );
    return result.ok ? result.data! : null;
  }

  /**
   * Fetch the canonical resolved worktree config (defaults / cache /
   * global / project / project-local layers, deep-merged) from Tower's
   * GET /api/worktree-config. The single source of truth for any client
   * that needs to act on `.codev/config(.local).json` — e.g. the VSCode
   * "Open Dev URL" surface — without parsing or merging the files
   * locally. Tower lazily installs a directory watcher on first call;
   * subsequent edits fan out a `codev-config-updated` SSE event so
   * subscribed clients refetch and re-render. Returns null on failure
   * so callers can degrade.
   */
  async getWorktreeConfig(workspacePath?: string): Promise<ResolvedWorktreeConfig | null> {
    const query = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : '';
    const result = await this.request<ResolvedWorktreeConfig>(`/api/worktree-config${query}`);
    return result.ok ? result.data! : null;
  }

  /**
   * Resolved `activityHooks` from Tower's GET /api/activity-hooks. Single source of
   * truth for the extension's activity hooks — no local file parsing. SECURITY: Tower
   * resolves these from the PERSONAL config layers only (`~/.codev/config.json` +
   * `.codev/config.local.json`), never the committed `.codev/config.json` — hooks open
   * URLs, so a committed hook would be a zero-click RCE (do NOT widen to loadConfig).
   * Shares the config-file watcher with worktree-config, so a `.codev/config(.local).json`
   * edit fans out a `codev-config-updated` SSE and subscribed clients refetch. Null on failure.
   */
  async getActivityHooks(workspacePath?: string): Promise<ResolvedActivityHooks | null> {
    const query = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : '';
    const result = await this.request<ResolvedActivityHooks>(`/api/activity-hooks${query}`);
    return result.ok ? result.data! : null;
  }

  /**
   * Invalidate Tower's in-memory overview cache and broadcast an
   * `overview-changed` SSE event. Subscribed clients (VSCode sidebar,
   * dashboard) re-fetch /api/overview on any SSE event, so this is
   * what makes them notice out-of-band mutations to builder state —
   * e.g., `afx cleanup` invoked from a shell or the architect. Without
   * it, the change is invisible to clients until some other SSE event
   * happens to fire. Best-effort: returns false if Tower isn't running.
   */
  async refreshOverview(): Promise<boolean> {
    const result = await this.request<{ ok: boolean }>('/api/overview/refresh', { method: 'POST' });
    return result.ok;
  }

  async getWorkspaceState(workspacePath: string): Promise<DashboardState | null> {
    const encoded = encodeWorkspacePath(workspacePath);
    const result = await this.request<DashboardState>(`/workspace/${encoded}/api/state`);
    return result.ok ? result.data! : null;
  }

  async createShellTab(workspacePath: string): Promise<{ id: string; name: string; terminalId: string } | null> {
    const encoded = encodeWorkspacePath(workspacePath);
    const result = await this.request<{ id: string; name: string; terminalId: string }>(
      `/workspace/${encoded}/api/tabs/shell`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    return result.ok ? result.data! : null;
  }

  async createTerminal(options: {
    command?: string;
    args?: string[];
    cols?: number;
    rows?: number;
    cwd?: string;
    label?: string;
    env?: Record<string, string>;
    persistent?: boolean;
    workspacePath?: string;
    type?: TerminalType;
    roleId?: string;
  }): Promise<TowerTerminal | null> {
    const result = await this.request<TowerTerminal>('/api/terminals', {
      method: 'POST',
      body: JSON.stringify(options),
    });
    return result.ok ? result.data! : null;
  }

  async listTerminals(): Promise<TowerTerminal[]> {
    const result = await this.request<{ terminals: TowerTerminal[] }>('/api/terminals');
    return result.ok ? result.data!.terminals : [];
  }

  async getTerminal(terminalId: string): Promise<TowerTerminal | null> {
    const result = await this.request<TowerTerminal>(`/api/terminals/${terminalId}`);
    return result.ok ? result.data! : null;
  }

  /**
   * Recent PTY output for a terminal (Spec 1273).
   *
   * The `/output` route has existed since the terminal manager was written; it
   * simply had no client binding. Reset uses it for the best-effort `/clear`
   * confirmation — without it that check can never succeed outside tests, and
   * every real run would report the clear as unconfirmed while looking like it
   * had tried.
   */
  async getTerminalOutput(
    terminalId: string,
    lines = 100,
  ): Promise<{ lines: string[]; total: number; hasMore: boolean } | null> {
    const result = await this.request<{ lines: string[]; total: number; hasMore: boolean }>(
      `/api/terminals/${terminalId}/output?lines=${lines}`,
    );
    return result.ok ? result.data! : null;
  }

  async writeTerminal(terminalId: string, data: string): Promise<boolean> {
    const result = await this.request(`/api/terminals/${terminalId}/write`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
    return result.ok;
  }

  async killTerminal(terminalId: string): Promise<boolean> {
    const result = await this.request(`/api/terminals/${terminalId}`, { method: 'DELETE' });
    return result.ok;
  }

  async resizeTerminal(
    terminalId: string,
    cols: number,
    rows: number
  ): Promise<TowerTerminal | null> {
    const result = await this.request<TowerTerminal>(`/api/terminals/${terminalId}/resize`, {
      method: 'POST',
      body: JSON.stringify({ cols, rows }),
    });
    return result.ok ? result.data! : null;
  }

  async renameTerminal(
    sessionId: string,
    name: string,
  ): Promise<{ ok: boolean; status: number; data?: { id: string; name: string }; error?: string; connectionRefused?: boolean }> {
    return this.request<{ id: string; name: string }>(`/api/terminals/${sessionId}/rename`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  }

  /**
   * Upload a clipboard image to Tower and get back a temp file path.
   *
   * Deliberately does NOT route through request<T>(): that helper force-sets
   * `Content-Type: application/json` after spreading options.headers, so a
   * binary content-type can't pass through. This mirrors request()'s auth
   * (codev-tower-key), timeout, and error-normalization for a raw binary body.
   */
  async pasteImage(
    workspacePath: string,
    bytes: Uint8Array,
    mime: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
      const authKey = this.getAuthKey();
      const headers: Record<string, string> = { 'Content-Type': mime };
      if (authKey) {
        headers['codev-tower-key'] = authKey;
      }
      // A typed-array view isn't reliably assignable to fetch's BodyInit
      // across lib versions; an ArrayBuffer slice always is.
      const body = bytes.buffer.slice(
        bytes.byteOffset, bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      // The paste-image handler is workspace-scoped (same router as
      // /workspace/<enc>/api/state) — a global /api/paste-image has no route.
      const encoded = encodeWorkspacePath(workspacePath);
      const response = await this.fetchFn(`${this.baseUrl}/workspace/${encoded}/api/paste-image`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!response.ok) {
        const text = await response.text();
        const error = extractTowerError(text);
        return { ok: false, error };
      }
      const data = (await response.json()) as { path: string };
      return { ok: true, path: data.path };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isConnectionRefused(err)) {
        return { ok: false, error: 'Tower not running' };
      }
      if (message.includes('timeout')) {
        return { ok: false, error: 'Request timeout' };
      }
      return { ok: false, error: message };
    }
  }

  getWorkspaceUrl(workspacePath: string): string {
    const encoded = encodeWorkspacePath(workspacePath);
    return `${this.baseUrl}/workspace/${encoded}/`;
  }

  async sendMessage(
    to: string,
    message: string,
    options?: {
      from?: string;
      workspace?: string;
      fromWorkspace?: string;
      raw?: boolean;
      noEnter?: boolean;
      interrupt?: boolean;
      /**
       * Spec 1273: deliver the message as a bare ESC keystroke (`\x1b`) written
       * straight to the PTY — no formatting, no send-buffer deferral. This is the
       * verified mid-turn recovery: ESC ends the running turn so queued messages
       * can process. Distinct from `interrupt`, which sends Ctrl+C (`\x03`).
       */
      escape?: boolean;
      /**
       * Spec 1307: hold the message in Tower and deliver it after this many
       * seconds. Resolution and authorization still happen at request time —
       * only delivery is deferred.
       *
       * Tower-side rather than a sleeping client because the caller may be the
       * session being written to: `/arch-save` sends its own `/clear` and then a
       * delayed `/arch-init`, and the process issuing them does not survive the
       * clear. Spec 1313 round 3: the row is PERSISTED at request time with a
       * `not_before` due time, so the delay is durable across a Tower restart and
       * the pending send is listable/cancellable via `afx inbox`.
       */
      deliverAfter?: number;
    },
  ): Promise<{
    ok: boolean;
    resolvedTo?: string;
    /**
     * #1950: the connection was refused, so this request never reached Tower and a resend
     * cannot duplicate it. Absent on every other failure, a timeout included.
     */
    connectionRefused?: boolean;
    /** Tower is holding this for later delivery (`deliverAfter`). */
    scheduled?: boolean;
    /** Tower buffered this because the user was typing (Spec 403). */
    deferred?: boolean;
    error?: string;
    /**
     * Spec 1940: Tower's code for a failed send, when it gave one, so a caller can tell the
     * failures apart without matching {@link error}'s text: `MALFORMED_ADDRESS` (the text
     * is not an address), `REFUSED` (this sender may not name that recipient),
     * `REMOTE_REFUSED` (a send to another Tower was refused; see {@link refusal}),
     * `LOCAL_ADDRESS_ONLY` (an interrupt names another Tower), and the older `NOT_FOUND`,
     * `AMBIGUOUS` and `INVALID_PARAMS`. Absent when Tower could not be reached.
     */
    errorCode?: string;
    /**
     * Spec 1967: with `REMOTE_REFUSED`, who refused the send to another Tower and why.
     * {@link error} is then the refusal in words for a person, with no code after it.
     */
    refusal?: RemoteSendRefusal;
    /**
     * Spec 1967: a send to another Tower that was not refused. `resolvedTo` is the
     * recipient's full address and `mailboxId` the message's id; `held` says where.
     */
    remote?: RemoteSendAnswer;
    /**
     * Spec 1313 mailbox-first delivery. `delivered` = written to the PTY now;
     * `held` = persisted to the durable mailbox and awaiting a clean prompt
     * (`reason` says why: `busy` | `no-profile` | `no-live-pty`), with `mailboxId`
     * the row id. Older Tower binaries omit all four — a bare `{ ok, resolvedTo }`
     * response then reads as delivered (`held` undefined), preserving behavior.
     */
    delivered?: boolean;
    held?: boolean;
    reason?: string;
    /**
     * Issue #1482: the render gate's detail behind a `busy` reason —
     * `'user-text'` (a draft or menu occupies the composer; a human is at the line and the
     * hold clears by itself) vs `'no-region-end'` / `'no-composer-marker'` (the classifier
     * could not verify the composer at all — a drifted profile, a torn frame, or Tower's
     * dimensions diverging from the real PTY, and this hold does NOT clear on its own).
     * Absent/null for a non-gate hold and from older Tower binaries.
     */
    detail?: string;
    mailboxId?: string;
    /**
     * Issue #1365: an `interrupt`/`escape` submission that gave up waiting for the terminal's
     * submission lock and wrote UNSERIALIZED, so its bytes may have interleaved with the
     * delivery write it skipped. Present only when it happened; absent means normally
     * serialized. It matters most for `interrupt`, whose mailbox row is claimed `delivered`
     * BEFORE the write (un-claiming would risk a double delivery), so `delivered: true` alone
     * would otherwise be an unqualified success for a possibly-mangled body.
     */
    degraded?: boolean;
    /** Machine-readable companion to {@link degraded} (`submit-wait-ceiling-expired`). */
    degradedReason?: string;
    /**
     * Spec 1313 round 3: due time (epoch ms) of a scheduled (`deliverAfter`) send. Present
     * only when `scheduled` — the row is persisted at request time and delivers not before
     * this instant. Omitted by older Tower binaries.
     */
    notBefore?: number;
    /**
     * Issue #1573: the exact byte length Tower accepted for this message body. Echoed back so
     * the sender can see WHAT was sent, not just that a send happened — the failures behind
     * this field (#1564) all looked like unqualified successes at the sender. Omitted by older
     * Tower binaries.
     */
    bodyLength?: number;
    /**
     * Issue #1584: whether the delivered message's header was actually SEEN on the receiving
     * terminal. `false` = the bytes were written and accepted, but the terminal never showed
     * them — the message is recorded as delivered and flagged, and is deliberately NOT
     * re-written (re-writing is what re-injected one message dozens of times in #1583).
     * Absent = verification was skipped or does not apply; older Tower binaries omit it, and
     * absent reads exactly as `true` always did.
     */
    verified?: boolean;
    /**
     * Issue #1473: why a delivered message could not be confirmed. `'input-raced'` — the
     * terminal received human input while the body was going out, so it may have been truncated
     * (`^U`/`^W`/`^C`) or submitted early (their Enter); `'no-echo'` — the write completed but
     * the header never appeared. Absent means confirmed, or not verifiable in the first place.
     *
     * Present alongside {@link verified} rather than folded into it, because the raced case
     * frequently reports `verified: true` — the HEADER landed; it was the tail that was lost —
     * which is exactly why that case used to reach the sender as an unqualified success. Older
     * Tower binaries omit it.
     */
    unverifiedCause?: 'no-echo' | 'input-raced';
  }> {
    const body = JSON.stringify({
      to,
      message,
      from: options?.from,
      workspace: options?.workspace,
      fromWorkspace: options?.fromWorkspace,
      options: {
        raw: options?.raw,
        noEnter: options?.noEnter,
        interrupt: options?.interrupt,
        escape: options?.escape,
        deliverAfter: options?.deliverAfter,
      },
    });
    // Tower drops a request past its ceiling unanswered, before any check could refuse it in
    // words; the request is measured here, as it will be sent, and not sent at all.
    const requestBytes = new TextEncoder().encode(body).length;
    if (requestBytes > TOWER_MAX_REQUEST_BYTES) {
      return {
        ok: false,
        error: `Not sent: the request would be ${requestBytes} bytes, and Tower reads none over ${TOWER_MAX_REQUEST_BYTES}.`,
        errorCode: REQUEST_TOO_LARGE,
      };
    }
    const result = await this.request<{
      ok: boolean;
      resolvedTo: string;
      scheduled?: boolean;
      deferred?: boolean;
      delivered?: boolean;
      held?: boolean;
      reason?: string | null;
      detail?: string | null;
      mailboxId?: string;
      degraded?: boolean;
      degradedReason?: string;
      notBefore?: number;
      bodyLength?: number;
      verified?: boolean;
      unverifiedCause?: 'no-echo' | 'input-raced';
      remote?: RemoteSendAnswer;
    }>(
      '/api/send',
      { method: 'POST', body },
      namesATower(to) ? Math.max(REMOTE_SEND_TIMEOUT_MS, this.requestTimeoutMs) : this.requestTimeoutMs,
    );

    if (!result.ok) {
      const failure = { ok: false, error: result.error, connectionRefused: result.connectionRefused };
      if (result.errorCode === undefined) return failure;
      const message = result.errorBody?.message;
      // Words that say the message is stored and not to send it again: those, and nothing appended.
      if (result.errorCode === REMOTE_HELD_ON_FAULT && typeof message === 'string') {
        return { ...failure, error: message, errorCode: result.errorCode };
      }
      const refusal = result.errorCode === REMOTE_REFUSED ? readRemoteRefusal(result.errorBody) : undefined;
      if (refusal === undefined || typeof message !== 'string') return { ...failure, errorCode: result.errorCode };
      return { ...failure, error: message, errorCode: result.errorCode, refusal };
    }

    const remote = readRemoteAnswer(result.data!.remote);
    return {
      ok: true,
      resolvedTo: result.data!.resolvedTo,
      scheduled: result.data!.scheduled === true,
      deferred: result.data!.deferred === true,
      delivered: result.data!.delivered,
      held: result.data!.held,
      reason: result.data!.reason ?? undefined,
      detail: result.data!.detail ?? undefined,
      mailboxId: result.data!.mailboxId,
      degraded: result.data!.degraded,
      degradedReason: result.data!.degradedReason,
      notBefore: result.data!.notBefore,
      bodyLength: result.data!.bodyLength,
      verified: result.data!.verified,
      unverifiedCause: result.data!.unverifiedCause,
      ...(remote === undefined ? {} : { remote }),
    };
  }

  async signalTunnel(action: 'connect' | 'disconnect'): Promise<void> {
    await this.request(`/api/tunnel/${action}`, { method: 'POST' }).catch(() => {});
  }

  async getTunnelStatus(): Promise<TowerTunnelStatus | null> {
    const result = await this.request<TowerTunnelStatus>('/api/tunnel/status');
    return result.ok ? result.data! : null;
  }

  async getStatus(): Promise<TowerStatus | null> {
    const result = await this.request<TowerStatus>('/api/status');
    return result.ok ? result.data! : null;
  }

  async sendNotification(payload: {
    type: string;
    title: string;
    body: string;
    workspace: string;
  }): Promise<boolean> {
    const result = await this.request('/api/notify', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return result.ok;
  }

  getTerminalWsUrl(terminalId: string): string {
    return `ws://localhost:${new URL(this.baseUrl).port}/ws/terminal/${terminalId}`;
  }

  /**
   * POST /api/command: ask the active provider to run a canonical verb.
   * `workspace` (when known) scopes it so a multi-workspace Tower routes to
   * the right provider. Lifted from `@cluesmith/codev-client` (issue #1189
   * absorption); this client owns the controller side of the command relay.
   */
  async sendCommand(
    verb: string,
    args: unknown[] = [],
    workspace?: string,
  ): Promise<{ ok: boolean; status: number; data?: { ok: boolean }; error?: string }> {
    const body: CommandRequest = { verb, args };
    if (workspace) {
      body.workspace = workspace;
    }
    return this.request<{ ok: boolean }>(COMMAND_ROUTE, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * Like `request`, but keeps the parsed body on a non-2xx response.
   *
   * `request` runs failures through `extractTowerError`, which reduces the body to a message and
   * discards everything else. The canvas channel answers with a machine-readable `code`, and a
   * controller has to act on it (render "no canvas open" versus "Tower is down"), so that code
   * must survive the trip. Never throws: a transport failure comes back as `status: 0`, matching
   * the never-reject invariant the rest of this client holds.
   */
  private async requestPreservingBody(
    path: string,
    options: RequestInit = {},
  ): Promise<{ status: number; body: unknown; error?: string }> {
    try {
      const authKey = this.getAuthKey();
      const headers: Record<string, string> = {
        ...(options.headers as Record<string, string>),
        'Content-Type': 'application/json',
      };
      if (authKey) {
        headers['codev-tower-key'] = authKey;
      }
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...options,
        headers,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null; // an unparseable body is reported by the caller as an unusable answer
      }
      return { status: response.status, body };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isConnectionRefused(err)) return { status: 0, body: null, error: 'Tower not running' };
      if (message.includes('timeout')) return { status: 0, body: null, error: 'Request timeout' };
      return { status: 0, body: null, error: message };
    }
  }

  /**
   * Like `requestPreservingBody`, for a route that answers with bytes (an image). That helper
   * reads the body as text, which would destroy binary bytes and drop the `Content-Type`. Same key
   * header, base URL and timeout as every other request. A 2xx comes back as its bytes and type; any
   * other status as its JSON-parsed body (null when it is not JSON), so a refusal keeps its code and
   * message. Never throws: a transport failure comes back as `status: 0`.
   */
  private async requestBinary(
    path: string,
  ): Promise<{ status: number; bytes: Uint8Array; contentType: string } | { status: number; body: unknown; error?: string }> {
    try {
      const authKey = this.getAuthKey();
      const headers: Record<string, string> = {};
      if (authKey) {
        headers['codev-tower-key'] = authKey;
      }
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        headers,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { status: response.status, bytes, contentType: response.headers.get('Content-Type') ?? '' };
      }
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null; // an unparseable body is reported by the caller as an unusable answer
      }
      return { status: response.status, body };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isConnectionRefused(err)) return { status: 0, body: null, error: 'Tower not running' };
      if (message.includes('timeout')) return { status: 0, body: null, error: 'Request timeout' };
      return { status: 0, body: null, error: message };
    }
  }

  /** One decisions document route's answer, as a {@link DecisionsRouteResult}. */
  private async requestDecisions(path: string, options: RequestInit = {}): Promise<DecisionsRouteResult<DecisionsReadResponse>> {
    const outcome = await this.requestPreservingBody(path, options);
    if (outcome.status === 0) return { kind: 'unreachable', error: outcome.error ?? 'Tower unreachable' };
    const verdict = asDecisionsVerdict(outcome.body);
    if (!verdict) return { kind: 'unreadable', status: outcome.status };
    return { kind: 'verdict', status: outcome.status, verdict };
  }

  /**
   * GET /workspace/<enc>/api/decisions: the workspace's decisions document, or Tower's refusal
   * (`not-found` when there is no decisions file) with its code and message (Spec 1819).
   */
  async getDecisions(workspacePath: string): Promise<DecisionsRouteResult<DecisionsReadResponse>> {
    return this.requestDecisions(`/workspace/${encodeWorkspacePath(workspacePath)}/api/decisions`);
  }

  /**
   * POST /workspace/<enc>/api/decisions/rule: write the owner's ruling into the decisions file.
   * Success carries the document re-parsed from the bytes written; a refusal keeps its code and
   * message (Spec 1819). Tower then tells the hub architect (#1828).
   */
  async ruleDecision(workspacePath: string, request: DecisionsRuleRequest): Promise<DecisionsRouteResult<DecisionsRuleResponse>> {
    return this.requestDecisions(`/workspace/${encodeWorkspacePath(workspacePath)}/api/decisions/rule`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * GET /workspace/<enc>/api/decisions/image?path=: one image a decisions item references (#1938),
   * as bytes and type. `imagePath` is as written in the item: relative to the decisions file, or
   * `/`-rooted at the workspace. Tower contains it to the workspace; a refusal keeps its code and
   * message. A 2xx answer that is not an image is `unreadable`.
   */
  async getDecisionImage(workspacePath: string, imagePath: string): Promise<DecisionImageRouteResult> {
    const encoded = encodeWorkspacePath(workspacePath);
    const outcome = await this.requestBinary(`/workspace/${encoded}/api/decisions/image?path=${encodeURIComponent(imagePath)}`);
    if ('bytes' in outcome) {
      if (!outcome.contentType.toLowerCase().startsWith('image/')) return { kind: 'unreadable', status: outcome.status };
      return { kind: 'image', bytes: outcome.bytes, contentType: outcome.contentType };
    }
    if (outcome.status === 0) return { kind: 'unreachable', error: outcome.error ?? 'Tower unreachable' };
    const refusal = asDecisionsRefusal(outcome.body);
    if (!refusal) return { kind: 'unreadable', status: outcome.status };
    return { kind: 'verdict', status: outcome.status, verdict: refusal };
  }

  /**
   * POST /api/canvas/command: drive one open artifact-canvas view (spec 1401).
   *
   * `target.workspace` is required and scopes the lookup; `target.file` narrows to one document,
   * and omitting it targets the workspace's most recently active view. `options.count` repeats a
   * traversal command and is rejected by Tower on any other.
   *
   * Never rejects. A resolved promise always carries Tower's verdict, except for `unreachable`,
   * which this client synthesizes when there was no answer at all — that distinction is the
   * reason the call exists in this shape, since "no canvas is open" and "Tower is down" must not
   * look alike to a controller.
   */
  async sendCanvasCommand(
    command: CanvasCommand,
    target: { workspace: string; file?: string },
    options?: { count?: number },
  ): Promise<CanvasCommandClientResult> {
    const payload: CanvasCommandRequest = { workspace: target.workspace, command };
    if (target.file !== undefined) payload.file = target.file;
    if (options?.count !== undefined) payload.count = options.count;

    const outcome = await this.requestPreservingBody(CANVAS_COMMAND_ROUTE, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (outcome.status === 0) {
      return { ok: false, code: 'unreachable', error: outcome.error ?? 'Tower unreachable' };
    }
    const verdict = parseCanvasCommandResult(outcome.body);
    if (verdict) return verdict;
    // A response we cannot fully verify is not a verdict, so it is reported as such rather than
    // being flattened into a success or an arbitrary failure code.
    return {
      ok: false,
      code: 'unreachable',
      error: `Unreadable response from Tower (HTTP ${outcome.status})`,
    };
  }

  /**
   * POST /api/canvas/views: a HOST registers one live canvas view and receives its Tower-minted
   * id. Host-side lifecycle, deliberately absent from the controller subpath — controllers drive
   * views, hosts own them.
   */
  async registerCanvasView(
    workspace: string,
    file: string,
  ): Promise<{ ok: boolean; viewId?: string; file?: string; error?: string }> {
    const result = await this.request<{ ok: boolean; viewId: string; file: string }>(
      CANVAS_VIEWS_ROUTE,
      { method: 'POST', body: JSON.stringify({ workspace, file }) },
    );
    if (!result.ok || !result.data) return { ok: false, error: result.error ?? 'Registration failed' };
    return { ok: true, viewId: result.data.viewId, file: result.data.file };
  }

  /**
   * POST /api/canvas/views/:viewId/heartbeat: keep a view's lease alive, and with
   * `focused: true` mark it the most recently active target.
   *
   * `unknownView` distinguishes "Tower has forgotten this id" (a restart, an expired lease) from
   * a transport problem, because the host's response to the two differs: re-register, versus try
   * again later.
   */
  async heartbeatCanvasView(
    viewId: string,
    focused?: boolean,
  ): Promise<{ ok: boolean; unknownView: boolean; error?: string }> {
    const body: { focused?: boolean } = {};
    if (focused !== undefined) body.focused = focused;
    const result = await this.request<{ ok: boolean }>(
      `${CANVAS_VIEWS_ROUTE}/${encodeURIComponent(viewId)}/heartbeat`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    if (result.ok) return { ok: true, unknownView: false };
    return { ok: false, unknownView: result.status === 404, error: result.error };
  }

  /** DELETE /api/canvas/views/:viewId: the host's view is gone. */
  async unregisterCanvasView(viewId: string): Promise<{ ok: boolean; error?: string }> {
    const result = await this.request<{ ok: boolean }>(
      `${CANVAS_VIEWS_ROUTE}/${encodeURIComponent(viewId)}`,
      { method: 'DELETE' },
    );
    if (result.ok) return { ok: true };
    return { ok: false, error: result.error };
  }

  /**
   * Subscribe to Tower's SSE stream (`/api/events`). Calls `onEnvelope` for
   * each decoded event and `onStatus(true|false)` as the connection comes up
   * or drops. Reconnects with backoff until the returned disposer is called.
   * Consumers typically ignore the event body and re-fetch overview on any
   * event (the established Tower-client pattern). `sleep` is injectable for
   * tests. Lifted from `@cluesmith/codev-client` (issue #1189 absorption).
   */
  subscribeEvents(handlers: {
    onEnvelope?: (env: SseEnvelope) => void;
    onStatus?: (online: boolean) => void;
    sleep?: (ms: number) => Promise<void>;
  }): () => void {
    const sleep = handlers.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let stopped = false;
    let abort: AbortController | null = null;

    const run = async (): Promise<void> => {
      let backoffMs = 500;
      while (!stopped) {
        abort = new AbortController();
        try {
          const authKey = this.getAuthKey();
          const headers: Record<string, string> = { Accept: 'text/event-stream' };
          if (authKey) {
            headers['codev-tower-key'] = authKey;
          }
          const res = await this.fetchFn(`${this.baseUrl}/api/events`, {
            headers,
            signal: abort.signal,
          });
          if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
          handlers.onStatus?.(true);
          backoffMs = 500;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            buffer = parseSseText(buffer, (env) => handlers.onEnvelope?.(env));
          }
        } catch {
          // fall through to reconnect
        }
        if (stopped) break;
        handlers.onStatus?.(false);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 10_000);
      }
    };

    run();
    return () => {
      stopped = true;
      abort?.abort();
    };
  }

  /** The base URL, exposed for opening browser links (e.g. a PR url) and tests. */
  get url(): string {
    return this.baseUrl;
  }
}
