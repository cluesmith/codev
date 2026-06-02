/**
 * Pure, vscode-free helpers backing a builder row's label and icon in the
 * Builders tree (`builders.ts`). Kept here (no `vscode` import) so the
 * legibility logic can be unit-tested under the vitest `__tests__/` harness
 * instead of the heavier Electron `src/test/` one — mirroring `backlog-filter.ts`.
 */

import type { OverviewBuilder } from '@cluesmith/codev-types';
import { isIdleWaiting } from '@cluesmith/codev-core/builder-helpers';

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
 * `GATE_LABELS` in `overview.ts` (the source of gate names). Unknown / future
 * gates fall back to `bell` so new protocols never render without an icon.
 */
const GATE_ICONS: Record<string, string> = {
  'spec-approval': 'book',
  'plan-approval': 'checklist',
  'dev-approval': 'code',
  'pr': 'git-pull-request',
  'verify-approval': 'verified',
};

/** Codicon name for a blocked builder's gate, with a `bell` fallback. */
export function gateIconFor(blockedGate: string | null): string {
  return (blockedGate && GATE_ICONS[blockedGate]) || 'bell';
}

/**
 * Roll up a Builders area-group's members into `{ blocked, idle, active }`
 * counts (#926). Uses the SAME per-builder classification as the row icon in
 * `builders.ts` — blocked (`b.blocked` truthy) takes precedence over idle
 * (`isIdleWaiting`), which takes precedence over active — so the header's
 * worst-of severity always tracks the rows beneath it.
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
    if (b.blocked) {
      blocked++;
    } else if (isIdleWaiting(b, now)) {
      idle++;
    } else {
      active++;
    }
  }
  return { blocked, idle, active };
}

export interface GroupRollup {
  blocked: number;
  idle: number;
  active: number;
}

/** The three builder states, in worst-to-best severity order. */
export type BuilderState = 'blocked' | 'idle' | 'active';

/**
 * Single source of truth for the three builder-state glyphs (codicon name +
 * theme color token), shared by the builder ROW (`builders.ts`) and the
 * area-group header rollup (`builder-tree-item.ts`) so the vocabulary is
 * defined once. Strings only — no vscode `ThemeIcon`/`ThemeColor` — so this
 * module stays vscode-free and unit-testable; call sites wrap them.
 *
 * NOTE: a blocked ROW overrides `icon` with the gate-specific `gateIconFor`
 * shape (keeping `color`); the generic `bell` here is the group HEADER's
 * blocked glyph and the row's unmapped-gate fallback.
 */
export const BUILDER_STATE_GLYPH: Record<BuilderState, { icon: string; color: string }> = {
  blocked: { icon: 'bell', color: 'notificationsWarningIcon.foreground' },
  idle: { icon: 'comment-discussion', color: 'notificationsInfoIcon.foreground' },
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
 * The builder row's label: `<prefix>#<id> <title><stateLabel>`.
 *
 * `prefix` is supplied by the active grouping strategy (`BuilderGrouping.rowPrefix`,
 * #952) — it carries whichever axis is NOT the group header (area when grouping by
 * stage, phase when grouping by area), already bracketed with a trailing space (or
 * `''` when omitted). Keeping prefix selection in the strategy lets this helper stay
 * a pure formatter that knows nothing about the grouping axis.
 *
 * The state-dispatched suffix is preserved for blocked/idle duration:
 *  - blocked: ` blocked on <label> [<elapsed>]`
 *  - idle:    ` waiting on input [<elapsed> silent]`
 *  - active:  (empty)
 *
 * `isIdle` is injected by the caller (which already computes it via
 * `isIdleWaiting` for the icon + contextValue dispatch) rather than recomputed
 * here — keeps this helper pure and unit-testable without a build step.
 */
export function builderRowLabel(
  b: OverviewBuilder,
  isIdle: boolean,
  now: number,
  prefix: string,
): string {
  const isBlocked = !!b.blocked;
  const waitTime = isBlocked && b.blockedSince ? ` [${timeSince(b.blockedSince, now)}]` : '';
  const idleTime = isIdle && b.lastDataAt ? ` [${timeSince(b.lastDataAt, now)} silent]` : '';
  const stateLabel = isBlocked
    ? ` blocked on ${b.blocked}${waitTime}`
    : isIdle
    ? ` waiting on input${idleTime}`
    : '';
  return `${prefix}#${b.issueId ?? b.id} ${b.issueTitle ?? ''}${stateLabel}`;
}
