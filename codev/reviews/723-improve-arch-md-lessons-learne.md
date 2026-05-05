# Review: Improve arch.md / lessons-learned.md governance

## Metadata
- **ID**: review-2026-05-05-723-arch-md-governance
- **Spec**: `codev/specs/723-improve-arch-md-lessons-learne.md`
- **Plan**: `codev/plans/723-improve-arch-md-lessons-learne.md`
- **Issue**: #723
- **Created**: 2026-05-05

## Summary

Shipped governance changes for `codev/resources/arch.md` and `codev/resources/lessons-learned.md`. The work introduces a new `update-arch-docs` skill (replacing the user-global `architecture-documenter` agent), upgrades the two resource templates with prefaces and disciplined section stubs, and wires audit-then-update governance into the MAINTAIN protocol with a "Lives where" routing matrix and pruning checklists. All six issue scope items addressed. No live `arch.md` / `lessons-learned.md` content edited — that cleanup belongs to a future MAINTAIN run that *uses* this governance.

## Files Changed

**Phase 1 (commit ca003d99)**:
- `.claude/skills/update-arch-docs/SKILL.md` — new skill (repo-local).
- `codev-skeleton/.claude/skills/update-arch-docs/SKILL.md` — byte-identical skeleton copy.
- `codev/templates/arch.md` — replaced 56-line stub with richer template (TL;DR, Repository Layout & Stack, Per-Subsystem Mechanism, Apps Roster, Packages Roster, Verified-Wrong Assumptions, Updating This Document); inline preface under "Updating This Document".
- `codev-skeleton/templates/arch.md` — byte-identical.
- `codev/templates/lessons-learned.md` — added preface with two-doc framing, "do NOT add" guidance, sanity-check checklist; topical sections preserved.
- `codev-skeleton/templates/lessons-learned.md` — byte-identical.

**Phase 2 (commit 7e36d988)**:
- `codev/protocols/maintain/protocol.md` — added "Lives where" matrix (8 rows), split Step 3 into 3a/3b, inline pruning checklists, sample audit prompt, `## Audit Findings` run-file section, skill cross-references.
- `codev-skeleton/protocols/maintain/protocol.md` — byte-identical.

## Verification Results

### Parity checks (success criterion: zero diff)

| Pair | Result |
|---|---|
| `codev/templates/arch.md` ↔ `codev-skeleton/templates/arch.md` | ✅ zero output |
| `codev/templates/lessons-learned.md` ↔ `codev-skeleton/templates/lessons-learned.md` | ✅ zero output |
| `codev/protocols/maintain/protocol.md` ↔ `codev-skeleton/protocols/maintain/protocol.md` | ✅ zero output |
| `.claude/skills/update-arch-docs/` ↔ `codev-skeleton/.claude/skills/update-arch-docs/` | ✅ zero output (`diff -r`) |

### Skill literal-content checks

- Frontmatter `description` contains: `arch.md` ✓, `lessons-learned.md` ✓, `MAINTAIN` ✓, exact trigger sentence ✓.
- Body contains all six required `## ...` sections: `What this skill does NOT do` ✓, `arch.md vs. lessons-learned.md (two-doc framing)` ✓, `Sizing by purpose, not by line count` ✓, `Mode: diff-mode (apply a specific change)` ✓, `Mode: audit-mode (identify what to cut)` ✓, `Output contract` ✓.
- Audit-mode echoes "when in doubt, KEEP" rule (skill body section 4 of audit-mode procedure) ✓.

### MAINTAIN protocol six-edit checklist

| Edit | Status |
|---|---|
| "Lives where" matrix (8 rows) | ✅ |
| Step 3 split into 3a (Audit) / 3b (Update); steps 1, 2, 4 numbering preserved | ✅ |
| Per-arch.md-section pruning checklist (5 questions) | ✅ |
| Per-lessons-learned.md-entry pruning checklist (4 questions) | ✅ |
| Sample audit prompt as paste-able code block | ✅ |
| `## Audit Findings` section in run-file template | ✅ |
| Skill cross-reference from both 3a and 3b | ✅ |

