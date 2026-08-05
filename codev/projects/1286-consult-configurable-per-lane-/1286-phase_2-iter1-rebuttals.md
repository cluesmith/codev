# phase_2 iteration 1 — rebuttals

**Verdicts**: gemini APPROVE (HIGH) · claude APPROVE (HIGH) · codex REQUEST_CHANGES (HIGH)

Codex's single issue is **accepted in full and fixed**. No disagreement on any point.

---

## Codex issue 1 — `--model-id` silently inert for `-m hermes` (ACCEPTED, FIXED)

> `--model-id` is documented as applying to "whichever lane `-m` selected"
> (`cli-options.ts:39`), but `runConsultation` only consumes it for `claude` and `codex` and drops it
> on the `hermes` path (`index.ts:1081-1119`). For `consult -m hermes --model-id foo`, the flag
> parses and is shown in help but has no effect.

**Verified before fixing.** I checked the claim against the code rather than accepting the summary:

- `MODEL_CONFIGURABLE_LANES = ['claude', 'codex', 'gemini']` (`consult-lanes.ts:29`) — hermes is
  deliberately excluded.
- `validateConsultModels` already carries a bespoke explanation of *why*: hermes is invoked as
  `hermes chat -q` and exposes no model selector.
- `runConsultation`'s hermes path never reads `modelIdOverride`.

Codex is correct on every element. The uncomfortable part is that **I wrote the phase_1 explanation
of why hermes cannot take a model id, then wrote a phase_2 help string promising the flag applies to
whatever `-m` selected.** Fixing a mechanism does not fix documentation that overpromises relative to
that mechanism; they are separate artifacts and they drift independently. This is also precisely the
"registered, documented, inert" class that this phase existed to eliminate — reintroduced inside the
same phase that eliminated it, which is the strongest possible argument for Codex's insistence.

**Fix** (commit `b29b40ec`): new `assertLaneAcceptsModelOverride(lane, flag)` in `consult-lanes.ts`,
called once in `runConsultation` **before dispatch**.

Placement is the substantive decision. Codex offered two options — hard-error for hermes, or narrow
the flag contract. I did both, and put the check pre-dispatch rather than inside the hermes branch:
a per-branch check would leave the identical hole open for the *next* lane that doesn't read the
override. The guard is keyed on `MODEL_CONFIGURABLE_LANES`, so it derives from the same single source
of truth the config validator uses instead of a second hand-maintained list.

The help text is corrected too, since the overpromise was the root cause rather than a side effect:
it now names the supported lanes and states that using it with a selector-less lane is an error, not
a no-op.

**Verified end-to-end, not only by unit test:**

| Invocation | Result |
|---|---|
| `consult -m hermes --model-id X` | exit 1; names accepting lanes + why hermes isn't one |
| `consult -m hermes` (no flag) | unchanged (pre-existing "hermes not found" path) |
| `consult -m gemini --model-id X` | deliberately **not** blocked |

**Tests added** (`lane-models.test.ts`, 20 → 25): hermes rejected with both the lane name and the
"no model selector" reason; the error names all three accepting lanes; every configurable lane
accepts the override; the `flag` parameter is echoed so other overrides can reuse the helper.

### One scoping decision I want on the record rather than buried

`-m gemini --model-id X` is **inert right now** — gemini is configurable by spec, but its passthrough
is phase_3's stated scope ("Agy lane model passthrough"). Strictly, that is the same inert-flag
condition Codex flagged.

I deliberately did **not** add a "not yet wired" error for gemini:

1. Nothing ships until the PR carries all six phases, so no user can encounter the inert window —
   phase_3 closes it first.
2. A temporary hard-error on a documented-supported combination would be a worse artifact than the
   gap, and would have to be removed one phase later.

To keep that from being merely an intention, the test `accepts every configurable lane, gemini
included` asserts all three lanes pass the guard — so **phase_3 cannot quietly narrow the contract**
without failing a test. If a reviewer prefers an explicit interim error for gemini, I will add it;
I judged the tracked-promise-plus-test to be the better trade.

---

## Reviewer-note items (raised by me at the architect's direction)

Both were endorsed by all three lanes; recorded here because they were unreviewed when written.

**Item 1 — rejecting `[]` as a lane list, with a config-vs-protocol asymmetry.** All three lanes
agree the asymmetry is correct and correctly bounded. gemini independently traced the validator's
call graph and confirmed "there are no third paths through the validator that reach protocol-supplied
models" — the one claim that had rested solely on my own single-caller grep, so this is the
verification I most wanted. claude: "Tightening is the reversible direction. I agree with the design."
gemini also answered the open docs question: `"none"` as the skip sentinel belongs in **phase_6**
user docs, not phase_2. Carried forward.

**Item 2 — the `cli-options.ts` extraction.** All three confirm it is behavior-preserving,
`STATS_ONLY_FLAGS` is correct and complete, and the forwarding test has no vacuous-pass path. claude
specifically credited the self-check on the introspection and the sentinel-per-key approach for
catching cross-wiring rather than only missing keys.

---

## Verification after the fix

- `tsc --noEmit`: clean
- Unit suite: **3905 passed**, 48 skipped, **0 failed**
- CLI integration suite: **93 passed**, 0 failed
- Manual: the three invocations tabulated above
