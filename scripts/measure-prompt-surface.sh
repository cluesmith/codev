#!/usr/bin/env bash
#
# measure-prompt-surface.sh — word-count measurement of Codev's prompt surface.
# Originally Spec 1252 (M6/T1); CORRECTED under Spec 1280 (M0).
#
# WHAT THIS MEASURES, AND WHY YOU SHOULD DISTRUST THE PREVIOUS VERSION
# -------------------------------------------------------------------
# Spec 1280 found three defects in the 1252 version. All three produced numbers
# that were precise and wrong:
#
#   1. It derived the phase-task term from `codev-skeleton/porch/prompts/` — a
#      dead Ralph-SPIR-era tree with NO runtime consumer. The live resolver
#      (commands/porch/prompts.ts, loadPromptFile) loads
#      `protocols/<protocol>/prompts/<file>.md`. Real SPIR phase prompts average
#      1,398 words; the dead tree averaged 400. The metric was structurally
#      blind to the largest always-on surface in the system.
#   2. It omitted `roles/builder.md` (1,837 words), which spawn-worktree.ts:854
#      writes to `.builder-role.md` for harness injection on EVERY builder spawn.
#   3. Its comment asserted CLAUDE.md "already inlines" the hot tier. Since #1119
#      (lib/managed-block.ts) CLAUDE.md carries `@import` lines, which Claude Code
#      TRANSCLUDES at session launch. So `wc -w CLAUDE.md` EXCLUDES 736 words that
#      are always loaded.
#
# Reported baseline went 21,702 -> 34,255 on correction. Spec 1280's principle:
# the instrument is part of the deliverable, and instruments get reviewed against
# what they claim to measure — not merely against whether they run.
#
# TWO REPORTING BASES — deliberately different, do not conflate
# ------------------------------------------------------------
#   ALWAYS-ON:      what rides into an agent's context whether needed or not.
#                   Dedupes twins (AGENTS.md is CLAUDE.md's byte-identical twin;
#                   one loads per session) and EXPANDS @import / {{> ...}}.
#   TOTAL AUTHORED: physical files on disk, each counted once, NO twin dedup and
#                   NO expansion. Its job is to detect RELOCATION — content moved
#                   out of an always-on file must still show up somewhere. Under
#                   an always-on-only metric, moving 3,900 words into a skill
#                   scores identically to deleting them (Spec 1280 M0c).
#
# Usage:  scripts/measure-prompt-surface.sh [repo-root]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

# WORD COUNT IS DEFINED HERE, NOT DELEGATED TO `wc -w`.
#
# `wc -w` is NOT portable for this corpus. macOS/BSD wc in a UTF-8 locale counts
# `⚠️` (U+26A0 WARNING SIGN + U+FE0F VARIATION SELECTOR-16) as TWO words; GNU wc
# on Linux, `LC_ALL=C wc`, and Python's str.split() all count it as one. There
# are four such banners in spir/protocol.md alone, so the same commit measured
# 34,235 on a developer's Mac and 34,231 in CI.
#
# For an instrument whose entire purpose is an honest before/after comparison,
# a platform-dependent count is a correctness defect: measure "before" on one
# machine and "after" on another and the delta is fiction. So the definition is
# made explicit and deterministic — a word is a whitespace-delimited token of
# the UTF-8 decoded text, per Python's str.split().
#
# (The irony is recorded rather than smoothed over: the characters that broke
# portability are the `⚠️ BLOCKING` worst-case-padding banners that principle P7
# exists to delete.)
_count() { # count words on stdin, deterministically
  python3 -c 'import sys; print(len(sys.stdin.read().split()))'
}
w() { # word count of a file, 0 if absent
  [ -f "$1" ] || { echo 0; return; }
  _count < "$1"
}
wdir() { # word count of all .md under a dir, 0 if absent
  [ -d "$1" ] || { echo 0; return; }
  find "$1" -name '*.md' -exec cat {} + 2>/dev/null | _count
}
fdir() { # count of .md files under a dir
  [ -d "$1" ] && find "$1" -name '*.md' | wc -l | tr -d ' ' || echo 0
}

# --- Four-tier resolution, PER FILE (Spec 1280 M0 item b) --------------------
# Mirrors lib/skeleton.ts resolveCodevFile. The 1252 version did TWO-tier,
# DIRECTORY-level selection, so a project overriding a single prompt in .codev/
# while the rest resolved from the skeleton was measured at the wrong tier.
# Tier 3 (runtime cache) is not present in a checkout and is skipped here; it is
# a cache of tier 4, so it cannot change the resolved CONTENT for measurement.
resolve() {
  if   [ -f ".codev/$1" ];         then echo ".codev/$1"
  elif [ -f "codev/$1" ];          then echo "codev/$1"
  elif [ -f "codev-skeleton/$1" ]; then echo "codev-skeleton/$1"
  else echo /dev/null; fi
}

