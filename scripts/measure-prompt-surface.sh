#!/usr/bin/env bash
#
# measure-prompt-surface.sh — word-count measurement of Codev's prompt surface.
# Spec 1252, criterion M6 / test T1.
#
# Run before any trimming (Phase 1) and again after (Phase 7); the delta is the
# N1 figure. Emits a markdown table on stdout.
#
# The number that matters is ALWAYS-ON: content that enters an agent's context
# whether or not it is needed. Total authored surface is much larger (~150k
# words) but most of it is on-demand and already correctly tiered.
#
# Usage:  scripts/measure-prompt-surface.sh [repo-root]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

w() { # word count of a file, 0 if absent
  [ -f "$1" ] && wc -w < "$1" | tr -d ' ' || echo 0
}
wdir() { # word count of all .md under a dir, 0 if absent
  [ -d "$1" ] && find "$1" -name '*.md' -exec cat {} + 2>/dev/null | wc -w | tr -d ' ' || echo 0
}
fdir() { # count of .md files under a dir
  [ -d "$1" ] && find "$1" -name '*.md' | wc -l | tr -d ' ' || echo 0
}

CLAUDE_MD=$(w CLAUDE.md)
AGENTS_MD=$(w AGENTS.md)
ARCH_CRIT=$(w codev/resources/arch-critical.md)
LESS_CRIT=$(w codev/resources/lessons-critical.md)
ARCH=$(w codev/resources/arch.md)
LESS=$(w codev/resources/lessons-learned.md)

SKEL_W=$(wdir codev-skeleton);            SKEL_F=$(fdir codev-skeleton)
SKEL_PROTO_W=$(wdir codev-skeleton/protocols)
SKEL_ROLES_W=$(wdir codev-skeleton/roles)
SHADOW_PROTO_W=$(wdir codev/protocols);   SHADOW_PROTO_F=$(fdir codev/protocols)
SHADOW_ROLES_W=$(wdir codev/roles);       SHADOW_ROLES_F=$(fdir codev/roles)
SKILLS_W=$(wdir .claude/skills);          SKILLS_F=$(fdir .claude/skills)

# Always-on = what rides into context regardless of need.
#   CLAUDE.md already inlines the two hot-tier files, so they are NOT re-added
#   here (double-counting them would inflate the baseline and flatter the result).
#   AGENTS.md is the byte-identical twin for other tools — one or the other
#   loads per session, never both, so it is excluded too.
PHASE_ITERS="${PHASE_ITERS:-10}"
SPAWN_PROMPT="${SPAWN_PROMPT_WORDS:-4891}"   # measured from a real .builder-prompt.txt
PHASE_TASK="${PHASE_TASK_WORDS:-1395}"       # measured from a real `porch next`
ALWAYS_ON=$(( CLAUDE_MD + SPAWN_PROMPT + PHASE_TASK * PHASE_ITERS ))

cat <<EOF
# Prompt-surface measurement

Repo: \`$ROOT\`
Commit: \`$(git rev-parse --short HEAD 2>/dev/null || echo n/a)\`

## Per-surface word counts

| Surface | Words | Files | Load |
|---|---:|---:|---|
| CLAUDE.md | $CLAUDE_MD | 1 | always-on (hot tier inlined) |
| AGENTS.md | $AGENTS_MD | 1 | always-on twin (other tools) |
| arch-critical.md (HOT) | $ARCH_CRIT | 1 | inlined in CLAUDE.md + every phase prompt |
| lessons-critical.md (HOT) | $LESS_CRIT | 1 | same |
| arch.md (COLD) | $ARCH | 1 | on demand |
| lessons-learned.md (COLD) | $LESS | 1 | on demand |
| codev-skeleton/** | $SKEL_W | $SKEL_F | resolver tier 4 |
| — skeleton protocols/ | $SKEL_PROTO_W | — | |
| — skeleton roles/ | $SKEL_ROLES_W | — | |
| codev/protocols/ (shadow) | $SHADOW_PROTO_W | $SHADOW_PROTO_F | wins over skeleton |
| codev/roles/ (shadow) | $SHADOW_ROLES_W | $SHADOW_ROLES_F | wins over skeleton |
| .claude/skills/** | $SKILLS_W | $SKILLS_F | on demand |

## Always-on load per builder

    CLAUDE.md            $CLAUDE_MD
  + spawn prompt         $SPAWN_PROMPT
  + phase task x $PHASE_ITERS      $(( PHASE_TASK * PHASE_ITERS ))   ($PHASE_TASK per iteration)
  ------------------------------
  = ALWAYS_ON            $ALWAYS_ON

AGENTS.md and the hot-tier files are deliberately excluded from this sum:
AGENTS.md is the byte-identical twin (one loads per session, not both), and the
hot-tier files are already inlined inside CLAUDE.md's count.

ALWAYS_ON_WORDS=$ALWAYS_ON
EOF
