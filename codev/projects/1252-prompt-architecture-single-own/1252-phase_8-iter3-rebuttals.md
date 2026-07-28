# Phase 8 — rebuttal, iteration 3

| Model | Verdict | Issues | Accepted | Disputed |
|---|---|---|---|---|
| Gemini | APPROVE | 0 | — | 0 |
| Codex | REQUEST_CHANGES | 1 | 1 | 0 |
| Claude | (pending at fix time) | — | — | — |

## CX-1 — filed issues not durably linked from the spec

Accepted — the issues were filed (#1276 tiering / #1277 A/B eval) but their
numbers lived only in the builder thread, while the plan explicitly requires
the spec's Non-goals to carry the pointers. Both Non-goals bullets now name
their issues. (The verify phase and the review doc will reference them as
well.)
