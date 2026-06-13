---
approved: 2026-06-06
validated: [codex, claude]
---

# Plan: Symmetric Hot/Cold Governance Docs — `arch.md` & `lessons-learned.md` Consumed at Decision Time

## Metadata
- **ID**: plan-2026-06-06-987-engineering-wisdom-write-only
- **Status**: approved 2026-06-06 (codex, claude)
- **Specification**: `codev/specs/987-engineering-wisdom-is-write-on.md`
- **Created**: 2026-06-06

## Executive Summary

Implements the approved symmetric **hot/cold** model. Each governance doc gains a tiny, hard-capped, **always-on** companion:
- **HOT** — `arch-critical.md`, `lessons-critical.md`: capped facts **+** a bounded cold-doc map. Always injected into (1) every porch phase prompt via the runtime resolver, and (2) interactive sessions via a generated managed block in `CLAUDE.md`/`AGENTS.md`.
- **COLD** — `arch.md`, `lessons-learned.md`: kept intact as on-demand reference, made discoverable by the hot file's map.

Producers **route hot-vs-cold** at review time (instead of appending to an archive); MAINTAIN polices the **cap and the map's accuracy**. Nothing is retired.

### Pinned decisions (resolving the spec's open questions)
- **Per-hot-file cap (PINNED — confirm at plan gate):** each hot file ≤ **35 lines total** (incl. headers), comprising **≤ 10 single-line fact bullets** + a cold-doc map of **≤ 12 top-level topics** (one line each, `topic — consult when…`). Both hot files injected together ≈ ≤ 70 lines (well under ~1k tokens/prompt — negligible, which is what makes always-on viable).
- **porch injection form (PINNED — prepend; flagged for architect confirm):** `buildPhasePrompt()` **prepends an always-on context block** built from the resolver-located hot files — chosen over per-template `{{variable}}`s because it guarantees *unconditional* presence in **every** phase without depending on each prompt template (across all protocols, both trees) carrying the variable. The spec previously contained an internal contradiction here ("LOCKED: variable" vs "deferred to plan"); per the plan-iter1 CMAP this is resolved — the spec now defers the *form* to the plan, and the plan pins prepend. **Flagged for the architect at the plan-approval gate** (Codex preferred honoring the literal "variable" wording; Claude judged prepend technically superior). Resolves via `resolveCodevFile()`; runtime fallback.
- **Interactive mechanism (PINNED per spec):** generated managed block with begin/end markers; replace-in-place; `@import` rejected.
- **Hot files materialize via an explicit wired-in step (PINNED — corrected from plan-iter1 CMAP):** the existing `copyResourceTemplates()` is **dead** (not called by `init`/`adopt`/`update`) and `UPDATABLE_PREFIXES` does not create resources — so a **new creation step** (mirroring `copySkills`) is wired into `init.ts`, `adopt.ts`, and `update.ts`. Porch injection itself does not require local files (tier-4 skeleton fallback), but local creation is required to make the hot tier **visible and editable** for per-project curation.
- **Skeleton placement (PINNED — from code audit):** the **starter** hot files live in **both** `codev-skeleton/templates/` (copy source for the new creation step) **and** `codev-skeleton/resources/` (runtime tier-4 fallback read by `resolveCodevFile('resources/…')`). The skeleton copies are **generic starters** (placeholder facts + a generic map + a "how to curate" header); this repo's `codev/resources/*-critical.md` (tier-2) holds the **real curated codev content**. (Resolves the spec's deferred "skeleton starter content" question.)
- **Review section names (PINNED):** keep `## Architecture Updates` / `## Lessons Learned Updates` (so existing porch checks stay valid); change the *instructions* inside to route hot-vs-cold.

## Success Metrics
- [ ] All spec success criteria met
- [ ] `buildPhasePrompt()` injects both hot files verbatim into every phase prompt; runtime fallback works
- [ ] Managed block present + identical in `CLAUDE.md`/`AGENTS.md`; non-clobbering on regeneration
- [ ] All four files (`arch.md`, `arch-critical.md`, `lessons-learned.md`, `lessons-critical.md`) scaffolded into new projects and created on `codev update`
- [ ] Existing unit/e2e tests pass; updated where they assert the old template list / sections

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. -->

```json
{
  "phases": [
    {"id": "phase_1", "title": "Hot files: curation, cap, placement"},
    {"id": "phase_2", "title": "Porch runtime injection (always-on, every phase)"},
    {"id": "phase_3", "title": "Interactive managed block in CLAUDE.md/AGENTS.md"},
    {"id": "phase_4", "title": "Project materialization: hot-file creation in init/adopt/update"},
    {"id": "phase_5", "title": "Producer routing (review prompts, both trees)"},
    {"id": "phase_6", "title": "MAINTAIN + skill policing, docs sweep, consistency"}
  ]
}
```

