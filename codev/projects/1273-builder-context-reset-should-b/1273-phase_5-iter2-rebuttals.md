# Rebuttal — Phase 5 (Re-orientation assembly), iteration 2

**Verdicts**: Gemini APPROVE (HIGH) · Claude APPROVE (HIGH) · Codex REQUEST_CHANGES (HIGH)

Accepted in full. Codex's finding is the most consequential defect caught in this project so far, and it
survived two complete review rounds before anyone saw it.

---

## Codex — REQUEST_CHANGES

### Issue: "The long form does not reconstruct issue-backed spawn context"

**Verified against the templates before acting, and accepted.** `SpawnPromptPort`'s context had no
`issue` field, so `buildLongForm` never passed issue metadata to the spawn prompt. But the builder-prompt
templates for every issue-driven protocol render it:

- `codev-skeleton/protocols/aspir/builder-prompt.md` — `{{issue.number}}`, `{{issue.title}}`, `{{issue.body}}`
- same in `spir`, `air`, `bugfix`, `pir`

**Why this is worse than a missing field.** On BUGFIX and AIR the issue body is not supporting context —
it *is* the spec. There is no `codev/specs/` artifact on those lanes. So a reset builder would have
received a long form that looked complete, carried the correct protocol framing, named the right issue
number, and silently omitted the requirements it was implementing. It would then have continued from its
state file alone, confident and under-briefed.

That is precisely the class of failure this whole feature exists to prevent, and my own R3 machinery did
not catch it: `REQUIRED_INLINE_MARKERS` validates the *frame I thought of*, not the *inputs the template
consumes*. Completeness checks only cover the shape you enumerated. Recorded for the review's lessons.

**Changed**:

- `SpawnPromptPort` context gains `issue?: { number, title, body }`.
- `AssembleOptions` gains an `IssuePayload`, fetched by the orchestrator so this module stays pure and
  free of I/O.
- `buildLongForm` forwards it when present.

**Judgement call on the absent case, stated explicitly.** When the lane is issue-backed but the issue
could not be fetched, reset does **not** hard-fail. A forge outage should not stop an architect resetting
a wedged builder — that would make the recovery tool depend on the availability of an unrelated service,
at exactly the moment things are already going wrong. Instead the long form carries a visible gap marker
naming the issue and `gh issue view <n>` as the recovery.

This is stated degradation with an instruction, not a silent fallback. The distinction matters against
the repository's "no fallbacks" rule: nothing alternative is substituted and nothing is concealed — the
builder is told what is missing and how to get it. Silent omission is the dangerous version, because a
BUGFIX builder would infer requirements from whatever framing survived.

### Issue: "Tests do not catch that gap"

**Accepted.** The forwarding tests asserted protocol, mode, spec and plan reached the prompt context, and
stopped there — so they would have passed with issue context absent forever.

**Changed** — five tests added: issue forwarded with all three fields; issue absent from the context when
none supplied; gap marker present when the lane has an issue but no payload; gap marker absent when the
payload is supplied; gap marker absent on a lane with no issue at all.

---

## Gemini — APPROVE

No issues raised.

## Claude — APPROVE

No issues raised. Both approvers passed over the issue-metadata gap, as did all three reviewers in
iteration 1 — the defect was only visible by reading the protocol templates rather than the phase diff.

---

## Net effect

One substantive gap closed in the phase's core claim (spawn-equivalence), five tests added. Tests 35 → 40.
