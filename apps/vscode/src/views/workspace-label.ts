/**
 * Disambiguating display labels for the Tower workspace list.
 *
 * `TowerWorkspace.name` is a raw `path.basename`, so two active checkouts with the same basename —
 * the live case of `~/cluesmith/codev` and `~/amrmelsayed/codev` (#1565) — both read as "codev".
 * This helper renders a **minimal distinguishing path tail** (e.g. `cluesmith/codev` vs
 * `amrmelsayed/codev`) for colliding names only; a unique basename stays plain. The Tower tree and
 * the switch quick-pick both consume it so the two surfaces label a workspace identically.
 *
 * Pure and host-free (no `vscode`/`node` imports) so it unit-tests without a mock.
 */

/** The minimal shape a labelled row needs: its unique path and its raw basename. */
export interface LabelledWorkspace {
  path: string;
  name: string;
}

/**
 * Map each workspace path to its display label. Unique basenames map to the plain `name`; a set of
 * workspaces sharing a basename all map to the shortest trailing path segments that tell them apart.
 * The depth is chosen per collision group and applied uniformly within it, so colliding rows line up
 * (`cluesmith/codev`, `amrmelsayed/codev`) rather than each trimming to a different length.
 */
export function disambiguateLabels(workspaces: ReadonlyArray<LabelledWorkspace>): Map<string, string> {
  const byName = new Map<string, LabelledWorkspace[]>();
  for (const ws of workspaces) {
    const group = byName.get(ws.name);
    if (group) { group.push(ws); }
    else { byName.set(ws.name, [ws]); }
  }

  const labels = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length === 1) {
      labels.set(group[0].path, group[0].name);
      continue;
    }
    const depth = distinguishingDepth(group.map((ws) => segments(ws.path)));
    for (const ws of group) {
      labels.set(ws.path, pathTail(segments(ws.path), depth));
    }
  }
  return labels;
}

/** Split a path into non-empty segments, tolerating POSIX (`/`) and Windows (`\`) separators. */
function segments(path: string): string[] {
  return path.split(/[/\\]/).filter((s) => s.length > 0);
}

/**
 * The smallest tail length (>= 2) at which every path in the group is distinct. Paths are unique
 * keys, so a distinguishing depth always exists; the fallback is the longest path's full length.
 */
function distinguishingDepth(paths: ReadonlyArray<string[]>): number {
  const maxLen = Math.max(...paths.map((p) => p.length));
  for (let depth = 2; depth < maxLen; depth++) {
    const tails = new Set(paths.map((p) => pathTail(p, depth)));
    if (tails.size === paths.length) { return depth; }
  }
  return maxLen;
}

/** The last `depth` segments joined by `/` (always `/`, for a stable cross-platform label). */
function pathTail(segs: ReadonlyArray<string>, depth: number): string {
  return segs.slice(Math.max(0, segs.length - depth)).join('/');
}
