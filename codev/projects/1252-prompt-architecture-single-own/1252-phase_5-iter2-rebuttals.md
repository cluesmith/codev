# Phase 5 — rebuttal, iteration 2

| Model | Verdict | Issues | Accepted | Disputed |
|---|---|---|---|---|
| Gemini | APPROVE | 0 | — | 0 |
| Codex | REQUEST_CHANGES | 2 | 2 | 0 |
| Claude | (pending at fix time) | — | — | — |

## CX-A — architect.md contradicted its own scar rule on the same surface

Accepted, and a genuine meaning-preservation catch: rule 4 (canonical
afx-from-root) sat directly above point 5's "All CLI tools (`afx`, `porch`,
`consult`, `codev`) … work from any directory." The tension predates this
project, but compression made it sharp. Fixed: point 5 now reads "`porch`,
`consult`, and `codev` are global commands that work from any directory
(`afx` is the exception — rule 4)."

## CX-B — human-gates rule unconverged on eight builder-prompts

Accepted. The old variant ("NEVER call `porch approve` without explicit human
approval — only run it after the architect says to") survived in all eight
skeleton builder-prompts, unregistered. My Phase-5 sweep grepped for
`auto-approve`/`only humans approve` phrasings and missed this one — the same
under-sweep failure mode as earlier phases, now on my own new rule. Converged
to the canonical + relay note on its own line, all eight files registered under
`human-gates`, and the old variant added to the stale-variant sweep so it can
never quietly return.

Fixtures re-pinned as the explicit intentional-change act (manifest ×9,
snapshots ×9, baselines ×3). Full suite: 3,734 passed, 0 failures.