# SERVED words: {{> ...}} includes are expanded into the prompt, so the proxy
# must count them or dedup-by-include would claim phantom savings (it changes
# authored ownership, not served bytes). Extension-agnostic: the runtime
# resolver inlines any file type, including protocol.json (Spec 1280 P6).
#
# This performs REAL TEXTUAL SUBSTITUTION rather than adding the include's word
# count to the host file's. The 1252 version added, which double-counted the
# directive's own tokens (`{{>` and the path are 2 words to `wc -w`) on top of
# the content that replaces them — so every include over-reported by ~2 words
# and moving text into a template was not exactly neutral. Substituting makes
# the phantom-savings property exact, which is what T2 asserts.
# Mirrors lib/skeleton.ts resolveCodevIncludes EXACTLY: a regex replace of the
# directive *within* the surrounding text (not a line-wise swap — text sharing a
# line with an include must survive), recursive, depth-guarded at 5, with an
# unresolved include collapsing to empty.
expand_text() {
  python3 - "$1" <<'PY'
import re, sys, os
DIRECTIVE = re.compile(r'\{\{>\s*([^}\s]+)\s*\}\}')

def resolve(rel):
    for base in ('.codev', 'codev', 'codev-skeleton'):
        p = os.path.join(base, rel)
        if os.path.isfile(p):
            return p
    return None

def expand(text, depth=0):
    if depth > 5:
        return text
    def sub(m):
        p = resolve(m.group(1))
        if not p:
            return ''
        with open(p, encoding='utf-8', errors='replace') as fh:
            return expand(fh.read(), depth + 1)
    return DIRECTIVE.sub(sub, text)

path = sys.argv[1]
if os.path.isfile(path):
    with open(path, encoding='utf-8', errors='replace') as fh:
        sys.stdout.write(expand(fh.read()))
PY
}
expanded_w() { [ -f "$1" ] && expand_text "$1" | _count || echo 0; }

CLAUDE_MD=$(w CLAUDE.md)
AGENTS_MD=$(w AGENTS.md)
ARCH_CRIT=$(w codev/resources/arch-critical.md)
LESS_CRIT=$(w codev/resources/lessons-critical.md)
ARCH=$(w codev/resources/arch.md)
LESS=$(w codev/resources/lessons-learned.md)
HOT=$(( ARCH_CRIT + LESS_CRIT ))

# --- SHARED bucket -----------------------------------------------------------
# CLAUDE.md @imports the hot tier (#1119) rather than inlining it, so the hot
# words are ADDED here. AGENTS.md is excluded: byte-identical twin, one loads.
SHARED=$(( CLAUDE_MD + HOT ))

# --- ARCHITECT bucket --------------------------------------------------------
ARCHITECT_ROLE=$(w "$(resolve roles/architect.md)")
ARCHITECT=$ARCHITECT_ROLE

# --- Per-protocol buckets ----------------------------------------------------
BUILDER_ROLE=$(w "$(resolve roles/builder.md)")     # inlined at spawn (defect 2)
CONSULTANT_ROLE=$(w "$(resolve roles/consultant.md)")

protocols() { # every protocol in EITHER tree, unioned, deduped
  { ls -d codev/protocols/*/ 2>/dev/null; ls -d codev-skeleton/protocols/*/ 2>/dev/null; } \
    | xargs -n1 basename 2>/dev/null | sort -u
}

spawn_words() { # BUILDER_SPAWN[p] = builder role + wrapper + protocol.md
  local p="$1"
  echo $(( BUILDER_ROLE \
    + $(expanded_w "$(resolve "protocols/$p/builder-prompt.md")") \
    + $(expanded_w "$(resolve "protocols/$p/protocol.md")") ))
}

phase_mean() { # mean expanded phase prompt for protocol p, 0 if it has none
  local p="$1" total=0 n=0 f
  for f in $(ls "codev/protocols/$p/prompts/"*.md "codev-skeleton/protocols/$p/prompts/"*.md 2>/dev/null \
             | xargs -n1 basename 2>/dev/null | sort -u); do
    total=$(( total + $(expanded_w "$(resolve "protocols/$p/prompts/$f")") )); n=$(( n + 1 ))
  done
  [ "$n" -gt 0 ] && echo $(( total / n )) || echo 0
}

consult_mean() { # mean consult-type prompt for protocol p, 0 if it has none
  local p="$1" total=0 n=0 f
  for f in $(ls "codev/protocols/$p/consult-types/"*.md "codev-skeleton/protocols/$p/consult-types/"*.md 2>/dev/null \
             | xargs -n1 basename 2>/dev/null | sort -u); do
    total=$(( total + $(w "$(resolve "protocols/$p/consult-types/$f")") )); n=$(( n + 1 ))
  done
  [ "$n" -gt 0 ] && echo $(( total / n )) || echo 0
}

