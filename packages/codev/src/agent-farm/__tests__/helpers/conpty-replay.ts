/**
 * Replay a timed terminal capture through the PRODUCTION delivery path (Spec 1658, Phase 8).
 *
 * A capture is what `scripts/spec-1658-conpty-capture.mts` records from a real agent TUI under
 * ConPTY: every output chunk, every human keystroke and every resize, each stamped with its
 * offset in milliseconds, plus PROBE points where the recorder wants a delivery verdict. Format
 * (JSON Lines, gzipped on disk): a header object first, then one event per line:
 *
 *   {"format":"codev-terminal-capture","version":1,"app":"claude","state":"idle","cols":120,"rows":40,...}
 *   {"t":512,"o":"<output chunk>"}
 *   {"t":2048,"i":"r"}                 a human keystroke (moves inputSeq / lastInputAt)
 *   {"t":3000,"r":[100,30]}            a resize of the PTY and the gate mirror
 *   {"t":4000,"probe":"after-boot"}    ask for a verdict here
 *
 * Nothing in this module re-implements a gate. Each probe enqueues a row in a real sqlite
 * mailbox and calls `deliverAgentMail` with the live bindings, `classifyAgentScreen` and
 * `composerFingerprintForSession`, reading a `SessionScreen` mirror fed the captured bytes. The
 * replay supplies only the clock and the terminal, so a verdict here is the verdict Tower would
 * reach on the same bytes at the same moments.
 */

import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';

import { GLOBAL_SCHEMA } from '../../db/schema.js';
import * as mailbox from '../../db/mailbox.js';
import {
  deliverAgentMail,
  SETTLE_BEFORE_WRITE_MS,
  MAX_COMPOSER_SAMPLE_GAP_MS,
  type DeliveryDetail,
  type DeliveryPorts,
  type DeliverySession,
} from '../../servers/mailbox-delivery.js';
import { classifyAgentScreen, composerFingerprintForSession } from '../../servers/mailbox-wiring.js';
import type { GateProfile } from '../../servers/render-gate.js';
import { SessionScreen } from '../../../terminal/session-screen.js';

export const CAPTURE_FORMAT = 'codev-terminal-capture';

/** The verdict a probe must reach, per capture state. */
export type ProbeExpectation = 'delivered' | 'held';

export interface CaptureHeader {
  format: typeof CAPTURE_FORMAT;
  version: 1;
  app: string;
  appVersion?: string;
  state: string;
  platform?: string;
  cols: number;
  rows: number;
  /** What every probe in this capture must reach. */
  expect: ProbeExpectation;
}

export type CaptureEvent =
  | { t: number; o: string }
  | { t: number; i: string }
  | { t: number; r: [number, number] }
  | { t: number; probe: string };

export interface Capture {
  header: CaptureHeader;
  events: CaptureEvent[];
}

export interface ProbeResult {
  probe: string;
  at: number;
  delivered: boolean;
  /** Capture-time milliseconds from the probe to the delivering pass; null when never delivered. */
  waitedMs: number | null;
  /** The hold detail of every pass that did not deliver, in order. */
  heldDetails: Array<DeliveryDetail | null>;
}

/**
 * How long a probe keeps retrying, in capture time, before it is reported undelivered. The
 * drainer re-checks a held agent at `retryAfterMs` and at the 1.5 s backstop; a probe that has not
 * delivered after the composer-sample gap has been exceeded is a real hold, not a retry interval.
 */
export const PROBE_WINDOW_MS = MAX_COMPOSER_SAMPLE_GAP_MS;

export function parseCapture(text: string): Capture {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new Error('empty capture');
  const header = JSON.parse(lines[0]) as CaptureHeader;
  if (header.format !== CAPTURE_FORMAT || header.version !== 1) {
    throw new Error(`not a ${CAPTURE_FORMAT} v1 capture`);
  }
  const events = lines.slice(1).map((line) => JSON.parse(line) as CaptureEvent);
  return { header, events };
}

export function loadCapture(bytes: Buffer): Capture {
  return parseCapture(gunzipSync(bytes).toString('utf8'));
}

