/**
 * The sending Tower's calls to Codev Cloud (Spec 1967, contract sections 2 to 4). All three
 * live here, and each speaks the wire only through `contract.ts`:
 *
 * - `POST /api/peer/relay`: one relay call, its answer read as section 6 reads it;
 * - `GET /api/peer/towers`: the peer listing, within its call budget (section 3);
 * - `PUT /api/peer/state`: the switch-state report, retried as section 2 says (K5).
 *
 * Every call follows the TLS rule: it is made only over `https:`, or to a cloud whose host
 * is a loopback address (tests). Against any other cloud no call is made, and the caller is
 * told the cloud is insecure, which the peer list reports as having no relay. Every call has
 * S's 20-second timeout, covering its answer's body as well as its status.
 *
 * Nothing here logs a key, a payload or an answer's body. Timers are injected, so the
 * timeout, the call budget and the report's retries are tested on a controlled clock.
 */

import { PEER_MAX_ANSWER_BYTES, PEER_SENDER_CALL_TIMEOUT_MS, type PeerRequestKind, type PeerSwitchState } from '@cluesmith/codev-types';
import {
  PEER_CLOUD_PATHS,
  PEER_HEADER,
  buildRelayRequestHeaders,
  classifyListingAnswer,
  classifyRelayAnswer,
  classifySwitchReportAnswer,
  encodeSwitchStateReport,
  isSecureCloudTransport,
  type ClassifiedAnswer,
  type ListingAnswer,
  type RelayCallResult,
} from './contract.js';

/** On demand (`afx peer list`, a send to a name not in the list), the listing is called at most this often. */
export const LISTING_ON_DEMAND_INTERVAL_MS = 10_000;
/** While this Tower holds mail for a peer, the listing is called to learn of its return at most this often. */
export const LISTING_HOLDING_INTERVAL_MS = 30_000;
/** The switch-state report is retried after each of these, or after `retryAfterSec` if longer; then it stops. */
export const SWITCH_REPORT_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000];
/**
 * How much of a listing's body is read. The contract sets no size for it; this is the
 * Tower's own bound, far above any account's list, so that an answer from something in
 * front of the cloud cannot fill memory. A longer body is a listing that does not fit.
 */
export const MAX_LISTING_BYTES = 1_048_576;

/** Where the cloud is and the key this Tower calls it with, from its registration. */
export interface CloudRegistration {
  serverUrl: string;
  apiKey: string;
}

export interface CloudTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CloudClientOptions {
  /** This Tower's registration, read on every call; `null` when it has none. */
  registration: () => CloudRegistration | null;
  /**
   * Whether this cloud has ever stated a relay (its last `auth_ok` carried a `relay` object,
   * or its last listing a non-null `relay`). It decides what an answer without the body means.
   */
  relayStated: () => boolean;
  now: () => number;
  timers?: CloudTimers;
  fetch?: FetchLike;
  log: (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void;
}

/**
 * Why no call was made: this Tower has no registration, or its cloud fails the TLS rule
 * (plain HTTP to a host that is not loopback).
 */
export type NoCallReason = 'not-connected' | 'insecure';

export interface RelayRequest {
  kind: PeerRequestKind;
  toTowerId: string;
  /** The message id or query id: a UUID in canonical lower-case form. */
  requestId: string;
  /** The payload's exact bytes, as stored with the message. */
  payload: Uint8Array;
}

export type RelayCall = { called: false; reason: NoCallReason } | { called: true; answer: ClassifiedAnswer };

/** Why the listing is wanted, which sets how soon it may be called again (section 3). */
export type ListingPurpose = 'on-demand' | 'holding';

export type ListingCall =
  | { called: false; reason: NoCallReason }
  /** Within the call budget: the listing was called at `lastCalledAt`, too recently to call again. */
  | { called: false; reason: 'budget'; lastCalledAt: number }
  | { called: true; answer: ListingAnswer };

interface PendingReport {
  state: PeerSwitchState;
  generation: number;
  /** Retries made so far, after the first attempt. */
  retries: number;
}

/** Real timers, unreferenced: a pending retry or call timeout never keeps Tower's process alive. */
const DEFAULT_TIMERS: CloudTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The URL of one of the cloud's peer routes, or why it may not be called. */
function routeUrl(serverUrl: string, path: string): URL | 'insecure' {
  let url: URL;
  try {
    url = new URL(`${serverUrl.replace(/\/+$/, '')}${path}`);
  } catch {
    throw new Error("cloud-config.json's server_url is not a URL");
  }
  return isSecureCloudTransport(url) ? url : 'insecure';
}

/** Does this cloud pass the TLS rule for its HTTPS calls? */
export function isSecureCloud(serverUrl: string): boolean {
  return routeUrl(serverUrl, '/') !== 'insecure';
}

/** At most `cap + 1` bytes of an answer's body: enough for the reader to see it is over the cap. */
async function readCapped(response: Response, cap: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  if (total > cap) await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, cap + 1);
}

