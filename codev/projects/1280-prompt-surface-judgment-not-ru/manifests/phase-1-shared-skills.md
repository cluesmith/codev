# Phase 1 — CLAUDE.md/AGENTS.md + four-tree skill relocation (G2)

**Decisions**: 1 (CLAUDE.md/AGENTS.md are one decision, two byte-identical files)
**Rollback group**: G2 · commit-pure
**Suite**: green · **Build**: rerun (`copy-skeleton` — skeleton edits are otherwise invisible to tests)

## Batch 1 — 10 files

| File | Old | New | Principles | Rationale |
|---|---:|---:|---|---|
| `CLAUDE.md` | 5815 | 1417 | P1, P3, P4, P7 | Contracts kept, procedure deleted. See breakdown below. |
| `AGENTS.md` | 5815 | 1417 | P1, P3, P4, P7 | Byte-identical twin of the above (T7). |
| `.claude/skills/runnable-worktrees/SKILL.md` | 0 | 926 | P3, P4 | **New destination.** Receives the entire Runnable Worktrees section — config block, `afx dev` CLI, VSCode controls, URL/cleanup semantics, 7 stack recipes. Needed rarely, was loaded always. |
| `.codex/skills/runnable-worktrees/SKILL.md` | 0 | 926 | P3, P4 | Four-tree copy (T17). |
| `codev-skeleton/.claude/skills/runnable-worktrees/SKILL.md` | 0 | 926 | P3, P4 | Four-tree copy — adopters receive it via `codev update`. |
| `codev-skeleton/.codex/skills/runnable-worktrees/SKILL.md` | 0 | 926 | P3, P4 | Four-tree copy. |
| `.claude/skills/codev/SKILL.md` | 326 | 529 | P4 | Receives Local Build Testing, the directory map, and the tokei metrics line — tool how-tos belong with the tool. |
| `.codex/skills/codev/SKILL.md` | 326 | 529 | P4 | Four-tree copy (T17). |
| `codev-skeleton/.claude/skills/codev/SKILL.md` | 326 | 529 | P4 | Four-tree copy. |
| `codev-skeleton/.codex/skills/codev/SKILL.md` | 326 | 529 | P4 | Four-tree copy. |

Supporting (new test, not a prompt surface):
`packages/codev/src/__tests__/spec-1280-skills-parity.test.ts` — **T17**.

## What was deleted vs relocated (M0c)

| | Words |
|---|---:|
| CLAUDE.md before | 5,815 |
| CLAUDE.md after | 1,417 |
| **Removed from always-on** | **4,398** |
| ↳ **relocated** to skills (`runnable-worktrees` 926 + `codev` +203) | 1,129 |
| ↳ **deleted** outright | 3,269 |

Relocation is written to **four** trees, so authored total falls by less than always-on —
which is the honest picture and exactly what T15 exists to expose.

- `ALWAYS_ON_WORDS`: 34,231 → **29,833** (−4,398)
- `TOTAL_AUTHORED_WORDS`: 153,219 → **148,925** (−4,294)

## What was deleted, and why it was safe

| Cut | Principle | Reasoning |
|---|---|---|
| "Before Starting ANY Task" (check for existing PRs/issues/git log, with bash) | P1 | A frontier model checks for prior art without being told; the hot tier already carries "check for existing work" as a lesson. |
| "When Stuck: STOP After 15 Minutes" + rathole warning signs | P1 | Judgment, and duplicated by the hot-tier lesson "when stuck, get an outside model's perspective". |
| "Understand Before Coding" | P1 | Restates what a competent agent does. |
| Duplicated 🚨 blocks (worktree destruction ×2, `afx` from root ×2, `git add -A` ×3) | P7 | Each survives **once**, verbatim, under *Irreversible acts*. Repetition was worst-case padding for weaker models. |
| CLI Command Reference — six doc links | P4 | Each CLI has a skill; the pointer list was a table of contents for content that is already addressable by name. |
| Agent Responsiveness table (4 rows of examples) | P1, P2 | Reduced to the rule: run anything over ~5s in the background. |
| cmap walkthrough (4 numbered steps) | P4 | One sentence + the `consult` skill. |
| Porch command list, Architect-Builder prose, messaging examples | P4 | Contract kept (addressing table, spoofing rule); walkthroughs dropped. |
| "Important Notes", "Core Workflow" numbered restatements | P1, P7 | Restated the protocol table immediately above them. |

## What was deliberately kept

- **All eight scar canonicals, verbatim and unwrapped** — verified byte-for-byte against
  `builder/spir-1252:codev/resources/scar-rules.yaml`. My first draft reflowed them across
  lines, which broke exact-match; canonicals must stay on one line.
- The generated hot-context block, byte-for-byte (`codev init`/`update` owns it).
- Repository dual nature, four-tier resolution, deliver-don't-fetch — the facts a wrong
  assumption about which would corrupt a whole change.
- Gate semantics and the approval frontmatter contract.
- `area/*` policy (compressed to the rule + the label list).
- Consultation defaults, including the load-bearing `-sol` model-id suffix.
- Commit/branch formats and the never-squash rule.

## M10 — assertions retired: **none**

`spec-1273-wait-discipline-docs`, `governance-sweep`, `framework-ref-audit` and
`template-delivery` all pass **unmodified**. The `afx` skill was deliberately **not** touched:
relocating messaging content into it would have obliged me to resolve its pre-existing
repo-vs-skeleton drift (and propagate its stale `tick` references to adopters), which is the
architect's separate issue. The addressing *contract* stayed in CLAUDE.md instead — it is a
policy, not a how-to, so P4 does not apply. **Flagged as a judgment call rather than made
silently.**

## Scope note

`roles/*.md` are **Phase 2** (groups G6/G3/G5), not this phase — Phase 1 is G2 only, so the
commit stays group-pure and a G2 revert cannot pull role work out with it.
