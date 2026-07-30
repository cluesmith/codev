# bugfix-1279 — SPIR spec template is dead code

Issue #1279: `codev-skeleton/protocols/spir/templates/spec.md` exists but nothing
delivers or enforces it. Audit mandate: check *all* template references across
*all* protocols before fixing one.

## Investigate — findings

The delivery mechanism already exists. Spec 1011 introduced
`{{> <codev-path>}}` includes (`resolveCodevIncludes()` in `lib/skeleton.ts`),
resolved on two channels: at spawn inside `protocol.md`, and in porch's
`loadPromptFile()` for phase prompts. It was applied to 3 of the 9 shipped
templates and never generalized — nothing enforces that a `templates/*.md` file
has a consumer.

### Full template-delivery audit (codev-skeleton/protocols)

| Template | Delivered? | How / why not |
|---|---|---|
| `spir/templates/plan.md` | YES | `{{> }}` in `spir/prompts/plan.md` |
| `spir/templates/spec.md` | **NO** | `prompts/specify.md` describes content in prose only — the reported bug |
| `spir/templates/review.md` | **NO** | `prompts/review.md` carries a *divergent hand-rolled inline copy* |
| `aspir/templates/plan.md` | **NO** | byte-identical dup; `aspir/prompts/plan.md` includes **spir's** template |
| `aspir/templates/spec.md` | **NO** | byte-identical dup, zero consumers |
| `aspir/templates/review.md` | **NO** | byte-identical dup, zero consumers |
| `maintain/templates/maintenance-run.md` | **NO** | `maintain/protocol.md` carries a divergent inline copy |
| `experiment/templates/notes.md` | YES | `{{> }}` in `experiment/protocol.md` |
| `spike/templates/findings.md` | YES | `{{> }}` in `spike/protocol.md` |

PIR/AIR/BUGFIX/RESEARCH ship no `templates/` dir — their prompts carry structure
inline by design. Not dead code (no orphaned file), so out of scope.

### The drift is real, not theoretical

Both inline copies have already diverged from the template they duplicate:

- `spir/prompts/review.md`'s block is missing `## Key Metrics`, `## Timelog`,
  `## Consultation Iteration Summary`, `## Architecture Updates`,
  `## Lessons Learned Updates`; the template is missing `## Flaky Tests`.
- `maintain/protocol.md`'s block has `## Audit Findings`; the template doesn't.

### Gate enforcement is weaker than the issue states

The issue says the `spec-approval` gate "checks only that the spec file exists."
It checks **nothing** — `specify` has `"checks": {}` in both `spir/protocol.json`
and `aspir/protocol.json`. (`plan` has three checks; `review` has four.)

### Root cause

An authored artifact with no owning consumer. The `{{> }}` mechanism landed for
three templates and no invariant was written that every template must be
delivered — so six templates rot silently while builders pattern-match the
previous artifact's shape.

## Fix shape

1. Wire the dead-but-live templates via `{{> }}` (spec, review, maintenance-run).
   Merge the drifted content into the canonical template first so nothing is lost.
2. Delete the three byte-identical `aspir/templates/*` duplicates; ASPIR already
   points at SPIR's templates for plans.
3. Regression test: enumerate every `protocols/*/templates/*.md` and assert each
   is reachable via a `{{> }}` include. Fails today, passes after (1)+(2).
4. Structure focus area in `consult-types/spec-review.md`.
5. Porch `specify`-phase checks (`spec_exists`, `spec_has_required_sections`).

Mirrored in BOTH trees — PR #1278 (Spec 1252) closed **unmerged**, so the
`codev/protocols/` shadow copies still exist and are currently in sync with the
skeleton. Keeping them in sync is mandatory.

**LOC note**: deletion-dominated. ~916 lines of the diff are the six dead
duplicate files (3 templates x 2 trees). Notified the architect.

## Fix — done

All five fix items landed, mirrored across `codev/` and `codev-skeleton/`.

- `spir` + `aspir` `prompts/specify.md`: `{{> protocols/spir/templates/spec.md}}`
  under `## Output`. Written as a **pure addition** (the original sentence is
  untouched) — Spec 746 freezes baselines for these four files and rejects any
  edit that modifies an existing line. Found this the hard way; worth knowing
  before editing `specify.md` / `implement.md` / the consult-types.
- `spir` + `aspir` `prompts/review.md`: the divergent 48-line inline block
  replaced by `{{> protocols/spir/templates/review.md}}`. `## Flaky Tests` and
  `### Methodology Improvements` (present only in the prompt copy) merged into
  the canonical template first.
- `maintain/protocol.md`: inline run-file block replaced by an include;
  `## Audit Findings` and the changes-log example row merged into the template
  first. Note the template was already the *superset* — it carried
  `### Dependencies Cleaned`, which the inline copy had dropped, so maintain
  builders have been missing that heading.
