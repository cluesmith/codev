# Review: Symmetric Hot/Cold Governance Docs (Spec 987)

## Summary

`codev/resources/lessons-learned.md` (and, identically, `arch.md`) was **write-only**: durable wisdom accreted into it but nothing consumed it at decision time, so it could not change agent behavior under load. Spec 987 makes both governance docs **consumed** via a symmetric **hot/cold two-tier** model (the architect's reframe — `arch.md` was equally write-only, so the fix had to be symmetric; nothing is retired):

- **HOT** — `arch-critical.md` / `lessons-critical.md`: tiny, hard-capped (≈10 entries + a ≤12-topic "consult when…" map of the cold doc, ≤35 lines), **always injected** into (a) every porch phase prompt and (b) interactive sessions via a generated managed block in `CLAUDE.md`/`AGENTS.md`.
- **COLD** — `arch.md` / `lessons-learned.md`: kept, full, on-demand reference; the hot maps point into them.

Producers **route** new facts/lessons by tier at review time; MAINTAIN + the `update-arch-docs` skill police the hot caps, displacement, and map accuracy. Delivered in 6 phases, all multi-agent reviewed.

## Architecture Updates

This project introduced a genuine new framework subsystem (always-on hot/cold governance), so both tiers were updated — dogfooding the routing model:

- **Routed HOT** → `codev/resources/arch-critical.md` (earned the 10th/last fact slot, within cap): *"Governance docs are two-tier (Spec 987): HOT … capped + always-injected; COLD … reference. Route new facts/lessons by tier; never grow a hot file past its cap (demote to cold)."* This is behavior-changing + cross-cutting — a future builder must know how to route governance updates.
- **Routed COLD** → `codev/resources/arch.md` new section **"Governance Docs (Hot/Cold Tiers)"**: the mechanism detail (`buildHotTierContext` runtime injection, the `managed-block.ts` generator + markers, `copyHotTierDefaults` materialization, four-tier resolution, cap/displacement/map policing) — reference, not always-on.
- The `CLAUDE.md`/`AGENTS.md` managed block was regenerated from the updated hot file (stays byte-identical).

## Lessons Learned Updates

- **Routed COLD** → `codev/resources/lessons-learned.md` (reference, under *3-Way Reviews*):
  - The agy/Gemini consult lane reviews against an **empty sandbox** → no `VERDICT` → porch defaults `REQUEST_CHANGES`, looping. Per-project fix: worktree-local `.codev/config.json` `porch.consultation.models: ["codex","claude"]` (gitignored; config > protocol). Bugs #1032/#1033.
  - The codev-instance skill lives at **repo-root** `.claude/skills/`, not `codev/.claude/skills/`; mirror to both trees and guard `CLAUDE.md ≡ AGENTS.md` + cross-tree identity with a test.
- **No new HOT lesson needed**: the most load-bearing lesson here ("'Who calls this in production?' grep before changing a long-lived API — vestigial code survives") was already a `lessons-critical.md` entry and directly caught the dead-`copyResourceTemplates` trap. Not adding a redundant hot entry **is** the displacement discipline working.

## Lessons Learned (retrospective)

**What went well**
- The architect's mid-flight reframe (lessons-only retire → symmetric hot/cold) was caught at the spec gate, before any code — cheap to redirect. Verifying the "`arch.md` is identically write-only" premise against `buildPhasePrompt()` confirmed it.
- CMAP earned its keep every phase: it caught the **dead-code trap** (`copyResourceTemplates` uncalled; `update.ts` doesn't backfill resources) at plan time, the **spec self-contradiction** on injection form ("LOCKED variable" vs "deferred to plan"), and missing integration/structural tests repeatedly.
- The prepend-in-`buildPhasePrompt` injection form (vs per-template variables) guaranteed *unconditional* presence — no template can silently miss it.

**What was challenging**
- The **Gemini lane defect** (empty-sandbox reviews) looped early phases 2–3 extra iterations until the architect approved scoping it out per-project. Root-caused from agy's own output.
- **Dual-tree discipline**: the codev-instance skill is at repo-root `.claude/`, the cold/hot docs and protocols mirror across `codev/` ↔ `codev-skeleton/`, and CLAUDE≡AGENTS — three different mirroring rules. Guarded with structural tests (`review-prompt-routing`, `governance-sweep`).
- A 5-day infra stall (node-26 migration) wiped the worktree `node_modules` and left the branch **359 commits behind main** (see PR notes).

**What I'd do differently**
- Verify framework wiring against *live call sites* during planning (the dead-code trap), not after — exactly the lesson already in the hot tier.

## Files Changed

52 files, +2270 / −184 (three-dot vs `main`):
- **Hot files** (new, 4 locations): `codev/resources/{arch,lessons}-critical.md` (real) + `codev-skeleton/{templates,resources}/` + `codev/templates/` (starters).
- **Source**: `commands/porch/prompts.ts` (injection), `lib/managed-block.ts` (new), `lib/scaffold.ts` (`copyHotTierDefaults`), `commands/{init,adopt,update}.ts`, `lib/templates.ts` (USER_DATA).
- **Producers/policing** (both trees): spir/aspir/pir/porch review prompts + templates; MAINTAIN protocol.md + maintain.md + run template; `update-arch-docs` skill (×2).
- **Docs**: `CLAUDE.md`/`AGENTS.md` (block + governance prose + directory map); spir/pir protocol.md descriptions; `arch.md`/`lessons-learned.md` (cold updates).
- **Tests** (6 new): `hot-tier`, `hot-tier-injection`, `managed-block`, `hot-tier-materialization`, `review-prompt-routing`, `governance-sweep`.

## Test Results

Full unit suite green: **~3266 passed / 13 skipped** (158 files). Build green. The new tests enforce the load-bearing invariants: hot-file cap + **map accuracy** (each map topic is a real cold-doc section), verbatim always-on injection + tier-4 fallback, non-clobbering managed-block upsert, `update` materialization integration, dual-tree producer routing, and `CLAUDE.md ≡ AGENTS.md`.

## Things to Look At During Review

- **Branch is 359 commits behind `main`** (5-day node-26 migration window). The merge will likely need `main` pulled in / conflict resolution — `prompts.ts`, `scaffold.ts`, `init/update.ts`, and `CLAUDE.md` are all plausible conflict sites. Flagged to the architect.
- The per-project Gemini scope-out (`.codev/config.json`) is **gitignored** — intentional (operational, not shipped), so it won't appear in the PR diff.
- `copyResourceTemplates` is left in place as dead code (out of scope to remove); Phase 4 deliberately did **not** revive it.

## How to Test Locally

- `pnpm build && (cd packages/codev && npx vitest run)` — full suite.
- Assemble a phase prompt: the hot tier is prepended to every `buildPhasePrompt` output.
- `codev init` in a temp dir → `codev/resources/{arch,lessons}-critical.md` created + the managed block injected into `CLAUDE.md`/`AGENTS.md`.

## Flaky Tests

None introduced. The agy/Gemini reviewer lane is an external infra defect (#1032/#1033), scoped out per-project; not a test.
