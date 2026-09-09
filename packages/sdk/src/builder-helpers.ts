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

/**
 * The **canonical cross-client urgency order** over two `AttentionSummary` values: a comparator
 * that ranks "what needs a human MOST" first. This is `deriveAttention`'s policy one level up —
 * it lives here, beside it, for the same reason (attention is shared UI policy, kept out of the
 * wire-contracts-only types package) so no client re-invents the order and drifts. A workspace-list
 * view sorts its rows with this; a fleet quick-pick presents them in this order.
 *
 * Semantics (a deterministic **total preorder** — distinct summaries may tie, and both callers rely
 * on exactly that, breaking ties with a stable sort):
 *
 * 1. Each summary falls into a single **primary bucket** — the most-urgent signal it carries, in the
 *    order **pending-gate → idle-waiting → held-mail → queued-feedback → quiet**. A summary with both
 *    a pending gate and held mail is a pending-gate workspace; the lower-urgency signals don't lower
 *    its rank. Lower bucket sorts first.
 * 2. Within a bucket, the tie-break matches the bucket's meaning:
 *    - **pending-gate** and **idle-waiting**: the *oldest* item first (longest-waiting; a `null`
 *      `since` — e.g. the PR-ready signal — sorts as +∞, i.e. last within the bucket).
 *    - **held-mail**: an escalated workspace before a merely-held one; then a higher held total first.
 *    - **queued-feedback**: a higher queued total first.
 * 3. Equal summaries compare `0`. `compareAttention` never breaks a tie on anything outside the
 *    summary (it cannot see the workspace's path or label), so callers that want a stable secondary
 *    order (e.g. by disambiguated label) must **pre-order by that key and use a stable sort**.
 *
 * Pure and dependency-free (reads only the two arguments); `Array.prototype.sort` in every engine
 * Codev targets is stable, so the caller-stable-sort contract in (3) is safe to rely on.
 */
export function compareAttention(a: AttentionSummary, b: AttentionSummary): number {
  const rankA = urgencyBucket(a);
  const rankB = urgencyBucket(b);
  if (rankA !== rankB) { return rankA - rankB; }

  switch (rankA) {
    case 0: // pending gates — oldest gate first
      return ascending(oldestSince(a.pendingGates), oldestSince(b.pendingGates));
    case 1: // idle-waiting — oldest wait first
      return ascending(oldestSince(a.waiting), oldestSince(b.waiting));
    case 2: // held mail — escalated first, then higher held total
      if (a.heldEscalated !== b.heldEscalated) { return escalationRank(b) - escalationRank(a); }
      return b.heldTotal - a.heldTotal;
    case 3: // queued feedback — higher total first
      return queuedTotal(b) - queuedTotal(a);
    default: // quiet — nothing to order on
      return 0;
  }
}

/** Ascending numeric compare that is safe for `Infinity`: equal values (incl. `∞ === ∞`) give 0. */
function ascending(x: number, y: number): number {
  if (x === y) { return 0; }
  if (x < y) { return -1; }
  return 1;
}

/**
 * Primary urgency bucket: 0 (most urgent) … 4 (quiet). The most-urgent signal present wins.
 *
 * Held mail buckets on `heldTotal > 0` OR `heldMail.length > 0`: the two are equal today
 * (`heldTotal` is workspace-wide and per-builder rows are a subset), but bucketing on both keeps a
 * workspace that `deriveAttention` reports as non-empty (whose `isEmpty` also weighs `heldMail`)
 * from ever bucketing as quiet — the invariant `!isEmpty ⇒ bucket < 4` holds by construction.
 */
function urgencyBucket(s: AttentionSummary): number {
  if (s.pendingGates.length > 0) { return 0; }
  if (s.waiting.length > 0) { return 1; }
  if (s.heldTotal > 0 || s.heldMail.length > 0) { return 2; }
  if (s.queuedFeedback.length > 0) { return 3; }
  return 4;
}

/**
 * Earliest `since` (ms) across items; a `null` since counts as +∞, an empty list as +∞. A
 * non-finite parse (a malformed timestamp → `NaN`) is treated as +∞ too, so it sorts last and never
 * reaches `ascending` as a `NaN` — which would silently break the comparator's antisymmetry.
 */
function oldestSince(items: ReadonlyArray<{ since: string | null }>): number {
  let oldest = Infinity;
  for (const item of items) {
    let ms = Infinity;
    if (item.since !== null) {
      const parsed = new Date(item.since).getTime();
      if (Number.isFinite(parsed)) { ms = parsed; }
    }
    if (ms < oldest) { oldest = ms; }
  }
  return oldest;
}

/** 1 when a summary's held mail has escalated, else 0 — the escalated-first ordering key. */
function escalationRank(s: AttentionSummary): number {
  if (s.heldEscalated) { return 1; }
  return 0;
}

/** Total queued review comments across a summary's per-builder counts. */
function queuedTotal(s: AttentionSummary): number {
  let total = 0;
  for (const item of s.queuedFeedback) { total += item.count; }
  return total;
}
