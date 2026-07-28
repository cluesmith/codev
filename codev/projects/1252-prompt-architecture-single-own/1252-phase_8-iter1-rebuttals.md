# Phase 8 — rebuttal, iteration 1

| Model | Verdict | Issues | Accepted | Disputed |
|---|---|---|---|---|
| Gemini | APPROVE | 0 | — | 0 |
| Codex | REQUEST_CHANGES | 3 (one class) | all | 0 |
| Claude | (pending at fix time) | — | — | — |

## CX-1/2/3 — stale deleted-path references in arch.md deep sections + one CLAUDE.md line

Accepted as one class: my Phase-8 sync rewrote the sections I knew about
(Dual Nature, Invariants) and missed arch.md's deep references (Quick Start
pointers, per-protocol section headers, the roles Location line, consultant
resolution order) plus CLAUDE.md's "Protocol details" quick-reference line.
Codex is also right that this made arch.md internally inconsistent — worse
than uniformly stale.

Fixed by sweep, not by cited-line: every `codev/protocols|roles` reference in
arch.md and CLAUDE/AGENTS was enumerated and either repointed at
`codev-skeleton/` (the single owner), annotated as the resolver's now-empty
tier-2 slot, or left standing where it correctly *describes* the resolution
doctrine (CLAUDE.md's File Resolution section — those lines are more true
post-1252 than before). N3 byte-identity maintained.

Suite: 3,744 green.
