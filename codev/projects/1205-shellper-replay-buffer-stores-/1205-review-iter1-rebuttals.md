# PIR #1205 — Response to iteration-1 consultation

Both reviewers returned `REQUEST_CHANGES`. **Neither finding was a false positive; there is nothing to rebut.** Both identified real defects, one in the code and one in my reasoning, and both are fixed in `ca3c8b89`. Recorded here in full because PIR's consultation is single-pass (`max_iterations: 1`), so neither fix receives an independent AI re-review — the human at the `pr` gate is the only remaining check.

---

## Claude — `getReplayData()` tail-walk splices non-contiguous fragments

**Finding.** `shellper-replay-buffer.ts` sliced the boundary chunk but did not `break` afterwards. Because `alignToEscape` moves the cut *forward*, `piece.length < remaining`, so `collected < maxBytes` and the loop continued into still-older chunks, taking a tail from each. The result is a stream spliced across a gap, whose leading fragment is itself an unaligned mid-sequence cut — exactly the corruption the alignment exists to prevent. It also contradicted the plan's own wording ("slicing only the boundary chunk").

**Assessment: real defect, accepted.** Verified before changing anything, with the reviewer's own fixture:

```
chunks: 6 × "BODY-N-abcdefg\x1b[m", cap 25
result: "[m\x1b[m\x1b[mBODY-5-abcdefg\x1b[m"
whole.endsWith(result) === false
```

Three fragments from three chunks, leading `"[m"` an orphaned sequence tail.

**Fix.** `break` after pushing the boundary piece. Returning fewer than `maxBytes` was already the accepted contract, so nothing else had to change.

**Regression tests** (both verified to fail with the `break` removed):
1. `returns a contiguous suffix, never fragments stitched across chunks` — the reproduction fixture, asserting `whole.endsWith(capped)`.
2. `keeps the suffix contiguous across a range of caps` — sweeps every cap from 1 to buffer length, so the property is pinned across all boundary positions rather than one lucky value.

**On reachability.** The reviewer correctly noted this was latent: with `REPLAY_BUFFER_MAX_BYTES === REPLAY_PAYLOAD_MAX`, `totalBytes <= maxBytes` always holds on a default shellper, so the capped branch only runs when `replayBufferBytes` is configured above 8MB. That knob is introduced by *this PR*, so the bug would have shipped live-on-configuration. I am not treating "latent" as mitigating.

**Why my tests missed it.** Every ESC fixture I wrote was single-chunk, and every multi-chunk fixture was ESC-free. The bug needs both at once. That is a fixture-design gap, not bad luck.

---

## Codex — the retained send-path guard is unreachable and its test claim is false

**Finding.** `shellper-process.test.ts:274` does not exercise the guard at `shellper-process.ts:402`. `getReplayData(REPLAY_PAYLOAD_MAX)` already caps the result regardless of the retention ceiling, so the branch is unreachable, and the review file asserted coverage that does not exist.

**Assessment: real defect in my reasoning, accepted.** The guard was `replayData.length > REPLAY_PAYLOAD_MAX` on a value that by construction cannot exceed `REPLAY_PAYLOAD_MAX`. Raising the retention ceiling in that test makes the *buffer* hold more than the wire cap, which is a different proposition from making the *guard* fire. I conflated the two and asserted the wrong one in three places: the plan, the review file, and verbally to the architect.

**Fix.** The guard is removed rather than made reachable. An unreachable branch that reads as defense-in-depth is worse than no branch: it invites the next reader to trust a check that cannot fire. The invariant now rests where it is genuinely enforced — `getReplayData`'s contract — and the send site carries a comment saying so explicitly, including that an earlier revision made the false claim.

**Verification that the invariant is still pinned.** The protection the guard was pretending to provide is a test that fails if the cap argument is ever dropped. I confirmed empirically rather than asserting it again: temporarily rewriting the call as `getReplayData()` produces

```
AssertionError: expected 9437195 to be 8388608
```

so the oversized-retention test is the real backstop. Its comment now says that, instead of the previous false claim about exercising a guard.

---

## Nits accepted

- **Single-chunk fast path aliasing** (`shellper-replay-buffer.ts`). It returns the internal `Buffer` by reference where the old always-concat version returned a fresh copy. Harmless today, but a new property; now documented in-place with a note to copy if a mutating caller ever appears.
- **`#1047` ring-buffer test name.** Renamed from "keeps a no-newline stream whole for faithful replay" to "...whole below the partial ceiling," with a note that wholeness holds only because the 100KB fixture is under the 2MB cap. Left unrenamed it would read as a live unbounded-retention guarantee.
- **String-slice claim in lessons-learned.** My entry said the JS string case is benign. Corrected: V8's `slice` also yields a parent-retaining `SlicedString`; it is benign *here* only because the parent is already bounded by the ceiling. Generalising "strings are fine" was wrong.

## Process note accepted

Claude flagged that it caught the worktree mid-edit and that the guard-removal changes were uncommitted, so PR #1353 did not match the working tree. Correct, and now resolved: all fixes are committed in `ca3c8b89`, pushed, and the PR body re-applied from the updated review file.

---

## Net

| | |
|---|---|
| Findings | 2 `REQUEST_CHANGES`, 3 nits, 1 process note |
| Rebutted | **0** |
| Fixed | all |
| New regression tests | 2 (both verified failing without their fix) |
| Suite after fixes | 4392 passed, 0 failed |

Both reviewers earned their place here. The tail-walk bug in particular was a genuine defect in shipped code that my own test design was structurally unable to catch, and it is worth noting for the retrospective that the two self-caught bugs earlier in this PR came from the same class: memory-and-boundary behaviour that correctness tests pass straight over.
