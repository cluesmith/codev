# Rebuttal — Spec 1470, Plan iteration 1

Both reviewers returned REQUEST_CHANGES. **All 13 distinct points accepted; none declined.**

Two of them are defects that would have produced a broken feature rather than a rough one:
the nonce could never be present when the command ran (every self-refresh would abort), and
a transition site was missing (the two highest-value boundaries would never fire on the path
this repo documents as normal). Both reviewers found the nonce defect independently, which is
the strongest signal a review pair can give.

I verified every load-bearing claim against the source before acting on it.

---

## The two blocking defects

### 1. The nonce cannot exist when the command runs *(both reviewers; my defect)*

**Verified**: `verifyReceipt` (`receipt.ts`) returns `wrong-nonce` unless
`content.includes(nonce)`. My Phase 3 said "nonce issued by the orchestrator" while the builder
writes `.builder-state.md` *before* invoking the command. A nonce minted at invocation can never
be inside a file already on disk. Every self-refresh would have aborted — the feature would have
been dead on arrival, and the unit tests would have passed, because they would have injected the
nonce both sides.

The driven path only works because the driver issues the nonce in the save request and *then*
polls. Removing the external driver removed the thing that made the handshake possible, and I
did not notice.

**Changed**: Phase 3 now specifies a real two-step handshake.

| Step | What happens |
|---|---|
| `afx self-refresh --begin` | mint nonce → write `.builder-refresh-challenge` (untracked, `.builder-` prefix so `afx cleanup` treats it as scaffold) → return the boundary-aware save request |
| *builder writes `.builder-state.md`* | |
| `afx self-refresh` | read challenge → verify against **that** nonce → assemble → write → schedule → clear → delete challenge |

Codex asked that this be "a concrete two-step preparation/execution handshake or another safe way
to issue the challenge before the save"; Claude asked that the nonce's origin be named and noted
it "interacts with Phase 4's no-positional-argument property". It doesn't conflict: `--begin` is a
mode flag, not a target, so nothing can be pointed at another session. Phase 4's deliverable now
says so explicitly.

**A property I gained by fixing it**: the challenge is deleted on use and reissued by every
`--begin`, so a stale `.builder-state.md` left over from an *earlier* boundary now fails
`wrong-nonce` instead of sailing through the gate. That replay protection came free to the driven
path from being externally driven; the self path had to earn it. New acceptance criterion and an
explicit replay test.

### 2. Phase 2 missed a fourth transition site *(Claude)*

**Verified**: `next.ts:240–276`. When an artifact carries `approved:` frontmatter,
`hasPreApproval` fires, porch auto-approves the gate, sets `state.phase`, extracts plan phases,
calls `writeStateAndCommit`, and recurses.

