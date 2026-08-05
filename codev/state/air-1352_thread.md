# air-1352 thread — packages/codev build doesn't build its workspace deps

## 2026-08-05 Implement phase

Verified the issue's claims against source:
- `packages/codev` build script: `pnpm clean && tsc && pnpm build:dashboard && pnpm copy-skeleton`. Never builds workspace deps.
- Root chain hand-lists types, sdk, core, artifact-canvas, codev. Confirmed drift: `pnpm --filter "@cluesmith/codev^..." list --depth -1` resolves to types, sdk, core, and codev-web (apps/web). artifact-canvas is NOT in the closure; apps/web IS (devDependency).
- artifact-canvas has zero workspace deps and is consumed by apps/vscode. Root builds it for the extension dev flow, so it stays as an explicit root entry (a deliberate extra, not dep-closure drift).
- `build:dashboard` is referenced only by codev's own `build`. apps/web's package build (`tsc -b && vite build`) is exactly what build:dashboard ran via `cd ../../apps/web && pnpm build`.

Plan (per architect guidance: fix A + D, project references out of scope):
- codev build gets a graph-derived prefix: `pnpm --filter "@cluesmith/codev^..." build`. Since the closure now builds apps/web, `build:dashboard` collapses to a copy-only step (`copy-dashboard`), avoiding a double vite build.
- Root chain: check-main-fresh + artifact-canvas + codev (codev now self-sufficient).
- Docs: CLAUDE.md/AGENTS.md line 66 (Local Build Testing) and line 320 (Directory Map), kept byte-identical. Existing governance-sweep test enforces identity.
- check-main-fresh.sh is a no-op off main, so builder-branch root builds are safe.

Acceptance: clean-tree (rm -rf packages/*/dist apps/web/dist) builds succeed from filter, from packages/codev, and from root.

## Implement complete

- All three clean-tree acceptance builds passed: `pnpm --filter @cluesmith/codev build` from root, `pnpm build` from packages/codev, root `pnpm build` (check-main-fresh is a no-op off main).
- Added `packages/codev/src/__tests__/build-scripts.test.ts`: asserts the closure prefix on codev's build and that the root script no longer hand-lists codev's workspace deps. governance-sweep byte-identity test covers the CLAUDE.md/AGENTS.md edits.
- `porch check 1352`: build + tests green. Moving to PR phase.

## PR gate

- PR #1355 created with the review embedded in the body (AIR: no spec/plan/review files). Follow-up noted in the PR body: TypeScript project references for the stale-dist case, out of scope per architect guidance.
- PR-phase checks green (pr_exists, e2e_tests). `porch gate 1352` requested; architect notified via afx send. Waiting for human approval of the pr gate.

## AIR consult at PR (architect-requested at gate)

I had skipped the consult, reading AIR's "optional" clause as builder discretion; the architect corrected this at the gate. First attempt failed on project auto-detection ("Multiple projects found", no verdicts produced); re-ran with `--issue 1352`.

- gemini: APPROVE (HIGH). No issues.
- codex: APPROVE (HIGH). No issues.
- claude: REQUEST_CHANGES (HIGH). Two stale build-wiring lines in `codev/resources/arch.md` (819: `build:dashboard` reference; 1143: the deleted hand-list build order plus stale types-first rationale). Non-blocking notes: CI workflows still hand-build sdk/core before codev (redundant but harmless, and test.yml's dep builds feed their own unit-test steps, so not blindly deletable); root guard test is absence-only.

Dispositions:
- arch.md 819 + 1143: FIXED in-branch (same doc-misdirection class the issue targets). Repo-wide grep: remaining `build:dashboard` mentions are historical artifacts (plans/reviews/release notes), left as history.
- CI workflow hand-builds: follow-up candidate, out of AIR scope; flagged to architect rather than expanded.
- Absence-only guard test: accepted as minor; the positive closure-prefix assertion is the load-bearing guard.
