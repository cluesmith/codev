/**
 * Shared row-builder for the two builder Quick Pick pickers that need both
 * the overview display fields (issue # + title) and a `getWorkspaceState`-only
 * runtime field — Open Builder Terminal (needs `terminalId`) and Send Message
 * (needs the canonical `Builder.id`). (Issue #925)
 *
 * The seven other builder pickers source rows from `client.getOverview`
 * (`OverviewBuilder`, which carries `issueId`/`issueTitle`/`phase`). These two
 * historically sourced from `client.getWorkspaceState` (`Builder`, which has
 * `terminalId`/`name` but NO `issueId`/`issueTitle`) and so rendered the bare
 * internal name. Neither endpoint alone has every field, so — mirroring
 * `run-worktree-dev.ts` — we take the overview as the display source and join
 * each row back to its workspace `Builder` via `resolveAgentName` (the two id
 * shapes differ, e.g. `pir-925` vs `builder-pir-925`, so a tail-match join is
 * required rather than strict `===`).
 *
 * Pure and dependency-light so it can be unit-tested without a live Tower,
 * following the `prune-builder-terminals.ts` precedent.
 */

import { resolveAgentName } from '@cluesmith/codev-sdk/agent-names';

/** Minimal shape of an `OverviewBuilder` row needs for display. */
export interface OverviewBuilderRow {
  id: string;
  issueId: string | null;
  issueTitle: string | null;
  phase: string;
}

/** Minimal shape of a `getWorkspaceState` `Builder` the action path needs. */
export interface WorkspaceBuilderRow {
  id: string;
  name: string;
  terminalId?: string;
}

/** A formatted Quick Pick row ready for `vscode.window.showQuickPick`. */
export interface BuilderPickRow {
  /** `#<issueId|id> <issueTitle>` — identical format to the seven correct pickers. */
  label: string;
  /** The builder's phase, shown in the picker description (matches Cleanup Builder). */
  description: string;
  /** Canonical workspace `Builder.id` — load-bearing for the downstream action. */
  id: string;
  /** Workspace `Builder.name` — used for the terminal tab title, unchanged from before. */
  name: string;
  /** Workspace `Builder.terminalId` — present only for builders with a live terminal. */
  terminalId?: string;
}

/**
 * Pair each overview builder with its workspace `Builder` (via `resolveAgentName`),
 * keep only those that resolve to a builder with a live terminal, and format the
 * Quick Pick row. The terminal filter preserves the outliers' original
 * `state.builders.filter(b => b.terminalId)` "only active builders" semantics.
 */
export function buildBuilderPickRows(
  overviewBuilders: OverviewBuilderRow[],
  workspaceBuilders: WorkspaceBuilderRow[],
): BuilderPickRow[] {
  const rows: BuilderPickRow[] = [];
  for (const ob of overviewBuilders) {
    const { builder: wb } = resolveAgentName(ob.id, workspaceBuilders);
    if (!wb?.terminalId) { continue; }
    rows.push({
      label: `#${ob.issueId ?? ob.id} ${ob.issueTitle ?? ''}`,
      description: ob.phase,
      id: wb.id,
      name: wb.name,
      terminalId: wb.terminalId,
    });
  }
  return rows;
}
