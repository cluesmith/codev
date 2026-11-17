/**
 * Pure, vscode-free helpers backing a builder row's label and icon in the
 * Builders tree (`builders.ts`). Kept here (no `vscode` import) so the
 * legibility logic can be unit-tested under the vitest `__tests__/` harness
 * instead of the heavier Electron `src/test/` one — mirroring `backlog-filter.ts`.
 */

import type { OverviewBuilder } from '@cluesmith/codev-types';
import { agentAttentionState, describeNeedsInput, isIdleWaiting } from '@cluesmith/codev-sdk/builder-helpers';
import { issueRef } from '../issue-id.js';

/**
 * Blocked-gate → codicon name. Keyed off the CANONICAL gate name
 * (`OverviewBuilder.blockedGate`, e.g. `"plan-approval"`), NOT the
 * human-readable `blocked` label (e.g. `"plan review"`) — those are distinct
 * strings (see `detectBlocked` vs `detectBlockedGate` in
 * `packages/codev/src/agent-farm/servers/overview.ts`). Keying off the label
 * would never match and every blocked row would fall through to `bell`.
 *
 * Color is applied by the caller and stays uniform warning-yellow across all
 * gates — the shape encodes WHAT kind of review is needed, the color stays the
 * constant "needs your attention" signal.
 *
 * To add a new gate: add one entry here, keeping the key in sync with
 * `GATE_LABELS` in `overview.ts` (the bundled protocols' gate names; Tower
 * reports any pending gate, listed or not, since #1777). Unknown / future
 * gates fall back to `bell` so new protocols never render without an icon.
 */
const GATE_ICONS: Record<string, string> = {
  'spec-approval': 'book',
  'plan-approval': 'checklist',
  'dev-approval': 'code',
  'pr': 'git-pull-request',
  'verify-approval': 'verified',
  'experiment-complete': 'beaker',
  'maintain-complete': 'tools',
  'scope-approval': 'search',
  'research-complete': 'library',
};

/** Codicon name for a blocked builder's gate, with a `bell` fallback. */
export function gateIconFor(blockedGate: string | null): string {
  return (blockedGate && GATE_ICONS[blockedGate]) || 'bell';
}

/**
 * Roll up a Builders area-group's members into `{ blocked, idle, active }`
 * counts (#926). Uses the SAME per-builder classification as the row icon in
 * `builders.ts` (`classifyBuilderRow`): blocked takes precedence over the
 * waiting family (needs-input, idle and dead all count as `idle` here), which
 * takes precedence over active — so the header's worst-of severity always
 * tracks the rows beneath it.
 *
 * The header subclass (`BuilderGroupTreeItem`) turns this into the worst-of icon
 * (blocked → `bell`, else idle → `comment-discussion`, else `circle-filled`) and
 * a `"<b> blocked · <i> waiting · <a> active"` tooltip. Note the blocked header
 * uses a GENERIC `bell`, not `gateIconFor` of any one member: a group can hold
 * builders at different gates, so a single gate shape on the header would
 * misrepresent the group — the yellow color carries the group-level signal.
 *
 * Pure / vscode-free so it's unit-tested under the vitest `__tests__/` harness.
 */
export function rollupGroupState(builders: OverviewBuilder[], now: number): GroupRollup {
  let blocked = 0;
  let idle = 0;
  let active = 0;
  for (const b of builders) {
    const state = classifyBuilderRow(b, now);
    if (state === 'blocked') {
      blocked++;
    } else if (state === 'active') {
      active++;
    } else {
      idle++;
    }
  }
  return { blocked, idle, active };
}

export interface GroupRollup {
  blocked: number;
  idle: number;
  active: number;
}

/**
 * A builder row's state. `blocked`, `idle` and `active` are also the group
 * header's three rollup states; a row further splits the waiting family into
 * `needs-input` (at a permission prompt or a question), `idle` (turn ended, or
 * silent past the threshold when Tower serves no state) and `dead` (the agent
 * process is gone), Spec 1595.
 */
export type BuilderState = 'blocked' | 'needs-input' | 'idle' | 'dead' | 'active';

/**
 * Classify one builder row through the shared sdk classifier: a porch gate
 * (`b.blocked`) first, then the served agent state (a stale `working` reads as
 * idle), then, when Tower serves no state, the PTY-silence predicate.
 */
export function classifyBuilderRow(b: OverviewBuilder, now: number): BuilderState {
  if (b.blocked) { return 'blocked'; }
  const served = agentAttentionState(b, now);
  if (served === 'needs-input' || served === 'idle' || served === 'dead' || served === 'blocked') { return served; }
  if (served === null && isIdleWaiting(b, now)) { return 'idle'; }
  return 'active';
}

/**
 * Single source of truth for the builder-state glyphs (codicon name +
 * theme color token), shared by the builder ROW (`builders.ts`) and the
 * area-group header rollup (`builder-tree-item.ts`) so the vocabulary is
 * defined once. Strings only — no vscode `ThemeIcon`/`ThemeColor` — so this
 * module stays vscode-free and unit-testable; call sites wrap them.
 *
 * NOTE: a blocked ROW overrides `icon` with the gate-specific `gateIconFor`
 * shape (keeping `color`); the generic `bell` here is the group HEADER's
 * blocked glyph and the row's unmapped-gate fallback. The header only ever
 * shows `blocked`, `idle` or `active`.
 */
