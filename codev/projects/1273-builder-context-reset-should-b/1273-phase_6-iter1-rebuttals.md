# Rebuttal — Phase 6 (Reset orchestrator + CLI wiring), iteration 1

**Verdicts**: Gemini APPROVE (HIGH) · Claude COMMENT · Codex REQUEST_CHANGES (HIGH)

**All three findings accepted.** Nothing disputed. Two of them are wrapper bugs that the orchestrator's
own tests structurally could not see, which is the more useful lesson than either bug.

---

## Codex — REQUEST_CHANGES

### Issue 1: "`afx reset` does not reuse `afx send`-style target resolution despite claiming it does"

**Accepted, and the docstring made it worse.** I wrote in `reset.ts`'s header comment that "addressing,
workspace detection and sender identity are reused verbatim from `afx send` — there is exactly one address
resolver", and then used `getBuilder(target, workspace)`, which matches the id **exactly**
(`state.ts:256-266`).

What I actually reused was workspace detection and sender identity. Not addressing. The comment asserted a
property the code did not have, which is worse than the gap: a later reader checking "is addressing
consistent?" would have read the comment and moved on.

The user-visible consequence is sharp. `afx send 1273` reaches a builder registered as `aspir-1273`;
`afx reset 1273` would have failed with "no builder". A command the architect cannot address the way they
already type addresses is a command that gets typed wrong — and this one gets typed in exactly the
situation where care is scarcest, with a builder wedged and context running out.

**Changed** — `findBuilderById` (`lib/builder-lookup.ts:48`), the resolver `afx dev`, `afx attach` and
`afx setup` already share. It tries the exact lookup, then `resolveAgentName` against local builders, then
Tower's terminal registry, and reports **AMBIGUOUS with the candidate list** rather than silently picking
one. The docstring now says what the code does.

### Issue 2: "`--dry-run` prints a blank line under the save-request header"

**Accepted. This one is embarrassing** — `console.log(result.payload?.longForm ? '' : '')` prints the
empty string on both branches. It is a placeholder I left in and never came back to, and it defeated the
single most useful thing a dry run shows: the exact instruction the builder will be asked to comply with,
which is what the entire R2 gate then verifies compliance *with*.

The root cause was structural, not a typo — `runReset` never exposed `saveRequest`, so the command had
nothing to print even had I written the line correctly.

**Changed** — `saveRequest` is now on `ResetResult` and printed under its header. Two tests: one that the
dry run exposes a request carrying the state path and **the nonce**, and one that the request a live run
actually sends is byte-identical to the one the dry run advertised (nonce factored out). A preview that
does not match the real thing is not a preview.

### Issue 3: "No command-surface test catches either issue"

**Accepted, and this is the real finding.** Both bugs lived in the wrapper, and the orchestrator's 27
tests could not see either by construction: the state machine cannot tell whether `sendRaw` was bound to
Tower's `raw` route or its `escape` route, nor whether the builder was found by exact id or by the shared
resolver. I had proven the dangerous part thoroughly and left the boring part — the wiring — unproven,
which is precisely where both bugs were. It is also where the near-miss `/clear`-via-escape bug was.

**Changed** — new `spec-1273-reset-command.test.ts`, 11 tests over the wrapper:

- target resolved via the shared resolver; unresolvable/ambiguous aborts before `runReset` is called
- an incomplete registry row (missing worktree/branch) refuses
- **`/clear` goes down `raw`, ESC goes down `escape`, and neither carries the other's flag** — the
  assertion that would have caught the near-miss
- the save request and re-orientation travel as formatted messages (neither flag set)
- `lastDataAt` is forwarded as `undefined`, not collapsed to `0`, at the port boundary
- a non-running terminal reports absent
- `--timeout` converts seconds → ms (an unconverted `300` would wait 0.3s and abort against every real
  builder)
- `--note`, `--dry-run`, `--interrupt-first` plumbing
- an aborted run sets a non-zero exit code

---

## Claude — COMMENT

Raised the `--dry-run` display bug independently; fixed above. No other issues.

## Gemini — APPROVE

No issues raised.

---

## Note on what these three phases have in common

Phases 5 and 6 have now produced the same lesson three times, from three directions: **the code I verified
hardest was correct, and the defects were all in what I assumed rather than checked.** The re-orientation
drifted from what spawn emits; `/clear` was bound to a route that discards its argument; the target
resolver was asserted-by-comment rather than reused. In every case the fix was to go read the thing I had
described from memory.

Worth carrying into the review as a lesson candidate: *a docstring claiming an invariant is not evidence
of it — when a comment says "this reuses X", the reviewer's job (and mine) is to open X.*

---

## Net effect

Addressing parity with the rest of `afx`; `--dry-run` prints all three of the outputs it promises. Tests
3926 → 3939: +2 in the orchestrator file (27 → 29, the dry-run/save-request pair) and +11 command-surface
tests. Build clean.
