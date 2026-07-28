# PR review — rebuttal, iteration 1

| Model | Verdict | Issues | Accepted | Disputed |
|---|---|---|---|---|
| Gemini | APPROVE | 0 | — | 0 |
| Codex | REQUEST_CHANGES | 2 | 1 | 1 |
| Claude | (pending at fix time) | — | — | — |

## CX-1 — spec/plan missing approval frontmatter — ACCEPTED

Both artifacts passed their human gates (spec-approval 2026-07-27,
plan-approval 2026-07-28 jointly with the D5 delta) but still read
`Status: draft` with no frontmatter. Fixed: both now carry the repo's
standard `approved:` / `validated: [gemini, codex, claude]` frontmatter and
approved status lines naming their gates.

## CX-2 — "54 commits do not match [Spec 1252] format" — DISPUTED (false positive by repo precedent)

The non-conforming commits are **porch-generated state-transition commits**
(`chore(porch): 1252 <event>`), written by the orchestrator itself when it
records gate requests/approvals and phase transitions in `status.yaml`.
Evidence that this is the repo's established convention — `main`'s own recent
history:

```
151ff076 chore(porch): bugfix-1264 pr gate-approved
b775f02f chore(porch): bugfix-1261 pr gate-approved
cf430e1b chore(porch): bugfix-1264 init bugfix
```

Every builder-authored commit on this branch follows
`[Spec 1252][Phase: …]` / `[Spec 1252] …`. Rewriting porch's commits would
require rebasing a pushed, in-review branch and would diverge from every
previously merged porch-driven project. The repo also merges with regular
merge commits (never squash), so the mixed history is the intended record.
