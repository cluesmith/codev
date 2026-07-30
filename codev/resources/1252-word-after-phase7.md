<!-- GENERATED after-measurement (Spec 1252, N1, Phase 7 final). Reproduce: scripts/measure-prompt-surface.sh. -->
# Prompt-surface measurement

Commit: `883b3a8a`

## Per-surface word counts

| Surface | Words | Files | Load |
|---|---:|---:|---|
| CLAUDE.md | 4330 | 1 | always-on (hot tier inlined) |
| AGENTS.md | 4330 | 1 | always-on twin (other tools) |
| arch-critical.md (HOT) | 422 | 1 | inlined in CLAUDE.md + every phase prompt |
| lessons-critical.md (HOT) | 320 | 1 | same |
| arch.md (COLD) | 20240 | 1 | on demand |
| lessons-learned.md (COLD) | 21270 | 1 | on demand |
| codev-skeleton/** | 78804 | 123 | resolver tier 4 |
| — skeleton protocols/ | 43812 | — | |
| — skeleton roles/ | 3836 | — | |
| codev/protocols/ (shadow) | 2347 | 3 | wins over skeleton |
| codev/roles/ (shadow) | 0 | 0 | wins over skeleton |
| .claude/skills/** | 16769 | 14 | on demand |

## Always-on load per builder (derived from resolved artifacts)

    CLAUDE.md                     4330
  + spawn prompt (proxy)          4564   (builder-prompt.md 861 + protocol.md 3703)
  + phase task (proxy) x 10       11430   (hot tier 742 + porch prompt mean 401, per iteration)
  ------------------------------
  = ALWAYS_ON                     20324

Proxies deliberately exclude per-project variable content (issue body,
task-JSON boilerplate) — those are not trimmable prompt surface, and including
them would let a rerun's delta be polluted by whichever issue happened to spawn
the measuring builder. AGENTS.md and the hot-tier files are likewise excluded
from the top-level sum: AGENTS.md is the byte-identical twin (one loads per
session, not both), and the hot-tier files appear inside CLAUDE.md's count
(they ARE counted once per phase task, where porch injects them separately).

ALWAYS_ON_WORDS=20324

## N1 delta vs baseline (required record)

| | Baseline (Phase 1, `1252-word-baseline.md`) | After Phase 7 | Delta |
|---|---:|---:|---:|
| CLAUDE.md | 5,773 | 4,330 | −1,443 |
| Spawn proxy (served) | 4,723 | 4,564 | −159 |
| Phase task ×10 | 11,360 | 11,430 | +70 |
| **ALWAYS_ON** | **21,856** | **20,324** | **−1,532** |

**Achieved: −7.0% against the ≥20% target. N1 is a target, not a gate; this is
the honest figure.** Decomposition: CLAUDE.md relocations/trims delivered the
bulk; drift repair *added* served words the prompts were supposed to have
(Multi-PR + Verify, ~207); D3's promotion of three user-global scar rules
added ~120; the remaining always-on surface is single-owned prose whose
largest block (protocol.md, 3,703 words) is protocol semantics — excluded by
the spec's Non-goals. The 20% arithmetic assumed more of the surface was
duplicated rules than measurement bore out. Whether even −7% moved behaviour
is the verify phase's question (M12b).
