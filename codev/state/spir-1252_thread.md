# spir-1252 — Prompt architecture: single-owner rule

## Specify phase — measurement first

Before drafting, I measured the actual prompt surface rather than trusting the
issue's "~45k words / 4–6 duplicates" estimate. Two findings changed the shape
of the spec.

### Finding 1: the real duplication axis is the `codev/` ↔ `codev-skeleton/` shadow tree

The issue lists CLAUDE.md/AGENTS.md, hot-tier docs, protocols, phase prompts,
roles, skills. It never mentions the largest one: **63 markdown files
(45,183 words) exist in BOTH `codev/protocols/` and `codev-skeleton/protocols/`**,
plus `codev/roles/` ↔ `codev-skeleton/roles/`.

This is not benign. Tier 2 (`codev/`) *wins* over tier 4 (skeleton) in the
four-tier resolver, so our self-hosted instance runs on the local copies —
and **19 of them have drifted** from the skeleton.

### Finding 2: the drift is live and it bit this very builder

`codev/protocols/spir/builder-prompt.md` (636 words, served) is missing the
entire **"Multi-PR Mechanics"** and **"## Verify Phase"** sections that
`codev-skeleton/protocols/spir/builder-prompt.md` (824 words, shipped) has.

My own spawn prompt has no verify-phase instructions. Adopters get them; we
don't. That is the drift failure mode, demonstrated, not hypothesized.

`codev/protocols/spir/protocol.md` differs from the skeleton by 138 diff lines.
Last touched by the same merge commit (d49f5f47, 2026-06-13) — they were forked
and left to rot.

### Finding 3: duplication count is worse than the issue estimated

The `git add -A` prohibition appears in **18 logical locations** (36 files
counting the shadow mirror), in **9 distinct wordings** — from
"Never `git add -A` / `.` / `--all` — stage files explicitly" to a full
"🚨 ABSOLUTE PROHIBITION 🚨" block. Not 4–6; and the wording variance is the
ambiguity cost the issue predicts.

### Measured surface (words)

| Surface | Words | Files | Load |
|---|---|---|---|
| CLAUDE.md | 5,773 | 1 | every session, auto |
| AGENTS.md | 5,773 | 1 | byte-identical twin |
| arch-critical + lessons-critical (HOT) | 736 | 2 | in CLAUDE.md *and* every phase prompt |
| arch.md + lessons-learned.md (COLD) | 41,510 | 2 | on demand |
| codev-skeleton (all) | 77,956 | 113 | resolver-dependent |
| codev/protocols (shadow) | 47,511 | 66 | wins over skeleton |
| .claude/skills | 16,743 | 14 | on demand |
| my actual spawn prompt | 4,891 | — | once per builder |
| my actual porch phase task | 1,395 | — | per phase iteration |

### Consequence for the spec

The issue framed this as a compression problem ("token cost"). The measurement
says the *drift* problem is bigger and more urgent than the token problem, and
that the shadow tree is where both concentrate. I am specifying accordingly:
ownership map + shadow-tree elimination first, compression second. Deduplication
of scar rules stays off the table per the issue.

Existing enforcement machinery to build on (not reinvent): `governance-sweep`,
`hot-tier`, `skeleton`, `protocol-prompt-audit`, `framework-ref-audit`,
`skill-parity` test suites.
