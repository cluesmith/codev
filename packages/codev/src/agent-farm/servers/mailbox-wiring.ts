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

import { homedir } from 'node:os';
import { loadConfig } from '../../lib/config.js';
import { terminalDeliverySignals, type PtySession } from '../../terminal/pty-session.js';
import type { SessionScreen } from '../../terminal/session-screen.js';
import { getWorkspaceTerminals, getTerminalManager } from './tower-terminals.js';
import { broadcastMessage, resolveAgentInRegistry, isResolveError } from './tower-messages.js';
import { submitMessagePaced } from './message-write.js';
import { bufferLines, classifyBuffer, type GateProfile, type GateVerdict } from './render-gate.js';
import { resolveProfile } from './gate-profiles.js';
import {
  buildContextFsPort,
  harnessFromLaunchScript,
  type ContextFsPort,
} from '../commands/reset/context.js';
import { getGlobalDb } from '../db/index.js';
import { getArchitectByName } from '../state.js';
import { formatBuilderMessage } from '../utils/message-format.js';
import { supersede as supersedeMailbox, dismissHeldWithKey, NOTICE_SUPERSEDE_PREFIX } from '../db/mailbox.js';
import path from 'node:path';
import {
  MailboxDrainer,
  normalizeForEcho,
  type EchoWatch,
  type UnverifiedDeliveryInfo,
  type DeliveryPorts,
  type DeliverySession,
  type DeliveredBroadcast,
  type EscalationInfo,
  type LivenessInfo,
  type HeldOwnerNoticeInfo,
} from './mailbox-delivery.js';
import type { MailboxEscalationPayload } from '@cluesmith/codev-types';

/**
 * "Recent output" window for the liveness diagnostic (Spec 1313, Phase 7 — spec line
 * 91). A `no-profile` streak only raises the loud log/broadcast when the session emitted
 * output within this window: that distinguishes a genuinely broken/unknown classifier on
 * a LIVE, producing app (worth alarming) from a dormant unknown session (still visible in
 * `afx inbox`, but no loud alarm). Sized well above the streak's own duration
 * (threshold × backstop interval ≈ 15s) so an actively-failing app comfortably qualifies.
 */
const LIVENESS_RECENT_OUTPUT_MS = 30_000;

