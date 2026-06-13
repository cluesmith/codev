# Review: Foundational reusable package `@cluesmith/codev-artifact-canvas`

- **Spec**: [codev/specs/945-build-foundational-reusable-pa.md](../specs/945-build-foundational-reusable-pa.md)
- **Plan**: [codev/plans/945-build-foundational-reusable-pa.md](../plans/945-build-foundational-reusable-pa.md)
- **GitHub Issue**: [#945](https://github.com/cluesmith/codev/issues/945)

## Summary

Built `@cluesmith/codev-artifact-canvas` — a host-agnostic React library for rendering and
reviewing Codev markdown artifacts (specs/plans/reviews) across surfaces (VSCode, dashboard, future
mobile). Four implement phases delivered: a dual-format (CJS+ESM+dts) package skeleton with locked
adapter interfaces and CSS-variable theming; a sanitized markdown renderer with 0-based `data-line`
attribution; the composed `ArtifactCanvas` component (intent-only comment overlay + minimal marker
rendering + adapter-driven data flow); and a smoke-test host (automated e2e round-trip proof + Vite
dev page + README). The package ships standalone — **no host integration** (that is #859 and
follow-ups). Net: a new ~1,600-LOC workspace package, fully tested, consumed via `workspace:*`.

## Spec Compliance

- [x] AC: Single package `@cluesmith/codev-artifact-canvas` (D1) (Phase 1)
- [x] AC: Async I/O — `read`/`list` async; `watch`/`onChange` sync returning `Disposable` (D2) (Phase 1/3)
- [x] AC: Serialization-agnostic — host owns marker format; `raw` preserved for round-trip (D3) (Phase 1/3)
- [x] AC: CSS-variable theming "Model A"; `ThemeAdapter` off the v1 render path (D4) (Phase 1/3)
- [x] AC: `data-line` 0-based on block tokens (D5) (Phase 2)
- [x] AC: Comment overlay intent-only — emits `onAddComment(line)`; package never calls `MarkerAdapter.add` (D6) (Phase 3)
- [x] AC: `html:false` + DOMPurify sanitization (D7) (Phase 2)
- [x] AC: Clicking `+` (mouse or keyboard) invokes `onAddComment` with the 0-based line (Phase 3)
- [x] AC: Existing markers render; host `add` + `watch` re-list refreshes them (Phase 3/4)
- [x] AC: Disposing a subscription stops re-renders; `dispose()` twice is a no-op (Phase 3)
- [x] AC: Rejecting `read`/`watch`/`list` caught → `onError` + logged; component never throws; failed `list()` preserves prior markers (Phase 3)
- [x] AC: Out-of-range marker dropped + warned once via `console.warn` (Phase 3)
- [x] AC: Automated e2e round-trip passes (render → intent → host add → watch/re-list → marker renders), mouse + keyboard (Phase 4)
- [x] AC: `examples/` Vite page runs and exercises the flow by hand (Phase 4)
- [x] AC: README documents adapters + host example + tsup rationale (Phase 4)
- [x] AC: Full package `test` script green (Phase 4)

## Deviations from Plan

- **Phase 2**: The plan proposed proving DOMPurify via a `javascript:` link vector. markdown-it's
  `validateLink` neutralizes `javascript:` *before* DOMPurify runs, so that vector can't isolate
  DOMPurify. Switched to a `vi.spyOn(DOMPurify, 'sanitize')` assertion (proves sanitize is on the
  render path) plus an attribute-injection DOM assertion. Documented inline.
- **Phase 3**: Added an optional `refreshKey?: number | string` to the (locked) `ArtifactCanvasProps`
  — architect-authorized, purely additive (no-op default). It honors spec D6's no-watcher refresh
  contract, which a stable-deps `useEffect` could not otherwise satisfy. Spec D6 wording was
  tightened to name `refreshKey`.
- **Phase 3**: Out-of-range-marker channel pinned to `console.warn` (not `onError?`); the plan's
  `onError?`/`console.warn` phrasing was ambiguous. `onError?` is reserved for genuine adapter
  failures; a dropped stale marker is data-hygiene. Plan deferred-#4 wording tightened
  (architect-authorized).
- **Phase 4**: Stub adapters are a `createStubHost(initial)` factory plus named
  `stubFileAdapter`/`stubMarkerAdapter`/`stubThemeAdapter` factories over a shared text store
  (rather than module-level singletons) — required for per-test isolation while keeping the
  text-as-source-of-truth round-trip.

## Key Metrics

- **Commits**: ~25 builder commits on `builder/spir-945` (plus porch chore commits).
- **Tests**: 34 passing in the new package (5 files: data-line, sanitization, artifact-canvas, import-boundary, end-to-end). 0 pre-existing package tests (greenfield).
- **Files created**: the `packages/artifact-canvas/` package (26 files: src + adapters + renderer + components + overlays + styles + fixtures + tests + examples + README + build/test config).
- **Files modified (repo wiring)**: root `package.json` (build graph), `.github/workflows/test.yml` (CI), `.gitignore` (dist), `scripts/bump-all.sh` (lockstep bump), `codev/protocols/release/protocol.md` (enumeration + git-add blocks).
- **Files deleted**: none.
- **Net LOC impact**: +~1,601 lines in the package (plus small wiring diffs).

## Flaky Tests

During Phase 2 (renderer), porch's `tests` check (which runs the **entire `@cluesmith/codev`
suite**, exit-code-based) failed on **pre-existing flaky tests in the codev package** — **not** in
the new `artifact-canvas` package, which made zero codev changes this spec.

