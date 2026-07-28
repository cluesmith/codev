### Iteration 1 Reviews
- gemini: APPROVE — Phase 1 deliverables (shadow-drift CI gate, surface measurement script, and behavioral metrics baseline) are complete, robustly tested, and fully aligned with the spec and plan.
- codex: REQUEST_CHANGES — Phase 1 lands the drift gate and most of the baseline work, but two phase-required measurements are still incomplete/non-reproducible.
- claude: APPROVE — Phase 1 delivers M2 (drift gate), M6 (measurement script), and M12a (behavioral baseline) cleanly — all tests pass, numbers match the spec, and the baseline is correctly captured before any prompt content changes.

### Builder Response to Iteration 1
# Phase 1 — rebuttal to iteration-1 implementation review

| Model | Verdict | Issues | Accepted | Disputed |
|---|---|---|---|---|
| Gemini | APPROVE | 0 | — | 0 |
| Codex | REQUEST_CHANGES | 2 | 2 | 0 |
| Claude | APPROVE | 0 | — | 0 |

**Nothing disputed.** Both Codex findings were real and both are fixed in this
iteration's commit.

## CX-A — hardcoded SPAWN_PROMPT_WORDS / PHASE_TASK_WORDS

**Accepted — this would have corrupted the N1 result.** The two largest
always-on inputs were one-off measured constants (4891 / 1395). After Phase 7
trims the protocol text, a rerun would still report the pre-trim numbers, so the
before/after delta would only reflect CLAUDE.md changes — precisely the
"reproducible before/after script" requirement M6 exists for.

**Fixed**: both are now derived from resolved artifacts (tier-2 `codev/` first,
then skeleton, matching runtime resolution):

- spawn proxy = `protocols/spir/builder-prompt.md` + `protocols/spir/protocol.md`
  (the parts inlined into every spawn prompt) = 636 + 4087 = **4723**
- phase-task proxy = hot tier (736) + porch phase-prompt mean (400) = **1136**

Per-project variable content (issue body ≈170 words, task-JSON boilerplate) is
*deliberately excluded*: it is not trimmable prompt surface, and including it
would let the delta be polluted by whichever issue spawned the measuring
builder. Sensitivity-verified: shrinking `protocol.md` in a temp copy moves
ALWAYS_ON 21,856 → 18,048.

**Consequence**: the reproducible baseline is **21,856**, not the earlier
24,614 (which included the variable content). The spec's N1 note is updated;
N1 is evaluated against 21,856. The word baseline output is now also committed
(`codev/resources/1252-word-baseline.md`) rather than existing only as script
output.

## CX-B — B5 absent from the committed baseline

**Accepted.** The plan's success criteria said "B1–B5"; I implemented B1–B4 and
wrote "capture B5 separately" without actually capturing it. The spec's design
(B5 = forward snapshot, advisory, non-deterministic) was never the issue — the
missing part was the snapshot itself.

**Fixed**: B5 forward snapshot appended to
`codev/resources/1252-behavior-baseline.md` — 30-day `consult stats`: 3,349
calls, $1,478.01 total, per-model durations/success rates, capture-dated. The
section is explicitly marked appended-at-capture-time (the script deliberately
does not read the machine-local DB, preserving T14 determinism over B1–B4), and
no threshold keys off it. Its verify-phase use is directional context only —
e.g. a B1 rise with collapsing review durations points at degraded review
quality rather than degraded prompts.

## Status

Tests re-run green after both fixes (12 passed, 1 phase-gated skip).


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