# --- TOTAL AUTHORED (relocation detector, M0 item g) -------------------------
# Physical files, no dedup, no expansion. Counts ALL FOUR skill trees: Spec 1280
# found .claude/skills and .codex/skills are byte-identical and the skeleton
# ships its own copies of both. Counting only .claude/skills would report
# content relocated into a skill as DELETED — inverting M0c.
SKILLS_CLAUDE=$(wdir .claude/skills)
SKILLS_CODEX=$(wdir .codex/skills)
SKILLS_SKEL_CLAUDE=$(wdir codev-skeleton/.claude/skills)
SKILLS_SKEL_CODEX=$(wdir codev-skeleton/.codex/skills)
SKILLS_ALL=$(( SKILLS_CLAUDE + SKILLS_CODEX + SKILLS_SKEL_CLAUDE + SKILLS_SKEL_CODEX ))
SKILLS_F_ALL=$(( $(fdir .claude/skills) + $(fdir .codex/skills) \
                 + $(fdir codev-skeleton/.claude/skills) + $(fdir codev-skeleton/.codex/skills) ))

AUTH_PROTO_CODEV=$(wdir codev/protocols);            AUTH_PROTO_SKEL=$(wdir codev-skeleton/protocols)
AUTH_ROLES_CODEV=$(wdir codev/roles);                AUTH_ROLES_SKEL=$(wdir codev-skeleton/roles)
TOTAL_AUTHORED=$(( CLAUDE_MD + AGENTS_MD + AUTH_PROTO_CODEV + AUTH_PROTO_SKEL \
                   + AUTH_ROLES_CODEV + AUTH_ROLES_SKEL + SKILLS_ALL ))

# --- DEAD --------------------------------------------------------------------
DEAD_W=$(wdir codev-skeleton/porch/prompts); DEAD_F=$(fdir codev-skeleton/porch/prompts)

# --- Headline ----------------------------------------------------------------
# ALWAYS_ON_WORDS == ALWAYS_ON(builder, spir, I). I is a COMPARISON CONSTANT,
# identical before and after; it is not a claim about any real project.
PHASE_ITERS="${PHASE_ITERS:-10}"
HEADLINE_PROTO="${HEADLINE_PROTO:-spir}"
SPAWN_SPIR=$(spawn_words "$HEADLINE_PROTO")
PHASE_MEAN_SPIR=$(phase_mean "$HEADLINE_PROTO")
ALWAYS_ON=$(( SHARED + SPAWN_SPIR + PHASE_ITERS * (HOT + PHASE_MEAN_SPIR) ))
ALWAYS_ON_ARCHITECT=$(( SHARED + ARCHITECT ))
ALWAYS_ON_CONSULTANT=$(( CONSULTANT_ROLE + $(consult_mean "$HEADLINE_PROTO") ))

cat <<EOF
# Prompt-surface measurement

Commit: \`$(git rev-parse --short HEAD 2>/dev/null || echo n/a)\`
Instrument: corrected under Spec 1280 (M0). Supersedes the Spec 1252 version.

## Exclusive buckets (partition the authored surface; these SUM)

| Bucket | Words |
|---|---:|
| SHARED (CLAUDE.md + transcluded hot tier) | $SHARED |
| ARCHITECT (roles/architect.md) | $ARCHITECT |
| DEAD (codev-skeleton/porch/prompts, $DEAD_F files) | $DEAD_W |

## Per-protocol (resolved per file, four-tier)

| Protocol | BUILDER_SPAWN | PHASE mean | CONSULT mean |
|---|---:|---:|---:|
EOF
for p in $(protocols); do
  printf "| %s | %s | %s | %s |\n" "$p" "$(spawn_words "$p")" "$(phase_mean "$p")" "$(consult_mean "$p")"
done

cat <<EOF

## Derived audience loads (these OVERLAP by design — never sum them)

    HOT                      = arch-critical($ARCH_CRIT) + lessons-critical($LESS_CRIT) = $HOT
    ALWAYS_ON(builder,p,I)   = SHARED + BUILDER_SPAWN[p] + I x (HOT + mean PHASE[p])
    ALWAYS_ON(architect)     = SHARED + ARCHITECT
    ALWAYS_ON(consultant,p)  = roles/consultant.md + mean CONSULT-type[p]

| Audience | Words |
|---|---:|
| **Builder ($HEADLINE_PROTO, I=$PHASE_ITERS)** — the headline | **$ALWAYS_ON** |
| Architect (per session) | $ALWAYS_ON_ARCHITECT |
| Consultant (per review, $HEADLINE_PROTO) | $ALWAYS_ON_CONSULTANT |

## Total authored surface (relocation detector — different basis, see header)

| Component | Words |
|---|---:|
| CLAUDE.md + AGENTS.md (no twin dedup here) | $(( CLAUDE_MD + AGENTS_MD )) |
| codev/protocols + codev-skeleton/protocols | $(( AUTH_PROTO_CODEV + AUTH_PROTO_SKEL )) |
| codev/roles + codev-skeleton/roles | $(( AUTH_ROLES_CODEV + AUTH_ROLES_SKEL )) |
| skills, ALL FOUR trees ($SKILLS_F_ALL files) | $SKILLS_ALL |
| **TOTAL_AUTHORED** | **$TOTAL_AUTHORED** |

Reference (on-demand, not always-on): arch.md $ARCH, lessons-learned.md $LESS.

ALWAYS_ON_WORDS=$ALWAYS_ON
TOTAL_AUTHORED_WORDS=$TOTAL_AUTHORED
EOF
