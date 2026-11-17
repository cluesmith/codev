import type { ArchitectState, NeedsInputDetail, OverviewBuilder, OverviewData, ServedAgentState } from '@cluesmith/codev-types';

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
 * Spec 1595: how long a served `working` with `backgroundWork` (the agent ended its turn with its
 * own background tasks still running) is trusted after its report (`activityAt`). Such an agent sits
 * at a still prompt by design, so the PTY-silence bound alone would call it waiting too early. Past
 * this bound the agent reads as idle, so a lost resume can never pin it `working`.
 */
export const BACKGROUND_WORK_STALE_MS = 30 * 60 * 1000;

/** The attention class of an agent, as the shared classifier sees it. */
export type AgentAttentionState = 'blocked' | 'needs-input' | 'idle' | 'dead' | 'working';

/** True when an ISO timestamp is older than `thresholdMs`. Absent or unparseable is never stale. */
function olderThan(iso: string | null | undefined, thresholdMs: number, now: number): boolean {
  if (!iso) { return false; }
  return now - new Date(iso).getTime() > thresholdMs;
}

/**
 * Apply the `working` staleness rule to a served state. A reported `working` is trusted only while
 * the agent's PTY output is fresher than `IDLE_WAITING_THRESHOLD_MS` (the TUI repaints while a turn
 * runs), or, with `backgroundWork`, while its report is younger than `BACKGROUND_WORK_STALE_MS`.
 * Past both it reads as `idle`, so a turn end that never arrived (an interrupt, a report lost while
 * Tower was down) behaves as today's silence rule would (SC6). A `null` or absent state is `null`.
 */
function classifyServedState(
  agentState: ServedAgentState | null | undefined,
  lastDataAt: string | null | undefined,
  now: number,
): AgentAttentionState | null {
  if (!agentState) { return null; }
  if (agentState.state !== 'working') { return agentState.state; }
  if (!olderThan(lastDataAt, IDLE_WAITING_THRESHOLD_MS, now)) { return 'working'; }
  if (agentState.backgroundWork && agentState.activityAt && !olderThan(agentState.activityAt, BACKGROUND_WORK_STALE_MS, now)) {
    return 'working';
  }
  return 'idle';
}

/** True when the builder's lane is finished: it never counts as waiting or dead (SC14). */
function isFinished(b: OverviewBuilder): boolean {
  return b.phase === 'complete' || b.phase === 'verified';
}

/**
 * Spec 1595: the single attention classifier over a builder's served state. Returns `null` for a
 * complete or verified builder, and for a builder Tower serves no state for (unknown: the caller
 * falls back to the PTY-silence rule). Otherwise the served state, with a stale `working` read as
 * `idle`. A served `blocked` is returned so callers can keep it on their existing gate path.
 */
export function agentAttentionState(b: OverviewBuilder, now: number = Date.now()): AgentAttentionState | null {
  if (isFinished(b)) { return null; }
  return classifyServedState(b.agentState, b.lastDataAt, now);
}

/**
 * True iff the builder is waiting on a human: its served state is `needs-input`, `idle` or `dead`
 * (a stale `working` reads as `idle`). With no served state, the PTY-silence rule: silent past
 * `IDLE_WAITING_THRESHOLD_MS` while still able to make progress (not blocked at a gate, not
 * completed/verified, and Tower has a `lastDataAt` timestamp for it).
 *
 * Canonical predicate for the third "needs me" state alongside `blocked`.
 * UI surfaces should call this rather than reimplementing the threshold
 * check.
 */
export function isIdleWaiting(b: OverviewBuilder, now: number = Date.now()): boolean {
  if (isFinished(b)) { return false; }
  // A porch gate is the human's move on the gate path, whatever the served state says.
  if (b.blocked) { return false; }
  const state = agentAttentionState(b, now);
  if (state !== null) { return isWaitingState(state); }
  if (!b.lastDataAt) { return false; }
  return now - new Date(b.lastDataAt).getTime() > IDLE_WAITING_THRESHOLD_MS;
}

/**
 * Spec 1595: the phrase every surface shows for what a `needs-input` agent is waiting on, so the
 * extension and the dashboard word it identically: `at a permission prompt: <tool> <summary>`,
 * `asking a question`, or `needs input` when the detail is absent or of another kind. The tool and
 * summary are copied verbatim; callers render the result as plain text, never as markup (SC19).
 */
export function describeNeedsInput(detail: NeedsInputDetail | undefined): string {
  if (detail === undefined) { return 'needs input'; }
  if (detail.kind === 'question') { return 'asking a question'; }
  if (detail.kind !== 'permission') { return 'needs input'; }
  const subject = [detail.tool, detail.summary].filter((part): part is string => !!part).join(' ');
  if (subject === '') { return 'at a permission prompt'; }
  return `at a permission prompt: ${subject}`;
}

/** The classifier states that mean "the human's move". */
function isWaitingState(state: AgentAttentionState): state is 'needs-input' | 'idle' | 'dead' {
  return state === 'needs-input' || state === 'idle' || state === 'dead';
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
  /** Canonical porch gate id (e.g. `plan-approval`; `pr` for a pending PR) — the key a UI maps to
   *  an icon. `null` when Tower reported a blocked label without its gate id. Optional so existing
   *  code constructing a `GateItem` keeps compiling; `deriveAttention` always sets it. */
  gateId?: string | null;
  /** ISO timestamp the builder became blocked, when known (`null` for the PR-ready signal). */
  since: string | null;
}

/** A builder waiting on a human (`isIdleWaiting`): at a prompt, idle, dead, or silent past the threshold. */
export interface WaitingItem extends AttentionBuilderRef {
  /** Spec 1595: what the builder is waiting in, when Tower served a state. Absent when the item
   *  comes from the PTY-silence fallback. */
  state?: 'needs-input' | 'idle' | 'dead';
  /** ISO timestamp the wait began, for an age display: the served state's `since` for a served
   *  needs-input, idle or dead; otherwise the builder's last output (`lastDataAt`). */
  since: string | null;
}

