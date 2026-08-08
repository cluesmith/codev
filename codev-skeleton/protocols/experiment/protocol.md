# EXPERIMENT Protocol

A disciplined experiment: state the hypothesis before running it, record what actually happened,
and keep the result whichever way it goes.

Use it for evaluating models or libraries, proof-of-concept work, and technique comparisons —
questions that should be settled by evidence rather than by argument.

## The state machine

```json
{{> protocols/experiment/protocol.json}}
```

## Structure

Each experiment gets a numbered directory under `codev/experiments/` with a `notes.md` recording
the hypothesis, method, results and conclusion.

## Notes structure

`notes.md` uses this structure:

{{> protocols/experiment/templates/notes.md}}

## The discipline that makes it worth doing

**Write the hypothesis and the success criteria before running anything.** An experiment scored
after the fact always succeeds — you discover the criterion the result happens to meet.

**Record negative results.** "We tried X and it did not work, here is why" is the output that
saves the next person a week. An experiment directory containing only successes is a directory
that has been curated rather than run.

**Keep the experiment separate from production code.** Experimental code answers a question; it
has not earned the standards production code is held to, and promoting it silently is how a
proof of concept becomes a maintenance burden nobody chose.
