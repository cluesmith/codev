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

---

## SUPERSEDED by Spec 1280 (2026-08-01)

**The figures above were produced by an instrument with three defects and should not be
cited.** They are preserved unaltered because the record of what was believed, and when,
is part of the history — not because they are correct.

The instrument (`scripts/measure-prompt-surface.sh` as of Spec 1252):

1. derived its phase-task term from `codev-skeleton/porch/prompts/`, a dead Ralph-SPIR-era
   tree with **no runtime consumer**, while the live resolver
   (`commands/porch/prompts.ts`, `loadPromptFile`) loads `protocols/<p>/prompts/`. Real SPIR
   phase prompts average ~1,396 words; the dead tree averaged 400;
2. omitted `roles/builder.md` (1,837 words), which `spawn-worktree.ts:854` injects into
   **every** builder spawn;
3. asserted in its own comments that `CLAUDE.md` "already inlines" the hot tier. Since #1119
   it carries `@import` lines, which are **transcluded** at session launch — so `wc -w
   CLAUDE.md` excludes 736 always-loaded words.

**Corrected pre-rewrite baseline: `codev/resources/1280-word-baseline.md`
(ALWAYS_ON_WORDS = 34,235 for a SPIR builder at I=10, versus the 21,702 implied here).**

The behavioural baseline in `1252-behavior-baseline.md` is **unaffected** — it uses a
different instrument (`measure-prompt-behavior.ts`) and remains the valid "before" for
Spec 1280's M8.
