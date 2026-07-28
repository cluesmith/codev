# Phase 7 — rebuttal, iteration 2

| Model | Verdict | Issues | Accepted | Disputed |
|---|---|---|---|---|
| Gemini | APPROVE | 0 | — | 0 |
| Codex | REQUEST_CHANGES | 3 | 2 fixed, 1 partially disputed | see below |
| Claude | APPROVE | 0 | — | 0 |

## CX-1 — "include model is centralization, not deduplication" — PARTIALLY DISPUTED

The frame is disputed; the concrete defect inside it was real and is fixed.

**Disputed part**: prose references on served surfaces were analyzed and
rejected in the Phase-7 design for a hard reason — builder/phase prompts are
SERVED artifacts. A bugfix builder never sees spir's prompt: removing a rule
from its prompt and pointing elsewhere **deletes the instruction from that
agent's context**; nothing is deduplicated from any reader's perspective.
Cross-protocol repetition on served surfaces is per-agent single delivery.
The single-owner rule's three costs are all addressed by the include model:
drift (one authored source), ambiguity (one wording), and token cost — which
per served prompt is *unchanged by either approach for content the agent must
receive*. Claude's independent verdict this round reached the same
conclusion. The YAML's own header prose still described the old
reference plan, which legitimately fed this objection — **fixed**: it now
documents the include model and when `references` (cross-tier pointers) apply.

## CX-2 — served prompt carries a rule twice — ACCEPTED, real bug

The genuine catch: I converged two different lines in the same file
(`plan.md`'s "No time estimates" list item AND its "What NOT to Do" bullet) to
the same include — spir and aspir plan phase prompts served the rule **twice**,
which is exactly the +70 phase-task words in the measurement. Fixed: one
include per file. This is within-one-served-artifact duplication — the real
S1 failure mode on the agent-facing surface — as distinct from cross-artifact
repetition, which is delivery.

## CX-3 — no end-to-end guard on assembled output — ACCEPTED

New **served-surface dedup guard**: for every automated non-scar class, the
pattern may appear at most `served_max` times (default 1) in (a) each of the
nine ASSEMBLED spawn prompts via the real `buildPromptFromTemplate`, and (b)
each expanded phase prompt. The guard caught the CX-2 bug on its first run,
then surfaced a legitimate ceiling: every spawn prompt carries the baked
instruction section plus the spir protocol doc's *description* of the
convention (a declared retention inlined via `protocol_reference`) — encoded
as an explicit, commented `served_max: 3`; a fourth appearance fails.

Full suite: 3,744 passed, 0 failures.