## Phase Breakdown

### Phase 1: Hot files — curation, cap, placement
**Dependencies**: None

#### Objectives
- Create the two always-on hot files, seeded by curation from the cold docs, within the pinned cap, and placed at every location the two surfaces resolve.

#### Implementation Details
- Author `arch-critical.md` and `lessons-critical.md`, each with two capped parts:
  - **Facts** (≤ 10 bullets): the behavior-changing, cross-cutting subset lifted from `arch.md` / `lessons-learned.md` (e.g. for lessons: "trust the protocol / never skip CMAP", "check existing work before building", "model permissions as roles not booleans", "verify end-to-end in a browser, not just compile", "single source of truth beats distributed state"). Curated, not exhaustive.
  - **Cold-doc map** (≤ 12 top-level topics): one line per top-level section of the corresponding cold doc, each `topic — consult when…`. For `lessons-critical.md`, map `lessons-learned.md`'s sections (Critical, Security, Architecture, Process, Testing, UI/UX, Documentation, 3-Way Reviews, Protocol Orchestration, Debugging). For `arch-critical.md`, map `arch.md`'s top-level sections.
  - A short header stating the cap + "generated/curated; edits are demote-on-add; see MAINTAIN."
- Place each hot file at: `codev/resources/` (this repo's tier-2 instance — **real curated codev content**), `codev-skeleton/templates/` (copy source for the Phase-4 creation step — **generic starter**), `codev-skeleton/resources/` (runtime tier-4 fallback — **generic starter**), and `codev/templates/` (instance template mirror).
- **Two content variants**: the `codev/resources/` instance files carry codev's real facts + real maps of codev's `arch.md`/`lessons-learned.md`; the `codev-skeleton/*` files carry a **generic starter** (placeholder facts, a generic map shape, and a "how to curate / demote / consult-when" header) that downstream adopters get and then populate via routing.
- **Cold docs untouched** in this phase.

#### Files
- `codev/resources/arch-critical.md`, `codev/resources/lessons-critical.md` (new)
- `codev-skeleton/templates/{arch-critical,lessons-critical}.md` (new)
- `codev-skeleton/resources/{arch-critical,lessons-critical}.md` (new)
- `codev/templates/{arch-critical,lessons-critical}.md` (new)

#### Acceptance Criteria
- [ ] Both hot files exist at all four locations (six paths incl. instance + skeleton)
- [ ] Each file is within the pinned cap (≤ 35 lines; ≤ 10 facts; ≤ 12 map topics)
- [ ] Map lists only top-level cold-doc topics (not a full enumeration), each with a "consult when…"
- [ ] `arch.md` and `lessons-learned.md` unchanged

#### Test Plan
- **Unit/structural**: a test asserts both hot files exist at the instance + skeleton resource/template paths, are non-empty, and are within the line cap; a test asserts the map section contains only top-level topics (heuristic: line count ≤ cap, each map line matches `… — consult when …`).

#### Rollback Strategy
- Delete the new files; no other surface depends on them yet.

#### Risks
- **Risk**: curation picks too much / exceeds cap. **Mitigation**: cap-check test fails loudly; displacement discipline documented in header.

---

### Phase 2: Porch runtime injection (always-on, every phase)
**Dependencies**: Phase 1

#### Objectives
- Make every porch phase prompt carry both hot files, resolved at runtime, with skeleton fallback.

#### Implementation Details
- In `packages/codev/src/commands/porch/prompts.ts`, `buildPhasePrompt()`: resolve `resources/arch-critical.md` and `resources/lessons-critical.md` via `resolveCodevFile()`; **prepend an always-on context block** (clear heading, e.g. `# Always-On Engineering Context (hot tier)`) containing both files verbatim, ahead of the phase-specific prompt body. Applies to all phases (specify, plan, implement, defend, evaluate, review).
- If a hot file resolves to null (should not happen given skeleton copy), inject nothing for that file and continue (no crash) — but the skeleton tier-4 copy from Phase 1 guarantees presence.
- **Spec-discrepancy note (read before implementing):** the spec text once said "LOCKED: variable injection" in one place and "deferred to the plan" in another. That contradiction is resolved: this plan pins the **prepend** form (one change in `buildPhasePrompt()` guarantees every phase; per-template `{{variable}}`s would require editing every phase-prompt template across all protocols and both trees, risking a silently-missed template — the exact "no context" failure this feature fights). If the architect prefers the variable form at the plan-approval gate, the fallback is: add `{{arch_critical}}`/`{{lessons_critical}}` to every phase-prompt template (both trees) + a test asserting presence in each assembled phase.

#### Files
- `packages/codev/src/commands/porch/prompts.ts`
- `packages/codev/src/commands/porch/__tests__/…` (prompt-assembly test; match existing test location/convention)

#### Acceptance Criteria
- [ ] Assembling a prompt for ≥2 distinct phases includes both hot files' text verbatim
- [ ] With the instance `codev/resources/arch-critical.md` absent, assembly falls back to the skeleton copy (no empty/failed injection)
- [ ] No phase prompt requires a `{{variable}}` edit to receive the block (it is prepended unconditionally)

#### Test Plan
- **Unit**: call `buildPhasePrompt()` for two phases; assert both hot files' content substrings appear. **Fallback**: point `resolveCodevFile` at a workspace lacking the instance file; assert skeleton content injected.

#### Rollback Strategy
- Revert the `prompts.ts` change; prompts return to prior behavior.

#### Risks
- **Risk**: block bloats prompts. **Mitigation**: the Phase-1 cap bounds it; assert combined size in test.

---

### Phase 3: Interactive managed block in `CLAUDE.md` / `AGENTS.md`
**Dependencies**: Phase 1

#### Objectives
- Surface the hot tier always-on for interactive sessions via a generated, non-clobbering managed block; dogfood it in this repo's root docs.

#### Implementation Details
- Add a managed-block generator (new helper in `packages/codev/src/lib/`, e.g. alongside `scaffold.ts`): reads both hot files via `resolveCodevFile()` (four-tier at generation time), renders a block delimited by explicit markers (`<!-- BEGIN CODEV HOT CONTEXT (generated — do not edit) -->` … `<!-- END CODEV HOT CONTEXT -->`), and writes it into `CLAUDE.md` and `AGENTS.md`:
  - If markers exist: **replace only between them**, preserving all surrounding user content.
  - If markers absent (existing adopter): **insert at a defined anchor** (e.g. immediately after the first H1) — never route the whole file to `.codev-new`.
- Wire generation into `codev init` (via `copyRootFiles`/scaffold path) and `codev update`.
- Update **this repo's** `CLAUDE.md` and `AGENTS.md` to contain the block (kept identical).

#### Files
- `packages/codev/src/lib/scaffold.ts` (or a new `managed-block.ts` helper invoked by it) + `codev update` command path
- `CLAUDE.md`, `AGENTS.md` (this repo, dogfood)
- tests under `packages/codev/src/__tests__/`

#### Acceptance Criteria
- [ ] After generation, both root docs contain the markers + hot content, identical between them
- [ ] Editing a hot file + regenerating updates the block only; content outside markers preserved
- [ ] A root doc with no markers gets the block inserted (not `.codev-new`)
- [ ] Block is a generated mirror (no hand-edit needed); single source = hot files

#### Test Plan
- **Unit**: generate into a fixture `CLAUDE.md` with user content above/below; assert markers+content present and user content intact; mutate a hot file, regenerate, assert block updated and user content unchanged; assert insert-when-absent path.

#### Rollback Strategy
- Remove the generator call; strip the block from root docs (markers make it mechanical).

#### Risks
- **Risk**: clobbering user edits. **Mitigation**: replace-only-between-markers + non-clobber test (spec's high-impact risk).

---

### Phase 4: Project materialization — hot-file creation in init/adopt/update
**Dependencies**: Phase 1, Phase 3

#### Objectives
- Every project — fresh (`init`/`adopt`) and upgrading (`update`) — gets editable, visible hot files in `codev/resources/`, via an explicit creation step (NOT the dead `copyResourceTemplates`/`UPDATABLE_PREFIXES`).

#### Implementation Details
- Add a focused scaffold helper (e.g. `copyHotTierDefaults(targetDir, skeletonDir, { skipExisting })` in `packages/codev/src/lib/scaffold.ts`) that copies **only** the two hot files from the skeleton into `codev/resources/`, with `skipExisting` so a curated copy is never overwritten. (Do **not** resurrect `copyResourceTemplates`/cold-doc copying — cold docs are intentionally born-on-first-write.)
- Wire it into:
  - `packages/codev/src/commands/init.ts` (after `copyRootFiles`; create fresh)
  - `packages/codev/src/commands/adopt.ts` (skip-existing)
  - `packages/codev/src/commands/update.ts` (skip-existing — this is the key fix Gemini/Codex/Claude flagged: update must call the creation step explicitly, exactly as it already calls `copySkills`/`copyRootFiles`)
- `packages/codev/src/lib/templates.ts`: add `resources/arch-critical.md` and `resources/lessons-critical.md` to `USER_DATA_PATTERNS` (protect a curated copy from any future copy logic).
- Update `scaffold.test.ts` / `templates.test.ts` and add/extend `update.test.ts`.
- **Combined integration test (Claude's recommendation):** run `codev update` on a fixture project that has **neither** the hot files **nor** the managed-block markers; assert both the hot files are created (Phase 4) **and** the managed block is inserted (Phase 3), and that no user content is clobbered.

#### Files
- `packages/codev/src/lib/scaffold.ts`, `packages/codev/src/lib/templates.ts`
- `packages/codev/src/commands/{init,adopt,update}.ts`
- `packages/codev/src/__tests__/scaffold.test.ts`, `templates.test.ts`, `update.test.ts` (match actual test locations/conventions)

#### Acceptance Criteria
- [ ] `codev init` and `codev adopt` create both hot files in `codev/resources/`
- [ ] `codev update` on a repo lacking the hot files creates them (skip-existing); existing curated copies preserved; cold docs untouched
- [ ] Combined `update` integration test passes (hot files + managed block both created; user content intact)
- [ ] No reliance on `copyResourceTemplates`/`UPDATABLE_PREFIXES` for creation

#### Test Plan
- **Unit**: new-helper copy + skip-existing; `USER_DATA` protection. **Integration**: the combined `update` fixture test above.

#### Rollback Strategy
- Remove the helper + its call sites + test changes; `update`/`init` revert to prior behavior.

#### Risks
- **Risk**: update.ts not actually wired (the original dead-code trap). **Mitigation**: the combined integration test exercises the real `codev update` path, not the helper in isolation.

---

### Phase 5: Producer routing (review prompts, both trees)
**Dependencies**: Phase 1

#### Objectives
- At review time, new facts/lessons are **routed hot-vs-cold** rather than appended to the archive — for both docs.

#### Implementation Details
- Update the review prompts' "Update Architecture and Lessons Learned Documentation" step in **both trees**:
  - `codev-skeleton/protocols/{spir,aspir,pir}/prompts/review.md` and `codev/protocols/{spir,aspir,pir}/prompts/review.md`
  - `codev-skeleton/porch/prompts/review.md` and `codev/protocols/maintain/prompts/review.md` (audit which review prompts exist in each tree; update all live ones)
  - **Review *templates* too (Claude's catch):** `codev-skeleton/protocols/{spir,aspir}/templates/review.md` and the `codev/` equivalents carry the same `## Architecture Updates` / `## Lessons Learned Updates` example sections — update their guidance to the routing model alongside the prompts (don't leave them for the Phase-6 sweep).
- New instructions: for each new architecture fact and each new lesson, decide **hot** (behavior-changing → add to `*-critical.md`, respecting the cap via displacement) vs **cold** (reference → `arch.md`/`lessons-learned.md`). Keep the `## Architecture Updates` / `## Lessons Learned Updates` section names; the section now records the routing decision.
- Confirm porch `review_has_arch_updates` / `review_has_lessons_updates` checks still pass (section names unchanged).

#### Files
- Review prompt files across both trees (spir/aspir/pir + porch/maintain as present)

#### Acceptance Criteria
- [ ] Each updated review prompt instructs hot-vs-cold routing for both docs; no "append everything to the archive" wording remains
- [ ] Section headers unchanged → porch review checks still pass
- [ ] Both trees updated (no skeleton/instance drift)

#### Test Plan
- **Structural**: grep that each review prompt contains routing language ("hot", "critical", "cold", "consult when"/cap) and the retained section headers; a dry review file with the headers passes the porch check commands.

#### Rollback Strategy
- Revert the prompt edits.

#### Risks
- **Risk**: missing a review prompt copy in one tree. **Mitigation**: dual-tree audit list; rg verification.

---

### Phase 6: MAINTAIN + skill policing, docs sweep, consistency
**Dependencies**: Phase 1, Phase 5

#### Objectives
- MAINTAIN polices the hot cap + map accuracy and keeps cold docs as reference; all remaining live surfaces describe the hot/cold model; both trees consistent.

#### Implementation Details
- `update-arch-docs` skill (both trees): add hot-tier responsibilities — enforce the cap + displacement; keep each hot file's **cold-doc map bounded and accurate** (sync top-level topics as cold sections change); soften the cold-tier rule so cold docs may retain spec-narrow reference content. Update the skill frontmatter `description`.
- MAINTAIN protocol + `maintain.md` prompt (both trees): reflect cap/map policing + cold-as-reference.
- `CLAUDE.md` / `AGENTS.md`: add the two hot files to the directory map; add a short "always-on hot/cold governance" description (distinct region from the Phase-3 managed block); keep the two files identical.
- `protocol.md` for spir/aspir/pir/maintain (both trees): update any prose that described the docs as write-targets to reflect hot/cold + routing.
- Final **dual-tree audit + rg sweep**: every live surface referencing the governance docs reflects the new model; the four files cohere; historical artifacts untouched.

#### Files
- `**/.claude/skills/update-arch-docs/SKILL.md` (both trees)
- MAINTAIN `protocol.md` + `prompts/maintain.md` (both trees)
- `CLAUDE.md`, `AGENTS.md`
- `protocol.md` for affected protocols (both trees)

#### Acceptance Criteria
- [ ] Skill + MAINTAIN describe cap-policing + map bounded-and-accurate + cold-as-reference
- [ ] `CLAUDE.md` ≡ `AGENTS.md`; directory map lists hot files; model described
- [ ] rg sweep: no live surface still describes the docs as append-only write targets; historical artifacts unchanged
- [ ] All four governance files present and coherent; full test suite green

#### Test Plan
- **Structural**: grep skill/MAINTAIN for cap+map language; CLAUDE≡AGENTS diff check; rg sweep assertions. **Suite**: run unit + relevant e2e.

#### Rollback Strategy
- Revert per-file; the mechanism (Phases 2–4) stands independently of the doc prose.

#### Risks
- **Risk**: dual-tree drift / missed surface. **Mitigation**: explicit audit list + rg sweep (spec's footgun risk).

## Dependency Map
```
Phase 1 ──┬──→ Phase 2 (porch injection)
          ├──→ Phase 3 (managed block) ──→ Phase 4 (hot-file materialization in init/adopt/update)
          └──→ Phase 5 (producer routing) ──→ Phase 6 (maintain/skill + sweep)
```
(Phase 4 depends on Phase 3 because both add a call into `update.ts`/`init.ts`; sequencing them avoids a same-file race, and Phase 4's integration test exercises both update paths together.)

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Managed-block regeneration clobbers user edits | Med | High | Replace-only-between-markers; non-clobber test; insert-at-anchor when absent |
| "Inject" degrades to a weak pointer | Low | High | Prepend verbatim block in `buildPhasePrompt`; assert verbatim text in test |
| Hot files grow past cap (re-accretion) | Med | High | Pinned cap + displacement + cap-check test + MAINTAIN policing |
| Missed surface across dual trees | High | Med | Explicit audit list + rg sweep in Phase 6 |
| Tier-4 fallback can't find hot files | Med | Med | Place hot files in `codev-skeleton/resources/` (verified tier-4 path), not only `templates/` |
| Wiring into dead code (the plan-iter1 trap: `copyResourceTemplates`/`UPDATABLE_PREFIXES` aren't called by init/update) | Med | High | Phase 4 adds an explicit creation step into `init`/`adopt`/`update`; the combined integration test runs the real `codev update`, not the helper alone |
| Injection-form ambiguity (spec self-contradiction) | Low | Med | Resolved: spec defers form to plan; plan pins prepend; flagged for architect at plan gate |

## Validation Checkpoints
1. **After Phase 2**: porch prompts demonstrably carry the hot tier (runtime + fallback).
2. **After Phase 4**: fresh scaffold + update both yield/retain all four files.
3. **Before Review**: rg sweep clean; CLAUDE≡AGENTS; full suite green.

## Documentation Updates Required
- [ ] `CLAUDE.md` / `AGENTS.md` (directory map + model + managed block)
- [ ] MAINTAIN protocol + `update-arch-docs` skill
- [ ] Review prompts (routing)
- [ ] Affected `protocol.md` files

## Expert Review
**Date**: [to be run by porch after this draft]
**Models**: Gemini, Codex, Claude
**Key Feedback**: TBD
**Plan Adjustments**: TBD

## Approval
- [ ] Technical Lead Review (human gate: plan-approval)
- [ ] Expert AI Consultation Complete

## Notes
Phases 2, 3, and 5 each depend only on Phase 1 and can proceed in parallel in principle; the dependency map serializes 3→4 (update wiring composes with managed-block generation) and 5→6 (MAINTAIN polices what producers create, and the sweep is last). Phase 1's curation is deliberately separated from the mechanism phases per the spec's note. The pinned cap and injection form resolve the spec's Important open questions; the architect confirms the cap at the plan-approval gate.

---

## Amendment History

<!-- TICK amendments, if any, recorded here in chronological order. -->
