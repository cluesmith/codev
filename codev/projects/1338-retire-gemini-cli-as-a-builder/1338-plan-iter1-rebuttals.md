# Plan 1338 — Rebuttals, Plan iteration 1

Reviews: **Gemini APPROVE**, **Codex REQUEST_CHANGES**, **Claude COMMENT**.
Disposition: **all points accepted and incorporated.** No point rejected. The plan was restructured
from 3 → 4 phases to keep each phase small after adding the spawn preflight and per-site architect
handling. Each claim below was independently re-verified against source before revising.

---

## Codex (REQUEST_CHANGES)

### X1 — Precedence order would change built-in/custom behavior
**Accepted (important).** Verified: current `resolveHarness` is `built-in → custom → unknown`
(harness.ts:363-381) — built-ins win over same-named custom. My draft's "custom → retired → built-in"
inverted that and would let a custom `claude`/`codex`/`opencode` shadow a built-in.
**Change**: pinned the order to **`built-in → custom → retired → generic throw`** for the explicit
path (Phase 1 Implementation Details), with regression tests that (a) a custom `claude` does NOT
shadow the built-in and (b) an explicit custom `gemini` still resolves.

### X2 — Spawn validation is too late; leaves partial state
**Accepted (important).** Verified: `spawn.ts` creates the worktree (`createWorktree`, ~:429/431) and
porch state (`initPorchInWorktree`, :442) **before** resolving the builder harness at :471 — a raw
throw orphans state. **Change**: Phase 2 now adds a **preflight** (`assertBuilderHarnessNotRetired`)
above all `createWorktree` entry points, aborting before any worktree/porch/db mutation, with a test
asserting a rejected gemini spawn creates **no** state.

### X3 — Escape-hatch ambiguity for auto-detected `gemini`
**Accepted.** **Change**: Phase 1 states explicitly that an auto-detected `gemini …` command is
retired **even when a custom `gemini` exists**; the custom escape hatch requires *explicit*
`builderHarness`/`architectHarness: "gemini"`. This matches current behavior (auto-detect only ever
resolved the built-in namespace, never custom).

### X4 — Doctor is not "override-aware"
**Accepted.** Verified: `doctor.ts:797-803` reads raw `shell.architect`/`shell.architectHarness`, not
`getResolvedCommands`/CLI/env overrides. **Change**: Phase 3 now specifies **persisted-config**
detection for the builder branch (raw `shell.builder`/`shell.builderHarness`, array-or-string) and
explicitly drops the "override-aware" claim, matching the spec's scope.

---

## Claude (COMMENT — all four verified accurate against source)

### #1 — Phase 2 mislabels `tower-utils.ts:291` / `:509` as "architect launch"
**Accepted (highest-value).** Verified: `:291` is `siblingRegistrationIsLive()` — a **boolean liveness
predicate** (returns bool; used by sibling-registration reconcile), and `:509` is a lazy `freshLaunch`
closure `next()`. **Change**: Phase 2 now enumerates all **four** `getArchitectHarness` sites with
per-site expected behavior: `:179`/`:357`/`:509` are launch paths → clean failure at the launch
boundary; **`:291` is guarded to return `false`** (a retired architect isn't live → reconcile prunes
it) so the throw never escapes a Tower predicate.

### #2 — Second `BUILTIN_HARNESSES` consumer + wrong path
**Accepted.** Verified: `harnessProviderFor` (`agent-farm/commands/reset/context.ts:468`) indexes
`BUILTIN_HARNESSES` directly → returns `null` post-removal → reset refuses (the spec's **accepted**
outcome; no code change). **Change**: Integration Points now names *both* reset consumers
(`harnessFromLaunchScript`:414 and `harnessProviderFor`:468) and corrects the path to the full
`agent-farm/commands/reset/context.ts`. (The approved spec's shorter `reset/context.ts` citation is
the same file; left as-is to avoid re-opening the approved spec for a path abbreviation.)

### #3 — Retired-check ordering stated inconsistently
**Accepted.** Resolved by the X1 fix: pinned as **custom lookup → retired check → generic throw**
(after built-in). Consistent everywhere now.

### #4 — Missing CHANGELOG deliverable
**Accepted.** Verified: `CHANGELOG.md` has a maintained `## [Unreleased]` section (line 10, active
Spec-786 entries). Removing a supported harness is a user-visible breaking change. **Change**: Phase 4
now includes a CHANGELOG `[Unreleased]` entry with a migration pointer.

### #5 — Phase 1 committable but not shippable
**Accepted.** **Change**: Executive Summary and the phase notes now state that committable ≠
individually shippable (after Phase 1 the resolver throws but nothing surfaces it), with an explicit
"do not stop before Phase 3."

---

## Gemini (APPROVE)
No changes requested; confirmed the plan accurately translates the role-agnostic spec into precise
phases with robust test replacements. Reinforces the direction.

---

## Net effect
Approach unchanged (retirement sentinel in the shared resolver). Correctness hardened: precedence
pinned to preserve built-in/custom behavior, spawn preflight prevents orphaned state, all four
architect sites handled per-site (predicate guarded), doctor scoped to persisted config, CHANGELOG
added, reset consumers named. Restructured 3→4 phases for small, reviewable units. Ready for
re-verification.
