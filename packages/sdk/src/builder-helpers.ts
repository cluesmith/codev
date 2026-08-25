import type { OverviewBuilder, OverviewData } from '@cluesmith/codev-types';

/**
 * Threshold (ms) for treating a builder as "idle, likely waiting on input".
 *
 * If Tower last received output from the builder's shellper longer than this
 * ago — and the builder isn't blocked at a gate or completed — it's likely
 * paused at a clarifying question. 5 minutes is conservative enough that
 * legitimate long agent "thinking" pauses rarely false-positive, but short
 * enough that a real wait surfaces while the user is still on-task.
 *
 * Lives here (not in `@cluesmith/codev-types`) because it's *application
 * policy* — the UI rule for interpreting `lastDataAt`. The types
 * package describes the wire contract; this constant decides what the
 * VSCode extension and the web dashboard *do* with it. Co-locating both
 * surfaces' threshold here prevents silent UI drift where one says
 * "waiting" and the other says "active" for the same builder.
 */
export const IDLE_WAITING_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * True iff the builder is silent past `IDLE_WAITING_THRESHOLD_MS` while
 * still being able to make progress (not blocked at a gate, not
 * completed/verified, and Tower has a `lastDataAt` timestamp for it).
 *
 * Canonical predicate for the third "needs me" state alongside `blocked`.
 * UI surfaces should call this rather than reimplementing the threshold
 * check.
 */
export function isIdleWaiting(b: OverviewBuilder, now: number = Date.now()): boolean {
  if (b.blocked) { return false; }
  if (b.phase === 'complete' || b.phase === 'verified') { return false; }
  if (!b.lastDataAt) { return false; }
  return now - new Date(b.lastDataAt).getTime() > IDLE_WAITING_THRESHOLD_MS;
}

/**
 * The "what needs a human right now" roll-up, projected from the overview cache — the same
 * cross-client UI policy `isIdleWaiting` embodies, one level up. Lives here (not in
 * `@cluesmith/codev-types`, which is wire-contracts-only) so every client that renders an attention
 * view — the VSCode contextual panel today, the web dashboard / Stream Deck tomorrow — shares one
 * definition of "attention" and cannot drift. Pure and environment-agnostic: it reads fields already
 * on the overview wire and adds no Tower/types surface.
 */

/** A builder an attention row is about (id + its issue, for the row label). */
export interface AttentionBuilderRef {
  builderId: string;
  issueId: string | null;
  issueTitle: string | null;
}

/** A builder parked on a human gate (a blocked porch gate, or a PR awaiting review). */
export interface GateItem extends AttentionBuilderRef {
  /** Display gate label (e.g. "plan review", or "PR review" for a pending PR). */
  gate: string;
  /** ISO timestamp the builder became blocked, when known (`null` for the PR-ready signal). */
  since: string | null;
}

/** A builder idle past the waiting threshold — likely paused on a clarifying question (`isIdleWaiting`). */
export interface WaitingItem extends AttentionBuilderRef {
  /** ISO timestamp of the builder's last output (`lastDataAt`), for an idle-age display. */
  since: string | null;
}

/** A builder with a countable pending item (held mail rows, or queued review comments). */
export interface CountItem extends AttentionBuilderRef {
  count: number;
}

/**
 * The render-ready attention roll-up. Lists preserve `OverviewData.builders` order (deterministic;
 * no sorting). `isEmpty` is the single flag a UI reads to choose an empty state over the sections.
 */
export interface AttentionSummary {
  /** Builders blocked at a porch gate, plus builders whose PR is awaiting a reviewer. */
  pendingGates: GateItem[];
  /** Builders idle past the waiting threshold (not already shown as a gate). */
  waiting: WaitingItem[];
  /** Workspace-wide count of held mailbox rows (all recipients, including architects). */
  heldTotal: number;
  /** True when at least one held row has crossed the escalation age. */
  heldEscalated: boolean;
  /** Per-builder held-mail counts (only builders with at least one held row). */
  heldMail: CountItem[];
  /** Per-builder queued review-comment counts (only builders with at least one queued). */
  queuedFeedback: CountItem[];
  /** True when nothing needs attention: every list empty AND no mail held anywhere. */
  isEmpty: boolean;
}

/** A fresh empty summary. A function (not a shared const) so a caller can never mutate a singleton
 *  handed to the next caller — this helper is public package surface with unknown consumers. */
function emptyAttention(): AttentionSummary {
  return {
    pendingGates: [],
    waiting: [],
    heldTotal: 0,
    heldEscalated: false,
    heldMail: [],
    queuedFeedback: [],
    isEmpty: true,
  };
}

/**
 * Project the overview cache into the attention roll-up.
 *
 * `data === null` (cache not yet populated, or a transient disconnect) yields the empty summary, so
 * a UI shows an honest empty state rather than stale or half-rendered content. `now` is injectable
 * for the same reason `isIdleWaiting` takes it — deterministic tests of the idle-threshold branch.
 */
export function deriveAttention(data: OverviewData | null, now: number = Date.now()): AttentionSummary {
  if (data === null) {
    return emptyAttention();
  }

  const pendingGates: GateItem[] = [];
  const waiting: WaitingItem[] = [];
  const heldMail: CountItem[] = [];
  const queuedFeedback: CountItem[] = [];

  for (const builder of data.builders) {
    const ref: AttentionBuilderRef = {
      builderId: builder.id,
      issueId: builder.issueId,
      issueTitle: builder.issueTitle,
    };

    // A blocked porch gate (plan / dev review, etc). `blocked` is the display label; `blockedSince`
    // dates it. `prReady` is the separate, uniform "PR waiting on a reviewer" gate signal — a builder
    // can present either, so both are checked independently.
    const atGate = builder.blocked !== null || builder.prReady;
    if (builder.blocked !== null) {
      pendingGates.push({ ...ref, gate: builder.blocked, since: builder.blockedSince });
    }
    if (builder.prReady) {
      pendingGates.push({ ...ref, gate: 'PR review', since: null });
    }

    // Idle-waiting is the canonical "needs me" state alongside `blocked`. Surface it only when the
    // builder is not already shown as a gate: `isIdleWaiting` already excludes `blocked`, but a
    // prReady builder could still be idle, and we don't want to list it twice.
    if (!atGate && isIdleWaiting(builder, now)) {
      waiting.push({ ...ref, since: builder.lastDataAt });
    }

    if (builder.heldCount !== undefined && builder.heldCount > 0) {
      heldMail.push({ ...ref, count: builder.heldCount });
    }

    const queued = data.queuedFeedback[builder.id] ?? 0;
    if (queued > 0) {
      queuedFeedback.push({ ...ref, count: queued });
    }
  }

  const heldTotal = data.heldCount;
  const isEmpty =
    pendingGates.length === 0 &&
    waiting.length === 0 &&
    heldMail.length === 0 &&
    queuedFeedback.length === 0 &&
    heldTotal === 0;

  return {
    pendingGates,
    waiting,
    heldTotal,
    heldEscalated: data.mailboxEscalated,
    heldMail,
    queuedFeedback,
    isEmpty,
  };
}
