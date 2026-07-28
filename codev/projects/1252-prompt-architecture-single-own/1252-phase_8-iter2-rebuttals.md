# Phase 8 — rebuttal, iteration 2

| Model | Verdict | Issues | Accepted | Disputed |
|---|---|---|---|---|
| Gemini | APPROVE | 0 | — | 0 |
| Codex | REQUEST_CHANGES | 1 substantive + 1 sandbox note | 1 | 0 |
| Claude | (pending at fix time) | — | — | — |

## CX-1 — arch docs vs the worktree scar rule

Accepted, with the underlying semantics worth stating: the two texts were in
*tension*, not true contradiction — `afx cleanup` is the sanctioned,
architect-driven retirement of a **finished** builder, while the scar rule
forbids `afx cleanup` + respawn as a way to bulldoze a **live** worktree. But
an always-on surface carrying "never delete manually (use afx cleanup)" next
to a scar rule reading "never destroy … `afx cleanup` + respawn" forces every
reader to reconstruct that distinction. Both lines now carry it explicitly
(arch-critical fact and arch.md's Worktree Integrity invariant): cleanup
retires finished builders; live ones are resumed, never bulldozed. Hot caps
verified after the edit: 10 facts, 33 lines.

## CX-2 — reviewer sandbox couldn't run Vitest (EPERM)

Noted for the record; not an implementation issue. Full suite on the branch:
3,744 passed, 0 failures.