- Deleted `aspir/templates/{spec,plan,review}.md` in both trees after sha256
  byte-identity proof (per file, per tree, cross-tree, hashed from `git show
  HEAD:` so in-flight edits couldn't confound it).
- `spec-review.md` consult type (both protocols): new Structure focus area.
- `specify` phase in `spir`/`aspir` `protocol.json`: `spec_exists` +
  `spec_has_required_sections`, backed by new `runArtifactCheck` cases.

### Two things worth passing on

**The enforcement test caught my own bug.** I wrote a literal
`{{> protocols/spir/templates/<name>.md}}` inside backticks in `aspir/protocol.md`
prose to explain the mechanism. `resolveCodevIncludes` does a blind regex
replace — it would have expanded that to empty at delivery, silently deleting
the paragraph. The dangling-include half of the test flagged it immediately.
Do not write a literal include directive in prose in any file that gets served
through the resolver.

**Editing `protocol.json` with `json.dump` is a trap.** Round-tripping
reserialized the whole file: `→` became `→`, and every inline array
(`["gemini", "codex", "claude"]`) reflowed to multi-line. 49 lines of churn for
a 10-line change. Reverted and did a surgical string insert against a unique
anchor instead — 10 lines, exactly the intended diff.

### Verification

- `pnpm build`: clean.
- Full unit suite: **3787 passed / 48 skipped / 0 failed** (193 files), re-run
  after the last doc edit. No flaky tests encountered, nothing skipped by me.
- End-to-end through the *real* four-tier resolver (not just the test's
  synthetic call): all five includes expand, zero `{{>` residue, spec prompt
  grows 4.6KB → 9.65KB with the template attached. Served from tier 2
  (`codev/`) in this repo, as expected.
- Live mutation demo: seeded an orphan template into the real skeleton, ran the
  real test, watched it fail with the file named; removed it.

### Left alone deliberately

`codev/protocols/maintain/templates/{audit-report,lessons-learned}.md` — also
unreferenced, but local-only with no skeleton counterpart, and explicitly
preserved by an architect T8 ruling in the 1252 shadow-tree audit. Exempted in
the test with that reason in a comment rather than reversed unilaterally.
Flagged as follow-up in the PR.

## PR + CMAP

PR #1283. CMAP: gemini=APPROVE, codex=REQUEST_CHANGES, claude=APPROVE.

**Codex was right and I'd overclaimed.** Its finding: my enforcement test scanned
*every* `.md` under `protocols/` for includes, so an include mentioned in a
consult-type would have counted as "this template has a consumer" — but only
`prompts/*.md` and `protocol.md` actually get `resolveCodevIncludes` run over
them. I verified the premise before acting on it (`commands/consult/index.ts`
loads consult-types with plain `readCodevFile`), and it holds: an include there
is never expanded, reaching the model as literal text while the template stays
unreachable. The test was weaker than the PR body's claim.

Rewrote `findOrphanedTemplates` as reachability-from-delivery-roots with
transitive include-following, added `findUnresolvedIncludeSites`, and added a
mutation test reproducing Codex's exact scenario. Re-ran the live seeded-orphan
demo after tightening to confirm the mutation check still has teeth.

Gemini's APPROVE landed in 11.6s and mostly restated my PR body — logged as
APPROVE but weighted as low-information. Claude's was substantive (independently
re-verified mirror parity on disk).

**Self-initiated fix, no reviewer asked for it.** I'd picked the
`spec_has_required_sections` headings by reading the template rather than by
measuring anything. Checked the guess against the repo's 166 real specs (last 40,
the mature-SPIR corpus): `## Solution Approaches` is absent from **30%** of them
and `## Open Questions` from 15%. Gating on those would have failed a third of
legitimate specs and taught people to route around the gate. Narrowed the hard
check to the four headings recent practice honors 88-100% of the time; the other
two stay advisory in the consult type. Added a calibration guard test.

**Process note worth remembering**: I ran the full suite once from the repo root
and got "224 failed" — that's vitest picking up all 325 workspace test files, not
a regression. CLAUDE.md says it: never run npm/test commands from the repo root,
run them from `packages/codev`. Package-scoped run was green throughout.

Final: 3793 passed / 48 skipped / 0 failed. Awaiting the `pr` gate.

## Merged

PR #1283 merged 2026-07-29T11:26:39Z as merge commit `54118ef0` (regular merge,
not squash). Issue #1279 auto-closed by `Fixes #1279`.

Verified live on `main` after the merge, not just assumed from a green PR: all
three new includes are present in the shipped skeleton
(`spir/prompts/specify.md:95`, `spir/prompts/review.md:62`,
`maintain/protocol.md:190`) and `codev-skeleton/protocols/aspir/` no longer has
a `templates/` directory.

### Merge path — worth recording for the next builder

The porch `pr` gate approving is **not** sufficient to merge in this repo.
GitHub branch protection on `main` independently requires:

- 1 approving review (`reviewDecision: REVIEW_REQUIRED`) — a builder cannot
  self-approve its own PR; bypass allowance is limited to `waleedkadous` and
  `amrmelsayed`
- 6 status checks: Unit Tests, CLI Tests (ubuntu + macos), CLI Integration
  Tests, Tower Integration Tests, Package Install Verification

`gh pr merge --merge` fails with "the base branch policy prohibits the merge"
until both clear. I escalated rather than reaching for `--admin` myself; the
human's explicit ruling ("use admin here") came back and I merged with
`--admin` only after CI was green, so the bypass covered the review requirement
alone and never the checks.

### CI flake, resolved

Two `Tests` runs on this branch failed at 18:07:53 and 18:08:09 —
`send-integration.e2e.test.ts`, "Hook timed out in 10000ms", Tower Integration
Tests. I called it pre-existing flake on the evidence (file untouched by this
PR; same workflow failing intermittently on `bugfix-1264`, `bugfix-1077`,
`docs/arch-init-compaction`, `air-1239` and one `main` merge; same content
passing at 18:06:56 then failing twice minutes later). The final run confirmed
it: Tower Integration Tests passed in 1m23s on the same content. Nothing was
skipped or worked around.

Worktree is clean and stays put — cleanup is the architect's call.