**Evidence the failures are flaky and unrelated to spir-945:**
- The same suite passed with **0 failures** in Phase 1 (3258 passed).
- The full-suite run failed **7** tests across 4 files; re-running just those 4 files gave only
  **1** failure (7→1) — non-deterministic, i.e. flaky, not a regression.
- Phase 2 touched only `packages/artifact-canvas/`; no codev source/test was modified.
- No worktree git pollution (the temp `ci`/`develop`/`feature` branches in the output are
  test-fixture repos, not the real worktree).

**Quarantined (skipped) per the builder protocol's "Handling Flaky Tests" rule, architect-authorized
(2026-06-10), on the `builder/spir-945` branch.** Each skip carries a `// FLAKY: skipped pending
investigation` annotation naming the flake pattern:

| File | Skipped | Flake pattern |
|---|---|---|
| `packages/codev/src/agent-farm/__tests__/tunnel-integration.test.ts` | `describe.skip('tunnel integration (Phase 4)')` | File-watcher timing — config file watcher races on detect change/deletion |
| `packages/codev/src/__tests__/default-branch.test.ts` | `describe.skip('resolveDefaultBranch')` | Git-fixture isolation — temp-repo default-branch resolution |
| `packages/codev/src/__tests__/non-main-default-branch.test.ts` | all 3 describes (`#784`, `#777 Defect A`, `#777 architect impl`) | Git-fixture isolation — temp-repo three-dot diff / GitRefResolver ref reads |
| `packages/codev/src/__tests__/team-cli.test.ts` | `describe.skip('afx team deprecation')` (only — other describes left active) | Deprecation-warning spy ordering (runAgentFarm spy state) |

These predate spir-945 and are unrelated to artifact-canvas. As of this review, none of the four
files had been changed on `main` since the branch point, so the skips remain necessary. The
architect is filing a tracker issue for the underlying flake fix. **Action for the un-skip:** remove
these `.skip`s once the tracker fix lands.

## Consultation Iteration Summary

21 consultation rounds across the protocol, each a 3-way (Gemini/Codex/Claude): Specify 3, Plan 5,
Phase 1 2, Phase 2 1, Phase 3 6, Phase 4 2, PR 2 (see the per-phase table below). Across them, the
Gemini/`agy` lane was unavailable in every round (non-blocking COMMENT skips — see Challenges);
Codex was the recurring blocker (REQUEST_CHANGES on the items in the table, all resolved); Claude
APPROVED from Phase 3 iter-2 onward and at the PR. (A couple of individual lane invocations produced
no verdict file — the `agy` skips and one Codex PR-round timeout — so the on-disk file count is a
few short of 21 × 3; exact per-file tallies are not load-bearing.)

| Phase | Iters | Who Blocked | What They Caught |
|-------|-------|-------------|------------------|
| Specify | 3 | Codex | Spec residual nits; resolved at the spec-approval gate (human checkpoint). |
| Plan | 5 | Codex | Repo build/test/release wiring; ThemeAdapter on render path; e2e-through-text; resolved at plan-approval gate. |
| Phase 1 | 2 | Codex | Build/test/release wiring named explicitly; jsdom env. |
| Phase 2 | 1 | — | Clean (renderer + sanitization). |
| Phase 3 | 6 | Codex | watch-guard bug → async race → warn-once → no-watcher refresh → stale `activeLine` → channel clarity; each progressively smaller. |
| Phase 4 | 2 | Codex | README install guidance contradicted the no-npm-publish / `workspace:*` decision. |

**Most frequent blocker**: Codex — the sole blocking reviewer in every round that had a blocker,
focused on contract/wiring fidelity and async-edge correctness. Claude APPROVED from Phase 3 iter-2
onward; Gemini's `agy` lane was unavailable throughout (non-blocking skips).

### Avoidable Iterations

1. **Async-edge completeness up front (Phase 3, ~3 of 6 iters)**: the request-versioning race,
   warn-once dedup, and stale-`activeLine`-after-reload were all "what happens on the *second*
   load" cases. A deliberate "enumerate every reload/out-of-order path before first consult" pass
   would have collapsed several iterations into one.
2. **Doc/decision cross-checks (Phase 4)**: the README install snippet contradicted a decision
   already locked in the plan + release protocol. Cross-checking docs against locked decisions
   before consult would have avoided the round.

## Consultation Feedback

Per-phase reviewer concerns and responses are recorded in the per-iteration rebuttal files under
`codev/projects/945-build-foundational-reusable-pa/` (`*-iterN-rebuttals.md`). Summary:

