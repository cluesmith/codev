/**
 * Pure, vscode-free helpers backing a builder row's label and icon in the
 * Builders tree (`builders.ts`). Kept here (no `vscode` import) so the
 * legibility logic can be unit-tested under the vitest `__tests__/` harness
 * instead of the heavier Electron `src/test/` one — mirroring `backlog-filter.ts`.
 */

import type { OverviewBuilder } from '@cluesmith/codev-types';

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
 * The builder row's label. The phase leads the label, before the issue number
 * (`[<phase>] #<id> <title>`), so it sits at a FIXED offset right after the
 * row's icon — letting the eye scan the phase column straight down the tree
 * (issue ids vary in width, so an id-first order would make the phase bracket
 * jiggle row-to-row). It also survives end-truncation in a narrow sidebar and
 * shows across all three states — unlike the old trailing `[<phase>]` suffix
 * that only active rows carried and long titles clipped.
 *
 * The state-dispatched suffix is preserved for blocked/idle duration:
 *  - blocked: ` blocked on <label> [<elapsed>]`
 *  - idle:    ` waiting on input [<elapsed> silent]`
 *  - active:  (empty — the phase prefix already covers it)
 *
 * The prefix uses the coarse `protocolPhase` (`plan` / `implement` / `review`),
 * NOT the collapsed `phase` field — `phase` prefers free-form plan sub-phase
 * ids (e.g. `phase_0_rebase_onto_ci`) which are too low-level for the row.
 * Empty `protocolPhase` (rare transient init state) omits the prefix entirely —
 * the row reads `#<id> <title>` rather than carrying a literal `[] `.
 *
 * `isIdle` is injected by the caller (which already computes it via
 * `isIdleWaiting` for the icon + contextValue dispatch) rather than recomputed
 * here — keeps this helper pure (no `@cluesmith/codev-core` runtime import) and
 * unit-testable without a build step.
 */
export function builderRowLabel(b: OverviewBuilder, isIdle: boolean, now: number): string {
  const isBlocked = !!b.blocked;
  const waitTime = isBlocked && b.blockedSince ? ` [${timeSince(b.blockedSince, now)}]` : '';
  const idleTime = isIdle && b.lastDataAt ? ` [${timeSince(b.lastDataAt, now)} silent]` : '';
  const stateLabel = isBlocked
    ? ` blocked on ${b.blocked}${waitTime}`
    : isIdle
    ? ` waiting on input${idleTime}`
    : '';
  const phasePrefix = b.protocolPhase ? `[${b.protocolPhase}] ` : '';
  return `${phasePrefix}#${b.issueId ?? b.id} ${b.issueTitle ?? ''}${stateLabel}`;
}
