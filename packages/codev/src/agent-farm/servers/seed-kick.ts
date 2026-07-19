/**
 * Readiness-gated first-message delivery for seed-style builder harnesses
 * (Issue #1201 — Kimi).
 *
 * A seed-style launch script spends its first ~5–15s running a non-interactive
 * seed call (`kimi -p …`) whose PTY has NO defined consumer for written bytes
 * (observed: input written during the seed window is silently lost, or at
 * worst replayed unpredictably into the TUI composer later). So the initial
 * task kick ("BEGIN") must not be written until the script signals readiness
 * by printing `<sentinel> <session-id>` on the PTY — after the seed completes,
 * before the interactive TUI starts.
 *
 * Delivery is then verified against the harness's session store (state.json's
 * `lastPrompt` updates when a message actually submits — observed, kimi
 * 0.27.0): the dominant failure mode is a swallowed Enter (paste detection),
 * so on timeout we re-send Enter, then re-send the whole kick once, then warn
 * loudly. Ground truth from the store makes delivery self-healing and absorbs
 * any residual Enter-delay uncertainty.
 *
 * Armed kicks are in-memory only: if Tower restarts between terminal creation
 * and the sentinel, the kick is lost — remediation is a manual
 * `afx send <builder-id> "BEGIN"`. Documented caveat of the MVI.
 */

import { writeMessageToSession } from './message-write.js';
import {
  readKimiSessionState,
  type KimiSessionState,
} from '../utils/kimi-session-discovery.js';

/** Server-side validated shape of the wire `seedKick` field (see
 *  SeedKickRequest in @cluesmith/codev-core/tower-client). */
export interface SeedKickOptions {
  sentinel: string;
  message: string;
  graceMs?: number;
  enterDelayMs?: number;
  verify?: { kind: 'kimi-session-store'; worktreePath: string };
}

/** Minimal session surface needed to arm a kick (PtySession satisfies it). */
export interface SeedKickSession {
  write(data: string): void;
  on(event: 'data', listener: (data: string) => void): unknown;
  off(event: 'data', listener: (data: string) => void): unknown;
}

export interface SeedKickTimings {
  /** Give up waiting for the sentinel after this long. */
  sentinelTimeoutMs: number;
  /** Post-sentinel grace before the first kick write. */
  defaultGraceMs: number;
  /** Store-poll interval during verification. */
  verifyIntervalMs: number;
  /** Polls before escalating to the next rung of the retry ladder. */
  verifyPollsPerStage: number;
}

const DEFAULT_TIMINGS: SeedKickTimings = {
  sentinelTimeoutMs: 180_000,
  defaultGraceMs: 2_500,
  verifyIntervalMs: 1_000,
  verifyPollsPerStage: 8,
};

/** Rolling scan buffer cap — sentinel lines are short; no need to retain more. */
const SCAN_BUFFER_MAX = 8_192;

type LogFn = (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void;

export interface SeedKickDeps {
  /** Test seam for the store reader (defaults to the real Kimi store). */
  readSessionState?: (sessionId: string) => KimiSessionState | null;
  timings?: Partial<SeedKickTimings>;
}

/**
 * Validate the raw wire value of `seedKick`. Returns null (not a throw) on
 * anything malformed — terminal creation must not fail over an optional field.
 */
export function parseSeedKick(raw: unknown): SeedKickOptions | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.sentinel !== 'string' || !obj.sentinel) return null;
  if (typeof obj.message !== 'string' || !obj.message) return null;
  const out: SeedKickOptions = { sentinel: obj.sentinel, message: obj.message };
  if (typeof obj.graceMs === 'number' && obj.graceMs >= 0) out.graceMs = obj.graceMs;
  if (typeof obj.enterDelayMs === 'number' && obj.enterDelayMs > 0) out.enterDelayMs = obj.enterDelayMs;
  const verify = obj.verify as Record<string, unknown> | undefined;
  if (
    typeof verify === 'object' && verify !== null &&
    verify.kind === 'kimi-session-store' &&
    typeof verify.worktreePath === 'string'
  ) {
    out.verify = { kind: 'kimi-session-store', worktreePath: verify.worktreePath };
  }
  return out;
}

/**
 * Arm a readiness-gated kick on a freshly created PTY session.
 * Fire-and-forget: all outcomes (delivered, unconfirmed, sentinel timeout)
 * are reported through `log`.
 */
