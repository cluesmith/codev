<!-- GENERATED word-count baseline (Spec 1252, M6). Reproduce: scripts/measure-prompt-surface.sh. Captured Phase 1, pre-trim. -->
# Prompt-surface measurement

Commit: `b37f7db1`

## Per-surface word counts

| Surface | Words | Files | Load |
|---|---:|---:|---|
| CLAUDE.md | 5773 | 1 | always-on (hot tier inlined) |
| AGENTS.md | 5773 | 1 | always-on twin (other tools) |
| arch-critical.md (HOT) | 416 | 1 | inlined in CLAUDE.md + every phase prompt |
| lessons-critical.md (HOT) | 320 | 1 | same |
| arch.md (COLD) | 20240 | 1 | on demand |
| lessons-learned.md (COLD) | 21270 | 1 | on demand |
| codev-skeleton/** | 77955 | 113 | resolver tier 4 |
| — skeleton protocols/ | 44784 | — | |
| — skeleton roles/ | 3813 | — | |
| codev/protocols/ (shadow) | 47511 | 66 | wins over skeleton |
| codev/roles/ (shadow) | 3687 | 3 | wins over skeleton |
| .claude/skills/** | 16743 | 14 | on demand |

## Always-on load per builder (derived from resolved artifacts)

    CLAUDE.md                     5773
  + spawn prompt (proxy)          4723   (builder-prompt.md 636 + protocol.md 4087)
  + phase task (proxy) x 10       11360   (hot tier 736 + porch prompt mean 400, per iteration)
  ------------------------------
  = ALWAYS_ON                     21856

Proxies deliberately exclude per-project variable content (issue body,
task-JSON boilerplate) — those are not trimmable prompt surface, and including
them would let a rerun's delta be polluted by whichever issue happened to spawn
the measuring builder. AGENTS.md and the hot-tier files are likewise excluded
from the top-level sum: AGENTS.md is the byte-identical twin (one loads per
session, not both), and the hot-tier files appear inside CLAUDE.md's count
(they ARE counted once per phase task, where porch injects them separately).

ALWAYS_ON_WORDS=21856
