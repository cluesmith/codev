/**
 * Live-Tower wiring for mailbox delivery (Spec 1313, Phase 4).
 *
 * `mailbox-delivery.ts` holds the PURE orchestration (persist → gate → deliver |
 * hold) behind the {@link DeliveryPorts} seam. This module binds those ports to
 * the real Tower — the live terminal registry, the render-gate, paced PTY writes,
 * and the WebSocket message bus — and owns the backstop drainer's lifecycle,
 * which replaces the retired in-memory `SendBuffer`.
 *
 * Keeping the wiring here (not in the pure module) is what lets the orchestration
 * be unit-tested without a live Tower, and lets `handleSend` and the drainer share
 * exactly one delivery path (and one per-agent write serializer).
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadConfig } from '../../lib/config.js';
import type { PtySession } from '../../terminal/pty-session.js';
import { getWorkspaceTerminals, getTerminalManager } from './tower-terminals.js';
import { broadcastMessage } from './tower-messages.js';
import { writeMessageToSession } from './message-write.js';
import { classifyScreen, type GateProfile } from './render-gate.js';
import { resolveProfile } from './gate-profiles.js';
import { harnessFromLaunchScript, type ContextFsPort } from '../commands/reset/context.js';
import { getGlobalDb } from '../db/index.js';
import {
  MailboxDrainer,
  type DeliveryPorts,
  type DeliverySession,
  type DeliveredBroadcast,
} from './mailbox-delivery.js';

type LogFn = (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;

/**
 * A node-fs adapter for {@link harnessFromLaunchScript}. Only `.read` is exercised
 * by that function, but `exists`/`listDirs` are implemented faithfully so the port
 * is honest and reusable rather than a lying stub.
 */
const NODE_FS_PORT: ContextFsPort = {
  exists: (p) => existsSync(p),
  read: (p) => {
    try {
      return readFileSync(p, 'utf-8');
    } catch {
      return null;
    }
  },
  listDirs: (p) => {
    try {
      return readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return null;
    }
  },
};

/**
 * The live, writable {@link PtySession} for an agent in a workspace, or `null`
 * when there is no usable live PTY — unknown agent, an exited session (the
 * PtyManager keeps an exited session for 30 s, so a stale hit is still filtered
 * here), or a session whose shellper connection is down (#1198). A `null` result
 * makes the delivery hold `no-live-pty` rather than write into the void.
 *
 * `toAgent` is the canonical identity stored on the row (a builder id or a
 * specific architect name), so an exact key match against the routing sub-maps is
 * correct — and because rows address the AGENT, a respawned terminal (new id, same
 * builder id) transparently drains its predecessor's held mail.
 */
export function resolveLiveSessionForAgent(workspacePath: string, toAgent: string): PtySession | null {
  const entry = getWorkspaceTerminals().get(workspacePath);
  if (!entry) return null;
  const tid = entry.builders.get(toAgent) ?? entry.architects.get(toAgent) ?? entry.shells.get(toAgent);
  if (!tid) return null;
  const session = getTerminalManager().getSession(tid);
  if (!session || !session.writable) return null;
  return session;
}

/**
 * The classifier profile for a session, resolving the wrapped-launch case. A real
 * builder runs through `.builder-start.sh`, so `session.command` is the shell, not
 * the agent, and the pure {@link resolveProfile} returns `null`. We then read the
 * launch script (exactly as `afx reset` does) to recover the underlying harness
 * command and resolve against that. Still `null` → the delivery holds `no-profile`
 * (fail-safe by construction: an unknown agent is held and surfaced, never guessed
 * — this is what correctly trips on wrapper/boot/relaunch screens too).
 */
export function resolveProfileForSession(session: DeliverySession): GateProfile | null {
  const direct = resolveProfile({ command: session.command, args: session.launchArgs });
  if (direct) return direct;
  const harness = harnessFromLaunchScript(NODE_FS_PORT, session.cwd);
  if (!harness) return null;
  return resolveProfile({ command: harness });
}