Claude's point about *which* path this is settles it: CLAUDE.md documents pre-approved artifacts
as the normal workflow ("Approved specs and plans need frontmatter and must be committed to
`main` before spawning"). Wiring only my three sites would have left `enter:plan` and
`enter:implement` — the two highest-value boundaries — silently dead for precisely the projects
most likely to want them. That is the "declared but never fires" risk Phase 1 exists to close,
reintroduced one layer down.

**Changed**: Phase 2 now enumerates all four sites in a table, each with its own positive test.
The pre-approval site also owns `plan_phases` extraction, so the implement/first-plan-phase
coincidence rule is asserted there too, and its test uses a fixture artifact carrying `approved:`
frontmatter.

---

## Phase 6: the derived stall signal doesn't work *(both reviewers)*

Codex and Claude converged again. I checked before rewriting: the only two `writeStateAndCommit`
calls in `next.ts`'s build-verify range are the **force-advance** and **re-iter** branches. The
normal task-emission path writes nothing. So `updated_at` stays pinned at the transition for the
whole of a healthy build, and Claude's consequence is exact — any threshold long enough to avoid
false positives is far too long to catch the unattended stall the requirement exists for. My
"derive it rather than store it" resolution was wrong, and it was wrong for a reason I could have
checked before writing it.

**Changed**: Phase 6 is rebuilt around a **porch-owned acknowledgment**, which is what Codex
proposed and one of Claude's two suggestions. The first `porch next` that takes the normal path
past a recorded boundary sets `acknowledged_at` and writes once. Recorded-but-never-acknowledged
is then a precise signal that the builder never came back.

I preferred this to Claude's other option (an untracked `.builder-refresh-inflight` marker)
because it keeps the whole signal inside the artifact porch already owns and commits, with no
second source of truth to go stale. Cost is one extra state write per boundary, not per call —
pinned by an acceptance criterion.

Also taken: Phase 6 now extends the `--json` branch (`index.ts:166–183`), whose fixed field set
dashboards read, with a snapshot test pinning backward compatibility.

## `verifyReceipt` needs two observations, not one *(Claude)*

**Verified**: `previous === null` → `still-growing`, so `accepted` is unreachable on a first
observation. My Phase 3 described "verify" as a single step.

**Changed**: Phase 3 specifies two observations ≥ `DEFAULT_STABILITY_WINDOW_MS` (2 s) apart, slept
through the injected clock — ~2 s of real cost, instant in tests, and the shared module stays
untouched. I preferred this to synthesizing a `previous` observation, which would have meant
reaching into the gate to satisfy it.

## The min-bytes decision was promised but never scheduled *(both reviewers)*

Fair, and it was a drafting failure rather than an oversight: the spec explicitly told the plan to
decide, and I left the decision in the Risks table where nothing would ever execute it.

**Decided in Phase 3, as a deliverable**: the automatic path **retains `DEFAULT_MIN_BYTES = 1000`**.
The floor's job is to reject a stub (100–200 bytes); a genuine boundary save — identity, phase
position, per-plan-phase receipts with commit hashes, deviations, flaky tests, next action — clears
1000 on pointers alone. Lowering it weakens the R2 substance gate Baked Decision 4 says to inherit
wholesale, to buy nothing.

On the calibration mismatch the spec flagged: it points the *other* way from how I first framed
it. 1000 was tuned on a mid-phase 203-line save, and a boundary save is smaller — so the live
question is whether it clears the bar *honestly*. Phase 8 now measures real boundary saves as
evidence, and if they cluster at the floor the number is revisited with data rather than argued.

## The save request doesn't satisfy "bounded and minimal" *(Codex)*

Correct, and I had only handled the review boundary. `buildSaveRequest` asks for a "complete
working state" and says "do not summarise for brevity", which contradicts the spec's bounded
boundary save at *every* boundary, not just review.

**Changed**: Phase 3 defines `buildBoundarySaveRequest` covering all boundaries — pointers over
prose, receipts over narrative — with the review boundary adding its extra exclusion in Phase 5.
Codex also asked which receipt code is shared versus specialized; that is now stated: **shared** =
nonce generation, marker, `verifyReceipt`, `stateFilePath`, `assembleReorientation`;
**specialized** = the request text. The structural test is scoped to the verification and assembly
modules accordingly, so it pins real drift without failing on a deliberate specialization.

## Protocol validation was incomplete *(Codex)*

`on_plan_phase_advance: true` on a protocol with no `per_plan_phase` phase is exactly the
unresolvable-but-accepted declaration Phase 1 exists to reject. **Added** as a deliverable and an
acceptance criterion.

## Phase 2 contained an ordering contradiction *(Codex)*

I wrote both "append after the transition state write" and "in the same state write". **Changed**
to state the sequence unambiguously: mutate phase/plan-phase fields **and** append the boundary
record, then call `writeStateAndCommit` **once**, then return the refresh task without recursing.
An acceptance criterion asserts exactly one state write per transition.

## A failed live test must block, not document *(Codex)*

My wording — "that is a finding, not a failure — report rather than work around" — reads as
permission to ship past a red acceptance criterion. That is not what I meant, and Codex is right
that it is what it said.

**Changed**: Phase 8 states that test 37 is blocking. If the re-entry is consumed by the clear,
the phase does not complete by documenting it; implementation or spec is revised and the run
repeated. The finding is reported either way.

## The live runs had no named owner *(Claude)*

The sharpest of the smaller items, and it identifies a genuine impossibility rather than a gap:
**I cannot clear my own context to test self-clearing and still be there to report the result.**

**Changed**: Phase 8 names the architect as the driver — they spawn or nominate a subject builder
on a SPIR lane and capture the transcript; I prepare the runbook, the observation checklist and
the evidence template, and analyse the captured output. This is now flagged as a coordination
dependency at the *start* of the phase rather than discovered at the end, with its own risk row.
If the run cannot be scheduled, the phase is **blocked, not waived** — I report and stop rather
than shipping the delay constant on inheritance.

## Smaller items, all taken

- **Early-return changes hot-path behavior** *(Claude)* — today one `porch next` can chain
  specify→plan→implement through recursion; returning at the first boundary splits that across
  calls. Now stated plainly in Phase 2 as intended-and-arguably-better, so it is not discovered as
  a surprise.
- **`normalizeProtocol` is not exported** *(Claude — verified, `protocol.ts:86`)* — Phase 1's test
  plan now drives it through `loadProtocol` against on-disk fixtures rather than widening the
  module's API. Closer to reality anyway.
- **`codev/protocols/release/` has no skeleton counterpart** *(Claude — verified)* — a
  pre-existing asymmetry this project did not create and is not scoped to fix. Phase 7's parity
  test now allowlists it with the reason inline, so the new test does not fail on old debt. Also
  added RELEASE to Phase 1's untouched-protocol list.
- **Pin the response `status` value** *(Codex)* — Phase 2 now specifies the existing
  `status: 'tasks'`, adding no new `PorchNextResponse.status` variant, so dashboard and VS Code
  consumers keep parsing.
- **The refresh task must not instruct `porch done`** *(Codex)* — added as a deliverable. A
  refresh is not a build, and `porch done` would advance state.
- **Phase 3 needs a frame for criterion 30 but Phase 5 owns the text** *(Claude)* — Phase 3 now
  ships a minimal frame satisfying the `schedule` step; Phase 5 enriches it.

---

## Net

13 points, 13 accepted, 0 declined. Two would have shipped a feature that never fires or always
aborts. The pattern across both reviews — and across the spec round before it — is consistent:
my errors came from reasoning about code I had read *around* rather than read. The nonce defect,
the missing transition site, and the `updated_at` assumption were each one grep from being caught
before I wrote them down.

Three of the fixes made the design better rather than merely correct: the challenge handshake
brought replay protection the self path did not otherwise have; the porch-owned acknowledgment is
a cleaner signal than the timestamp arithmetic it replaced; and naming the architect as the live-run
driver surfaced a coordination dependency that would otherwise have surfaced at the very end of
the project, which is the worst possible time to discover it.