type LogFn = (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;

/**
 * The SSE broadcast fn (Tower's `broadcastNotification`), wired once at boot via
 * {@link setMailboxBroadcaster}. Mirrors `codev-config-watcher.ts`'s
 * `setCodevConfigNotifier` pattern: the pure delivery module and the boot-time drainer
 * have no `RouteContext`, so the two held-set SSE events they raise
 * (`overview-changed` on a held-state change, `mailbox-escalation` on an age crossing)
 * are fanned out through this module singleton instead. Undefined until boot wires it,
 * so `makeDeliveryPorts` is safe to call before Tower is up (unit tests never set it,
 * making the ports genuine no-ops).
 */
type MailboxBroadcastFn = (n: { type: string; title: string; body: string; workspace?: string }) => void;
let mailboxBroadcaster: MailboxBroadcastFn | undefined;

/** Wire the SSE broadcast fn once at Tower startup (see {@link MailboxBroadcastFn}). */
export function setMailboxBroadcaster(fn: MailboxBroadcastFn): void {
  mailboxBroadcaster = fn;
}

/**
 * The shared node-fs adapter for {@link ContextFsPort}.
 *
 * Was a hand-rolled copy — one of three identical ones. A stub in any copy
 * silently nulls the porch context for that path, and a regression test can only
 * observe the copy it imports, so the implementations are now one.
 */
const NODE_FS_PORT: ContextFsPort = buildContextFsPort();

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
 * The inverse of {@link resolveLiveSessionForAgent}: reverse-map a live session id to
 * the agent it serves (`{ workspacePath, toAgent }`), or `null` when the id belongs to
 * no registered agent — a plain shell nobody addresses, or a session already torn
 * down. Drives the Phase 5 fast triggers: a submit/quiescence signal carries only the
 * session id, and delivery is keyed on the canonical agent, so the id must be resolved
 * back before scheduling a drain. Iterates the routing registry (agents per active
 * workspace — small) which is cheap at trigger frequency and coalesced downstream. The
 * agent name it returns is the same canonical identity the row is addressed to, so a
 * respawned terminal's signal still resolves to the right held mail.
 */
export function resolveAgentForSession(
  sessionId: string
): { workspacePath: string; toAgent: string } | null {
  for (const [workspacePath, entry] of getWorkspaceTerminals()) {
    for (const registry of [entry.builders, entry.architects, entry.shells]) {
      for (const [agent, tid] of registry) {
        if (tid === sessionId) return { workspacePath, toAgent: agent };
      }
    }
  }
  return null;
}

/**
 * The classifier profile for a session, resolving the wrapped-launch case. A real
 * builder runs through `.builder-start.sh`, so `session.command` is the shell, not
 * the agent, and the pure {@link resolveProfile} returns `null`. We then read the
 * launch script (exactly as `afx refresh` does) to recover the underlying harness
 * command and resolve against that. Still `null` → the delivery holds `no-profile`
 * (fail-safe by construction: an unknown agent is held and surfaced, never guessed
 * — this is what correctly trips on wrapper/boot/relaunch screens too).
 *
 * Stale-identity note (Spec 1313): `session.command` is now sourced from the
 * persisted `terminal_sessions.command` on reconnect. If it ever goes stale (a
 * user re-points `shell.architect` at a different harness and the shellper later
 * auto-restarts into it while the row still names the old one), this can resolve
 * the WRONG profile — but it fails CLOSED today, not misdelivered: CLAUDE_PROFILE
 * and CODEX_PROFILE are behaviourally identical (same marker + region patterns),
 * and any cross-family mismatch (e.g. agy's `> ` marker) fails the composer-marker
 * test → not clean → held. That safety is a property of the current profile TABLE,
 * not of this design; the day codex/claude markers diverge, stale identity becomes
 * a live bug and the authoritative fix is WELCOME-frame hydration (see review).
 */
export function resolveProfileForSession(session: DeliverySession): GateProfile | null {
  const direct = resolveProfile({ command: session.command, args: session.launchArgs });
  if (direct) return direct;
  const harness = harnessFromLaunchScript(NODE_FS_PORT, session.cwd);
  if (!harness) return null;
  return resolveProfile({ command: harness });
}

/**
 * Classify a session's CURRENT screen for the gate (Spec 1313 render-gate round 2). Reads the
 * session's persistent {@link SessionScreen} mirror — a bounded headless Terminal fed the
 * session's output from birth — and runs the shared classifier on its viewport. This replaces
 * the old whole-ring re-render (`classifyScreen(ringBuffer.getAll()…)`), which #1205's 2 MiB
 * partial cap could hand a TORN frame → a permanent false-`busy` hold for the busiest agents.
 *
 * The delivery path only ever calls this with a live session resolved by
 * {@link resolveLiveSessionForAgent} — always a `PtySession`, which carries the mirror — so the
 * cast is sound. A session that has produced NO output yet has no mirror (`gateScreen` is null);
 * that is not a verified-empty prompt, so it classifies not-clean (`no-composer-marker`), exactly
 * as an empty replay always did. `SessionScreen.read()` flushes the parser, so the buffer the
 * shared {@link classifyBuffer} reads reflects every byte counted by the change token the
 * delivery path sampled — the property its gate→write TOCTOU relies on.
 */
export async function classifyAgentScreen(session: DeliverySession, profile: GateProfile): Promise<GateVerdict> {
  const screen = (session as PtySession).gateScreen;
  if (!screen) return { clean: false, reason: 'busy', detail: 'no-composer-marker' };
  const { term, cols, rows } = await screen.read();
  return classifyBuffer(term, cols, rows, profile);
}

/**
 * How long {@link watchEchoOnScreen}'s verification waits for a delivered message's header to
 * show up, and how often it re-reads while waiting (Issue #1573).
 *
 * Measured 2026-09-01 against live claude and codex PTYs: the header is on screen from the
 * first sample after the write completes (the composer echoes it as it is typed, before the
 * Enter that submits it), and remains present at every sample out to +5 s. The budget is
 * therefore slack for a loaded machine, not the expected cost — the common case returns on the
 * first read with no added latency. It is bounded because the `afx send` request path awaits
 * this before answering the sender.
 *
 * Issue #1584: the delivery path calls `verify()` at most TWICE (a second window for a slow
 * renderer, no bytes written), so this constant is half the worst-case wait a sender sees —
 * ~1.2 s. Raising it raises that, and the answer is no longer a retry decision: an unconfirmed
 * delivery is recorded as delivered-unverified, never re-written.
 */
const ECHO_VERIFY_TIMEOUT_MS = 600;
const ECHO_VERIFY_POLL_MS = 50;

/**
 * How many times `needle` appears in the session's rendered mirror right now.
 *
 * A COUNT rather than a boolean because presence alone is not evidence (CMAP round 1 — codex):
 * a previous delivery attempt's echo sits in the same scrollback, so "the header is on screen"
 * would certify a retry whose bytes the composer swallowed. Comparing against a pre-write
 * sample is what ties the evidence to the write that is being judged.
 *
 * Reads the SAME `SessionScreen` the render gate classifies, so verification and gating can
 * never disagree about what the terminal shows, and scans its full retained buffer rather than
 * the viewport — a long message scrolls its own header into scrollback while it types.
 */
async function countEchoOnScreen(screen: SessionScreen, needle: string): Promise<number> {
  const { term } = await screen.read();
  const text = normalizeForEcho(bufferLines(term).join('\n'));
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
}

/**
 * Open an echo watch on a session (Issue #1573) — the live binding for
 * {@link DeliveryPorts.watchEcho}.
 *
 * Samples the terminal BEFORE the write, then `verify()` polls until the needle appears MORE
 * often than it did in that sample. New evidence, not mere presence.
 *
 * A session with no mirror has produced no output and therefore cannot echo anything, so its
 * watch verifies `false` rather than passing.
 *
 * Known residuals — these are why a negative is "could not confirm", not "not delivered". Issue
 * #1584: they are also why a negative must NOT trigger a redelivery. Each recurs for the same
 * message on every attempt, so holding-and-rewriting on one of them is a loop that cannot
 * converge — #1583 saw a message re-injected dozens of times on exactly the second one. The
 * caller now commits the delivery and reports it unverified instead. None is designed around
 * here; #1578 tracks smarter verification:
 *   - a harness on the ALTERNATE screen buffer has no scrollback, so a message longer than one
 *     viewport can scroll its header out of reach and never confirm. The agy profile boots into
 *     the alternate buffer and was not measurable here (unauthenticated).
 *   - a very long write can evict the pre-write copy from the 1000-line mirror, so the count
 *     comes back equal rather than greater and a genuine delivery reads as unconfirmed.
 *   - an unconfirmed delivery re-reads and re-normalizes the retained buffer once per poll
 *     while the `afx send` request waits. Bounded by the timeout (and by the delivery path's
 *     two windows, ~1.2 s total), and off the happy path entirely — the measured case confirms
 *     on the first read.
 */
export async function watchEchoOnScreen(session: DeliverySession, needle: string): Promise<EchoWatch> {
  const screen = (session as PtySession).gateScreen;
  if (!screen) return { verify: () => Promise.resolve(false) };
  const before = await countEchoOnScreen(screen, needle);
  return {
    verify: async (): Promise<boolean> => {
      const deadline = Date.now() + ECHO_VERIFY_TIMEOUT_MS;
      for (;;) {
        if (await countEchoOnScreen(screen, needle) > before) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, ECHO_VERIFY_POLL_MS));
      }
    },
  };
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
 * Build the {@link DeliveryPorts} bound to the live Tower. Cheap (closures over
 * module singletons), so `handleSend` may construct one per request and the
 * drainer one at boot; the shared state that matters (the per-agent write
 * serializer) lives in `mailbox-delivery.ts`, not here.
 */
