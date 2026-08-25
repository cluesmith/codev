# Spec 1470 — live-run runbook (Phase 8, spec tests 37 and 38)

**For**: the architect. **Prepared by**: spir-1470.
**Status**: ready. Two runs, both blocking acceptance criteria.

---

## Why a human has to drive this

A builder cannot test self-clearing on itself. If I clear my own context to run this, I
lose the ability to observe and report what happened — the observer is the thing being
destroyed. So the runs happen on a **separate subject builder** and you capture the
transcript.

## What is being proven, and why no unit test reaches it

Everything about *ordering* is already covered by port-injected tests. What no test can
reach is one harness fact:

> **Can a queued `/clear` consume a re-entry that is delivered just after turn-end?**

The refresh schedules the re-entry **before** it clears — the inverse of `/arch-save` —
precisely because that ordering fails safe. If it is wrong, the builder ends up cleared
with no route back: idle, and indistinguishable from working. That is the whole risk.

**Test 37 is blocking, not informational.** If the re-entry is consumed, Phase 8 does not
complete by documenting the finding — the implementation or the spec is revised and the
run repeats.

---

## ADDENDUM (2026-08-19, after pass 3) — a constraint stated below is FALSE

The section that follows says the subject's porch "will not emit a refresh task" and that Option B
"skips porch entirely". **Both are wrong, and pass 3 disproved them.**

What is true: the *installed* porch (3.3.0) predates this feature and cannot emit. But `porch` is
driveable by path exactly as `afx` is —

```bash
node /Users/mwk/Development/cluesmith/codev/.builders/spir-1470/packages/codev/bin/porch.js next <id>
```

— so the feature porch emits refresh tasks at real boundaries with **no Tower restart**. Pass 3 did
exactly that on a real ASPIR project and closed both of spec test 37's remaining clauses.

The original framing was mine and it removed a cheaper, more complete option from consideration for
two rounds. It is corrected here rather than deleted, because the text below is what the first two
passes were actually run against, and a runbook that quietly rewrites its own history is worse than
one carrying a correction.

## HOW THE SUBJECT LANE RUNS THE FEATURE BUILD — decided: OPTION B

Per the subject builder's *installed* `@cluesmith/codev` (3.3.0) predating this feature, its
porch **will not emit a refresh task**. Waiting at a boundary for one would be waiting for
something that can never arrive.

**Ruling (architect, 2026-08-19): OPTION B — drive the CLI by hand, no Tower restart.**

The reasoning, recorded because it is the kind of trade-off that looks like a shortcut later
and was not:

- Option A (`pnpm -w run local-install`) would be closer to production, but it **restarts
  Tower, killing every builder across 14 workspaces** — including another project's fleet.
  The cost is not "a restart"; it is other people's in-flight work.
- Option B satisfies tests 37 and 38 **honestly**, because those tests are about the
  *harness* — can a queued `/clear` consume a re-entry delivered just after turn-end — and
  not about porch's emission. Porch's emission is covered by the full-protocol simulation
  (`spec-1470-full-protocol.test.ts`, spec test 36), which drives all four transition sites.
- So the two halves are each covered by the cheaper instrument that genuinely covers them,
  rather than one expensive instrument covering both and taking down live work.

### The exact invocation — VERIFIED, not assumed

Run the **worktree-built** binary by path so PATH's installed 3.3.0 cannot shadow it:

```bash
node /Users/mwk/Development/cluesmith/codev/.builders/spir-1470/packages/codev/bin/afx.js \
  self-refresh --boundary 'enter:review' [--begin | --dry-run]
```

`bin/afx.js` imports `../dist/agent-farm/cli.js`; `dist` is current in this worktree (built
newer than every `.ts` under `src/`). Verified by running it: `self-refresh --help` lists
`--begin`, `--boundary`, `--dry-run` and the rest, which installed 3.3.0 does not have.

**Identity comes from the working directory, not from the binary's location** — so run it
with `cwd` = the SUBJECT's worktree while pointing at this worktree's binary. Verified
directly: invoked from `/tmp`, the same binary refuses with

> `afx self-refresh must be run from inside a builder worktree`

and **exits 1**, so a scripted preflight sees the failure.

This cross-worktree shape is the whole point: my build, the subject's identity.

## PREFLIGHT — run this first, always

