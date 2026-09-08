# Rebuttal — Spec 1470, Phase 2 (porch trigger) iteration 1

**Verdicts**: Codex REQUEST_CHANGES (2 issues) · Claude REQUEST_CHANGES (4 + 3 minor).

**All accepted, none declined.** The two reviewers converged on the same two problems from
different directions, and between them they found a real pre-existing product bug plus a test
suite that was passing for the wrong reason in *nine* places.

---

## 1. A pre-existing ASPIR bug — found by Codex, confirmed by me, fixed here

**Codex**: the ungated ASPIR transition into `implement` does not extract or initialize
`plan_phases`, so ASPIR can skip the per-plan-phase branch entirely and its `plan-phase:*`
boundaries never fire.

**Verified before acting.** `grep -n extractPlanPhases next.ts` returns exactly two call sites —
303 (pre-approval) and 376 (gate-approved). The ungated direct advance in `handleVerifyApproved`
had none. ASPIR has no spec/plan gates, so `plan → implement` *always* comes through that path.

So the consequence is larger than the refresh feature: **ASPIR entered `implement` with an empty
`plan_phases` and never reached the per-plan-phase advance branch at all**, silently costing ASPIR
its per-phase iteration. That predates this project by a long way. It surfaces now only because
ASPIR's declared `plan-phase:*` boundaries are unreachable without it.

**Fixed**, minimally, by mirroring what the other two sites already do, with the pre-existing
nature documented inline and a regression guard in the test.

**Claude asked that I own this explicitly rather than bury it** — agreed, and it is now called out
in the commit message, the builder thread, and here. It is a behavior change beyond Spec 1470's
stated scope: ASPIR's implement loop goes from single-shot to a genuine per-plan-phase cycle. I am
flagging it to the architect rather than deciding for them whether it should ship in this PR or be
split out.

**Claude's follow-up question — do in-flight ASPIR projects need repair?** They are not repaired:
the fix runs on transition, so a project already sitting at `phase: implement` with empty
`plan_phases` stays that way. **I recommend leaving it so, deliberately.** Retroactively populating
`plan_phases` for a project mid-implement would reset its phase statuses to `pending` and rewind
its recorded progress — which is precisely the #1408 class of harm this spec's idempotency design
exists to prevent. A one-off repair, if ever wanted, belongs in a tool a human runs against a named
project, not in a read path that mutates state as a side effect.

## 2. My tests were passing for the wrong reason — in nine places

**Codex**: the test file only drives the gate-approved transition end to end; the ASPIR "test"
merely calls `declaresEnter`/`shouldRefresh` and never invokes `next()`.

**Claude**, independently and more completely: the fixtures omit `verify` (and `implement` omits
`build`), so `isBuildVerify` (`protocol.ts:500` — `!!(phase.build && phase.verify)`) is false and
neither the pre-approval branch nor `handleBuildVerify` is ever reached. **And therefore the
existing negatives were vacuous too** — mid-iteration, plain build task, the #1408 reproduction,
and the legacy-state test were all passing via `handleOncePhase`, i.e. they asserted "no refresh
fired" about a code path where no refresh could ever fire.

Both are right. Four new tests were failing, and five older ones were green for no reason. I found
the same fixture defect by building a minimal repro — dumping what `next()` actually returned
rather than reasoning about it — which surfaced `subjects: ['Implement: Complete phase work']`,
the `handleOncePhase` signature.

That is the **fourth** instance of one pattern in this project: Phase 1's `null` test that codified
the wrong behavior, Phase 2's `spirLike(undefined)` that silently declared everything, this
fixture gap, and the vacuous negatives it created. The common shape is *a test that passes without
exercising the thing it names*. The specific correction I am carrying forward: **assert on an
observable effect of the transition (state mutation), never only on the response shape** — the new
tests all check `after.phase`, `after.current_plan_phase` and `after.context_refreshes`, which is
what makes a vacuous pass impossible.

**Fixed**: fixtures now carry `build` + `verify` on every build_verify phase, and there are real
end-to-end tests for all four transition sites (pre-approval with `approved:` frontmatter,
gate-approved, plan-phase advance, review entry, ASPIR ungated). 22/22 pass, and the previously
vacuous negatives now run through the real path and still hold.

## 3. Missing `loadConfig` / `fetchIssue` mocks *(Claude; accepted)*

Correct, and it was the direct cause of three remaining failures after the fixture fix.
`resolveConsultationModels` does **not** read the phase's `verify.models` — it reads workspace
config, which in a temp root falls back to the three-model default. Porch was waiting for a
`gemini` review the fixture never writes, and returned "Run remaining consultations".

`next.test.ts:22–37` already establishes the convention for exactly this, and I had not followed
it. Adopted both mocks. The second one is visible in the numbers: per-test time dropped from
~350 ms to ~2 ms, which is the `gh issue view` round-trip Claude said I was paying (the #894
flake).

## 4. Minor items *(Claude; all taken)*

- **`buildRefreshTask(state, boundary)` never uses `state`** — parameter dropped.
- **Plan wording contradicts the spec.** The plan's Phase 2 deliverable says the refresh task
  "carries the phase's normal tasks with it"; the spec says "a single sequential refresh task and
  **none** of the phase's normal tasks". The implementation follows the **spec**, which is the
  approved authority and the correct behavior — emitting normal tasks alongside would defeat the
  point, since the builder is about to clear. Noting it so a later reviewer does not read it as a
  skipped deliverable; the plan line is a drafting error on my part, not a deliberate divergence.
- **Pre-Phase-4 boundary burn.** The task text instructs `afx self-refresh`, which does not exist
  until Phase 4, and boundaries are consumed at emission — so anyone driving SPIR *from this
  branch* between Phase 2 and Phase 4 burns a boundary on a missing command. Harmless by design
  (non-blocking, at-most-once), and it cannot affect this project: the architect confirmed, and I
  verified, that the porch driving builders is the globally installed 3.3.0, which has no
  `context_refresh` code at all. Recorded here and carried to the review artifact.

---

## Net

6 substantive changes: the ASPIR `plan_phases` fix (pre-existing product bug), fixtures made
genuinely `build_verify`, end-to-end tests for all four sites, `loadConfig`/`fetchIssue` mocks,
the unused parameter dropped, and the vacuous negatives re-verified against the real path.

One decision deferred to the architect: whether the ASPIR fix ships in this PR or is split out,
given it changes ASPIR's implement loop beyond this spec's scope.

The reviewers' value this round was concentrated in what neither the build nor my own reading
would have caught: a green test suite that was green for the wrong reason, and a bug three lines
from code I had just edited.