/** Build a capture in memory (tests, and the recorder's own self-check). */
export function serializeCapture(capture: Capture): string {
  return [capture.header, ...capture.events].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

const WS = '/replay/1658';
const AGENT = 'conpty-replay';

/**
 * A terminal replaying a capture on a virtual clock. `advanceTo(t)` applies every event stamped
 * at or before `t`, exactly as the live `PtySession` would have seen them: output feeds the
 * mirror and moves `bytesWritten` / `lastDataAt`, human input moves `inputSeq` / `lastInputAt`,
 * a resize resizes the mirror.
 */
class ReplayTerminal {
  readonly screen: SessionScreen;
  bytesWritten = 0;
  lastDataAt = 0;
  inputSeq = 0;
  lastInputAt = 0;
  now = 0;
  private next = 0;

  constructor(
    private readonly events: CaptureEvent[],
    cols: number,
    rows: number,
  ) {
    this.screen = new SessionScreen(cols, rows);
  }

  async advanceTo(t: number): Promise<void> {
    while (this.next < this.events.length && this.events[this.next].t <= t) {
      const event = this.events[this.next];
      this.next++;
      if ('o' in event) {
        this.screen.feed(event.o);
        this.bytesWritten += Buffer.byteLength(event.o, 'utf8');
        this.lastDataAt = event.t;
      } else if ('i' in event) {
        this.inputSeq++;
        this.lastInputAt = event.t;
      } else if ('r' in event) {
        this.screen.resize(event.r[0], event.r[1]);
      }
    }
    this.now = Math.max(this.now, t);
    // Flush the parser so the synchronous fingerprint read sees every byte fed so far, as the
    // live binding's classify-then-fingerprint sequence does.
    await this.screen.read();
  }

  session(command: string): DeliverySession {
    const terminal = this;
    const session = {
      id: `${AGENT}-term`,
      get bytesWritten() { return terminal.bytesWritten; },
      get lastDataAt() { return terminal.lastDataAt; },
      get inputSeq() { return terminal.inputSeq; },
      get lastInputAt() { return terminal.lastInputAt; },
      get info() { return { cols: terminal.screen.cols, rows: terminal.screen.rows }; },
      command,
      launchArgs: [],
      cwd: WS,
      writable: true,
      write: () => true,
      gateScreen: terminal.screen,
    };
    return session as unknown as DeliverySession;
  }
}

function portsFor(terminal: ReplayTerminal, session: DeliverySession, profile: GateProfile): DeliveryPorts {
  return {
    getSessionForAgent: () => session,
    resolveProfile: () => profile,
    classify: (s, p) => classifyAgentScreen(s, p),
    composerFingerprint: (s, p) => composerFingerprintForSession(s, p),
    writeMessage: (_s, _msg, _noEnter, precheck) => {
      const abort = precheck();
      if (abort) return { status: 'aborted', abort };
      return { status: 'written' };
    },
    watchEcho: () => Promise.resolve({ verify: () => Promise.resolve(true) }),
    broadcast: () => {},
    onHeldStateChange: () => {},
    onEscalation: () => {},
    onLiveness: () => {},
    log: () => {},
    now: () => terminal.now,
  };
}

/**
 * Replay a capture and run one delivery attempt per probe. Each probe gets a fresh mailbox and
 * a fresh replay up to the probe's instant, then retries on the delivery path's own schedule
 * (`retryAfterMs`, else the settle interval) while the capture keeps playing, for at most
 * {@link PROBE_WINDOW_MS} of capture time.
 */
export async function replayProbes(capture: Capture, profile: GateProfile): Promise<ProbeResult[]> {
  const probes = capture.events.filter((e): e is { t: number; probe: string } => 'probe' in e);
  const results: ProbeResult[] = [];
  for (const probe of probes) {
    results.push(await runProbe(capture, profile, probe));
  }
  return results;
}

async function runProbe(
  capture: Capture,
  profile: GateProfile,
  probe: { t: number; probe: string },
): Promise<ProbeResult> {
  const terminal = new ReplayTerminal(capture.events, capture.header.cols, capture.header.rows);
  const session = terminal.session(capture.header.app);
  const ports = portsFor(terminal, session, profile);
  const db = new Database(':memory:');
  db.exec(GLOBAL_SCHEMA);
  try {
    await terminal.advanceTo(probe.t);
    mailbox.enqueue(db, {
      workspacePath: WS,
      toAgent: AGENT,
      body: 'replay probe',
      formattedMessage: '### [ARCHITECT INSTRUCTION] ###\nreplay probe',
      now: probe.t,
    });
    const heldDetails: Array<DeliveryDetail | null> = [];
    let at = probe.t;
    while (at - probe.t <= PROBE_WINDOW_MS) {
      const outcome = await deliverAgentMail(ports, db, WS, AGENT);
      if (outcome.delivered.length > 0) {
        return { probe: probe.probe, at: probe.t, delivered: true, waitedMs: at - probe.t, heldDetails };
      }
      heldDetails.push(outcome.detail ?? null);
      const step = outcome.retryAfterMs ?? SETTLE_BEFORE_WRITE_MS;
      at += Math.max(step, 1);
      await terminal.advanceTo(at);
    }
    return { probe: probe.probe, at: probe.t, delivered: false, waitedMs: null, heldDetails };
  } finally {
    db.close();
    terminal.screen.dispose();
  }
}