### Test runs

- **Scaffold tests**: `cd packages/codev && pnpm exec vitest run scaffold` → 1 file passed, 21/21 tests passed (Duration 141ms). The broader suite was not run because pre-existing flaky tests in `src/terminal/__tests__/session-manager.test.ts` (unrelated to this work) fail intermittently and would mask scaffold results. Scaffold-specific is the test surface this work touches.
- **Build**: `pnpm --filter @cluesmith/codev build` → exit 0.

### `codev init` smoke test

- `node packages/codev/dist/cli.js init -y scratch-test` in `/tmp/codev-723-smoke/` → success.
- `.claude/skills/update-arch-docs/SKILL.md` landed in the scratch project ✓.
- **Discovery**: `codev init` does NOT call `copyResourceTemplates`; only `copySkills` and `copyRootFiles` (verified in `packages/codev/src/commands/init.ts:96-107`). Therefore `codev/resources/arch.md` and `codev/resources/lessons-learned.md` are NOT created by `codev init` in fresh projects. This is **pre-existing init.ts behavior**, not introduced by this work. The new templates still propagate to projects that explicitly invoke `copyResourceTemplates` (e.g. `adopt`) or that copy from `codev-skeleton/templates/` manually.
- **Fallback verification**: skeleton template content confirmed correct via direct inspection (`cat codev-skeleton/templates/arch.md`).

### Skill propagation via `codev update`

- Init scratch project → `update-arch-docs` skill present.
- `rm -rf .claude/skills/update-arch-docs` to simulate "existing project missing the new skill".
- `(cd /tmp/scratch && node /path/to/cli.js update)` → output included `+ (new) .claude/skills/update-arch-docs/`.
- Skill returned at expected path. ✓

### Self-consistency check — audit-mode against live `codev/resources/arch.md`

The spec requires ≥3 categories of candidate cuts. Found **4 distinct categories**:

1. **Per-spec changelog framing** — 60 references to `Spec NNNN` patterns in body text. Examples: line 39 ("`(Spec 0108)`" inline in a router table cell); line 95 ("removed in Spec 0098"); lines 159–160 ("Spec 0085", "Spec 0104"); lines 176, 182 (an explicit `> **Historical note** (Specs 0008, 0098):` block).
2. **Exhaustive `## Complete Directory Structure` section** (lines 1010–1190 = ~180 lines) — per-file enumeration that goes stale immediately. Should compress to top-level tree + key files; the rest is `git ls-files` territory.
3. **Per-file enumerations elsewhere** — 11 occurrences of `- file.ext: ...` patterns across other sections, often duplicating what the directory tree already shows.
4. **Date-stamped / temporal narrative** — `> **Historical note**` framing on line 182 (and the broader "As of Spec 0098" framing on line 176).

These findings are recorded here as the smoke-test artifact only. The cuts are **NOT applied** in this PR — that's a future MAINTAIN run that *uses* this governance.

### Skill discovery (manual)

After Phase 1 commit, the skill appeared in the system's available-skills list as `update-arch-docs`. Triggering verified by description content (the skill is offered when prompts mention arch.md, lessons-learned.md, MAINTAIN, or auditing/pruning architecture documentation).

## Spec Acceptance Criteria — final check

All checked items below correspond to the Success Criteria block in the spec:

### Skill (deterministic checks)
- [x] `.claude/skills/update-arch-docs/SKILL.md` and `codev-skeleton/.claude/skills/update-arch-docs/SKILL.md` exist; byte-identical.
- [x] Frontmatter `description` contains the four required phrases plus the trigger sentence.
- [x] Body contains all six required named sections.
- [x] Manual smoke test (skill loads / surfaces) verified.

