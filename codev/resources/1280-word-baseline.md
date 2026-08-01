<!-- GENERATED pre-rewrite baseline (Spec 1280, M0/M0b). Reproduce: scripts/measure-prompt-surface.sh
     Captured in Phase 0, BEFORE any prompt-surface file is rewritten.

     SUPERSEDES the figures in 1252-word-baseline.md and 1252-word-after-phase7.md, which were
     produced by an instrument with three defects (see the script header). Those files are
     annotated in place; their originals are preserved.

     NOTE ON 34,231 vs the 34,255 quoted in spec 1280 — two corrections, both making the
     instrument more honest, neither moving an acceptance criterion (size is reporting-only
     under the charter AMENDMENT of 2026-08-01):

       -20  The 1252 ADDITIVE include model counted a `{{> path}}` directive's own tokens AND
            the content substituted for them. This instrument performs real substitution,
            mirroring lib/skeleton.ts resolveCodevIncludes.
        -4  `wc -w` is NOT portable for this corpus. macOS/BSD wc in a UTF-8 locale counts
            `WARNING SIGN + VARIATION SELECTOR-16` as TWO words; GNU wc on Linux, `LC_ALL=C wc`,
            and Python's str.split() count ONE. Four such banners in spir/protocol.md made the
            same commit measure 34,235 on macOS and 34,231 in CI. Word counting is now DEFINED
            (whitespace-delimited tokens of the UTF-8 decoded text) rather than delegated to the
            host's wc. Caught by CI on PR #1319 — the local suite was green. -->
# Prompt-surface measurement

Commit: `5c962b7a`
Instrument: corrected under Spec 1280 (M0). Supersedes the Spec 1252 version.

## Exclusive buckets (partition the authored surface; these SUM)

| Bucket | Words |
|---|---:|
| SHARED (CLAUDE.md + transcluded hot tier) | 6551 |
| ARCHITECT (roles/architect.md) | 2048 |
| DEAD (codev-skeleton/porch/prompts, 10 files) | 4009 |

## Per-protocol (resolved per file, four-tier)

| Protocol | BUILDER_SPAWN | PHASE mean | CONSULT mean |
|---|---:|---:|---:|
| air | 3017 | 456 | 437 |
| aspir | 3467 | 1396 | 430 |
| bugfix | 2965 | 377 | 683 |
| experiment | 3330 | 0 | 0 |
| maintain | 4158 | 356 | 406 |
| pir | 4801 | 1435 | 491 |
| release | 3463 | 0 | 0 |
| research | 3671 | 0 | 0 |
| spike | 3155 | 0 | 0 |
| spir | 6360 | 1396 | 430 |

## Derived audience loads (these OVERLAP by design — never sum them)

    HOT                      = arch-critical(416) + lessons-critical(320) = 736
    ALWAYS_ON(builder,p,I)   = SHARED + BUILDER_SPAWN[p] + I x (HOT + mean PHASE[p])
    ALWAYS_ON(architect)     = SHARED + ARCHITECT
    ALWAYS_ON(consultant,p)  = roles/consultant.md + mean CONSULT-type[p]

| Audience | Words |
|---|---:|
| **Builder (spir, I=10)** — the headline | **34231** |
| Architect (per session) | 8599 |
| Consultant (per review, spir) | 682 |

## Total authored surface (relocation detector — different basis, see header)

| Component | Words |
|---|---:|
| CLAUDE.md + AGENTS.md (no twin dedup here) | 11630 |
| codev/protocols + codev-skeleton/protocols | 88461 |
| codev/roles + codev-skeleton/roles | 8274 |
| skills, ALL FOUR trees (42 files) | 44840 |
| **TOTAL_AUTHORED** | **153205** |

Reference (on-demand, not always-on): arch.md 20367, lessons-learned.md 21270.

ALWAYS_ON_WORDS=34231
TOTAL_AUTHORED_WORDS=153205