/** Convert a delivered-message frame to the WebSocket bus shape and broadcast it. */
function broadcastDelivered(frame: DeliveredBroadcast): void {
  broadcastMessage({
    type: 'message',
    from: { project: frame.from.project ?? 'unknown', agent: frame.from.agent ?? 'unknown' },
    to: frame.to,
    content: frame.content,
    metadata: { source: 'mailbox' },
    timestamp: new Date(frame.timestamp).toISOString(),
  });
}

/**
 * Paced write of a message (text + trailing Enter unless `noEnter`), returning a
 * promise that resolves when the last scheduled write fires. `writeMessageToSession`
 * schedules its writes via `setTimeout` and returns the ms offset of the final one;
 * awaiting that is what makes the per-agent serializer's completion-chaining real —
 * the next delivery cannot begin until this submit is entirely on the wire.
 */
function writeMessagePaced(session: DeliverySession, formattedMessage: string, noEnter: boolean): Promise<void> {
  const doneMs = writeMessageToSession(session, formattedMessage, noEnter);
  return new Promise((resolve) => setTimeout(resolve, doneMs));
}

/**
 * Build the {@link DeliveryPorts} bound to the live Tower. Cheap (closures over
 * module singletons), so `handleSend` may construct one per request and the
 * drainer one at boot; the shared state that matters (the per-agent write
 * serializer) lives in `mailbox-delivery.ts`, not here.
 */
export function makeDeliveryPorts(log: LogFn): DeliveryPorts {
  return {
    getSessionForAgent: (ws, agent) => resolveLiveSessionForAgent(ws, agent),
    resolveProfile: (session) => resolveProfileForSession(session),
    classify: (snapshot, profile) => classifyScreen(snapshot, profile),
    writeMessage: (session, msg, noEnter) => writeMessagePaced(session, msg, noEnter),
    broadcast: (frame) => broadcastDelivered(frame),
    log: (m) => log('INFO', m),
    now: () => Date.now(),
  };
}

// The single backstop drainer instance (replaces the retired SendBuffer). Created
// lazily so it picks up the configured retention window (below) at first use.
let drainer: MailboxDrainer | undefined;

/**
 * The terminal-row retention window (days) for the prune. This is a Tower-GLOBAL
 * policy — the drainer prunes rows across every workspace in the user-global
 * `global.db` — so it is read from the user-global `~/.codev/config.json` layer via
 * `loadConfig` (rooted at home), not any single workspace's config. Spec default 30
 * (already `DEFAULT_CONFIG.mailbox.retentionDays`). A malformed config never stops
 * the drainer from booting — it falls back to the default.
 */
function configuredRetentionDays(): number {
  try {
    return loadConfig(homedir()).mailbox?.retentionDays ?? 30;
  } catch {
    return 30;
  }
}

function ensureDrainer(): MailboxDrainer {
  if (!drainer) drainer = new MailboxDrainer({ pruneRetentionDays: configuredRetentionDays() });
  return drainer;
}

/**
 * Start the mailbox backstop drainer (replaces `startSendBuffer`). Called once on
 * Tower boot: prunes terminal rows and begins the periodic held-row drain that
 * redelivers on the first clean gate after a line clears. Fast submit/quiescence
 * triggers are layered on in Phase 5.
 */
export function startMailboxDrainer(log: LogFn): void {
  ensureDrainer().start(makeDeliveryPorts(log), getGlobalDb());
  log('INFO', '[mailbox] backstop drainer started');
}

/**
 * Stop the mailbox backstop drainer (replaces `stopSendBuffer`). Just stops the
 * timer — there is NO shutdown force-flush, because every held row is already
 * persisted in SQLite and will be redelivered after restart on a clean gate.
 */
export function stopMailboxDrainer(): void {
  drainer?.stop();
}

/** The live drainer (liveness-telemetry streaks; Phase 7 surfaces them). */
export function getMailboxDrainer(): MailboxDrainer {
  return ensureDrainer();
}