export function makeDeliveryPorts(log: LogFn): DeliveryPorts {
  return {
    getSessionForAgent: (ws, agent) => resolveLiveSessionForAgent(ws, agent),
    resolveProfile: (session) => resolveProfileForSession(session),
    classify: (session, profile) => classifyAgentScreen(session, profile),
    // Issue #1365: the write edge takes the session's per-terminal submission lock as a
    // LEAF inside the per-agent serializer, so a gated delivery and a concurrent
    // `--interrupt`/`--escape` can no longer interleave. The precheck is the delivery
    // module's, re-run inside that lock.
    writeMessage: (session, msg, noEnter, precheck) => submitMessagePaced(session, msg, noEnter, precheck),
    // Issue #1573: the only end-to-end evidence that the bytes reached the terminal — opened
    // before the write. Issue #1584: consulted AFTER the row is marked delivered, because the
    // commit is what makes a completed write un-repeatable; this only decides what we report.
    watchEcho: (session, needle) => watchEchoOnScreen(session, needle),
    broadcast: (frame) => broadcastDelivered(frame),
    onHeldStateChange: () => broadcastHeldStateChange(),
    onEscalation: (info) => broadcastEscalation(info),
    onLiveness: (info) => surfaceLiveness(info, log),
    // Issue #1584: an unconfirmed delivery is committed, not retried, so this notice is the
    // only human-facing trace for a cron/backstop send with no sender waiting on a response.
    onUnverifiedDelivery: (info) => surfaceUnverifiedDelivery(info),
    escalateHeldToOwner: (info) => escalateHeldToOwner(info, log),
    clearHeldOwnerNotice: (ws, agent) => clearHeldOwnerNotice(ws, agent),
    log: (m, level) => log(level ?? 'INFO', m),
    now: () => Date.now(),
  };
}