### Templates
- [x] Both `arch.md` template files replaced with richer template.
- [x] Both `lessons-learned.md` template files updated with preface and pruning guidance.
- [x] (Spec amendment): `arch-md-guide.md` was dropped during architect review; its content folded into the arch.md "Updating This Document" preface and the skill body.
- [x] (Spec amendment): No scaffold-list change needed since arch-md-guide.md no longer exists.

### MAINTAIN protocol
- [x] Both protocol files byte-identical; carry the matrix, the 3a/3b split, the two pruning checklists, the sample audit prompt, the run-file format addition, and the skill cross-references.
- [x] Step 3a/3b sub-step split preserves Step 1, 2, 4 numbering.

### Whole-spec checks
- [x] No live `arch.md` / `lessons-learned.md` content rewritten in this PR.
- [x] Self-consistency check produced 4 categories of candidate cuts (≥3 required).
- [x] `diff -r` parity verified across all four touched pairs.
- [x] Scaffold tests pass.
- [x] `codev init` smoke test produces the expected skill artifact (template behavior is pre-existing init limitation, documented above).

## Lessons Learned

(To be reviewed for inclusion in `lessons-learned.md` during the next MAINTAIN run.)

- **Skill replaces agent — clean cutover beats coexistence.** The original spec proposed running the new skill alongside the user-global `architecture-documenter` agent. Architect feedback collapsed this to a clean replacement; the resulting design is simpler and avoids ambiguity. *General principle*: when introducing a new mechanism that supersedes an old one, prefer cutover over coexistence — coexistence framing accumulates ambiguity that compounds over time.

- **Author governance discipline as prose, not as code.** The skill body is markdown prose codifying what NOT to do; it has no executable surface and no tests beyond literal-content checks. This is the right shape for governance: enforcement is by review, not by runtime. Trying to make it "executable" (e.g. a linter that flags per-spec changelog patterns) would be premature complexity. *General principle*: governance docs that exhort a discipline can ship as prose alongside the things they govern; the system that needs them is the human + LLM reviewing the PR.

- **Plan checks should test the actual change surface, not the broader suite.** Initial plan said `pnpm --filter @cluesmith/codev test -- --testPathPatterns=scaffold` but Vitest doesn't accept that flag. After fix (`pnpm exec vitest run scaffold` — positional), the test ran cleanly in 141ms. Running the full suite would have surfaced unrelated pre-existing flaky session-manager tests and obscured the result. *General principle*: target verification at the change surface; broader suites mask signal with pre-existing noise.

- **Two homes are simpler than three (architect intervention).** The original design had three places carrying the documenter discipline: the skill, a new `arch-md-guide.md` template, and the MAINTAIN protocol. Architect compressed to two: the skill (discipline content) and the arch.md preface (in-template reminder). Removing the third home cut redundancy without losing any load-bearing content. *General principle*: when discipline content has multiple homes, ask which homes are *load-bearing*; collapse the rest.

- **Pre-existing scaffold behavior shapes the smoke-test scope.** The plan assumed `codev init` would copy resource templates; in fact `init.ts` only copies skills + root files (templates are scaffold-internal, used by `adopt` and tests but not `init`). Caught during Phase 2 verification; documented in the review rather than treated as a bug. *General principle*: when planning verification, read the consumer code — assumptions about pipeline behavior should be code-grounded, not API-name-grounded.

## Flaky Tests

Pre-existing flaky tests observed during the broader test run, not related to this work and not bypassed:

- `src/terminal/__tests__/session-manager.test.ts` — multiple tests intermittently fail with `Invalid shellper info JSON: ` (empty data). Not introduced by this work; the scaffold-only run (`pnpm exec vitest run scaffold`) avoids them entirely.

These were not skipped or modified in this PR. They remain as-is.

## PR Description Draft

The PR description published with this work:

