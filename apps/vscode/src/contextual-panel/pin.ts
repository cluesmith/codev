/**
 * PURE pin of the active surface to one builder (#1809).
 *
 * A builder-worktree window attaches read-only to the PARENT workspace, so the palette can still open
 * a sibling builder's diff or terminal there (read-only viewing). The panel must not become an action
 * path onto that sibling: in such a window it is pinned to the worktree's own builder. Builder diff /
 * builder terminal signals for any OTHER builder are dropped before mode resolution, so Code Review and
 * Builder Inspector (and their Submit / Discard / Re-send / Mark Delivered buttons) only ever show the
 * own builder. The artifact signal is untouched: Document Review carries no queue actions.
 *
 * No `vscode` / `node:` imports, so it is unit-testable without a host.
 */

import { resolveAgentName } from '@cluesmith/codev-sdk/agent-names';
import type { SurfaceContext } from './types.js';

export function pinSurfaceToBuilder(surface: SurfaceContext, ownBuilderId: string): SurfaceContext {
  const pinned: SurfaceContext = {};
  if (surface.artifact !== undefined) {
    pinned.artifact = surface.artifact;
  }
  // The diff-inject registry keys diffs by the overview builder id, which for a worktree is its
  // `.builders/<id>` directory name — the same id the window's path yields, so compare directly.
  if (surface.builderDiff !== undefined && surface.builderDiff.builderId === ownBuilderId) {
    pinned.builderDiff = surface.builderDiff;
  }
  // A builder terminal carries the Tower-canonical terminal id (e.g. `builder-pir-42`), a different id
  // space: tail-match it against the own id, never `===`.
  if (surface.builderTerminal !== undefined
    && resolveAgentName(ownBuilderId, [{ id: surface.builderTerminal.builderId }]).builder !== null) {
    pinned.builderTerminal = surface.builderTerminal;
  }
  return pinned;
}