/** Pseudo-sender identity for owner starvation notices (Spec 1313 round 3, change 3). */
const NOTICE_SENDER = 'af-mailbox';

/** Supersede key for the single pending owner notice ABOUT a starving `toAgent`. */
function noticeSupersedeKey(toAgent: string): string {
  return `${NOTICE_SUPERSEDE_PREFIX}${toAgent}`;
}

/** Human-readable notice body (metadata only — never the starved messages' contents). */
function formatOwnerNoticeBody(info: HeldOwnerNoticeInfo): string {
  const mins = Math.max(1, Math.round(info.ageMs / 60_000));
  const plural = info.heldCount === 1 ? 'message' : 'messages';
  return (
    `Mailbox delivery is STUCK for builder '${info.toAgent}' @ ${path.basename(info.workspacePath)}. ` +
    `${info.heldCount} ${plural} held ~${mins}m (reason: ${info.reason ?? 'held'}) — its composer never classifies as a ready prompt, ` +
    `so nothing is being delivered (cron nudges included). ` +
    `Remedy: run 'afx inbox' to inspect; 'afx interrupt ${info.toAgent}' clears a stuck composer.`
  );
}

/**
 * Raise a starvation notice to a starving agent's OWNER architect (Spec 1313 round 3, change
 * 3). Skips agents that are themselves architects — the alarm would land in the same starved
 * mailbox, and `afx status` covers that case. Resolves the recipient EXACTLY as `afx send
 * architect` does — the starving builder's spawning architect (affinity), else the workspace's
 * `main`, else the first-registered architect — via the shared registry resolver. Then enqueues
 * ONE coalesced (supersede-keyed), GATE-delivered mailbox row: visibility only, never a force
 * path. No-op when no architect can be resolved (nowhere to send).
 *
 * RETURNS `true` iff a notice row was enqueued; `false` on every no-op path (recipient is
 * itself an architect / no architect resolvable / would notify the agent about itself). The
 * drainer arms its once-per-episode guard only on `true`, so a no-op retries next tick rather
 * than silently suppressing the alarm for the episode.
 */
function escalateHeldToOwner(info: HeldOwnerNoticeInfo, log: LogFn): boolean {
  // An architect-addressed row gets no notice (it would starve in the same mailbox).
  if (getArchitectByName(info.workspacePath, info.toAgent)) return false;
  // Resolve the owner architect the same way `afx send architect` does (bare `architect` form
  // with the starving builder as sender → spawning affinity, else main, else first).
  const owner = resolveAgentInRegistry('architect', info.workspacePath, info.toAgent);
  if (isResolveError(owner)) {
    log('INFO', `[mailbox] starvation notice for ${info.toAgent} skipped: no architect to notify (${owner.message})`);
    return false;
  }
  if (owner.agent === info.toAgent) return false; // defensive: never notify an agent about itself
  const body = formatOwnerNoticeBody(info);
  supersedeMailbox(getGlobalDb(), info.workspacePath, noticeSupersedeKey(info.toAgent), {
    workspacePath: info.workspacePath,
    toAgent: owner.agent,
    body,
    formattedMessage: formatBuilderMessage(NOTICE_SENDER, owner.agent, body),
    fromAgent: NOTICE_SENDER,
    fromWorkspace: info.workspacePath,
  });
  broadcastHeldStateChange();
  // Deliver the notice promptly through the SAME gate (it holds if the architect is busy).
  void ensureDrainer().scheduleDrain(owner.workspacePath, owner.agent);
  log(
    'WARN',
    `[mailbox] STARVATION notice → ${owner.agent} about ${info.toAgent} @ ${path.basename(info.workspacePath)} ` +
      `(${info.heldCount} held ~${Math.round(info.ageMs / 1000)}s, reason ${info.reason ?? 'held'})`,
  );
  return true;
}

