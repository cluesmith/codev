# Rebuttal — Spec 1470, Phase 8 (end-to-end) iteration 1

**Verdicts**: Codex REQUEST_CHANGES (3 + 1 environmental) · Claude REQUEST_CHANGES (1 + 1 minor).

**All accepted, no disputes.** One of them sent the phase back for a third live run rather than
being fixed in code, which was the right outcome and not the cheap one.

---

## Both reviewers — `finalStatus` captured and never asserted *(accepted)*

The full-protocol simulation computed `finalStatus` and `lastSubjects` and asserted neither.
`drive()` breaks on `status === 'error'` **without** hitting the step ceiling, so an errored run
satisfied both the progress assertions and read as a healthy pass.

Independently found by both reviewers, which is itself a signal — this is not a subtle one.

What makes it worse than an ordinary gap: **captured-but-unasserted looks like the check exists.**
A reader scanning the test sees `finalStatus` in the result type and reasonably assumes completion
is verified somewhere. An absent field would at least have been honestly absent. The values were
there because I had used them for diagnosis and left them in.

**Fixed** on all three full-run arms, verified against what the fixture actually reaches
(`implement → review → verified`, ending at "Merge the pull request") rather than assumed —
Claude's suggested `expect(finalStatus).toBe('complete')` is correct, and I confirmed it before
writing it in rather than after.

## Codex — the busy-terminal test proved nothing about busy terminals *(accepted)*

> It inserts a mailbox row already marked `reason: 'busy'` and reads it back; this would pass even
> if production delivery incorrectly delivered onto busy terminals.

Exactly right, and Claude flagged the same thing as a naming problem. It proved `enqueue` stores the
reason it is handed — which nobody doubted — while claiming to prove that a busy terminal causes a
hold.

Codex offered the fix and it was the right one: **invoke the real delivery path**. `deliverAgentMail`
is fully port-injected, so the test now drives it with the gate verdict as the only variable and
asserts what actually matters — that **nothing is written**. A re-entry written onto a busy prompt
does not just arrive early; it fuses with whatever the builder was typing.

Added the paired positive (a clean gate delivers) and a pre-due case (not delivered even onto a clean
prompt, because the delay is a lower bound the gate must not override). Mutation-checked both
directions: forcing every verdict clean fails the busy test, forcing every verdict busy fails the
clean one. Neither would have failed against the old version.

I could have taken Claude's cheaper option — rename the test to match what it checked. Renaming
would have made the suite honest and the coverage no better.

## Codex — the live evidence did not satisfy the approved spec *(accepted; the important one)*

> The runbook explicitly bypasses porch and manually supplies `--boundary`; the raw evidence records
> a post-clear identity probe, not an actual `porch next` resumption. The architect ruling is
> documented but is not an amendment to the approved spec.

Correct on every clause. Spec test 37 requires four things; the first live pass proved two. "At a
real boundary" was supplied by hand, and "resumes from `porch next`" was not demonstrated at all —
the subject was a task-lane builder, for which `porch next` is not even meaningful. The probe answer
was good evidence of *re-orientation*, and I should not have let it stand in for *resumption*.

The process point is the sharper half: **an architect ruling recorded in a runbook is not an
amendment to an approved artifact.** This project already has the precedent — the `--boundary`
contradiction went to the human — and I did not apply it to my own evidence.

**Escalated rather than resolved**, with a correction I owed: I had framed Option B as "skip porch
entirely", when the actual constraint was only "do not install over a running Tower". Porch is
driveable by path exactly as `afx` was, so a third pass needed no Tower restart — an option that
existed the whole time and that my framing had removed from consideration.

**Resolved by running it, not by amending.** Third pass on a real ASPIR porch project:

- **Real boundary**: feature porch emitted the task at `plan-phase:phase_2_index` after genuine
  phase-1 work.
- **Real resumption**: the fresh context read both files, ran `porch next`, and porch recovered the
  consultation that had died with the clear.

Both remaining clauses closed as specified. No spec amendment was needed, which is the outcome worth
having: the artifact still describes what was actually verified.

## Codex — could not re-run tests (`EPERM` under `node_modules/.vite-temp`) *(environmental)*

Noted, not a finding. Recorded because a reviewer that cannot execute is reviewing by reading, and
that is worth knowing when weighing its confidence — it makes the two findings above *more*
impressive, not less.

---

## Beyond the findings: what the third pass surfaced

The pass-3 subject found a **hole in the central guarantee** that no reviewer, test, or earlier run
had reached: the gates verify a save is authentic, substantive, settled and recent, and **nothing
verifies it is still true**. A refusal-and-retry cycle left a save describing a phase as not started
when it was finished.

Written up in the review under its own heading. I shipped the instruction and deliberately not the
cheap `HEAD`-moved mechanism — it catches only committed drift, so it would advertise a staleness
check that misses uncommitted work, and false confidence is worse than a known gap.

---

## Net

2 test defects fixed and mutation-checked, 1 live re-run that closed the spec as written rather than
amending it around what was convenient, 1 new finding recorded as the top follow-up.

**The lesson**: I let a *good* piece of evidence — the probe answer — stand in for a *required* one,
because it was genuinely impressive and pointed the right way. Evidence being strong is not the same
as evidence being the thing asked for, and the check is to re-read the acceptance criterion clause by
clause against what was actually captured, rather than judging the body of evidence as a whole.
