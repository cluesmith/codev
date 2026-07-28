<!-- GENERATED after-measurement (Spec 1252, N1, Phase 7). Reproduce: scripts/measure-prompt-surface.sh. Compare with 1252-word-baseline.md. -->
# Prompt-surface measurement

Commit: `c286541f`

## Per-surface word counts

| Surface | Words | Files | Load |
|---|---:|---:|---|
| CLAUDE.md | 4330 | 1 | always-on (hot tier inlined) |
| AGENTS.md | 4330 | 1 | always-on twin (other tools) |
| arch-critical.md (HOT) | 422 | 1 | inlined in CLAUDE.md + every phase prompt |
| lessons-critical.md (HOT) | 320 | 1 | same |
| arch.md (COLD) | 20240 | 1 | on demand |
| lessons-learned.md (COLD) | 21270 | 1 | on demand |
| codev-skeleton/** | 79217 | 118 | resolver tier 4 |
| — skeleton protocols/ | 44506 | — | |
| — skeleton roles/ | 3836 | — | |
| codev/protocols/ (shadow) | 2347 | 3 | wins over skeleton |
| codev/roles/ (shadow) | 0 | 0 | wins over skeleton |
| .claude/skills/** | 16769 | 14 | on demand |

## Always-on load per builder (derived from resolved artifacts)

    CLAUDE.md                     4330
  + spawn prompt (proxy)          4554   (builder-prompt.md 851 + protocol.md 3703)
  + phase task (proxy) x 10       11430   (hot tier 742 + porch prompt mean 401, per iteration)
  ------------------------------
  = ALWAYS_ON                     20314

Proxies deliberately exclude per-project variable content (issue body,
task-JSON boilerplate) — those are not trimmable prompt surface, and including
them would let a rerun's delta be polluted by whichever issue happened to spawn
the measuring builder. AGENTS.md and the hot-tier files are likewise excluded
from the top-level sum: AGENTS.md is the byte-identical twin (one loads per
session, not both), and the hot-tier files appear inside CLAUDE.md's count
(they ARE counted once per phase task, where porch injects them separately).

ALWAYS_ON_WORDS=20314