/**
 * Clear (dismiss) any still-held owner notice about `toAgent` once its starvation is over
 * (Spec 1313 round 3). A no-op on an already-delivered notice — the architect already saw it.
 */
function clearHeldOwnerNotice(workspacePath: string, toAgent: string): void {
  const dismissed = dismissHeldWithKey(getGlobalDb(), workspacePath, noticeSupersedeKey(toAgent));
  if (dismissed > 0) broadcastHeldStateChange();
}

/**
 * Fire the `overview-changed` SSE event so the held-count indicator refetches its
 * count (Spec 1313, Phase 7). Cheap and idempotent (it only triggers a refetch), so
 * the delivery path fires it freely on any held-set change. No-op until the broadcaster
 * is wired at boot.
 */
function broadcastHeldStateChange(): void {
  mailboxBroadcaster?.({
    type: 'overview-changed',
    title: 'Held mail changed',
    body: 'Mailbox held-set changed',
  });
}

/**
 * Fire the `mailbox-escalation` SSE event when a held row crosses the escalation age
 * (Spec 1313, Phase 7) — a VISIBILITY signal that moves the dashboard/VSCode indicator
 * into its attention state; it never triggers delivery. Carries metadata only (ids +
 * age + reason), never the message body, per the spec's redaction rule. No-op until the
 * broadcaster is wired at boot.
 */
function broadcastEscalation(info: EscalationInfo): void {
  const payload: MailboxEscalationPayload = {
    workspacePath: info.workspacePath,
    toAgent: info.toAgent,
    mailboxId: info.mailboxId,
    ageMs: info.ageMs,
    reason: info.reason,
  };
  mailboxBroadcaster?.({
    type: 'mailbox-escalation',
    title: 'Message held past escalation age',
    body: JSON.stringify(payload),
    workspace: info.workspacePath,
  });
}

/**
 * Surface the liveness diagnostic (Spec 1313, Phase 7 — spec line 91). Applies the spec's
 * "with recent output" gate: only when the agent's live session emitted output within
 * {@link LIVENESS_RECENT_OUTPUT_MS} — proving a genuinely broken/unknown classifier on a
 * PRODUCING app, not a dormant unknown session — does it raise the loud log AND a broadcast.
 * The broadcast rides the existing generic `notification` SSE channel (human title/body, no
 * body-of-message), so it is immediately visible in the dashboard's notification surface
 * without any new event type or client wiring. An idle unknown session raises nothing here —
 * its held row is still discoverable in `afx inbox`, per the metadata-only visibility model.
 */
function surfaceLiveness(info: LivenessInfo, log: LogFn): void {
  const session = resolveLiveSessionForAgent(info.workspacePath, info.toAgent);
  const hasRecentOutput = session != null && Date.now() - session.lastDataAt <= LIVENESS_RECENT_OUTPUT_MS;
  if (!hasRecentOutput) return; // dormant unknown session → no loud alarm (still in `afx inbox`)
  const where = `${info.toAgent} @ ${path.basename(info.workspacePath)}`;
  log(
    'WARN',
    `[mailbox] LIVENESS: ${where} held no-profile for ${info.streak} consecutive checks with recent output — ` +
      `unrecognized app; its mail will not deliver until a classifier profile matches (check for a TUI update)`
  );
  mailboxBroadcaster?.({
    type: 'notification',
    title: 'Mailbox: delivery blocked (unrecognized app)',
    body: `${where} — its screen never classifies as a ready prompt, so held messages will not deliver. A classifier profile may need updating.`,
    workspace: info.workspacePath,
  });
}

/**
 * Surface an unconfirmed delivery (Issue #1584) on the generic `notification` SSE channel that
 * {@link surfaceLiveness} already uses — human title/body, no message body.
 *
 * Deliberately NOT the `mailbox-escalation` event: that one means "held past the escalation
 * age", and saying that about a row we just delivered would be false. The wording here states
 * exactly what is and is not known — the bytes went out, the screen never showed them, and it
 * will not be sent again.
 */
