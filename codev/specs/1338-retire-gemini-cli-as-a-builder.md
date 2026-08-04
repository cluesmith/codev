# Specification: Retire Gemini CLI as a Builder Harness

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
Implementation phases, file-level edits, and code belong in codev/plans/1338-*.md.
Line-number references below are orientation for reviewers, not edit instructions.
-->

## Metadata
- **ID**: spec-2026-08-03-retire-gemini-cli-builder
- **Status**: Approved (spec-approval gate 2026-08-03) — implemented (PR #1342)
- **Created**: 2026-08-03
- **Issue**: #1338

## Clarifying Questions Asked
<!-- This spec is authored from a well-specified GitHub issue (#1338) plus an architect
constraint delivered at spawn time, then refined by a 3-way consultation. No live human Q&A
was needed; the questions below are the ones the issue/constraint/review already answer,
recorded to show the discovery process. -->

1. **What exactly is being retired — the Gemini *builder* harness, the `gemini` *consult* lane, or `agy`?**
   Only the standalone **Gemini CLI (`gemini`) builder harness**. The `agy`/Antigravity consult
   lane, `consult -m gemini`, and any `agy` architect support are explicitly **out of scope**
   (issue Non-goals).

2. **Is this "the CLI no longer exists," or a Codev product decision?**
   A **Codev product retirement**. Google ended Gemini CLI access for **consumer accounts**
   (free/Pro/Ultra tiers) on **2026-06-18**; Standard/Enterprise subscriptions and API-key
   authentication reportedly remain. Codev is retiring the *built-in* `gemini` harness as a
   *supported* option because it is unavailable to most users — not asserting the binary is gone
   everywhere. Users who retain access can still wire it via a **custom harness** (see Assumptions).

3. **Should Gemini be hard-removed, or retired-with-a-message?**
   Retired with a **clear explanation**. Acceptance criterion 2 requires that a user selecting
   Gemini CLI as a builder "receive a clear explanation that the option has been retired" — a
   silent removal or a generic error does not satisfy this.

4. **`resolveHarness` is role-agnostic — does retirement affect the architect path too?**
   Yes, and that is **intended**. The single `resolveHarness` (harness.ts:358) takes no role
   parameter and is shared by both `getArchitectHarness` and `getBuilderHarness` (config.ts:261,
   280). Because the CLI is unavailable for the same tiers regardless of role — and gemini is
   *already* unsupported as an architect (doctor warns today) — the retirement is applied
   **role-agnostically** rather than threading a role parameter through a shared signature. This is
   broader in *mechanism* than "builder-only," but consistent with the issue's intent and with the
   existing architect stance. (Surfaced by the Claude review; flagged to the architect at the gate.)

5. **What must remain unaffected?**
   Claude, Codex, OpenCode, and custom builder harnesses (acceptance criterion 3), and the entire
   `agy` / `consult -m gemini` subsystem.

6. **Are there pinned architectural decisions (Baked Decisions) to honor verbatim?**
   No. Issue #1338 contains no "Baked Decisions" section.

7. **Can this PR self-merge once approved?**
   No. We are not upstream maintainers on this repo; the PR requires an external maintainer to
   approve/merge (architect constraint, 2026-08-03). The change must stand on its own for external
   review.

## Problem Statement
Codev still presents and wires the standalone **Gemini CLI (`gemini`)** as a supported *builder*
harness. On **2026-06-18** Google ended Gemini CLI availability for **consumer accounts** (Pro,
Ultra, and free tiers), so for most users the option no longer works. Continuing to advertise it as
a supported builder — in the harness registry, in command auto-detection, in `codev doctor`
guidance, and in the README configuration example — is misleading: users who follow that guidance
configure a builder that cannot launch for them, and the failure they hit today is not a clear
"this is retired" explanation. This is therefore a **Codev product retirement** of the built-in
`gemini` harness, not a claim that the Gemini binary is gone for everyone (Standard/Enterprise and
API-key access reportedly persist — see Assumptions for the custom-harness escape hatch).

Compounding the case, the retirement must be done carefully because the shared resolver has two
distinct latent failure modes if `gemini` is naively removed (verified against `harness.ts`):

- **Remove the auto-detect case *and* the registry entry** → `detectHarnessFromCommand` no longer
  returns `'gemini'`, so a config with `builder: "gemini …"` falls through to the final
  `return CLAUDE_HARNESS` (harness.ts:392). Result: Codev **silently launches the Claude harness**
  for a gemini command, injecting Claude-only args (`--append-system-prompt`) into a non-Claude
  binary — the same class of silent mismatch Issue #929 fixed for architects.
- **Remove *only* the registry entry** (leave the detector) → `detected === 'gemini'` (truthy), so
  `return BUILTIN_HARNESSES[detected]` (harness.ts:387) returns **`undefined`** typed as a
  `HarnessProvider` → a downstream `TypeError`, not a clean failure.

Both are unacceptable. The retirement must fail **clearly and closed** on every resolution path —
never a silent Claude fallback, never an `undefined`/TypeError.

## Current State
Today the `gemini` builder harness is a first-class, supported option:

- **Harness registry & provider.** A `GEMINI_HARNESS` provider (role injection via the
  `GEMINI_SYSTEM_MD` environment variable) is registered under the name `gemini` in the built-in
  harness registry (`BUILTIN_HARNESSES`, harness.ts:209-214) that enumerates all valid harness
  names (`claude`, `codex`, `gemini`, `opencode`).
- **Command auto-detection.** `detectHarnessFromCommand` (harness.ts:336-341) maps any command whose
  first token contains `gemini` to the `gemini` harness, so `builder: "gemini --yolo"` resolves to
  `GEMINI_HARNESS` even without an explicit `builderHarness` setting.
- **Shared, role-agnostic resolver.** `resolveHarness(harnessName, customHarnesses, command)`
  (harness.ts:358) has **no role parameter** and is called by *both* `getArchitectHarness` and
  `getBuilderHarness` (config.ts:261, 280). It throws a **generic** "Unknown harness" error for
  unrecognized explicit names (harness.ts:376-380), returns `BUILTIN_HARNESSES[detected]` for
  auto-detected names (:387), and otherwise **defaults to the Claude harness** (:392). None of these
  communicates "retired," and two of them are the failure modes described above.
- **`codev doctor`.** Doctor warns when `gemini` is configured as an *architect* and its message
  explicitly states "gemini is supported **for builders**, not architects" (doctor.ts:816-826),
  emitting a structured `issue:`/`recommendation:` pair at :826. After retirement this premise fully
  **inverts** — there is no supported builder either — so the branch needs a *defined new end state*,
  not just a reworded sentence. Doctor does not currently flag `gemini` configured as a *builder* at
  all.
- **README.** The README presents Gemini as a supported shell ("Other shells (Codex, Gemini) are
  also supported", README:392), lists the Gemini CLI `--yolo` autonomous flag (README:436), and
  shows a `.codev/config.json` example with **both** `"architect": "gemini --yolo"` *and*
  `"builder": "gemini --yolo"` (README:456-457). A soft caveat already notes the CLI "will stop
  working" for retired tiers and is "tracked as a follow-up" — this spec is that follow-up.
- **`afx reset`.** `harnessFromLaunchScript` (reset/context.ts:405-421) builds its
  recognizable-name set from `Object.keys(BUILTIN_HARNESSES)`, so removing `gemini` changes how
  reset treats a pre-existing gemini builder (see Assumptions — decided outcome).
- **Governance docs.** `codev/resources/arch.md` (291, 311-317) and `lessons-learned.md` (80)
  describe gemini as "builder-only," reflecting the pre-retirement state.
- **Tests.** Several unit/integration tests assert `GEMINI_HARNESS` behavior, `GEMINI_SYSTEM_MD`
  injection, gemini auto-detection, and `--builder-cmd gemini` resolution.

Scope confirmation: the `agy` consult lane and `consult -m gemini` are a **separate** subsystem,
already migrated off the retired CLI; they are out of scope here and remain untouched.

## Desired State
The standalone Gemini CLI is no longer offered or treated as a supported harness (builder **or**
architect, since the resolver is shared), and every path a user could take to select it produces a
**clear, specific retirement explanation** rather than a silent fallback, a generic error, an
`undefined`/TypeError, or a broken launch:

- Selecting `gemini` — via explicit `shell.builderHarness`/`shell.architectHarness: "gemini"` **or**
  by auto-detection from `shell.builder`/`shell.architect: "gemini …"` (string or array form) —
  fails **loudly and closed** with a message stating the option has been retired (Google ended
  consumer-tier Gemini CLI access on 2026-06-18) and naming the supported alternatives (claude,
  codex, opencode, or a custom harness). No silent Claude fallback and no `undefined` return on any
  path — the retired name is intercepted before both harness.ts:387 and :392.
- `gemini` is no longer enumerated among the supported/available built-in harnesses (it disappears
  from `BUILTIN_HARNESSES` and from the resolver's "Available harnesses" error listing).
- `codev doctor` no longer claims gemini is "supported for builders." Its `gemini` branch is
  redefined to present the **retirement** for both roles, and it additionally **flags a `gemini`
  builder configuration** with the same explanation (so users learn at config-check time, not only
  when a spawn fails). The structured `issue:`/`recommendation:` fields are updated accordingly.
- The README no longer presents Gemini as a supported shell: the "other shells" line, the
  autonomous-flags table, and the config example (both the architect and builder lines) are updated
  to supported harnesses, with a plain statement that the built-in Gemini CLI harness is retired.
- Governance docs (`arch.md`, `lessons-learned.md`) reflect that gemini is retired as a harness
  (updated in the Review phase per the hot/cold routing discipline).
- **Claude, Codex, OpenCode, and custom harnesses behave exactly as before**, and the entire
  `agy` / `consult -m gemini` subsystem is untouched.

## Stakeholders
- **Primary Users**: Codev users configuring a builder (or architect) harness in
  `.codev/config.json` — especially anyone with an existing `gemini` config who will now get a clear
  retirement message.
- **Secondary Users**: Architects spawning builders; adopters reading the README to choose a shell.
- **Technical Team**: Codev maintainers of the agent-farm harness subsystem (this builder) and the
  external upstream maintainer who will review/merge the PR.
- **Business Owners**: Codev project owners (issue author / architect).

## Success Criteria
- [ ] `gemini` is no longer registered or enumerated as a supported built-in harness — removed from
      `BUILTIN_HARNESSES` and absent from the resolver's "Available harnesses" listing (criterion 1).
- [ ] Selecting `gemini` via **explicit** `builderHarness: "gemini"` fails with a clear message that
      the option is **retired**, naming supported alternatives (criterion 2).
- [ ] Selecting `gemini` via **auto-detection** from `builder: "gemini …"` (string form) fails with
      the same clear retirement message — specifically **not** the Claude harness and **not**
      `undefined` (criterion 1 + 2; closes both #929-class footguns).
- [ ] The retirement holds through the real config integration paths, not just direct
      `resolveHarness` calls: `getBuilderHarness`, the `--builder-cmd gemini` CLI override, and the
      **array-form** builder command (`builder: ["gemini", "--yolo"]`) all fail closed with the
      retirement message.
- [ ] The **architect** path is defined and covered: `getArchitectHarness` / `--architect-cmd gemini`
      also fail closed with the retirement message (consequence of the shared resolver; stated
      explicitly rather than left undefined).
- [ ] `codev doctor` no longer states gemini is "supported for builders"; its `gemini` branch
      presents the retirement and **also flags a `gemini` builder config**, verified via the
      structured `issue:`/`recommendation:` fields (a stabler assertion target than console text).
- [ ] The README no longer presents Gemini as a supported shell; the "other shells" line, the
      autonomous-flags table, and **both** the architect and builder lines of the config example are
      updated, with a plain retirement note.
- [ ] Claude, Codex, OpenCode, and custom harnesses resolve and spawn unchanged (criterion 3),
      demonstrated by existing green tests for those paths.
- [ ] Each removed gemini test is **replaced by a retirement-behavior test** (rather than merely
      deleted), so the retired paths are positively asserted. (Coverage is measured by
      replacement, not by an absolute baseline delta.)
- [ ] Governance docs (`arch.md` / `lessons-learned.md`) updated to reflect the retirement.
- [ ] No *current, user-facing harness-selection* documentation still presents gemini as a supported
      builder (see the scoped documentation criterion in Test Scenarios — historical artifacts and
      the `consult -m gemini` lane are exempt).

## Constraints
### Technical Constraints
- **Shared, role-agnostic resolver.** The retirement is implemented once in the shared
  `resolveHarness` and therefore applies to *both* architect and builder resolution. This is a
  deliberate design choice (see Clarifying Question 4), not a threaded role parameter.
- **Both resolution branches must be covered on the retired name**: the explicit-name path, the
  auto-detected-name path (must not return `BUILTIN_HARNESSES['gemini']` → `undefined`, harness.ts:387),
  and the no-match default (must not degrade to `CLAUDE_HARNESS`, :392). Intercept `gemini` before
  both.
- **Fail closed, never mis-inject**: a retired harness must never launch under another harness's
  role-injection mechanism, and must never resolve to `undefined`.
- **No changes to the `agy` consult lane, `consult -m gemini`, or `agy` architect support** (issue
  Non-goals). This is strictly the harness resolver + its presentation.
- **Existing harnesses untouched**: claude/codex/opencode/custom resolution and spawning must be
  behavior-identical after the change.
- **Framework-file mirroring**: any change to a framework doc shipped in `codev-skeleton/` must be
  mirrored in both trees. (Verified: **no** skeleton doc currently presents gemini as a builder, so
  the doc changes here are the top-level README + self-hosted `codev/resources/*` governance docs,
  which have no skeleton twin — but re-grep both trees during implementation before claiming done,
  per lessons-critical.)

### Business Constraints
- **No self-merge**: the PR must be approved/merged by an external upstream maintainer; the change
  must be self-contained and reviewable on its own.
- No time estimates (per protocol).

## Assumptions
- The retirement is a **hard retirement of the built-in option**, not a temporary deprecation:
  Codev will not present or affirm the built-in `gemini` harness as supported.
- **Standard/Enterprise and API-key access is served via a custom harness.** Users who still have a
  working Gemini CLI (enterprise subscription or API-key auth) can define a **custom harness** in
  `.codev/config.json` — the sanctioned extension point, which remains fully available (this is what
  keeps criterion 3's "custom builder support" intact). The retirement targets the built-in `gemini`
  *name*, not a user's own custom definition.
- **Already-running gemini builders are unaffected** — they are already launched; only *new*
  selections are gated. Such sessions cannot be re-created once the upstream CLI is unavailable to
  the user.
- **`afx reset` outcome — DECIDED (accepted).** After `gemini` leaves `BUILTIN_HARNESSES`,
  `harnessFromLaunchScript` (reset/context.ts:414) will no longer recognize a pre-existing gemini
  builder's launch script and will return `null` → `afx reset` reports "cannot determine harness"
  and declines. This is acceptable and requires no extra handling: a retired harness cannot
  context-reset anyway (only Claude declares `supportsContextReset`), and reset already refuses
  unrecognized harnesses loudly. Recorded here as a decided outcome, not an open question.

## Solution Approaches

### Approach 1: Retirement sentinel in the shared resolver (Recommended)
**Description**: Introduce an explicit notion of a **retired harness name** (a small
retired-names registry carrying a per-name explanation). The shared `resolveHarness` consults it
early on **both** entry paths — when a name is supplied explicitly, and after command auto-detection
resolves a name (intercepting *before* the `return BUILTIN_HARNESSES[detected]` at harness.ts:387
and the `return CLAUDE_HARNESS` default at :392) — and fails with a clear, specific retirement
message. `detectHarnessFromCommand` continues to recognize `gemini` so the auto-detect path lands on
the retirement message rather than falling through. The `GEMINI_HARNESS` provider and its registry
entry are removed, so gemini no longer appears among supported harnesses. Because the resolver is
role-agnostic, this covers architect and builder paths in one place.

**Pros**:
- Single source of truth for "what is retired and why."
- Clear, identical retirement message on *every* selection path (explicit + auto-detect, builder +
  architect), and guards the `undefined`-return path at :387.
- Eliminates the silent Claude fallback footgun (fails closed).
- Extensible: future retirements slot into the same mechanism.
- gemini disappears from the "available harnesses" enumeration → satisfies "no longer presented."

**Cons**:
- Slightly more than a one-line delete; a partial implementation (covering only one branch) would
  reopen a footgun, so all three resolver exits must be handled.
- Retires the architect path too — correct here, but a design point to state explicitly (done).

**Estimated Complexity**: Low–Medium
**Risk Level**: Low

### Approach 2: Throwing provider (mirror the OpenCode-architect pattern)
**Description**: Keep a `gemini` entry in the built-in registry but replace its provider with one
whose role-injection methods **throw** the retirement error (mirroring how the OpenCode harness
throws when misused as an architect). Auto-detection unchanged.

**Pros**:
- Minimal structural change; reuses an existing in-repo precedent.
- Auto-detect still finds `gemini`, and the throw fires when role injection is attempted.

**Cons**:
- Fails **late** (deep in the spawn path at role-injection time) rather than at resolution — worse
  diagnostics and a later failure point.
- Keeps a "live-looking" registry entry: gemini still appears in the resolver's "available
  harnesses" list and in every consumer that enumerates `BUILTIN_HARNESSES` (e.g. `afx reset`),
  contradicting "no longer presented as supported."
- The error only surfaces on paths that actually call role injection.

**Estimated Complexity**: Low
**Risk Level**: Medium (weaker on criterion 1; later failure)

### Approach 3: Hard removal only (Rejected)
**Description**: Delete `GEMINI_HARNESS`, its registry entry, and the auto-detect case, with no
retirement sentinel.

**Pros**:
- Least code.

**Cons**:
- Explicit `builderHarness: "gemini"` → generic "Unknown harness" error (no retirement explanation
  → **fails criterion 2**).
- Auto-detected `builder: "gemini …"` → **silently** resolves to the Claude harness and injects
  Claude args into the gemini command (**fails criterion 1**, dangerous #929-class mismatch). If
  instead only the registry entry is removed, the auto-detect path returns `undefined` → TypeError.

**Rejected**: does not meet the acceptance criteria and reintroduces a known footgun.

**Recommendation**: **Approach 1.** It is the only approach that satisfies all three acceptance
criteria, closes both silent-failure footguns, and covers the shared architect/builder paths in one
place, at modest cost. The plan also corrects the stale `codev doctor` messaging (redefining its
`gemini` branch and adding builder-side flagging) and the README presentation as part of the same
change.

## Open Questions

### Critical (Blocks Progress)
- [ ] None. Approach, scope, and the architect-path/doctor/afx-reset decisions are all resolved
      above.

### Important (Affects Design)
- [ ] None outstanding. (The doctor question — "should a `gemini` *builder* config be flagged?" — is
      **decided: yes**, and is now a success criterion. The architect-path outcome is **decided:
      role-agnostic retirement**.)

### Nice-to-Know (Optimization)
- [ ] Exact wording of the single retirement message string (must name the 2026-06-18 consumer-tier
      end-of-availability and the alternatives). Deferred to the plan; not blocking.

## Performance Requirements
N/A — this change removes/gates a code path and edits docs; it has no runtime performance dimension
(no measurable response-time, throughput, or resource-usage impact).

## Security Considerations
- **Fail closed (primary safety property)**: the retirement must never cause a `gemini` command to
  be launched under another harness's role-injection mechanism (no Claude `--append-system-prompt`
  into a non-Claude command — the Issue #929 class of bug), and must never resolve to `undefined`
  (a TypeError is an unclean failure, not a safe one). Clear, early failure on every resolver exit
  is the safe behavior, and is encoded as explicit tests.
- **No new input surfaces, auth, or data-handling changes.** Authentication/authorization model: N/A
  (unchanged).

## Test Scenarios
### Functional Tests
1. **Explicit retired name**: resolving with explicit `builderHarness: "gemini"` throws a clear
   error containing the retirement explanation and supported alternatives (not a generic "Unknown
   harness").
2. **Auto-detected retired command (string form)**: resolving from `builder: "gemini --yolo"` (no
   explicit `builderHarness`) throws the **same** retirement error — asserting it returns neither
   `CLAUDE_HARNESS` nor `undefined`.
3. **Config integration paths** (per the "every path" concern): `getBuilderHarness` with a gemini
   config, the `--builder-cmd gemini` CLI override, and the **array-form** builder command
   (`builder: ["gemini", "--yolo"]`) each fail closed with the retirement message.
4. **Architect path**: `getArchitectHarness` / `--architect-cmd gemini` also fail closed with the
   retirement message (shared-resolver consequence).
5. **Unrelated unknown harness still generic**: an unrelated unknown name (e.g. `"frobnicate"`)
   still throws the ordinary "Unknown harness" error (retirement handling is specific to retired
   names, not a catch-all).
6. **Unaffected harnesses**: claude, codex, opencode, and a representative custom harness each still
   resolve to their correct provider and produce correct role injection (regression guard for
   criterion 3).
7. **Doctor guidance**: `codev doctor` no longer asserts gemini is "supported for builders"; for a
   gemini config it emits the retirement via its structured `issue:`/`recommendation:` fields
   (assert on those fields, not console text).

### Non-Functional Tests
1. **Scoped documentation consistency**: a check confirms no **current, user-facing
   harness-selection** doc still presents `gemini` as a supported builder shell (README config
   example / autonomous-flags / "other shells" line; governance harness docs). **Explicitly
   exempt**: historical artifacts (`codev/specs`, `plans`, `reviews`, `projects`, `docs/releases/*`,
   release notes) and every `consult -m gemini` / `agy` consult-lane reference (out of scope by the
   Non-goals).
2. **Coverage by replacement**: each removed gemini-specific test has a corresponding
   retirement-behavior test (measured as replacement, since an absolute coverage baseline is not
   meaningful for a removal).
3. **Security/behavioral (fail-closed encoded as tests)**: explicit assertions that the retired
   paths return neither `CLAUDE_HARNESS` nor `undefined` on both the auto-detect and default exits.

## Dependencies
- **External Services**: None.
- **Internal Systems**: The agent-farm harness subsystem (`agent-farm/utils/harness.ts` resolver,
  registry, and detector), `codev doctor` (`commands/doctor.ts`), the config typing for
  `builderHarness`/`architectHarness` (`agent-farm/types.ts`, `lib/config.ts`), and the `afx reset`
  harness-recognition path (`reset/context.ts`, sanity-checked for the decided edge case).
- **Libraries/Frameworks**: None added.

## References
- Issue #1338 — Retire Gemini CLI as a builder harness (this spec's source).
- Issue #778 — Gemini CLI retirement and migration of the consultation lane to `agy`.
- Issue #929 — gemini made builder-only; introduced override-aware harness resolution (the
  silent-mismatch class of bug this spec must avoid reopening).
- Issue #1063 — possible `agy` architect support (out of scope; does not cover builder support).
- Google Gemini Code Assist deprecations (consumer-tier CLI access ended 2026-06-18;
  Standard/Enterprise + API-key reportedly remain) — basis for the "Codev product retirement" framing.
- `packages/codev/src/agent-farm/utils/harness.ts` — current registry, provider, detector, resolver
  (orientation only; edits belong in the plan).
- `codev/resources/arch.md` (harness section) — governance description of harness support.

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| Partial fix covers only one resolver exit, leaving `builder: "gemini …"` to silently return Claude (harness.ts:392) or `undefined` (harness.ts:387) | Medium | High | Test scenarios 2 + 3 + Non-Functional 3 assert the retired paths return neither `CLAUDE_HARNESS` nor `undefined`; made a required success criterion. |
| Retiring the shared resolver unintentionally breaks a *supported* architect (codex/claude) | Low | High | Sentinel keys only on the retired name (`gemini`); scenario 6 regression-guards claude/codex/opencode/custom for both roles. |
| Scope creep into the `agy`/`consult -m gemini` lanes | Low | Medium | Constraints + Non-goals pin the boundary; documentation criterion explicitly exempts the consult lane. |
| Stale `doctor` message left asserting "supported for builders" | Medium | Medium | Explicit success criterion + functional test 7 on doctor's structured fields. |
| Over-broad "no lingering presentation" criterion flags historical artifacts / consult refs | Medium | Low | Documentation criterion is scoped to *current user-facing harness-selection* docs; historical + consult refs explicitly exempt. |
| A framework doc in `codev-skeleton/` missed during doc updates | Low | Low | Verified no skeleton doc presents gemini as a builder; re-grep both trees during implementation before claiming done. |

## Expert Consultation
**Date**: 2026-08-03
**Models Consulted**: Gemini (via agy), Codex (GPT-5.6 Sol), Claude Opus 5 — SPIR spec review, iteration 1.
**Verdicts**: Gemini APPROVE; Codex REQUEST_CHANGES; Claude REQUEST_CHANGES.
**Sections Updated (this iteration)**:
- *Problem Statement / Clarifying Questions*: reframed as a **Codev product retirement** and corrected
  the availability wording (consumer tiers ended; Standard/Enterprise + API-key remain) — Codex.
- *Problem Statement / Approaches / Security*: split the naive-removal footgun into its **two** precise
  failure modes (silent Claude fallback vs. `undefined`/TypeError) and required guarding both — Claude.
- *Desired State / Success Criteria / Constraints / Clarifying Q4*: made the **role-agnostic** (shared
  `resolveHarness`) retirement explicit, covering the architect path and the README architect line — Claude.
- *Desired State / Success Criteria / Test 7*: defined doctor's new end state, added **builder-side
  flagging**, and switched assertions to the structured `issue:`/`recommendation:` fields — Codex + Claude.
- *Success Criteria / Test Scenarios*: added `getBuilderHarness`, `--builder-cmd gemini`, and
  **array-form** builder-command coverage; reframed coverage as **replacement** — Codex + Claude.
- *Assumptions*: recorded the **`afx reset`** outcome as a decided/accepted result (moved out of Open
  Questions) — Claude + Gemini.
- *Test Scenarios (Non-Functional 1)*: scoped the documentation criterion to exempt historical
  artifacts and the `consult -m gemini` lane — Codex.

Note: All consultation feedback has been incorporated directly into the relevant sections above; the
rebuttal document records the point-by-point disposition.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [x] Expert AI Consultation Complete (iteration 1; re-verification pending after this revision)

## Notes
- The **custom harness** mechanism remains the sanctioned extension point for any user who still has
  access to a (e.g. enterprise / API-key) Gemini CLI: the retirement targets the built-in `gemini`
  name, not a user's own custom harness definition.
- This spec fixes *behavior* and *acceptance*, deliberately leaving implementation mechanics (exact
  files, the shape of the retired-name registry, the precise message string) to the plan.
