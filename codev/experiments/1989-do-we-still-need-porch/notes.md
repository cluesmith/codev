# Experiment 1989: Do we still need porch?

**Status**: In Progress · **Date**: 2026-11-27

Issue #1989. This run covers two of the issue's three sources of evidence: **History**
(`history.md`) and **Consumers** (`consumers.md`). The third, the controlled strict-vs-soft run,
is the architect's (porchless), runs separately, and is not designed, run or scored here. This file
reaches no conclusion about strict against soft. The finding and the recommendation are written
later, from the controlled run's scored results.

## Goal

The question: for each of porch's eight functions, what does the record on `main` show?

| # | Function | Short name |
|---|---|---|
| F1 | Holds phase and plan-phase state; decides what comes next (`porch next`, `porch done`) | State machine |
| F2 | Records a gate as pending; only `porch approve … --a-human-explicitly-approved-this` passes it | Human gates |
| F3 | Runs build/test commands before a phase may advance, with timeouts | Phase checks |
| F4 | Emits review commands, counts verdicts, iterates, records rebuttals | Consultation |
| F5 | Delivers phase prompts and templates to the builder | Prompt delivery |
| F6 | `porch status`, `porch pending`, dashboard, VS Code, gate notifications, `codev check` | Queryable state |
| F7 | Chooses where a builder refreshes its context | Context refresh |
| F8 | PR and merge recorded per project; `status.yaml` lands on `main` | Records |

For each function, two counts from the record:

- **Saves**: porch stopped something that would otherwise have gone wrong.
- **Costs**: porch itself was the problem.

And from the code: who reads porch's state or calls its commands, and what each would need if porch
were absent or smaller.

**Expectation, written before reading the cases.** Not a hypothesis this run can confirm about
soft mode; a statement of what the history should show if porch is still earning its place:
saves are recorded and outnumber costs for F2 and F4; F3 shows saves; F5 and F7 show few saves of
their own because a model can read a document; F1 shows costs. If the record shows the opposite
pattern for F2 and F4, or shows no saves at all, that is a result and is reported as one.

## Approach: counting rules (fixed before the cases were read)

**A save** is a recorded event in which a porch mechanism refused, blocked, forced or re-ran
something, and the record shows that the thing it stopped was wrong or would have gone wrong. Kinds:

- `S-check`: a porch phase check failed for a real defect and held the phase.
- `S-gate`: porch held a gate that someone was about to pass, or kept a builder waiting where it
  would otherwise have moved on.
- `S-consult-skip`: porch caught a missing consultation (for example "VERIFICATION REQUIRED").
- `S-consult-loop`: porch ran a further review round that found a real defect the builder then
  fixed. Counted separately from `S-consult-skip`, because a builder without porch may also run
  reviews; this kind is evidence that review rounds catch things, and only weak evidence that
  *porch* is what made them happen.
- `S-state`: porch's state let work recover or resume correctly where it would otherwise have been
  lost or repeated.
- `S-prompt`, `S-refresh`, `S-record`: the same for F5, F7, F8.

**A cost** is a recorded event in which porch's behaviour was wrong or got in the way. Kinds:

- `C-wedge`: a builder stuck because of porch (wrong next task, a loop, unable to advance).
- `C-check`: a check timed out, failed falsely, or blocked on something unrelated to the change.
- `C-state`: porch state wrong, reset, rolled back, hand-edited, or repaired by a later command.
- `C-text`: porch told the builder or the human something false (a wrong banner, wrong counts,
  wrong instruction).
- `C-bypass`: porch let through something it exists to stop (a gate, a review loop, a check).
- `C-other`: anything else, described.

**Not counted** as either: a mention of porch that records neither (a builder ran `porch next`
and it worked), and design proposals or feature requests that describe no incident.

**Sources and denominators.** Every count is stated against its population:

| Source | Population on `main` at `ab0fa50a9` |
|---|---|
| `codev/projects/*/status.yaml` | 365 status files (377 project directories; 12 hold only rebuttal files) |
| `codev/projects/*/*rebuttals.md` | rebuttal files, one per review round that ended with a REQUEST_CHANGES |
| `codev/state/*_thread.md` | 320 builder threads, the first added 2026-05-22 |
| `codev/reviews/*.md` | 287 review files (corrected on reading: 285 `.md`; 3 of the 288 files are images) |
| GitHub issues | 311 issues that mention "porch" (search) or carry `area/porch` |

**Sampling.** Status and rebuttal files are counted mechanically, all of them. Threads and reviews
are filtered to the lines that mention porch, `status.yaml`, a gate approval, a force-advance or a
verification refusal, and every matching file is read around those lines. Issues are classified
from title and body, all 311. Every case cited in `history.md` was checked in its file or issue
before it was cited.

## Environment & Reproduction

Reading only. Branch `builder/experiment-1989`, base `ab0fa50a9` (main, 2026-11-26). The shell
commands behind each mechanical count are given beside the count in `history.md`.

## Code

None. The outputs of this run:

- `history.md`: saves and costs per function from the record on `main`, with denominators and
  what the record cannot show.
- `consumers.md`: everything that reads porch's state or calls its commands, with file and line,
  and what each would need if porch were absent or smaller.
- `data/`: the verified per-case tables behind `history.md` (threads, reviews, issues), the
  rebuttal sample and the pending-gate check.

## Results

History and Consumers are drafted (`history.md`, `consumers.md`). No conclusion is drawn here; see
the top. `history.md` section 6 checks the expectation above against the counts, as a result of the
history strand only.

## What Worked / What Didn't

To be written with the finding.

## Next Steps

The architect supplies the controlled run's scored results; the finding and recommendation are
written from those together with this file's two documents.
