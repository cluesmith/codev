# spir-987 — Engineering wisdom is write-only

## Project
Make `codev/resources/lessons-learned.md` actually *consumed* at decision time — or retire + route it. SPIR, strict mode.

## Phase: SPECIFY (in progress)

### Investigation findings (verified against the framework)
Mapped every framework touchpoint of `lessons-learned.md`:

**PRODUCERS (write/prune):**
- SPIR/ASPIR/PIR review prompts (`codev-skeleton/protocols/*/prompts/review.md`) — builder appends entries; review-file `## Lessons Learned Updates` section is enforced by porch `checks`.
- MAINTAIN protocol step 3 + `maintain.md` prompt — extract from reviews, prune.
- `update-arch-docs` skill — audit/diff-mode pruning discipline (already routes by purpose: arch.md vs lessons-learned.md).

**CONSUMERS (read at decision time):** *NONE.* Confirmed gap.
- `buildPhasePrompt()` (`packages/codev/src/commands/porch/prompts.ts`) never reads lessons-learned.
- specify/plan prompts never read it.
- role files (builder.md, architect.md) never reference it.
- CLAUDE.md/AGENTS.md only mention it as a MAINTAIN target, no "read before designing" line.

**Structure:** ~400 lines / ~250 entries, topical sections (Critical, Security, Architecture, Process, Testing, UI/UX, …). Entries tagged only by source `[From NNNN]`. No area/type metadata. Heavy accretion of spec-narrow recipes (XSS escaping, vitest mock quirks) that the skill's own rules say should be pruned but haven't been → the file is mostly noise, with a small durable-design-wisdom subset buried in it.

### Design fork (per issue)
- **A. Inject at design time** — needs relevance retrieval (tagging/matching) or it re-creates accretion.
- **B. Retire + route by type** into consumed surfaces (rule→CLAUDE/role/step; anti-pattern→check; design consideration→design prompt).
- Architect lean: **B with a dash of A**.

Principle: wisdom only changes behavior if it lives in **always-on context**, an **executed protocol step**, or an **enforced check**.

### Architect decisions (clarifying questions)
- Archive: **Retire entirely, route everything** (delete the file).
- Injection: **Bounded always-injected design-heuristics digest** at spec/plan time. No retrieval engine.
- Enforcement: **Executed step, no hard consumption check.**

### Spec drafted + committed (iter 1), then CMAP consultation
- Gemini APPROVE (no issues), Claude APPROVE (5 minor plan-level notes), Codex REQUEST_CHANGES (4 concrete gaps).
- Codex/Claude both correct: there are **4** physical `lessons-learned.md` copies (resources, skeleton/templates, codev/templates, maintain template), plus `scaffold.ts` copies it into new projects and tests assert it, plus injection must use the 4-tier resolver, plus codev-update orphan handling.
- Incorporated all into spec (Current State inventory, Success Criteria, Dependencies, Consultation Log). examples/ ref = non-issue (verified zero hits).

### Reached spec-approval gate (iter1 model: retire+route). Notified architect.

## MAJOR PIVOT (architect instruction, 2026-06-05) — at the gate, before approval
The "retire lessons-learned + single design-heuristics digest" model is **REPLACED**. New model = **symmetric two-tier (hot/cold) across BOTH arch.md AND lessons-learned.md. Nothing retired.**

Reframe: `arch.md` is **identically write-only** — `buildPhasePrompt()` injects NEITHER doc (verified: it reads only summary/plan-phase/history/user-answers). Fix must be symmetric.

**New model (baked):**
- **HOT:** `arch-critical.md` + `lessons-critical.md` — tiny, **hard-capped** (handful of lines each), **ALWAYS injected** into EVERY prompt (CLAUDE.md-style, not design-time-only). The behavior-changer.
- **COLD:** `arch.md` + `lessons-learned.md` — **KEPT/expanded**, on-demand reference. NOT deleted. Spec-narrow recipes STAY (reference, not behavior-changers).
- Decision A: injection scope = ALWAYS-ON every prompt; viability rests on the HARD CAP; adding to hot forces DEMOTING to cold (displacement). MAINTAIN polices cap; review phase routes hot-vs-cold at capture.
- Decision B: KEEP expanded docs intact (no deletion/dropping).
- **Mechanism wrinkle (meaty):** hot files must reach BOTH (1) porch builders via `buildPhasePrompt()` AND (2) interactive architect sessions via CLAUDE.md-style always-on — different surfaces, both via 4-tier fallback resolver.

**Keep from iter1 spec:** 4-tier resolver for injected files; scaffold.ts+tests; live-surface sweep both trees; route-not-append (now hot-vs-cold); MAINTAIN polices cap; codev-update/USER_DATA coherence.

Verified: buildPhasePrompt uses `{{var}}` substitution (`substituteVariables`) → template-var injection feasible. No `@import` in CLAUDE.md today.