### Phase 3 (6 rounds)
- **Codex**: watch() unguarded (Addressed); async race / no request-versioning (Addressed);
  out-of-range warned every reload not once (Addressed); no-watcher refresh contract unmet
  (Addressed via additive `refreshKey`, architect-authorized); stale `activeLine` after reload
  (Addressed); out-of-range channel ambiguity (Addressed via plan tightening).
- **Claude**: APPROVE from iter-2 onward.
- **Gemini**: lane skipped (COMMENT, non-blocking) throughout.

### Phase 4 (2 rounds)
- **Codex**: README told consumers to `pnpm add` the package, contradicting the not-npm-published /
  `workspace:*` decision (Addressed — Install section rewritten). iter-2 APPROVE.
- **Claude**: APPROVE both rounds.
- **Gemini**: lane skipped (COMMENT).

## Lessons Learned

### What Went Well
- **Locked decisions (D1–D7) as a contract** kept a 6-dependent foundational package from drifting:
  every consult could be checked against an explicit decision rather than taste.
- **The verify-loop genuinely improved the software.** Each Phase 3 Codex iteration shipped a real
  async-edge fix; the final component is markedly more robust than iter-1 would have been.
- **text-as-source-of-truth e2e proof**: asserting the new marker lands in the shared text store
  (not an in-memory side store) is what makes the round-trip test meaningful.

### Challenges Encountered
- **The Gemini/`agy` lane was unavailable the entire project** — `agy` timed out producing no
  verdict, and porch defaults a verdict-less file to REQUEST_CHANGES. Architect-authorized
  normalizing genuinely-empty files to `COMMENT` (recorded in-thread, never overriding a real
  verdict). Cost: per-round bookkeeping; no design impact.
- **Pre-existing flaky codev tests** blocked porch's whole-suite check though the package made zero
  codev changes; resolved by architect-authorized quarantine (see Flaky Tests).
- **A confabulated "tampering" alert** early on: I reported tool-output tampering that never
  appeared in the actual results. Corrected by verifying file integrity via git hashes and
  retracting. Lesson: summarize what verdict files *actually say*; treat them as deterministic
  source of truth.

### What Would Be Done Differently
- Enumerate all reload / out-of-order / second-load edge cases before the first implement consult of
  a stateful component (would have compressed the Phase 3 loop).
- Cross-check every doc claim (install, distribution) against already-locked decisions before
  consulting.

## Architecture Updates

No `codev/resources/arch.md` change needed in this spec. `arch.md` documents the architecture of
the *running* Codev system; `@cluesmith/codev-artifact-canvas` ships standalone with **no host
integration** in v1 (integration is #859 and follow-ups). The package's own architecture — the
three adapter interfaces, the D1–D7 decisions, the CSS-variable theming model, and the dual-format
build — is fully documented in the spec, the plan, and the package `README.md`. An `arch.md` entry
should be added when the first host wires the canvas in (so arch.md reflects an integrated, running
component rather than an unconsumed library).

## Lessons Learned Updates

No direct edit to `codev/resources/lessons-learned.md` in this spec — that file is aggregated during
the MAINTAIN protocol. The reusable lessons from this build are captured in the **Lessons Learned**
section above for MAINTAIN to fold in: (1) the `agy`/verdict-less → REQUEST_CHANGES porch behavior
and its normalization boundary; (2) whole-suite porch checks being blocked by flakes unrelated to a
package-scoped change; (3) enumerate stateful-component reload edge cases before the first consult.

## Technical Debt

- Four codev flaky tests remain `.skip`-quarantined on this branch pending the architect's tracker
  fix (see Flaky Tests). The un-skip is the explicit follow-up.
- The `examples/` page is not type-checked in CI (transpiled by esbuild via Vite; verified to bundle
  headlessly). Acceptable for a dev aid; a host integration will exercise the real types.

## Follow-up Items

- **#859 (and follow-ups)**: host integration — wire the canvas into the VSCode extension /
  dashboard. Add the `arch.md` entry at that point.
- **#863**: polished inline marker bubbles + the `<canvas>` minimap (the JS-side `ThemeAdapter`
  consumer). Explicitly out of v1 scope.
- **Flaky-test tracker** (architect-filed): fix the 4 quarantined codev tests, then remove the
  `.skip`s on a follow-up.
- **#1029**: package-layering decision (DOM vs universal; defer a core/web/native split until
  native rendering is committed).
- **#1036**: marker comments render as body text — the renderer/host must hide marker lines while
  preserving `data-line` accounting (entangled with host serialization, #859). Surfaced via the
  smoke host; the companion overlay-anchoring half was fixed in this PR (below).

## Post-review polish (smoke-host feedback)

During visual review of the smoke host, the comment overlay was found to render at the bottom of
the canvas rather than beside the active block (the Phase 3 "visual positioning deferred" item). It
now **anchors to the active block**: the component records the block's `offsetTop` on hover/focus
and positions the overlay absolutely at that offset (left gutter for the `+`), verified in a real
browser (Playwright) to align with, and follow, the hovered/focused block. The marker-comment-as-
text issue noticed at the same time is the separate, deeper item tracked as #1036.