export function armSeedKick(
  session: SeedKickSession,
  opts: SeedKickOptions,
  log: LogFn,
  deps?: SeedKickDeps,
): void {
  const timings: SeedKickTimings = { ...DEFAULT_TIMINGS, ...deps?.timings };
  const readState = deps?.readSessionState ?? readKimiSessionState;
  // Sentinel token + captured id, tolerant of PTY line endings and chunking.
  const sentinelRe = new RegExp(`${escapeRegExp(opts.sentinel)}[ \\t]+(\\S+)`);

  let scanBuffer = '';
  let done = false;

  const onData = (data: string) => {
    if (done) return;
    scanBuffer = (scanBuffer + data).slice(-SCAN_BUFFER_MAX);
    const match = sentinelRe.exec(scanBuffer);
    if (!match) return;
    done = true;
    session.off('data', onData);
    clearTimeout(sentinelTimer);
    const sessionId = match[1];
    log('INFO', `Seed sentinel observed (session ${sessionId.slice(0, 16)}…); delivering kick in ${opts.graceMs ?? timings.defaultGraceMs}ms`);
    setTimeout(() => deliverAndVerify(sessionId), opts.graceMs ?? timings.defaultGraceMs);
  };

  const sentinelTimer = setTimeout(() => {
    if (done) return;
    done = true;
    session.off('data', onData);
    log('WARN', `Seed sentinel never appeared within ${timings.sentinelTimeoutMs / 1000}s — initial kick "${opts.message}" NOT delivered. The seed may have failed (check the builder terminal); deliver manually via afx send.`);
  }, timings.sentinelTimeoutMs);

  session.on('data', onData);

  const writeKick = () => {
    writeMessageToSession(session, opts.message, false, 0, opts.enterDelayMs ? { enterDelayMs: opts.enterDelayMs } : undefined);
  };

  const confirmed = (sessionId: string): boolean => {
    const state = readState(sessionId);
    // lastPrompt reflects the last SUBMITTED message (observed) — the strong
    // signal. updatedAt also moves on unrelated store writes (TUI open), so
    // it is deliberately not treated as confirmation. The comparison must be
    // normalized EQUALITY, not substring: on a fresh spawn lastPrompt is the
    // SEED prompt (observed), whose ack-and-wait wrapper itself mentions the
    // kick word ("wait for BEGIN") — a substring check would report success
    // before the kick ever submitted, silently defeating the swallowed-Enter
    // recovery (caught by the PR consultation, PIR #1201). A submitted
    // message lands in lastPrompt with newlines flattened to spaces
    // (observed), hence whitespace normalization on both sides.
    return !!state?.lastPrompt &&
      normalizeWhitespace(state.lastPrompt) === normalizeWhitespace(opts.message);
  };

  function deliverAndVerify(sessionId: string): void {
    writeKick();
    if (!opts.verify) {
      log('INFO', 'Kick delivered (no store verification requested)');
      return;
    }

    // Retry ladder: poll → re-send Enter → poll → re-send kick once → poll → warn.
    type Stage = 'initial' | 'after-enter' | 'after-resend';
    let stage: Stage = 'initial';
    let pollsInStage = 0;

    const interval = setInterval(() => {
      if (confirmed(sessionId)) {
        clearInterval(interval);
        log('INFO', `Kick "${opts.message}" confirmed submitted (session store lastPrompt)`);
        return;
      }
      pollsInStage++;
      if (pollsInStage < timings.verifyPollsPerStage) return;
      pollsInStage = 0;
      if (stage === 'initial') {
        // Dominant observed failure: the Enter was swallowed by paste
        // detection — the message body is sitting in the composer.
        log('WARN', 'Kick not confirmed — re-sending Enter');
        session.write('\r');
        stage = 'after-enter';
      } else if (stage === 'after-enter') {
        log('WARN', 'Kick still not confirmed — re-sending the kick message once');
        writeKick();
        stage = 'after-resend';
      } else {
        clearInterval(interval);
        log('WARN', `Could not confirm delivery of initial kick "${opts.message}" via the session store. The builder may be idle — check its terminal and send "${opts.message}" manually (afx send).`);
      }
    }, timings.verifyIntervalMs);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