/** Spec 1595: an architect waiting on a human, at a prompt or with its agent dead. An idle
 *  architect is its normal resting state and is never listed. */
export interface ArchitectAttentionItem {
  /** The architect's name (`ArchitectState.name`). */
  architect: string;
  state: 'needs-input' | 'dead';
  /** ISO time the served state began. */
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
  /** Builders waiting on a human (not already shown as a gate). */
  waiting: WaitingItem[];
  /** Spec 1595: architects at a prompt or with their agent dead. Counts in the waiting bucket. */
  architects: ArchitectAttentionItem[];
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
    architects: [],
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
    // can present either, so both are checked independently. A lane parked at the porch `pr` gate
    // with its PR open presents both for the same gate (#1787): keep only the porch row, which
    // carries `since`. A different porch gate plus `prReady` is a real two-row case.
    const atGate = builder.blocked !== null || builder.prReady;
    if (builder.blocked !== null) {
      pendingGates.push({ ...ref, gate: builder.blocked, gateId: builder.blockedGate ?? null, since: builder.blockedSince });
    }
    const porchRowCoversPr = builder.blocked !== null && builder.blockedGate === 'pr';
    if (builder.prReady && !porchRowCoversPr) {
      pendingGates.push({ ...ref, gate: 'PR review', gateId: 'pr', since: null });
    }

    const item = waitingItem(builder, ref, atGate, now);
    if (item !== null) {
      waiting.push(item);
    }

    if (builder.heldCount !== undefined && builder.heldCount > 0) {
      heldMail.push({ ...ref, count: builder.heldCount });
    }

    const queued = data.queuedFeedback[builder.id] ?? 0;
    if (queued > 0) {
      queuedFeedback.push({ ...ref, count: queued });
    }
  }

  const architects = architectItems(data.architects ?? [], now);

  const heldTotal = data.heldCount;
  const isEmpty =
    pendingGates.length === 0 &&
    waiting.length === 0 &&
    architects.length === 0 &&
    heldMail.length === 0 &&
    queuedFeedback.length === 0 &&
    heldTotal === 0;

  return {
    pendingGates,
    waiting,
    architects,
    heldTotal,
    heldEscalated: data.mailboxEscalated,
    heldMail,
    queuedFeedback,
    isEmpty,
  };
}

/**
 * The waiting row for one builder, or `null`. Waiting is the canonical "needs me" state alongside
 * `blocked`, listed only when the builder is not already shown as that same ask:
 * - At a porch gate (`blocked`), the gate row covers it: the human's move either way.
 * - With only `prReady`, a served `needs-input` or `dead` is a different ask from the PR review and
 *   is listed; an idle agent whose PR waits on a reviewer is expected and is not (nor is today's
 *   PTY-silence wait).
 */
function waitingItem(builder: OverviewBuilder, ref: AttentionBuilderRef, atGate: boolean, now: number): WaitingItem | null {
  if (builder.blocked !== null) { return null; }
  const state = agentAttentionState(builder, now);
  if (state === null) {
    if (atGate || !isIdleWaiting(builder, now)) { return null; }
    return { ...ref, since: builder.lastDataAt };
  }
  if (!isWaitingState(state)) { return null; }
  if (atGate && state === 'idle') { return null; }
  // A stale `working` reads as idle; its wait began at the last output, not when `working` began.
  let since: string | null = builder.lastDataAt;
  if (builder.agentState && builder.agentState.state === state) { since = builder.agentState.since; }
  return { ...ref, state, since };
}

/** Architects at a prompt or with their agent dead, in `OverviewData.architects` order. */
function architectItems(architects: ReadonlyArray<ArchitectState>, now: number): ArchitectAttentionItem[] {
  const items: ArchitectAttentionItem[] = [];
  for (const architect of architects) {
    const state = classifyServedState(architect.agentState, architect.lastDataAt, now);
    if (state === 'needs-input' || state === 'dead') {
      items.push({ architect: architect.name, state, since: architect.agentState?.since ?? null });
    }
  }
  return items;
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
 *    order **pending-gate → idle-waiting → held-mail → queued-feedback → quiet**. Waiting builders
 *    and waiting architects share the idle-waiting bucket. A summary with both
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
    case 1: // idle-waiting — oldest wait first, across builders and architects
      return ascending(oldestWait(a), oldestWait(b));
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
  if (s.waiting.length > 0 || s.architects.length > 0) { return 1; }
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

/** Earliest `since` (ms) across a summary's waiting builders and architects. */
function oldestWait(s: AttentionSummary): number {
  return Math.min(oldestSince(s.waiting), oldestSince(s.architects));
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

/**
 * The canonical compact relative age for an attention timestamp: `"just now"` under a minute, then
 * `"6m"` / `"2h"` / `"3d"`. Returns `null` when the timestamp is absent, unparseable, or in the
 * future, so each client decides how to render its absence. Lives here (not per-client) so every
 * attention surface — the VS Code Tower tree and the contextual panel today, the dashboard /
 * Stream Deck tomorrow — shows the same age for the same event rather than one saying `"just now"`
 * and another `"0m"`. Pure: reads only its arguments.
 */
export function formatAge(iso: string | null, now: number = Date.now()): string | null {
  if (iso === null) { return null; }
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) { return null; }
  const ms = now - then;
  if (ms < 0) { return null; }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) { return 'just now'; }
  if (minutes < 60) { return `${minutes}m`; }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) { return `${hours}h`; }
  return `${Math.floor(hours / 24)}d`;
}
