# Review: Artifact-Canvas Remote Command Channel (Tower relay + sdk route)

**Spec**: [codev/specs/1401-artifact-canvas-remote-command.md](../specs/1401-artifact-canvas-remote-command.md) ·
**Plan**: [codev/plans/1401-artifact-canvas-remote-command.md](../plans/1401-artifact-canvas-remote-command.md) ·
**Issue**: #1401 · **PR**: #1413 · **Branch**: `builder/spir-1401`

## Summary

A generic remote-command channel for the artifact canvas, delivered in six phases: Tower keeps a
registry of live canvas views, resolves exactly one target for a command, and answers explicitly
when none is open. The Stream Deck (#1400) is the first consumer rather than the only possible
one. 46 files, roughly +6000 lines; every layer green, with one human-only verification
outstanding at the PR gate.

## Spec Compliance

- [x] AC1: All 14 commands produce their table-defined effect (Phase 3, verified by unit + Playwright)
- [x] AC2: The remote origin is well-defined with no prior interaction — clean-state and scrolled-state both covered (Phase 3)
- [x] AC3: No parallel vocabulary; keyboard and remote run the same per-action implementations (Phases 2-3)
- [x] AC4: `count` multiplies the eight traversal commands and is rejected on the other six (Phases 3-4)
- [x] AC5: Failure codes reach sdk callers as the closed union, never only prose (Phase 5)
- [x] AC6: No matching view answers an explicit machine-readable `no-canvas` (Phase 4)
- [x] AC7: Several matching views deliver to exactly one, most recently active, named in the response (Phase 4)
- [x] AC8: File-qualified and file-less selectors route correctly (Phase 4)
- [x] AC9: `composer-open` → typed body → `composer-submit` posts exactly one comment — **automated at the unit level (Phase 3); the live VS Code instance is the outstanding check below**
- [x] AC10: The sdk call is available from `@cluesmith/codev-sdk/controller`; both boundary suites pass unchanged (Phase 5)
- [x] AC11: In-page keyboard behavior unchanged — the pre-existing suite passes unmodified (Phase 2)
- [x] AC12: Closing the last preview makes the next command return `no-canvas` (Phase 6, unit-verified; live pass outstanding)

## Deviations from Plan

- **Phase 2/3 split.** The plan's original phase 2 mixed a pure extraction with newly authored
  actions. Since only 6 of 14 commands had a handler to extract, and the template requires one
  atomic commit per phase, the phase was split so the extraction's "no behavior change" claim
  could be proven by an unmodified test suite. Agreed during plan review, before implementation.
- **Registration transport.** The plan left this open; per-view HTTP register/heartbeat/unregister
  was chosen over binding registrations to the SSE connection, because one VS Code window holds a
  single SSE connection but can host several canvas panels.
- **Two spec/plan factual corrections**, both authorized rather than worked around: the spec's
  "split editor" multi-view example was impossible under
  `supportsMultipleEditorsPerDocument: false` (MRU requirement unchanged, verification venue moved
  to the Tower registry), and the plan's claim that the webview has no `check-types` coverage was
  wrong — `tsconfig.webview.json` covers it and the package script runs both configs.

## Consultation Feedback

Every phase ran a three-way consultation; several ran two or three rounds. Full per-round detail
lives in `codev/projects/1401-*/1401-*-rebuttals.md`. Summarised by disposition:

### Specify Phase (Round 1)
- **Gemini**: No concerns → **N/A**
- **Codex**: sdk error contract left open-ended (`…` in the union); parity not always literal; path/clock normalization unspecified; security posture absent → **Addressed** (closed error union, effect-parity rewrite, Tower-side canonicalization and timestamps, security paragraph)
- **Claude**: (blocking) remote commands have no `e.target`, so literal parity would no-op 8 of 14 commands; `block-next/prev` cannot be Tab parity → **Addressed** (origin chain defined; block stepping defined against `[data-line]`, not Tab)

### Plan Phase (Round 1)
- **Gemini**: No concerns → **N/A**
- **Codex**: runtime-vs-type-only classification; missing composer file; `supportsMultipleEditorsPerDocument: false`; reconnect undefined; canonicalization wording → **Addressed** (type-level classification; files added; scenario re-venued; re-registration specified)
- **Claude**: (blocking) the shared runtime traversal list is unimportable by both consumers; "pure extraction" hid ~6 commands of new work; a type-test under `src/` would ship → **Addressed** (type-level with per-consumer `satisfies`; phase split; guard moved out of `src/`)

### Phase 1 — Wire contracts (Rounds 1-2)
- **Gemini / Codex**: APPROVE, no concerns → **N/A**
- **Claude**: the exhaustiveness guard is never invoked by CI → **Addressed** (step added to `test.yml`; re-verified by the reviewer in round 2)

### Phase 2 — Action registry extraction (Round 1)
- **Gemini**: lane skipped (`agy` produced no output) → **N/A** (`CONSULT_ERROR`-equivalent, non-blocking by design)
- **Codex / Claude**: APPROVE. Three advisories for phase 3 (per-render registry needs ref dispatch; use `Extract<CanvasCommand,…>`; `pageColumn` edge untested) → **Addressed** in phase 3

### Phase 3 — Canvas remote seam (Rounds 1-3)
- **Gemini**: APPROVE → **N/A**
- **Codex**: column paging missing a mode check; counted traversal unbounded; coverage gaps → **Addressed** (mode check, progress-based break, browser suite driving the dev page). The stated vertical-mode scenario did not reproduce (`overflow-x` is mode-scoped) → **Rebutted** in part, with the guard kept as defence and the test rewritten to assert what is verifiable
- **Claude**: (blocking) the drift guard is inert; unbounded `count` loop; quiet-focus not re-armed; `check-types` failing on the new spec → **Addressed** (all four; guard re-verified by deliberately breaking it)

### Phase 4 — Tower registry and route (Rounds 1-2)
- **Gemini**: APPROVE → **N/A**
- **Codex / Claude**: (blocking) command delivery refreshed the liveness lease; a literal `null` body escaped as a 500 with no wire code; a malformed heartbeat renewed the lease; response literals untyped → **Addressed** (all four; the typing change exposed that the registration contract omitted `ok`)

### Phase 5 — sdk calls (Rounds 1-2)
- **Gemini / Claude**: APPROVE → **N/A**
- **Codex**: (blocking) `sendCanvasCommand` accepted any object with `ok` → **Addressed** (full shape validation). Registration methods reachable via the exported class → **Rebutted**: the subpath exports `TowerClient` with 39 public methods; the three added here are no more reachable than the 36 that predate them. Streamdeck stakeholder accepted as-is; structural fix is #1411

### Phase 6 — VS Code host wiring (Rounds 1-3)
- **Gemini**: APPROVE → **N/A**
- **Claude**: COMMENT then APPROVE. Re-registration race; deactivate-unregister missing; no reconnect handling; unvalidated command; lint warnings → **Addressed** (all five). Also corrected my own false premise about webview typechecking → **Addressed** (propagated to this document)
- **Codex**: reconnect, runtime validation, malformed `count`, reconnect leaking the old id → **Addressed**. The live end-to-end pass → **Rebutted as unclosable by a builder**: it needs a real VS Code window, Tower, and an open panel driven by a person. Escalated to the PR gate with architect authorization (precedent: pir-1179, 1313 phase 7)

## Lessons Learned

### What Went Well

The three-way consultation earned its cost. Six findings changed the design rather than the
wording, and two of them — the self-renewing lease and the inert type guard — were defects that
would have shipped looking correct.

Splitting the canvas work into a pure extraction followed by new authorship made the
"no behavior change" claim checkable by an untouched test suite, which is a much stronger
guarantee than a careful diff read.

Deciding the target rule at spec time, as the issue demanded, meant the multi-view and no-canvas
cases were never open questions during implementation.

### Challenges Encountered

**A non-convergent review loop.** Phase 6 ended 2-1 three rounds running, with the sole remaining
objection being a check no code change can close. Escalating was correct, but it cost two extra
consultation rounds to establish that the loop could not converge on its own.

**An hour lost to a wedged subprocess.** `porch next` appeared hung; it had spawned a `git push`
that was itself stuck. Checking the parent said "still running" indefinitely; checking the *child*
found it in one step.

**Cross-worktree contamination.** The canvas Playwright suite reuses any server on port 5199, and
an orphaned vite process from a since-removed worktree served deleted code to my first run. It
failed loudly, which was lucky — the dangerous case is a compatible sibling making the suite pass
against the wrong code.

### What Would Be Done Differently

Prove a guard fails before trusting it, the first time. I wrote an inert exhaustiveness check,
had it caught, and then wrote the identical inert form again two phases later underneath a comment
asserting it worked.

Run `check-types` after adding the last file rather than after the last logic change. A Playwright
spec added post-typecheck left the criterion red while every suite I was watching stayed green.

Check the keyboard equivalent before "fixing" a remote-path bug. Twice a failing new test looked
like my regression and turned out to be long-standing behavior that the remote path was faithfully
reproducing.

### Methodology Improvements

**Porch should recognise an unclosable finding.** When a reviewer's only remaining objection is a
human-only verification, further rounds cannot change the verdict, and the loop currently relies
on a human noticing and authorising a stop. A protocol-level "escalate to gate" disposition would
make that path explicit instead of ad hoc.

**Consultation prompts could ask for the reviewer's own verification method.** The most valuable
findings this project came from reviewers who ran the code (probing the guard with `tsc`, running
the CI step) rather than reading it. Asking for that explicitly would raise the floor.

## Architecture Updates

- Routed: **cold** — `codev/resources/arch.md`, Integration Points — "Two remote-command paths
  into an editor surface (Spec 1401)": a comparison table of the broadcast verb relay versus the
  targeted canvas channel, the rule for choosing between them, and the canvas channel's
  registry/lease/liveness specifics.
- **Not promoted to hot**, deliberately. `arch-critical.md` is at its 10-fact cap, and this is
  subsystem detail a builder needs *when touching remote control*, not before every decision. The
  hot map's existing "Integration Points — crossing a subsystem or process boundary" line already
  routes a reader to it, so no displacement was warranted. Flagged for the architect in case they
  judge the two-paths trap worth a hot slot at MAINTAIN.

## Lessons Learned Updates

- Routed: **cold** — `codev/resources/lessons-learned.md`, Testing — "A guard is not a guard until
  you have watched it fail", covering both the inert conditional-type-alias form and the
  guard-that-CI-never-runs variant, with the concrete fix.
- Routed: **cold** — same section — green signals hiding a red one: run `check-types` after the
  last file is added, not the last logic change.
- **Hot candidate flagged, not taken unilaterally.** The guard lesson is cross-cutting and
  behaviour-changing, which is hot-tier shape, but `lessons-critical.md` is at its 10-lesson cap
  and promoting it requires demoting an existing entry. That displacement is the architect's call
  at MAINTAIN, not a builder's mid-PR.

## Flaky Tests

No flaky tests encountered. One environmental failure is worth recording but is not flakiness:
`pnpm --filter codev-vscode test` maps to `vscode-test` (the Electron harness), which fails in
this worktree with `spawn Electron ENOENT`. It is pre-existing and unrelated; the unit tests run
under `test:unit` → `vitest`, which is what CI invokes.

## Follow-up Items

- **Outstanding at this PR gate — the live VS Code pass.** Needs a real VS Code window with the
  extension loaded (built from this worktree), a running Tower, and an open canvas panel. Steps:
  (1) drive `comment-next` by `curl` and watch focus move; (2) close the panel and confirm `404
  no-canvas` rather than a silent success; (3) `block-next` with `count: 3`; (4) `composer-open`,
  type a body, `composer-submit`, confirm **exactly one** comment written. Everything either side
  of that seam is verified — Tower's route by 5 e2e tests against a real booted Tower, the canvas
  by 173 unit and 39 Playwright tests plus a human dev-page session, the sdk by 98 tests, and the
  host glue by 17 — so this closes the single untested join.
- **#1411** — restricted controller client / capability surface (streamdeck architect, after merge).
- **#1407** — per-worktree Playwright port for the canvas browser suite.
- **#1400** — the deck actions themselves, unblocked by this bridge.
- **#1386** — `afx open` onto the canvas; that page becomes a second registrant with no protocol change.
