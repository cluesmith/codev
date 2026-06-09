# PIR #1011 — inline protocol.md into builder prompt at spawn

## Plan phase (2026-06-08)

Read issue #1011, PIR protocol, and the target code. Investigation findings:

- Target: `loadBuilderPromptTemplate()` in `packages/codev/src/agent-farm/commands/spawn-roles.ts:99-108`.
- The returned template flows through `renderTemplate()` in `buildPromptFromTemplate()` (handlebars substitution + `\n{3,}→\n\n` collapse + trim).
- Verified: **zero `{{` occurrences across all 8 `codev-skeleton/protocols/*/protocol.md`** files, so appending protocol.md before render is safe today (no accidental substitution).
- `validateProtocol()` already fatals earlier in the spawn flow if BOTH `protocol.json` and `protocol.md` are missing — so by the time we inline, a missing `protocol.md` means the json exists; silently skipping is correct.
- Tests live in `packages/codev/src/agent-farm/__tests__/spawn-roles.test.ts`; the skeleton-fallback `describe` block (issue #706) is the natural home for the new inline-behavior test.
- Plan-gate decisions locked: (1) `---` + `## Protocol Reference (full text)` delimiter, (2) silently skip + debug log when protocol.md absent, (3) unconditional (no config flag).

Plan written to `codev/plans/1011-agent-farm-inline-protocol-md-.md`. Awaiting plan-approval gate.

## Implement phase (2026-06-08)

plan-approval approved. Implemented per plan:

- `spawn-roles.ts`: `loadBuilderPromptTemplate()` now resolves `protocol.md` via `resolveCodevFile()` and appends it under `\n\n---\n\n## Protocol Reference (full text)\n\n`. Missing protocol.md → `logger.debug` + skip (validateProtocol already fatals earlier if both json+md absent).
- `spawn-roles.test.ts`: 2 new tests in the skeleton-fallback block — (1) inlines protocol.md under the delimiter with a sentinel body, (2) builds without error and omits the heading when protocol.md is absent.

Build ✓ (root `npm run build`), full suite ✓ (3260 passed, 13 pre-existing skips — none mine). Committed + pushed. At dev-approval gate.

## Scope expansion (2026-06-08, architect-driven)

Architect expanded #1011 twice: first to a framework-file class fix (A.1/A.2/A.3), then to a three-layer structure (Delivery / Cleanup / Enforcement). Plan rewritten accordingly. 5 plan-gate decisions locked (delimiter; Patch2=B explicit-embed; A.3=strip; missing-file=silent-skip+debug; doctor=warn-not-error skeleton-only). Patch 1 (Layer 1/A.1) already done + at dev-approval; Patch 2 + Layer 2 sweep + Layer 3 (doctor check + AGENTS/CLAUDE convention) still to implement.

bugfix sub-decision RESOLVED → drop its dead pointer, embed nothing. Evidence: bugfix builder-relevant guidance (300-LOC/escalation/regression/Fixes#) already in its phase prompts (investigate/fix/pr); the 548-line codev/ protocol.md is mostly architect-facing + partly stale (manual merge flow, deprecated projectlist) and absent from the skeleton. That doc-hygiene gap filed separately as **#1013** (area/protocols), kept out of #1011's plumbing scope.

## Three-layer implementation complete (2026-06-08)

- **Layer 1**: Patch 1 (protocol.md inline at spawn) already done. Patch 2 (A.2) = explicit-embed: dropped redundant template pointers in spir/aspir plan prompts; embedded notes.md/findings.md into experiment/spike protocol.md under `## Template:` + `BEGIN/END EMBEDDED TEMPLATE` sentinels (drift-guarded).
- **Layer 2**: swept the protocol.md pointer from all 9 builder-prompts (path-free `Follow the X protocol.`), fixed roles/builder.md cat example, stripped A.3 workflow-reference line from spir/protocol.md. Both trees.
- **Layer 3**: added the "Framework files: never shell-fetch by literal path" convention to root AGENTS.md + CLAUDE.md; added `lib/framework-ref-audit.ts` + a `doctor()` section (warn-not-error, skeleton-only).

**Key finding that reshaped Layer 3**: the skeleton has ~60 legitimate `codev/...` mentions (user files arch.md/lessons-learned.md; the documented protocol list in CLAUDE/AGENTS templates; cross-refs). A blanket grep would be a noise cannon and contradict documented convention. So the doctor check is deliberately NARROW: only shell-fetch verbs (cat/cp/...) reading `codev/(protocols|roles)/...`. resources/ excluded (mixed framework+user). Documented this scope in the lib + convention. **Flag for architect: the doctor check guards the shell-fetch regression specifically, not the backtick-instruction form (which can't be flagged without false-positiving the legit protocol list).**

Also found + left out-of-scope: `codev/protocols/release/protocol.md:43` cats maintain/protocol.md (architect-run, codev/-only, not in skeleton). And relative-path template refs inside protocol.md (spir:215/301, experiment:90) — relative, informational.

Two pre-existing tests updated (legit staleness from the sweep): baked-decisions.test.ts baselines (3 fixtures swept to match) + bugfix-619 assertion (now asserts no protocol.md path at all, preserving #619 intent). Build ✓, full suite ✓ (3270 passed, 13 pre-existing skips). Still at dev-approval gate.

## Reworked at dev-approval gate: static embed/append → fresh-at-delivery placeholders (2026-06-08)

Reviewer feedback: (a) "Follow the X protocol." is too terse + don't drop "Read and internalize..."; want a reference + a literal placeholder that's replaced; (b) embedding notes.md/findings.md inline causes staleness.

Reworked the whole delivery mechanism:
- spawn-roles.ts: removed the append; added `resolveIncludes()` (recursive `{{> path}}` resolution) + `resolveProtocolReference()`; buildPromptFromTemplate now sets a `{{protocol_reference}}` context var (protocol.md read FRESH at spawn, with its `{{> ...}}` template includes resolved). No committed copy anywhere → no staleness.
- builder-prompts (9, both trees): `## Protocol` restored to "Follow the X protocol. Read and internalize the protocol before starting any work.{{#if protocol_reference}} ...included below...{{/if}}" + appended `{{#if protocol_reference}} ## Protocol Reference (full text) {{protocol_reference}}{{/if}}`.
- experiment/spike protocol.md: replaced my static embed with `{{> protocols/<name>/templates/<file>}}` include (resolved fresh). Found + left a PRE-EXISTING out-of-scope partial copy of notes.md in experiment's `## notes.md Template` section (relative ref).
- Tests: spawn-roles placeholder + include tests; framework-ref-audit drift test now asserts include-present + no static embed; baked-decisions baselines re-swept to the new `## Protocol` line.

Build ✓, full suite ✓ (3271 passed, 13 skips). Still at dev-approval gate.

## #1013 folded into this PR (2026-06-09)

Architect: "implement 1013 as part of this session so we have a complete implementation of the whole bug." Rationale: #1011's Layer 1 now reliably inlines protocol.md into builders, so the stale bugfix doc reaching builders is a correctness risk, not just hygiene.

- **bugfix**: rewrote `protocol.md` from the stale 548-line manual-flow doc to a concise ~78-line porch-accurate one, grounded in `protocol.json` (investigate/fix/pr + `pr` gate) and `prompts/pr.md` (builder CMAP → `porch done` → `pr` gate → human approves → porch merge task). Dropped the projectlist section + manual "Merge it" handshake + manual architect CMAP; fixed branch-naming. **Shipped to the skeleton** (was absent) so fresh-install bugfix builders get a correct meta-doc via Layer 1. Verified doctor-clean (no shell-fetch).
- **experiment**: removed the redundant `## notes.md Template` partial-copy section (relative-ref duplicate of notes.md); the `## Template: notes.md` fresh-include #1011 added makes it redundant. No committed template copy remains.

Build ✓, full suite ✓ (3271 passed, 13 skips). PR #1015 (draft) to be updated to also Fixes #1013. Still at dev-approval gate.

## Follow-up review: spir dead template pointers + soft-mode finding (2026-06-09)

Reviewer asked whether other protocols need compliance changes, then probed the experiment/spike template injection.

- **spir/protocol.md dead pointers (fixed, commit 926168a5)**: the two `**Template**: templates/spec.md|plan.md` annotations + the `## Templates` section pointed builders (via inlined protocol.md) at template paths absent in fresh installs. Reworded to point at the phase prompts / describe templates as skeleton-shipped reference. (`aspir/protocol.md` `└── templates/` and `consult-types/` are ASCII directory-tree diagrams — benign, left.)
- **Unused files**: confirmed `maintain/templates/*` are all orphaned (referenced by nothing; run-file structure is inline in maintain protocol.md). Per reviewer, NOT deleting them — added a "Unused framework files (kept for reference)" note to the PR body instead. (Reverted an earlier deletion of maintenance-run.md.)
- **Soft-mode finding (resolves the injection inconsistency)**: `experiment`/`spike` default to **`mode: soft`** (`prompt: None` on every phase, empty `prompts/`). Soft mode = builder follows `protocol.md` directly, no porch phase prompts — so `protocol.md` is their only guidance channel, which is *why* templates are injected into it via `{{> }}` (and why strict protocols spir/aspir/bugfix, whose phase prompts carry structure, are NOT injected). So: strict → phase prompts carry structure (don't inject); soft → protocol.md is everything (inject). The `{{> }}` injection FIXES experiment/spike (their old `cp`/template path was dead in fresh installs). Retracted the earlier "give experiment/spike phase prompts" follow-up — phase prompts are a strict-mode concept; soft-mode protocols correctly live in protocol.md, so no follow-up needed.

Build ✓, full suite ✓ (3271 passed, 13 skips). Still at dev-approval gate.

## Doctor check repointed: workspace overrides, not global skeleton (2026-06-09)

Reviewer: "codev doctor is an end-user tool — why is its check focused on the global package skeleton?" Correct catch, and a real flaw (not just framing). Auditing the shipped skeleton from an end-user tool is pointless — the user can't fix it, and it's already CI-guaranteed clean. Repointed the `doctor()` check from `getSkeletonDir()` (global package) to the **workspace `codev/` overrides** (`resolve(workspaceRoot, 'codev')`), moved it inside the "in a codev project" block, no-op when there are no local protocol/role overrides. Shipped-skeleton guard stays in the unit test (`framework-ref-audit.test.ts` scans `codev-skeleton/`, runs in CI). Renamed lib param `skeletonDir`→`rootDir`; updated the CLAUDE.md/AGENTS.md convention line ("audits your project's local codev/ overrides"); revised plan decision #5 (was wrongly "skeleton-only" — this matches the architect's original Layer 3 intent of grepping local codev/ dirs). Build ✓, suite ✓ (3272 passed, 13 skips).

## Removed the {{#if protocol_reference}} guard; enforce completeness instead (2026-06-09)

Reviewer: since all protocols now have a protocol.md (bugfix got one in #1013), the `{{#if protocol_reference}}` guard is always-true / dead code — remove it. Done, safely:
- Stripped `{{#if protocol_reference}}`/`{{/if}}` from both spots (the `## Protocol` line + the EOF `## Protocol Reference (full text)` block) in all 9 builder-prompts, both trees → the protocol reference is now **unconditional**.
- Added a **completeness unit test** (`framework-ref-audit.test.ts`): every shipped skeleton protocol with a `protocol.json` must also ship a `protocol.md`. This makes the "every protocol has a meta-doc" invariant true-by-construction (a future json-only protocol fails CI rather than rendering an empty `## Protocol Reference` section), which is what justifies dropping the guard.
- Updated the spawn-roles "absent" test (the omit-behavior is gone; now asserts the build still succeeds and the placeholder resolves) + the mock template (unconditional). Re-swept the 3 Spec-746 baselines to the unconditional `## Protocol` line (pure-addition diff).
- Residual (now handled): a user's OWN `codev/protocols/` json-only override (protocol.json, no protocol.md) would render an empty `## Protocol Reference` heading. Added a **non-fatal `validateProtocol` warning** for that case — "protocol X has a protocol.json but no protocol.md; builders will spawn with an empty Protocol Reference section." Non-fatal so json-only protocols stay valid; flags the omission at spawn without bringing back the render-time `{{#if}}` guard. +2 tests (warns when md absent; silent when md present).

Build ✓, suite ✓ (3275 passed, 13 skips). Still at dev-approval gate.

## BUG FOUND + FIXED: spir/aspir plan template was load-bearing (2026-06-09)

Reviewer probed how the builder gets the plan template now. Found a real bug I introduced: porch's spir/aspir **plan gate requires machine-readable phases JSON** (`has_phases_json` + `min_two_phases`), which lives ONLY in `templates/plan.md`. My earlier "drop the redundant plan-template pointer; the inline `### Plan Structure` is self-contained" was WRONG — that inline block is JSON-less, and neither it nor the inlined protocol.md guides the JSON. So a spir/aspir builder would have written a markdown-only plan and FAILED the plan gate.

Also surfaced a mechanism constraint: the `{{> }}` include only ran in `resolveProtocolReference` (spawn, on protocol.md). porch's `loadPromptFile` (phase-prompt delivery) did NOT resolve includes — so a `{{> }}` in a phase prompt would be left literal.

Fix (Option B):
- Extracted the include logic to a shared `resolveCodevIncludes` in `lib/skeleton.ts` (one impl).
- `loadPromptFile` (porch) now resolves includes → phase prompts can pull framework files fresh.
- spir/aspir `prompts/plan.md`: replaced the divergent inline `### Plan Structure` with `{{> protocols/spir/templates/plan.md}}` — the builder now follows the real canonical template (with the phases JSON), delivered fresh, single-source.
- spawn-roles `resolveProtocolReference` now calls the shared `resolveCodevIncludes`.
- Tests: spawn-roles skeleton mock provides `resolveCodevIncludes`; framework-ref-audit asserts the include is used (not inline structure), the template carries the JSON, and the resolved plan prompt contains the JSON (porch delivery). Build ✓, suite ✓ (3277 passed, 13 skips).

spec/review re-check: **review is self-contained** — its prompt explicitly mandates `## Architecture Updates` + `## Lessons Learned Updates` (the porch-checked sections), so it's gate-satisfied (no template delivery needed). **specify has no porch check** and guides the spec via a process (no structural template delivered); not broken, but `templates/spec.md` isn't delivered and the spir/protocol.md "Structure: provided in the specify-phase prompt" note slightly overstates (the prompt gives a process, not the template). Flagged to the architect for a decision (deliver templates/spec.md via include for consistency, or leave process-only + correct the note).