function surfaceUnverifiedDelivery(info: UnverifiedDeliveryInfo): void {
  const where = `${info.toAgent} @ ${path.basename(info.workspacePath)}`;
  mailboxBroadcaster?.({
    type: 'notification',
    title: 'Mailbox: delivered but not confirmed on screen',
    body:
      `${where} — the message was written to terminal ${info.terminalId.slice(0, 8)}… and every byte was ` +
      `accepted, but its header never appeared on that screen. It is recorded as delivered and will NOT ` +
      `be sent again (mailbox id ${info.mailboxId.slice(0, 8)}…). Check the agent's transcript.`,
    workspace: info.workspacePath,
  });
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

/**
 * The held-row escalation age in ms (Spec 1313, Phase 7). Like the retention window
 * this is a Tower-GLOBAL policy read from the user-global config layer, default 60s
 * (matching today's max-age; `DEFAULT_CONFIG.mailbox.escalationSeconds`). A malformed
 * config never stops the drainer from booting — it falls back to the default.
 */
function configuredEscalationMs(): number {
  try {
    return (loadConfig(homedir()).mailbox?.escalationSeconds ?? 60) * 1000;
  } catch {
    return 60_000;
  }
}

function ensureDrainer(): MailboxDrainer {
  if (!drainer) {
    drainer = new MailboxDrainer({
      pruneRetentionDays: configuredRetentionDays(),
      escalationMs: configuredEscalationMs(),
    });
  }
  return drainer;
}

// Phase 5 fast-trigger bus handler. Held at module scope so `stopMailboxDrainer` can
// detach it: re-subscribing on every start would accumulate duplicate listeners across
// Tower restarts within one process (and the tests do start/stop/start).
let deliverySignalHandler: ((sessionId: string) => void) | undefined;

/**
 * Subscribe the fast submit/quiescence triggers (Spec 1313 Phase 5) to the drainer.
 * Each signal names only the emitting session; we reverse-map it to its agent and
 * schedule a coalesced, gated drain. Idempotent — a second call while already
 * subscribed is a no-op, so the single-listener invariant (which arms the
 * per-session quiescence timers) holds.
 */
function subscribeDeliverySignals(): void {
  if (deliverySignalHandler) return;
  const handler = (sessionId: string): void => {
    const target = resolveAgentForSession(sessionId);
    if (target) void ensureDrainer().scheduleDrain(target.workspacePath, target.toAgent);
  };
  deliverySignalHandler = handler;
  terminalDeliverySignals.on('submit', handler);
  terminalDeliverySignals.on('quiescence', handler);
}

/** Detach the Phase 5 trigger handler so a subsequent start re-subscribes cleanly. */
function unsubscribeDeliverySignals(): void {
  if (!deliverySignalHandler) return;
  terminalDeliverySignals.off('submit', deliverySignalHandler);
  terminalDeliverySignals.off('quiescence', deliverySignalHandler);
  deliverySignalHandler = undefined;
}

/**
 * Start the mailbox drainer (replaces `startSendBuffer`). Called once on Tower boot:
 * prunes terminal rows, begins the periodic held-row backstop that redelivers on the
 * first clean gate after a line clears, and subscribes the Phase 5 fast triggers so a
 * held message drains within a microtask of a user submit or output quiescence rather
 * than waiting for the next backstop tick.
 */
export function startMailboxDrainer(log: LogFn): void {
  ensureDrainer().start(makeDeliveryPorts(log), getGlobalDb());
  subscribeDeliverySignals();
  log('INFO', '[mailbox] backstop drainer started');
}

/**
 * Stop the mailbox drainer (replaces `stopSendBuffer`). Detaches the fast triggers and
 * stops the backstop timer — there is NO shutdown force-flush, because every held row
 * is already persisted in SQLite and will be redelivered after restart on a clean gate.
 */
export function stopMailboxDrainer(): void {
  unsubscribeDeliverySignals();
  drainer?.stop();
}

/** The live drainer (liveness-telemetry streaks; Phase 7 surfaces them). */
export function getMailboxDrainer(): MailboxDrainer {
  return ensureDrainer();
}
