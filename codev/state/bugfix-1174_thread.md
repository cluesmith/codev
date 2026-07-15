# bugfix-1174 — architects disappear from Agents view (architect axis) when last builder cleaned up

## Investigate (done)

**Root cause** (confirmed by reading source):
- `packages/vscode/src/views/builder-grouping.ts` `architectGrouping().group(ordered)` buckets architects only from the builders array's `spawnedByArchitect` values. A childless architect contributes no key → no group header. When the last builder is cleaned up, the architect's row vanishes.
- The architect roster is already available without a second fetch: `OverviewData.architects: ArchitectState[]` (main-first, live sessions only), populated server-side by `liveArchitects` in `packages/codev/src/agent-farm/servers/tower-routes.ts:954` and carried on the overview cache the `BuildersProvider` already holds.
- Empty-group rollup icon: `rollupGroupState([])` returns `{0,0,0}` → `worstBuilderState` falls through to `active` (green circle) — misleading. Need a neutral idle glyph.

**Fix plan** (architect axis only; stage/area unchanged):
1. `builder-grouping.ts` — `BuilderGrouping.group` gains optional `roster?: readonly string[]`; `architectGrouping` seeds an empty bucket for every roster architect so childless architects still get a header. Other axes ignore the arg.
2. `builders.ts` — pass `(data.architects ?? []).map(a => a.name)` into both `group()` call sites; render empty groups (`items.length === 0`) as leaf-like (`CollapsibleState.None`) so they still carry the click-to-open-terminal command.
3. `builder-tree-item.ts` — `BuilderGroupTreeItem` uses a neutral glyph (`circle-outline` / `disabledForeground`) when the rollup is all-zero, instead of the worst-of tri-state.
4. Tests: 0-builder architect + populated combos under architect axis; neutral icon; no change for stage/area.

## Fix (done)

Implemented all 4 points. Diff ~88 LOC across 4 files (3 src + 2 test, well under 300):
- `builder-grouping.ts`: `group(ordered, roster?)`; architectGrouping seeds empty buckets from roster.
- `builders.ts`: pass `(data.architects ?? []).map(a => a.name)` into both group() calls; empty groups → `CollapsibleState.None` (leaf-like, still carry openArchitectTerminal command).
- `builder-tree-item.ts`: all-zero rollup → `circle-outline`/`disabledForeground` neutral glyph + "No builders" tooltip.

Verification (from worktree): `pnpm vitest run` → 627 pass (53 files); `pnpm check-types` clean; `pnpm lint` clean. Had to build core/types/artifact-canvas deps first (dist-based subpath exports).

No CHANGELOG edit: that workflow lives on the separate docs/vscode-changelog branch (architect's per-PR job post-merge), not this builder branch.

Committed 2 commits (fix + tests). Next: push, open PR, CMAP.

## PR (in progress)

PR #1175 opened (Fixes #1174).

CMAP verdicts:
- Gemini: APPROVE (HIGH) — no issues
- Codex: APPROVE (MEDIUM) — no issues
- Claude: COMMENT (HIGH) — one non-blocking nit: ternary for collapsibleState → if/else per no-ternaries convention. Applied (commit 4). Re-verified check-types + lint + tests clean.

Requesting `pr` gate next; waiting for human approval before merge.