This exists because the command was once **dead on arrival**: it resolved the builder
against the wrong workspace root and could not find itself. That class of failure is cheap
to check and catastrophic to discover mid-clear.

From **inside the subject's worktree**:

```bash
cd /Users/mwk/Development/cluesmith/codev/.builders/<subject-id>
node /Users/mwk/Development/cluesmith/codev/.builders/spir-1470/packages/codev/bin/afx.js \
  self-refresh --begin --boundary 'enter:review'
```

**Pass** — it prints a challenge and the save instructions, naming the subject's own id.

**Fail** — any identity/lookup error (cannot find builder, wrong workspace, no such
worktree). **Stop.** Nothing further in this runbook is safe to run; send me the error.

Then clean up the challenge so the real run starts fresh:

```bash
rm -f .builders/<subject-id>/.builder-refresh-challenge
```

A `--dry-run` pass is also available and clears nothing:

```bash
node /Users/mwk/Development/cluesmith/codev/.builders/spir-1470/packages/codev/bin/afx.js \
  self-refresh --dry-run --boundary 'enter:review'
```

---

> In the two runs below, `<AFX>` means
> `node /Users/mwk/Development/cluesmith/codev/.builders/spir-1470/packages/codev/bin/afx.js`,
> and every command is run with `cwd` = the subject's worktree.

## RUN 1 — spec test 37 (the happy path). BLOCKING.

**Setup.** A subject builder with real context: let it do actual work first (a phase or
two), so the save has something to carry and the clear has something to destroy. A subject
with an empty context proves nothing.

**Steps**, from inside the subject's worktree:

1. `<AFX> self-refresh --begin --boundary 'enter:review'`
2. Have the subject write `.builder-state.md` per the printed instructions. It must begin
   with the nonce line **exactly**, on the **first line**.
3. `<AFX> self-refresh --boundary 'enter:review'`

**Observation checklist** — record each, with the timestamp:

- [ ] The receipt gate **accepted** the save (nonce on line 1, size and stability OK).
- [ ] `.builder-reorient.md` was written **before** anything was sent.
- [ ] The re-entry was **scheduled before** the clear was attempted (step-log order).
- [ ] The clear landed — the subject's context is gone.
- [ ] **The re-entry ARRIVED after the clear and was NOT consumed by it.** ← *test 37*
- [ ] The subject **resumed from `porch next`** rather than sitting idle.
- [ ] **Measure**: seconds from clear-landed to re-entry-delivered. ← sets the delay constant
- [ ] **Measure**: `wc -c .builder-state.md` — real boundary-save size.

**If the re-entry is consumed**: capture the transcript verbatim, stop, and send it to me.
Do not retry to "see if it works the second time" — an intermittent pass is a fail.

---

## RUN 2 — spec test 38 (the negative). BLOCKING.

Proves the fail-safe: **a refresh that cannot verify its save must leave the context intact.**

**Steps:**

1. `<AFX> self-refresh --begin --boundary 'enter:review'`
2. Deliberately fail the gate — pick **one** and note which:
   - write nothing at all; or
   - write a 3-line stub (under the byte floor); or
   - write a real-looking file **without** the nonce on the first line.
3. `<AFX> self-refresh --boundary 'enter:review'`

**Observation checklist:**

- [ ] The command **refused** and named the reason.
- [ ] **The subject's context is INTACT** — it was not cleared. ← *test 38*
- [ ] No re-entry was scheduled (nothing arrives later to confuse it).
- [ ] The subject can keep working normally.

Variant 2c (nonce present but not on line 1) is the most valuable: it is the
echo-the-request bypass, where copying the instruction file over `.builder-state.md` used
to pass every gate.

---

## What I need back

Transcripts (or paste), the two measurements from Run 1, and which failure mode you used in
Run 2. I fold them into the review artifact as evidence and set
`DEFAULT_REENTRY_DELAY_SECONDS` from the measured clear→ready time — it is **15** today by
inheritance, and Phase 8 is where it stops being a guess.

## Safety notes

- The subject must be **disposable**. Run 1 destroys its context by design.
- Never run any of this in my worktree (`spir-1470`) or against a builder doing real work.
- `--dry-run` clears nothing and is safe anywhere.
- If a run wedges the subject: `afx interrupt <subject-id>`, or `afx refresh <subject-id>`.