export const BUILDER_STATE_GLYPH: Record<BuilderState, { icon: string; color: string }> = {
  blocked: { icon: 'bell', color: 'notificationsWarningIcon.foreground' },
  'needs-input': { icon: 'question', color: 'notificationsWarningIcon.foreground' },
  idle: { icon: 'comment-discussion', color: 'notificationsInfoIcon.foreground' },
  dead: { icon: 'debug-disconnect', color: 'notificationsErrorIcon.foreground' },
  active: { icon: 'circle-filled', color: 'testing.iconPassed' },
};

/**
 * The worst (most severe) state present in a group's rollup: blocked beats
 * idle beats active. Drives the header's worst-of icon without a nested
 * ternary at the call site.
 */
export function worstBuilderState(rollup: GroupRollup): BuilderState {
  if (rollup.blocked > 0) { return 'blocked'; }
  if (rollup.idle > 0) { return 'idle'; }
  return 'active';
}

/**
 * Compact elapsed-time label (`<1m`, `42m`, `3h`, `2d`) from `isoDate` to
 * `now`. `now` is passed in (not read from `Date.now()`) so callers and tests
 * compute deterministically.
 */
export function timeSince(isoDate: string, now: number): string {
  const ms = now - new Date(isoDate).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) { return '<1m'; }
  if (minutes < 60) { return `${minutes}m`; }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) { return `${hours}h`; }
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The ISO time a waiting row's wait began, for its `[elapsed]` badge: the
 * served state's `since` when the served state is the row's state, else the
 * last output (`lastDataAt`), which also covers a stale `working` read as idle.
 */
function waitSince(b: OverviewBuilder, state: BuilderState): string | null {
  if (b.agentState && b.agentState.state === state) { return b.agentState.since; }
  return b.lastDataAt;
}

/** True when the row's idle comes from a served turn end, not from PTY silence. */
function isServedIdle(b: OverviewBuilder): boolean {
  return !!b.agentState && b.agentState.state === 'idle';
}

/**
 * The plain-text phrase for a row's state, shared by its label and tooltip:
 * empty for an active row, `blocked on <label>` for a gate. Never Markdown: the
 * needs-input detail is reporter-built text and is shown verbatim (SC19).
 */
function stateText(b: OverviewBuilder, state: BuilderState): string {
  if (state === 'blocked') { return `blocked on ${b.blocked ?? 'a gate'}`; }
  if (state === 'needs-input') { return describeNeedsInput(b.agentState?.needsInput); }
  if (state === 'dead') { return 'agent exited'; }
  if (state === 'idle' && isServedIdle(b)) { return 'turn ended'; }
  if (state === 'idle') { return 'waiting on input'; }
  return '';
}

/**
 * The builder row's label: `<prefix>#<id> <title><stateLabel>`.
 *
 * `prefix` is supplied by the active grouping strategy (`BuilderGrouping.rowPrefix`,
 * #952) — it carries whichever axis is NOT the group header (area when grouping by
 * stage, phase when grouping by area), already bracketed with a trailing space (or
 * `''` when omitted). Keeping prefix selection in the strategy lets this helper stay
 * a pure formatter that knows nothing about the grouping axis.
 *
 * The state-dispatched suffix carries the wait's duration:
 *  - blocked:     ` blocked on <label> [<elapsed>]`
 *  - needs-input: ` at a permission prompt: <tool> <summary> [<elapsed>]` or ` asking a question [<elapsed>]`
 *  - idle:        ` turn ended [<elapsed>]`, or ` waiting on input [<elapsed> silent]` from PTY silence
 *  - dead:        ` agent exited [<elapsed>]`
 *  - active:      (empty)
 *
 * `state` is injected by the caller (which already computes it via
 * `classifyBuilderRow` for the icon + contextValue dispatch) rather than
 * recomputed here — keeps this helper pure and unit-testable without a build step.
 */
export function builderRowLabel(
  b: OverviewBuilder,
  state: BuilderState,
  now: number,
  prefix: string,
): string {
  const title = `${prefix}${issueRef(b.issueId ?? b.id)} ${b.issueTitle ?? ''}`;
  if (state === 'active') { return title; }
  let since = waitSince(b, state);
  if (state === 'blocked') { since = b.blockedSince; }
  let elapsed = '';
  if (since && state === 'idle' && !isServedIdle(b)) {
    elapsed = ` [${timeSince(since, now)} silent]`;
  } else if (since) {
    elapsed = ` [${timeSince(since, now)}]`;
  }
  return `${title} ${stateText(b, state)}${elapsed}`;
}

/**
 * The builder row's tooltip, a plain string (never a `MarkdownString`, so a
 * needs-input summary carrying Markdown or a `command:` link renders
 * literally, SC19): the protocol line, then the state phrase when the row is
 * not active.
 */
export function builderRowTooltip(b: OverviewBuilder, state: BuilderState): string {
  const base = `Protocol: ${b.protocol} | Mode: ${b.mode} | Progress: ${b.progress}%`;
  const text = stateText(b, state);
  if (text === '') { return base; }
  return `${base}\n${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