export class CloudClient {
  private readonly timers: CloudTimers;
  private readonly fetch: FetchLike;

  private lastListingAt: number | null = null;
  /** The registration that last call was made under: a budget belongs to one. */
  private lastListingFor: string | null = null;
  /** The listing call in flight, and the registration it was made under. */
  private listingInFlight: { for: string; call: Promise<ListingCall> } | null = null;

  private reportGeneration = 0;
  private pendingReport: PendingReport | null = null;
  private reportTimer: unknown = null;
  private reportInFlight: Promise<void> | null = null;

  constructor(private readonly options: CloudClientOptions) {
    this.timers = options.timers ?? DEFAULT_TIMERS;
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  // -------------------------------------------------------------------------
  // One call
  // -------------------------------------------------------------------------

  private target(path: string): { url: URL; apiKey: string } | NoCallReason {
    const registration = this.options.registration();
    if (registration === null) return 'not-connected';
    const url = routeUrl(registration.serverUrl, path);
    return url === 'insecure' ? 'insecure' : { url, apiKey: registration.apiKey };
  }

  /**
   * One HTTPS call, as section 6 needs it read: the status, the media type, the outcome
   * header and at most `cap + 1` bytes of the body. No answer within S's call timeout, a
   * connection error, or a body cut short is no answer at all. Redirects are not followed:
   * a 3xx is an answer like any other, and the key never goes anywhere else.
   */
  private async call(
    method: 'GET' | 'POST' | 'PUT',
    target: { url: URL; apiKey: string },
    headers: Record<string, string>,
    body: Uint8Array | undefined,
    cap: number,
  ): Promise<RelayCallResult> {
    const controller = new AbortController();
    const timer = this.timers.setTimeout(() => controller.abort(), PEER_SENDER_CALL_TIMEOUT_MS);
    try {
      const response = await this.fetch(target.url.href, {
        method,
        headers: { ...headers, authorization: `Bearer ${target.apiKey}` },
        // A copy on an ArrayBuffer of its own, the one shape fetch's body type takes for bytes.
        body: body === undefined ? undefined : new Uint8Array(body),
        redirect: 'manual',
        signal: controller.signal,
      });
      const bytes = await readCapped(response, cap);
      return {
        answered: true,
        status: response.status,
        contentType: response.headers.get('content-type') ?? undefined,
        outcomeHeader: response.headers.get(PEER_HEADER.outcome) ?? undefined,
        body: bytes,
      };
    } catch {
      return { answered: false };
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Section 4: the relay call
  // -------------------------------------------------------------------------

  /** One relay call: one forward attempt at most. Ordering per peer is the caller's (the outbox). */
  async relay(request: RelayRequest): Promise<RelayCall> {
    const target = this.target(PEER_CLOUD_PATHS.relay);
    if (typeof target === 'string') return { called: false, reason: target };
    const headers = buildRelayRequestHeaders(request);
    const result = await this.call('POST', target, headers, request.payload, PEER_MAX_ANSWER_BYTES);
    return { called: true, answer: classifyRelayAnswer(result, { kind: request.kind, relayStated: this.options.relayStated() }) };
  }

  // -------------------------------------------------------------------------
  // Section 3: the listing, within its call budget
  // -------------------------------------------------------------------------

  /**
   * The listing, called at most every 10 seconds on demand and every 30 while holding
   * mail, counted from the last call made for either under the same registration. A caller
   * asking while a call is in flight under the same registration shares that call.
   * (Everything before the call's first `await` runs at once, so a second caller always sees
   * the first's call.)
   */
  async listTowers(purpose: ListingPurpose): Promise<ListingCall> {
    const target = this.target(PEER_CLOUD_PATHS.towers);
    if (typeof target === 'string') return { called: false, reason: target };
    const registration = `${target.url.href}\n${target.apiKey}`;
    if (this.listingInFlight !== null && this.listingInFlight.for === registration) return this.listingInFlight.call;
    const now = this.options.now();
    const interval = purpose === 'holding' ? LISTING_HOLDING_INTERVAL_MS : LISTING_ON_DEMAND_INTERVAL_MS;
    if (this.lastListingAt !== null && this.lastListingFor === registration) {
      const since = now - this.lastListingAt;
      // A clock that went back counts as time passed: a budget must not lock the listing out.
      if (since >= 0 && since < interval) return { called: false, reason: 'budget', lastCalledAt: this.lastListingAt };
    }
    this.lastListingAt = now;
    this.lastListingFor = registration;
    const call = (async (): Promise<ListingCall> => {
      const result = await this.call('GET', target, {}, undefined, MAX_LISTING_BYTES);
      const answer = classifyListingAnswer(result, { relayStated: this.options.relayStated(), maxBytes: MAX_LISTING_BYTES });
      return { called: true, answer };
    })().finally(() => {
      // A call under another registration may have started since; it stays the one in flight.
      if (this.listingInFlight?.call === call) this.listingInFlight = null;
    });
    this.listingInFlight = { for: registration, call };
    return call;
  }

  // -------------------------------------------------------------------------
  // Section 2: the switch-state report
  // -------------------------------------------------------------------------

  /**
   * Tell the cloud the switch is now `state`. On no answer, a 5xx or a `429` (or the cloud
   * unreachable) the report is tried again after 5 seconds, 30 seconds and 2 minutes, or
   * after `retryAfterSec` if that is longer, and then not again: the next `auth` states the
   * switch. A newer change replaces a pending report. One call is in flight at a time, so
   * the cloud hears the changes in the order they were made.
   */
  reportSwitch(state: PeerSwitchState): void {
    this.clearReportTimer();
    this.pendingReport = { state, generation: ++this.reportGeneration, retries: 0 };
    // With a call in flight, its end sends this one.
    if (this.reportInFlight === null) this.sendReport();
  }

  /** A new tunnel session's `auth` has stated the switch: a pending report is dropped. */
  cancelSwitchReport(): void {
    this.clearReportTimer();
    this.pendingReport = null;
    this.reportGeneration++;
  }

  /** Resolves once no report call is in flight (for tests and shutdown). */
  async switchReportSettled(): Promise<void> {
    while (this.reportInFlight !== null) await this.reportInFlight;
  }

  /** Is a report still to be made: a call in flight, or a retry waiting on its timer? */
  hasPendingSwitchReport(): boolean {
    return this.pendingReport !== null;
  }

  private clearReportTimer(): void {
    if (this.reportTimer !== null) this.timers.clearTimeout(this.reportTimer);
    this.reportTimer = null;
  }

  private sendReport(): void {
    const pending = this.pendingReport;
    if (pending === null) return;
    this.reportInFlight = this.attemptReport(pending)
      .catch((err: unknown) => {
        // Only a registration that cannot be read or used throws here; the report is dropped.
        if (this.pendingReport?.generation === pending.generation) this.pendingReport = null;
        this.options.log('ERROR', `Peer: the switch-state report was not made: ${(err as Error).message}`);
      })
      .finally(() => {
        this.reportInFlight = null;
        // A change made while that call was in flight goes now, after it.
        if (this.pendingReport !== null && this.pendingReport.generation !== pending.generation && this.reportTimer === null) {
          this.sendReport();
        }
      });
  }

  private async attemptReport(pending: PendingReport): Promise<void> {
    const current = () => this.pendingReport !== null && this.pendingReport.generation === pending.generation;
    const target = this.target(PEER_CLOUD_PATHS.state);
    if (typeof target === 'string') {
      if (current()) this.pendingReport = null;
      return;
    }
    const result = await this.call(
      'PUT',
      target,
      { 'content-type': 'application/json' },
      encodeSwitchStateReport(pending.state),
      PEER_MAX_ANSWER_BYTES,
    );
    const answer = classifySwitchReportAnswer(result, { relayStated: this.options.relayStated() });
    // Replaced by a newer change, or dropped by a new connection, while it was in flight.
    if (!current()) return;
    if (answer.ok) {
      this.pendingReport = null;
      this.options.log('INFO', `Peer: Codev Cloud told remote messaging is ${pending.state}`);
      return;
    }
    const why = answer.status === null ? answer.reason : `${answer.reason}, HTTP ${answer.status}`;
    if (!answer.retryable || pending.retries >= SWITCH_REPORT_RETRY_DELAYS_MS.length) {
      this.pendingReport = null;
      this.options.log(
        'WARN',
        `Peer: Codev Cloud could not be told remote messaging is ${pending.state} (${why}); ${answer.retryable ? 'gave up after three retries' : 'not retried'}. The next connection states it.`,
      );
      return;
    }
    const delay = Math.max(SWITCH_REPORT_RETRY_DELAYS_MS[pending.retries], (answer.retryAfterSec ?? 0) * 1000);
    pending.retries++;
    this.reportTimer = this.timers.setTimeout(() => {
      this.reportTimer = null;
      this.sendReport();
    }, delay);
  }
}
