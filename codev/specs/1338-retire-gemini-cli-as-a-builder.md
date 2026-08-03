# Specification: Retire Gemini CLI as a Builder Harness

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
Implementation phases, file-level edits, and code belong in codev/plans/1338-*.md.
-->

## Metadata
- **ID**: spec-2026-08-03-retire-gemini-cli-builder
- **Status**: draft
- **Created**: 2026-08-03
- **Issue**: #1338

## Clarifying Questions Asked
<!-- This spec is authored from a well-specified GitHub issue (#1338) plus an architect
constraint delivered at spawn time. No live human Q&A was needed; the questions below are
the ones the issue/constraint already answer, recorded to show the discovery process. -->

1. **What exactly is being retired — the Gemini *builder* harness, the `gemini` *consult* lane, or `agy`?**
   Only the standalone **Gemini CLI (`gemini`) builder harness**. The `agy`/Antigravity consult
   lane, `consult -m gemini`, and any `agy` architect support are explicitly **out of scope**
   (issue Non-goals).

2. **Should Gemini be hard-removed, or retired-with-a-message?**
   Retired with a **clear explanation**. Acceptance criterion 2 requires that a user selecting
   Gemini CLI as a builder "receive a clear explanation that the option has been retired" — a
   silent removal or a generic error does not satisfy this.

3. **What must remain unaffected?**
   Claude, Codex, OpenCode, and custom builder harnesses (acceptance criterion 3).

4. **Are there pinned architectural decisions (Baked Decisions) to honor verbatim?**
   No. Issue #1338 contains no "Baked Decisions" section.

5. **Can this PR self-merge once approved?**
   No. We are not upstream maintainers on this repo; the PR requires an external maintainer to
   approve/merge (architect constraint, 2026-08-03). The change must stand on its own for
   external review.

## Problem Statement
Codev still presents and wires the standalone **Gemini CLI (`gemini`)** as a supported *builder*
harness. On **2026-06-18** Google discontinued Gemini CLI availability for Pro, Ultra, and free
tiers, so for most users the CLI no longer exists to launch. Continuing to advertise it as a
supported builder — in the harness registry, in command auto-detection, in `codev doctor`
guidance, and in the README configuration example — is misleading: users who follow that guidance
configure a builder that cannot run, and the failure they hit today is not a clear "this is
retired" explanation.

Worse, the current resolution logic has a latent footgun for the retirement: if the `gemini`
harness were naively deleted, a config that auto-detects the harness from `builder: "gemini …"`
would **silently fall back to the Claude harness** and inject Claude-specific arguments
(`--append-system-prompt`) into a non-Claude command — the same class of silent mismatch that
Issue #929 fixed for architects. Any retirement must fail *clearly and closed*, not silently.

## Current State
Today the `gemini` builder harness is a first-class, supported option:

- **Harness registry & provider.** A `GEMINI_HARNESS` provider (role injection via the
  `GEMINI_SYSTEM_MD` environment variable) is registered under the name `gemini` in the built-in
  harness registry that enumerates all valid builder harnesses (`claude`, `codex`, `gemini`,
  `opencode`).
- **Command auto-detection.** The command-basename detector maps any command whose first token
  contains `gemini` to the `gemini` harness, so `builder: "gemini --yolo"` resolves to
  `GEMINI_HARNESS` even without an explicit `builderHarness` setting.
- **Resolver behavior.** The resolver throws a **generic** "Unknown harness" error for names it
  does not recognize, and — on the *auto-detect* path only — **defaults to the Claude harness**
  when no name is detected. Neither behavior communicates "retired."
- **`codev doctor`.** Doctor warns when `gemini` is configured as an *architect*, and its message
  explicitly states "gemini is supported **for builders**, not architects." After retirement this
  message is actively wrong: it affirms builder support that no longer exists. Doctor does not
  currently flag `gemini` configured as a *builder*.
- **README.** The README presents Gemini as a supported shell ("Other shells (Codex, Gemini) are
  also supported"), lists the Gemini CLI `--yolo` autonomous flag, and shows a `.codev/config.json`
  example with `"builder": "gemini --yolo"`. A soft caveat already notes the CLI "will stop
  working" for retired tiers and is "tracked as a follow-up" — this spec is that follow-up.
- **Governance docs.** `codev/resources/arch.md` and `lessons-learned.md` describe gemini as
  "builder-only," reflecting the pre-retirement state.
- **Tests.** Several unit/integration tests assert `GEMINI_HARNESS` behavior, `GEMINI_SYSTEM_MD`
  injection, gemini auto-detection, and `--builder-cmd gemini` resolution.

Scope confirmation: the `agy` consult lane and `consult -m gemini` are a **separate** subsystem and
are already migrated off the retired CLI; they are out of scope here and remain untouched.

## Desired State
The standalone Gemini CLI is no longer offered or treated as a supported builder harness, and every
path a user could take to select it produces a **clear, specific retirement explanation** rather
than a silent fallback, a generic error, or a broken launch:

- Selecting `gemini` as a builder — whether via an explicit `shell.builderHarness: "gemini"` or by
  auto-detection from `shell.builder: "gemini …"` — fails **loudly and closed** with a message that
  states the option has been retired (Google discontinued the Gemini CLI on 2026-06-18 for
  Pro/Ultra/free tiers) and names the supported alternatives (claude, codex, opencode, or a custom
  harness). No silent fallback to the Claude harness on any path.
- `gemini` is no longer enumerated among the supported/available built-in builder harnesses.
- `codev doctor` no longer claims gemini is "supported for builders"; its guidance reflects the
  retirement (and, ideally, flags `gemini` configured as a builder with the same clear explanation).
- The README no longer presents Gemini as a supported builder shell; the configuration example and
  autonomous-flags guidance point users to supported harnesses, with a plain statement that the
  Gemini CLI builder is retired.
- Governance docs (`arch.md`, `lessons-learned.md`) reflect that gemini is retired as a builder
  (updated in the Review phase per the hot/cold routing discipline).
- **Claude, Codex, OpenCode, and custom builder harnesses behave exactly as before.**

## Stakeholders
- **Primary Users**: Codev users configuring a builder harness in `.codev/config.json` (especially
  anyone with an existing `gemini` builder config who will now get a clear retirement message).
- **Secondary Users**: Architects spawning builders; adopters reading the README to choose a shell.
- **Technical Team**: Codev maintainers of the agent-farm harness subsystem (this builder) and the
  external upstream maintainer who will review/merge the PR.
- **Business Owners**: Codev project owners (issue author / architect).

## Success Criteria
- [ ] `gemini` is no longer registered or enumerated as a supported built-in builder harness
      (acceptance criterion 1).
- [ ] Selecting `gemini` as a builder via **explicit** `shell.builderHarness: "gemini"` fails with a
      clear message that the option is **retired**, naming supported alternatives (criterion 2).
- [ ] Selecting `gemini` via **auto-detection** from `shell.builder: "gemini …"` fails with the same
      clear retirement message — and specifically does **not** silently resolve to the Claude
      harness (criterion 1 + 2; closes the #929-class footgun).
- [ ] `codev doctor` no longer states gemini is "supported for builders"; its output reflects the
      retirement (criterion 1/2).
- [ ] The README no longer presents Gemini as a supported builder shell; its config example and
      autonomous-flag guidance are updated to supported harnesses with a plain retirement note.
- [ ] Claude, Codex, OpenCode, and custom builder harnesses resolve and spawn unchanged
      (criterion 3), demonstrated by existing green tests for those paths.
- [ ] The harness test suite is updated to assert **retirement behavior** (clear error on both
      resolution paths) instead of `GEMINI_HARNESS` injection; no reduction in overall coverage.
- [ ] Governance docs (`arch.md` / `lessons-learned.md`) updated to reflect the retirement.
- [ ] Documentation updated (README + governance docs); no lingering presentation of gemini as a
      supported builder across the repo.

## Constraints
### Technical Constraints
- **Two resolution paths must both be covered**: explicit harness name and command auto-detection.
  Correctness requires the retirement message on *both*; the auto-detect path must not degrade to
  the default Claude harness.
- **Fail closed, never mis-inject**: a retired builder must never launch under another harness's
  role-injection mechanism (no Claude args into a `gemini` command).
- **No changes to the `agy` consult lane, `consult -m gemini`, or `agy` architect support** (issue
  Non-goals). This is strictly the builder harness.
- **Existing harnesses untouched**: claude/codex/opencode/custom resolution and spawning must be
  behavior-identical after the change.
- **Framework-file mirroring**: any change to a framework doc shipped in `codev-skeleton/` must be
  mirrored in both trees. (Note: verified that **no** skeleton doc currently presents gemini as a
  builder, so the doc changes here are self-hosted `codev/resources/*` governance docs + the
  top-level README, which have no skeleton twin — but this must be re-confirmed during
  implementation, not assumed.)

### Business Constraints
- **No self-merge**: the PR must be approved/merged by an external upstream maintainer; the change
  must be self-contained and reviewable on its own.
- No time estimates (per protocol).

## Assumptions
- The retirement is a **hard retirement**, not a temporary deprecation: there is no supported path
  that keeps the Gemini CLI builder working, because the upstream CLI is gone for the affected
  tiers. (An enterprise Gemini CLI may still exist, but Codev will not present or affirm the
  built-in `gemini` builder harness as supported; users needing it can define a **custom harness**.)
- Users who need Gemini-style behavior are directed to supported harnesses (claude/codex/opencode)
  or the existing **custom harness** mechanism, which remains available and is the sanctioned
  extension point (this is the escape hatch that keeps criterion 3's "custom builder support"
  intact).
- Already-running gemini builders (spawned before this change) are out of scope — they are already
  launched; only *new* selections are gated. This is acceptable because such sessions cannot be
  re-created once the upstream CLI is unavailable.
- The `custom harness` path can still *name* a harness `gemini`-like via a distinct custom key; the
  retirement applies to the built-in `gemini` name, not to a user's own custom definition.

## Solution Approaches

### Approach 1: Retirement sentinel in the resolver (Recommended)
**Description**: Introduce an explicit notion of a **retired harness name** (e.g. a small
retired-names registry carrying a per-name explanation). The harness resolver consults it early on
**both** entry paths — when a name is supplied explicitly and after command auto-detection resolves
a name — and fails with a clear, specific retirement message. Command auto-detection continues to
recognize `gemini` (so the auto-detect path lands on the retirement message rather than silently
defaulting to Claude). The `GEMINI_HARNESS` provider and its registry entry are removed, so gemini
no longer appears among supported harnesses.

**Pros**:
- Single source of truth for "what is retired and why."
- Clear, identical retirement message on *every* selection path (explicit + auto-detect).
- Eliminates the silent Claude fallback footgun (fails closed).
- Extensible: future retirements slot into the same mechanism.
- gemini disappears from the "available harnesses" enumeration → satisfies "no longer presented."

**Cons**:
- Slightly more than a one-line delete; must ensure *both* resolver branches consult the retired
  set (a partial implementation would reopen the footgun).

**Estimated Complexity**: Low–Medium
**Risk Level**: Low

### Approach 2: Throwing provider (mirror the OpenCode-architect pattern)
**Description**: Keep a `gemini` entry in the built-in registry but replace its provider with one
whose role-injection methods **throw** the retirement error (mirroring how the OpenCode harness
throws when misused as an architect). Auto-detection is unchanged.

**Pros**:
- Minimal structural change; reuses an existing in-repo precedent.
- Auto-detect still finds `gemini`, and the throw fires when role injection is attempted.

**Cons**:
- Fails **late** (deep in the spawn path at role-injection time) rather than at resolution — worse
  diagnostics and a later failure point.
- Keeps a "live-looking" registry entry: gemini still appears in the resolver's "available
  harnesses" list and in other consumers that enumerate built-in harnesses, which contradicts "no
  longer presented as supported."
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
  Claude args into the gemini command (**fails criterion 1**, dangerous #929-class mismatch).

**Rejected**: does not meet the acceptance criteria and reintroduces a known footgun.

**Recommendation**: **Approach 1.** It is the only approach that satisfies all three acceptance
criteria and closes the silent-fallback footgun, at modest cost. The plan will also correct the
stale `codev doctor` builder-support message and the README presentation as part of the same change.

## Open Questions

### Critical (Blocks Progress)
- [ ] None. The recommended approach and scope are determined by the issue and verified surface.

### Important (Affects Design)
- [ ] Should `codev doctor` additionally **flag `gemini` configured as a *builder*** (proactively,
      at config-check time) with the retirement explanation, or is failing at spawn time sufficient?
      (Recommendation: do both — correct the stale architect-facing message *and* surface a
      builder-facing retirement note in doctor, since doctor is the natural "clear explanation"
      surface. Final call deferred to the plan/consultation.)

### Nice-to-Know (Optimization)
- [ ] Should `afx reset` on a pre-existing `gemini` builder emit the retirement message rather than
      simply not recognizing the harness once gemini leaves the built-in registry? (Edge case; a
      retired harness cannot context-reset anyway. Likely "leave as-is, note in review.")

## Performance Requirements
N/A — this change removes/gates a code path and edits docs; it has no runtime performance
dimension (no measurable response-time, throughput, or resource-usage impact).

## Security Considerations
- **Fail closed (primary safety property)**: the retirement must never cause a `gemini` command to
  be launched under another harness's role-injection mechanism. Silently injecting Claude's
  `--append-system-prompt` (or any mismatched arguments) into a non-Claude command is the class of
  bug Issue #929 addressed; this change must not reintroduce it. Clear, early failure is the safe
  behavior.
- **No new input surfaces, auth, or data-handling changes.** Authentication/authorization model:
  N/A (unchanged).

## Test Scenarios
### Functional Tests
1. **Explicit retired name (happy-path for the retirement)**: resolving a builder harness with an
   explicit `builderHarness: "gemini"` throws a clear error containing the retirement explanation
   and supported alternatives (not a generic "Unknown harness").
2. **Auto-detected retired command (edge case + footgun guard)**: resolving a builder harness from
   `builder: "gemini --yolo"` (no explicit `builderHarness`) throws the **same** retirement error —
   and specifically does **not** return the Claude harness.
3. **Error condition — unrelated unknown harness still generic**: an unrelated unknown name (e.g.
   `"frobnicate"`) still throws the ordinary "Unknown harness" error (retirement handling is
   specific to retired names, not a catch-all).
4. **Unaffected harnesses**: claude, codex, opencode, and a representative custom harness each still
   resolve to their correct provider and produce their correct role injection (regression guard for
   criterion 3).
5. **Doctor guidance**: `codev doctor` output no longer asserts gemini is "supported for builders,"
   and reflects the retirement (assert on the emitted text).

### Non-Functional Tests
1. **Documentation consistency**: a repo-wide check confirms no user-facing doc still presents
   `gemini` as a supported builder shell (README config example / autonomous-flags / "other shells"
   line updated; governance docs updated).
2. **Coverage non-regression**: overall test coverage does not drop; gemini-specific tests are
   replaced by retirement-behavior tests rather than merely deleted.
3. **Security/behavioral**: an explicit assertion that the auto-detect path for `gemini` never
   returns `CLAUDE_HARNESS` (encodes the fail-closed property as a test).

## Dependencies
- **External Services**: None.
- **Internal Systems**: The agent-farm harness subsystem (`agent-farm/utils/harness.ts` resolver
  and registry), `codev doctor`, and the config typing for `builderHarness`. The `afx reset`
  harness-recognition path (`reset/context.ts`) consumes the built-in registry and should be sanity-
  checked for the edge case above.
- **Libraries/Frameworks**: None added.

## References
- Issue #1338 — Retire Gemini CLI as a builder harness (this spec's source).
- Issue #778 — Gemini CLI retirement and migration of the consultation lane to `agy`.
- Issue #929 — gemini made builder-only; introduced override-aware harness resolution (the
  silent-mismatch class of bug this spec must avoid reopening).
- Issue #1063 — possible `agy` architect support (out of scope; does not cover builder support).
- `packages/codev/src/agent-farm/utils/harness.ts` — current harness registry, provider, detector,
  and resolver (orientation only; edits belong in the plan).
- `codev/resources/arch.md` (harness section) — governance description of harness support.

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| Partial fix covers only the explicit path, leaving the auto-detect path to silently fall back to Claude | Medium | High | Test scenario 2 + 3 explicitly assert the auto-detect path fails closed with the retirement message; make it a required success criterion. |
| Scope creep into the `agy`/`consult -m gemini` lanes | Low | Medium | Constraints + Non-goals pin the boundary; reviewers instructed the consult lane is out of scope. |
| Stale `doctor` message left asserting "supported for builders" | Medium | Medium | Explicit success criterion + functional test for doctor output. |
| A framework doc in `codev-skeleton/` missed during doc updates | Low | Low | Verified no skeleton doc presents gemini as a builder; re-grep both trees during implementation before claiming done (per lessons-critical). |
| Breaking an existing user's running gemini builder | Low | Low | Only *new* selections are gated; running sessions are unaffected. Documented in Assumptions. |

## Expert Consultation
<!-- Populated by porch's 3-way consultation (Gemini via agy, Codex, Claude) after this draft. -->
**Date**: (pending porch consultation)
**Models Consulted**: (pending)
**Sections Updated**: (pending)

Note: All consultation feedback will be incorporated directly into the relevant sections above.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes
- The **custom harness** mechanism remains the sanctioned extension point for any user who still has
  access to an (e.g. enterprise) Gemini CLI: the retirement targets the built-in `gemini` name, not
  a user's own custom harness definition.
- This spec deliberately keeps implementation mechanics (exact files, the shape of the retired-name
  registry, the precise message string) for the plan; it fixes the *behavior* and *acceptance*, not
  the code.