### Rewrote spec to hot/cold symmetric model → re-consult (iter2)
- iter2 CMAP: Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES.
- Codex + Claude converged on the **interactive-session surface** (the meaty part) being underspecified. Real gap: I'd conflated runtime 4-tier resolution (works for porch via `resolveCodevFile()`) with the interactive surface (CLAUDE.md/AGENTS.md are STATIC — no runtime loader; verified `copyRootFiles()` only does new-file/`.codev-new`).
- Fixed: porch surface = runtime resolution+inject; interactive surface = **generated managed block** (markers, replace-in-place, non-clobber, insert-at-anchor) written at **generation time** (codev init/update). Locked the mechanism (rejected `@import`), made interactive criteria testable, added tier-4 placement + codev-update file-creation. Rebuttal: 987-specify-iter2-rebuttals.md.

### iter2 revision committed, re-presented at gate. Notified architect.

## Architect refinement (2026-06-06) — bounded cold-doc map
Each hot file now = **capped facts + a bounded cold-doc map** (curated top-level topics of its cold doc, each w/ "consult when…"). Rationale: "on-demand" cold reference still requires the agent to KNOW the cold doc exists/covers the topic — the always-on hot tier should carry a small map so the cold tier is genuinely discoverable. BOUNDED (top-level only, NOT a full/auto TOC — that re-accretes), counts against the cap, MAINTAIN keeps it bounded AND accurate (synced to cold doc top-level sections).
- Amended: hot/cold model (table + item 1 two-part hot file), cap (item4 covers facts+map), MAINTAIN (item6 + criterion: bounded+accurate), new success criterion, new test scenario, cap open-question.
- Re-consult: architect left to my discretion; judged a full 3-way re-consult unnecessary for a bounded additive model change over an already-validated model. Flagged in spec so architect can request one at the gate.

### Refinement committed, re-presented. → SPEC APPROVED by Waleed (2026-06-06).

## PLAN phase (in progress)
Drafted `codev/plans/987-...md` on the final hot/cold model. 6 phases (porch JSON block; checks pass: plan_exists/has_phases_json/min_two_phases=6).

**Pinned the open questions (architect asked):**
- **Cap**: each hot file ≤ 35 lines; ≤ 10 fact bullets + cold-doc map ≤ 12 top-level topics. (~≤70 lines both files injected = negligible tokens.)
- **porch injection**: PREPEND an always-on block in `buildPhasePrompt()` (more robust than per-template `{{var}}` — guarantees unconditional presence every phase). Resolves via `resolveCodevFile()`.
- **Skeleton placement (code-audit)**: hot files needed in BOTH `codev-skeleton/templates/` (scaffold) AND `codev-skeleton/resources/` (runtime tier-4 — verified resolveCodevFile reads resources/ there; skeleton/resources exists but lacks arch/lessons today).
- **Review sections**: keep `## Architecture Updates`/`## Lessons Learned Updates` names (porch checks stay valid); change instructions to route hot/cold.

**6 phases:** 1 hot-file curation+cap+placement · 2 porch runtime injection · 3 interactive managed block (markers, non-clobber) · 4 scaffold/templates.ts/tests · 5 producer routing (review prompts both trees) · 6 MAINTAIN+skill cap/map policing + docs sweep + consistency.

### Plan iter1 CMAP: Gemini RC, Codex RC, Claude COMMENT — incorporated
Two real findings + one reviewer disagreement:
1. **DEAD CODE (Gemini/Codex/Claude):** `copyResourceTemplates` is NOT called by init/adopt/update (verified — init.ts comment: framework files resolve at runtime). `update.ts` only does copySkills+copyRootFiles; `UPDATABLE_PREFIXES` = hash-migration, not resource creation. → My Phase 4 premise was wrong. REWROTE Phase 4: new `copyHotTierDefaults` helper (skip-existing) wired explicitly into init/adopt/**update** + combined integration test on real `codev update`.
2. **Injection form — Codex vs Claude disagreed.** Root cause: spec self-contradicted ("LOCKED variable" vs "deferred to plan") — lesson [From 0089]. Fixed spec to defer form to plan; plan PINS prepend (guarantees every phase; variables risk silently-missed template); FLAGGED for architect at plan gate. Did NOT silently override — corrected the contradiction + surfaced.
3. **Phase 5:** add review *templates* (not just prompts) — done.

**Spec corrected too** (dead-code assumption had propagated into approved success criteria): Current State scaffold para, 2 install/update criteria, injection-form text, consultation-log note. Goals unchanged, mechanism corrected. Architecture insight: hot files = framework defaults in skeleton/resources (tier-4 runtime) + locally materialized (visible/editable for curation); skeleton = generic starter, codev/resources = real curated content (resolves spec-iter1 deferred #5).

Rebuttal: 987-plan-iter1-rebuttals.md.

### Next: commit → afx architect (architecture correction + injection-form flag) → porch done → likely re-consult iter2 → plan-approval gate (HUMAN). Do NOT self-approve.
