# Iteration 1 — disposition of review feedback (PIR #1201)

Verdicts: gemini APPROVE · claude APPROVE · codex REQUEST_CHANGES.

## Codex finding 1 — seed-kick confirmation false-positive: ACCEPTED, FIXED

**Claim**: `seed-kick.ts` confirmed delivery via `state.lastPrompt.includes(opts.message)`; on a fresh spawn the seed prompt itself contains "BEGIN" (the ack-and-wait wrapper says 'You will receive a message "BEGIN"…' and the briefing header says "do not act until BEGIN"), so the verifier could report success even when the Tower-sent BEGIN never submitted — defeating the swallowed-Enter recovery.

**Assessment**: real defect, confirmed against the spike's observed behavior (after a `kimi -p` seed, `state.json.lastPrompt` = the seed prompt). The live demo had not caught it because its kick genuinely submitted (`lastPrompt` overwritten to exactly `BEGIN`) — the false-positive window only matters on the failure path the verification exists to heal.

**Fix** (commit `732f04b8`): confirmation now requires **whitespace-normalized equality** between `lastPrompt` and the kick message. Normalization matters because submitted multi-line messages land in `lastPrompt` with newlines flattened to spaces (observed, kimi 0.27.0), and it keeps the predicate correct for the pre-planned fallback where the whole task prompt becomes the kick payload.

**Pinning tests** (both fail on the pre-fix code):
1. `seed-kick.test.ts` — "the SEED prompt containing the kick word is NOT confirmation": store state carrying a BEGIN-mentioning seed prompt must not confirm and must escalate to the Enter re-send; confirmation only fires once `lastPrompt` becomes exactly `BEGIN`.
2. "confirmation tolerates the observed newline-flattening": a multi-line kick payload still confirms through the flattening.

**Post-fix validation**: full seed-kick suite 14/14; live demo re-run against real kimi 0.27.0 → 5/5 PASS (no false negative from the stricter predicate).

## Codex finding 2 — test suite missed the case: ACCEPTED, FIXED

Covered by the two pinning tests above; also documented in the review file's "Things to Look At During PR Review" with an explicit note that PIR's single-pass consultation did **not** re-review the fix, flagging `confirmed()` for the human's attention at the `pr` gate.
