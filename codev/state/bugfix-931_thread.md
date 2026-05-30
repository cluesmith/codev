# bugfix-931 — dashboard: gateKindClass missing 'dev review' case

Issue #931 (cosmetic, dashboard-only). Deferred from #927.

## Investigate (2026-05-29)

Confirmed the bug by reading the code path. Three relevant files:

1. **`packages/codev/src/agent-farm/servers/overview.ts:421`** — `GATE_LABELS` maps
   `dev-approval → 'dev review'`. This is the human-facing label that `detectBlocked`
   stamps onto `OverviewBuilder.blocked` for a PIR builder paused at its `dev-approval` gate.

2. **`packages/dashboard/src/components/NeedsAttentionList.tsx:23-32`** — `gateKindClass`
   switches on that label to pick a CSS class. Cases present: `spec review`, `plan review`,
   `code review`, `PR review`, `verify review`. **No `case 'dev review'`** → falls through
   to `default: 'attention-kind--plan'`. So a PIR dev-approval gate row renders with the
   **plan** color, not its own.

   Also: `case 'code review'` is **dead** — no `GATE_LABELS` value is `'code review'`
   (verified by grep). Its only references are this case + the `.attention-kind--code-review`
   CSS rule + one stale comment. The issue flags it as optional-to-remove.

3. **`packages/dashboard/src/index.css:1377-1397`** — CSS rules for `--pr/--spec/--plan/
   --code-review/--verify`. **No `.attention-kind--dev`.**

VSCode handles `dev review` independently (gate-toast.ts), so the dashboard `gateKindClass`
is the only consumer missing it.

## Fix plan
- Add `case 'dev review': return 'attention-kind--dev';` to `gateKindClass`.
- Remove the dead `case 'code review'` (and its orphaned `.attention-kind--code-review` CSS
  rule + fix the stale comment that references "code review").
- Add `.attention-kind--dev` to `index.css`. dev-approval is a **pre-PR** human gate (PIR),
  so group it with the urgent pre-PR error gates (spec/plan) → `var(--status-error)`,
  not the review-style waits (PR/verify) → `var(--status-waiting)`.
- Regression test in `__tests__/NeedsAttentionList.test.tsx`: a dev-approval-pending builder
  yields `kindClass === 'attention-kind--dev'` (fails pre-fix: would be `--plan`).

## Fix (2026-05-29)

Applied all four changes above. Verified:
- `NeedsAttentionList.test.tsx`: **14/14 pass** (13 original + new `--dev` regression test).
- New test is a genuine regression guard — pre-fix it asserts `--dev` while the code returned
  the `--plan` fallback.
- `tsc --noEmit -p tsconfig.app.json`: clean (exit 0).
- Full dashboard suite after building `@cluesmith/codev-core`: **30/31 files, 315 pass, 1 skip,
  1 fail**.

### Environment note (not a code issue)
Fresh worktree had no `node_modules` and `@cluesmith/codev-core` was unbuilt. The first full
suite run showed 12 files with `(0 test)` — all `Failed to resolve import
"@cluesmith/codev-core/<subpath>"` (Terminal.*, BuilderCard, VirtualKeyboard, escapeBuffer,
architect-toolbar). Ran `pnpm install` + `pnpm --filter "...@cluesmith/codev-core" build` and
all 12 cleared. Pure setup gap, unrelated to #931.

### Pre-existing unrelated failure (flagged to architect, NOT fixed — out of scope)
`__tests__/scrollController.test.ts > ... > warns on unexpected scroll-to-top (Issue #630)`
fails **consistently** (3/3 runs), 1 test. It concerns terminal scroll-to-top warning behavior
and imports nothing from the attention-row path. Not flaky, not caused by #931. Per BUGFIX
protocol (unrelated test failures are out of scope) I am leaving it untouched and surfacing it
to the architect rather than modifying an unrelated test file.

## PR + CMAP (2026-05-29)

Opened **PR #935**. First 3-way CMAP (`--type pr`):
- **Claude**: APPROVE (HIGH) — full review with worktree file access.
- **Codex**: REQUEST_CHANGES (HIGH) — *valid, substantive*: I'd set `.attention-kind--dev`
  to `var(--status-error)`, the SAME color as `.attention-kind--plan`. So renaming the class
  left dev rows visually identical to plan rows — the user-visible symptom of #931 ("renders
  with the plan color instead of their own") was NOT resolved by the rename alone.
- **Gemini**: blind APPROVE — could not read the diff (`Path not in workspace`: consult wrote
  the diff to `/tmp/...`, outside Gemini's sandbox `~/.gemini/tmp/bugfix-931`). Known consult/
  Gemini lane environmental bug, not a real review. Flagging to architect.

**Resolution (commit 8c666c2):** changed `.attention-kind--dev` to `var(--status-implementing)`
(orange). Rationale: dev-approval is PIR's gate at the END of the implement phase, so the orange
"implementing" palette color is semantically apt AND makes dev rows visually distinct — a 3-tier
design(red spec/plan) → implement(orange dev) → review(yellow PR/verify) progression. This
directly resolves Codex's finding. Strengthened the regression test to also assert dev never
maps to the plan class. Re-running the 3-way CMAP to confirm Codex flips to APPROVE.
