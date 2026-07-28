# Phase 8 — rebuttal, iteration 4

| Model | Verdict | Issues | Accepted | Disputed |
|---|---|---|---|---|
| Gemini | APPROVE | 0 | — | 0 |
| Codex | REQUEST_CHANGES | 2 | 2 | 0 |
| Claude | APPROVE (iter-2, late) | 0 | — | 0 |

## CX-1 — Important Notes still instructed fetch-by-path

Accepted, and an ironic one: my Phase-8 repointing turned "check
codev/protocols/spir/protocol.md" into "check codev-skeleton/..." — fixing the
dangling path while preserving the *fetch instruction*, which is the #1011 bug
class the project itself polices. Rewritten to delivery language: protocol text
arrives inlined in every spawn prompt, templates arrive in porch phase tasks;
the skeleton path remains as an orientation reference only.

## CX-2 — glossary's Skeleton entry said "copied to projects on init/adopt"

Accepted — stale since #1012 and directly contradicting arch-critical fact #1
after this project. Now describes the skeleton as the framework source tree,
embedded at build time, served as the resolver's tier-4 runtime fallback, with
init/adopt copying only root docs, skills, and tier starters.

Suite: 3,744 green.