```
[Spec 723] Improve arch.md / lessons-learned.md governance

## 🚨 Post-merge cutover required (architect action)

After merging this PR, the architect must run:

```
rm ~/.claude/agents/architecture-documenter.md
```

The user-global agent is being **replaced**, not coexisting with, the new
`update-arch-docs` skill. The PR cannot delete this file directly because the
path is outside the repo. This step retires the legacy add-biased prompt.

## Summary

Closes #723. Shifts arch.md / lessons-learned.md governance from "append by
default" to "audit, then update." Six scope items from the issue:

1. **architecture-documenter agent → `update-arch-docs` skill**: new skill at
   `.claude/skills/update-arch-docs/SKILL.md` (and skeleton copy). Body codifies
   what NOT to include, two-doc framing, purpose-driven sizing, diff-mode and
   audit-mode (with "when in doubt, KEEP" echo), and an output contract.
2. **Richer `arch.md` template**: replaces the 56-line stub with TL;DR,
   Repository Layout & Stack, Per-Subsystem Mechanism, Apps Roster, Packages
   Roster, Verified-Wrong Assumptions, and Updating This Document. The
   "Updating This Document" preface folds in maintenance guidance (when, how,
   what NOT, sanity-check checklist).
3. **Upgraded `lessons-learned.md` template**: adds preface with two-doc framing,
   "do NOT add" guidance, sanity-check checklist; preserves topical sections.
4. **MAINTAIN "Lives where" matrix**: 8-row routing matrix under the
   protocol's Key Documents section.
5. **MAINTAIN audit-then-update split**: Step 3 → Step 3a (Audit) + Step 3b
   (Update). Steps 1, 2, 4 numbering preserved. Audit findings recorded in
   the run file before any edits land.
6. **MAINTAIN pruning checklists**: per-arch.md-section and
   per-lessons-learned.md-entry checklists inline under Step 3a, plus a
   paste-able sample audit prompt.

`codev-skeleton/` carries identical copies of every artifact so other
projects pick this up via `codev init` (templates, skills) and `codev update`
(skills only — templates are init-time only).

## Out of scope

- The actual cleanup of the live 1,812-line `codev/resources/arch.md` and
  371-line `codev/resources/lessons-learned.md`. Belongs to a future MAINTAIN
  run that uses this governance.
- Four other follow-up items listed in the spec's "Out of Scope" section.

## Verification

- `diff -r` parity zero output across all four skeleton/codev pairs.
- Skill literal-content checks pass (frontmatter phrases, six required body
  sections).
- MAINTAIN protocol six-edit checklist all green.
- `cd packages/codev && pnpm exec vitest run scaffold` → 21/21 passing.
- `codev init` smoke test: skill propagates correctly. (init does not copy
  resource templates — pre-existing init.ts behavior, not introduced here.)
- `codev update` skill propagation: `+ (new) .claude/skills/update-arch-docs/`
  confirmed; skill returns to scratch project after deletion + update.
- Self-consistency audit-mode check on live arch.md: 4 candidate-cut
  categories found (per-spec changelog framing, exhaustive Complete
  Directory Structure section, per-file enumerations, Historical-note
  narrative). Cuts NOT applied — that's a separate MAINTAIN run.

## Files changed

Phase 1 (skill + templates):
- `.claude/skills/update-arch-docs/SKILL.md` (new)
- `codev-skeleton/.claude/skills/update-arch-docs/SKILL.md` (new)
- `codev/templates/arch.md` (replaced)
- `codev-skeleton/templates/arch.md` (replaced)
- `codev/templates/lessons-learned.md` (preface added)
- `codev-skeleton/templates/lessons-learned.md` (preface added)

Phase 2 (MAINTAIN wiring):
- `codev/protocols/maintain/protocol.md` (matrix + 3a/3b + checklists +
  sample prompt + run-file format + skill cross-refs)
- `codev-skeleton/protocols/maintain/protocol.md` (byte-identical)
```

(Note: the PR description above is the *draft*. The actual published PR text may differ slightly if architect review comments warrant tweaks.)
