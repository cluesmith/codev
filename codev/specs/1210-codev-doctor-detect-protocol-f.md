# Specification: `codev doctor` — detect protocol-file drift

## Metadata
- **ID**: 1210-codev-doctor-detect-protocol-f
- **Status**: draft
- **Created**: 2026-07-22
- **Issue**: #1210
- **Area**: `area/scaffold` (resolver / doctor)

## Clarifying Questions Asked
No clarifying questions were needed — issue #1210 fully specifies the problem, the proposal
(4 numbered items), and the field evidence (17 confirmed instances in one adopting repo). The
issue contains **no "Baked Decisions" section**, so the design below is explored freely. The
proposal's four items are treated as the requirement backbone, with item 2 (known-default
detection) explicitly flagged "(stretch)" by the issue.

## Problem Statement

Codev's four-tier resolver (`.codev/` → `codev/` → cache → installed skeleton) lets a
project-local file shadow the shipped skeleton. That is the intended customization mechanism.
It fails **silently**, however, when a local copy is not a deliberate customization but a stale
snapshot of an old upstream default: the project keeps running old framework behavior forever,
with no signal, even after the installed package ships a fix. Nothing today distinguishes
"deliberately customized" from "rotted copy of an old default" — both look identical to the
resolver.

There is a sibling failure mode: even with **no** local shadow, the *installed skeleton itself*
can be a version behind, so non-shadowed resolution still serves pre-fix framework files. Also
silent.

### Field evidence (from the issue)
- A "bugfix PRs reviewed against SPIR conventions" consult-noise bug hit **3×** in one CI-cleanup
  sweep. Root cause: two project-local `codev/protocols/bugfix/consult-types/*.md` files, checked
  in months earlier from old upstream defaults, shadowing the skeleton's fixed templates. Upgrading
  the package changed nothing — tier precedence kept loading the stale local copies.
- A follow-up sweep of the same repo found **15 more** differing local protocol files (air / maintain
  / bugfix families) each needing customization-vs-rot adjudication.
- Before the upgrade, that repo's *installed skeleton* was itself a version behind — even
  non-shadowed resolution served pre-fix templates.
- Meta-note: the first diagnosis of this bug was itself derailed by a silently-vacuous check
  (relative paths run from the wrong cwd). This failure class compounds because every layer is quiet.

## Current State

`codev doctor` (`packages/codev/src/commands/doctor.ts`) already runs a battery of section-based
checks and rolls warnings into a `warningDetails` summary. It has three precedents for exactly this
shape of check — a pure audit lib that returns findings plus a formatter, wired into doctor
(and sometimes `update`):
- **PR-gate audit** (`lib/pr-gate-audit.ts`, #943) — resolved protocol overrides missing a `pr` gate.
- **Framework-ref audit** (`lib/framework-ref-audit.ts`, #1011) — local overrides that shell-fetch
  framework files by literal path.
- **State-file gitignore audit** (`lib/gitignore.ts`).

What is **missing**: doctor has no notion of *shadow drift* (a local file diverging from the skeleton
file it shadows) and no notion of *skeleton staleness* (installed package version vs npm latest).
The resolver (`lib/skeleton.ts`) already exposes the primitives needed — `getSkeletonDir()`,
`listSkeletonFiles(subdir)`, `resolveCodevFile()`, `hasLocalOverride()` — but nothing consumes them
for drift reporting. Today the only signal an adopter gets is a bug in production.

## Desired State

`codev doctor`, when run inside a codev project, gains a **Protocol / Framework Drift** report with
three checks. All are **report-only** — doctor never deletes or rewrites a local file:

1. **Shadow drift** — For every local framework file (under the scanned subtrees) that *also* exists
   in the installed skeleton:
   - **Byte-identical** → informational: this is a redundant copy that adds nothing but risk; suggest
     removing it so resolution falls through to the package.
   - **Differs** → warning: list the file, flagged "customized or stale? — adjudicate", with enough
     context (the skeleton's package version) for a human to decide.
2. **Skeleton staleness** — Compare the installed `@cluesmith/codev` version against the npm
   `latest` version (best-effort, offline-tolerant). Report how far behind the resolved framework
   files are, or stay silent/neutral when offline.
3. **Known-default detection (stretch)** — If the local copy of a differing file byte-matches a
   *historical* skeleton default (from shipped hashes), it is provably rot, not customization →
   emit a stronger, safe-to-delete recommendation. Optional; see Solution Approaches.
4. **No auto-delete.** Report only. Adjudication stays human — local copies may be deliberate.

The report is **quiet by default**: the Framework Drift section prints **nothing** unless it has
something actionable to say — i.e. either (a) at least one local shadow of a skeleton file exists, or
(b) the installed skeleton is behind npm latest. When the project ships no local framework overrides
**and** the skeleton is up to date (or the registry can't be reached), the section is a **true no-op
(no section printed / no warnings)**, mirroring how the framework-ref audit stays silent for projects
with no overrides. The staleness check is thus silent when up-to-date or offline, and surfaces only
when the installed skeleton is genuinely behind (the issue's sibling failure mode) — it is *not*
unconditionally printed just because doctor runs inside a project.

## Scope

### In scope
- A new drift-audit library (pure, testable) returning structured findings + formatters.
- Wiring the report into `codev doctor`.
- Shadow-drift detection over the framework subtrees that ship in the skeleton and resolve via the
  resolver. **Explicit scan set** (per Codex spec review — pinned here, not deferred to Plan): every
  `.md` / `.json` file under the skeleton's **`protocols/`**, **`consult-types/`**, and **`roles/`**
  trees (prompts and per-protocol templates live *within* `protocols/`, so they are covered). This is
  the enumerable "framework files that can be shadowed" set; adding a new top-level framework subtree
  is a documented maintenance point (same shape as `PR_PRODUCING_PROTOCOLS` in pr-gate-audit).
- **Both override roots are considered independently.** A given skeleton file may be shadowed by a
  tier-1 `.codev/<path>` copy, a tier-2 `codev/<path>` copy, or both. doctor reports **each local
  copy it finds**, labeled with its tier, each classified on its own (identical vs differs) — because
  a stale lower-precedence `codev/` copy is still rot even when a `.codev/` copy currently wins
  resolution. The report also names which copy the resolver actually resolves (the winner), so the
  human knows which one is live. (Note: the existing `hasLocalOverride()` helper only checks tier-2
  `codev/`; the no-op / presence detection here must check **both** roots.)
- Skeleton staleness: installed-version vs npm-latest, best-effort and offline-tolerant.
- Classification of each shadow as **identical** (redundant) vs **differs** (adjudicate).
- Tests: unit tests for the audit lib; an e2e/CLI test asserting doctor surfaces drift.

### Out of scope
- **Auto-deletion or auto-migration** of any local file (explicitly forbidden by the issue).
- Changing the **resolver's precedence** — tier order is unchanged; local still wins.
- Drift of **user-evolved resources** (`codev/resources/arch.md`, `lessons-learned.md`, and their
  `-critical` companions). These are intentionally project-owned, not framework files, and must not
  be flagged. (Consistent with framework-ref-audit deliberately excluding `codev/resources/`.)
- Detecting drift against the **cache tier** (tier 3). The failure class in the field is local-copy
  vs *skeleton*; cache drift is a separate concern and stays out to keep the check focused.
- Wiring the report into `codev update` is **optional / SHOULD**, not required (the issue says
  "and optionally `codev update`"). The primary home is doctor.

## Success Criteria
- [ ] Running `codev doctor` in a project with a **byte-identical** local shadow of a skeleton file
      prints an informational "redundant copy — safe to remove" line for that file.
- [ ] Running `codev doctor` in a project with a local shadow that **differs** from the skeleton
      prints a warning flagged "customized or stale? — adjudicate", naming the file and the skeleton
      package version, and increments the doctor warning count.
- [ ] Running `codev doctor` in a project with **no** local framework overrides **and an up-to-date
      (or unreachable) skeleton** prints no Framework Drift section at all (true no-op — no false "all
      clean", no warnings, no crash). If the skeleton is behind, the staleness warning still surfaces
      (that case is not a no-op — it is the issue's sibling failure mode).
- [ ] Skeleton-staleness check reports the **installed and latest versions explicitly** (e.g.
      `installed 3.2.1; latest 3.2.3` — per Codex, an explicit pair is crisply testable where a
      computed "N versions behind" distance is not) and flags "behind" when installed < latest. It
      degrades gracefully (no error, no hang) when offline or the registry is unreachable, bounded by
      a short timeout (~2–3s per Gemini).
- [ ] doctor **never** modifies, deletes, or moves any local file as part of the drift check.
- [ ] The drift audit is a standalone, unit-tested library (findings + formatter), mirroring the
      pr-gate / framework-ref precedent.
- [ ] **Item 3 (known-default detection) is explicitly non-blocking** for this spec: it MAY ship, but
      items 1 (shadow drift) and the staleness check are the required deliverables. The spec is
      satisfied without item 3.
- [ ] All new tests pass; existing doctor tests continue to pass.

## Constraints

### Technical Constraints
- Must reuse the existing resolver primitives in `lib/skeleton.ts` (`getSkeletonDir`,
  `listSkeletonFiles`, `resolveCodevFile`, `hasLocalOverride`) rather than re-deriving skeleton
  paths, so the audit and the resolver agree on what the skeleton is.
- The skeleton→local path mapping is a direct prefix relationship: skeleton `protocols/spir/...`
  ↔ local `codev/protocols/spir/...` (and `.codev/protocols/spir/...`).
- Must follow the mirror rule (arch-critical): any change touching a framework file must be applied
  to **both** `codev/` and `codev-skeleton/`. This feature is primarily product code
  (`packages/codev/src`), so the mirror rule applies only if any skeleton doc/text changes.
- Offline tolerance: the staleness check must have a bounded timeout (model on doctor's existing
  `runCommand`/`spawnSync` 5s pattern) and must never make doctor hang or fail when the network is
  unavailable.
- Report-only: no filesystem mutation of user files.

### Business Constraints
- None beyond the above. This is internal tooling / adopter-facing diagnostics.

## Assumptions
- The installed skeleton is the correct "current default" to diff against — i.e. detecting shadow
  drift against `getSkeletonDir()` is meaningful. (Staleness check item 3 handles the case where the
  installed skeleton is itself behind.)
- npm `latest` for `@cluesmith/codev` is the right staleness baseline (the package the user installs).
- The set of framework subtrees to scan (protocols, consult-types, roles, prompts within them) is
  stable enough to enumerate; new framework subtrees would need to be added to the scan set (same
  maintenance shape as `PR_PRODUCING_PROTOCOLS` in pr-gate-audit).

## Solution Approaches

### Approach 1 (recommended): Skeleton-driven diff via a new `protocol-drift-audit` lib
**Description**: A new pure lib (e.g. `lib/protocol-drift-audit.ts`) enumerates skeleton files under
the in-scope subtrees via `listSkeletonFiles()`, and for each, checks whether a local copy exists in
`.codev/` or `codev/`. If a local copy exists, it byte-compares (hash or direct content) against the
skeleton file and classifies it `identical` | `differs`. A separate function performs the
staleness check (installed version from `version.ts` vs `npm view @cluesmith/codev version`,
bounded + offline-tolerant). doctor consumes findings + formatters, exactly like pr-gate-audit.

**Pros**:
- Directly mirrors three existing, reviewed precedents — low architectural risk, familiar to reviewers.
- Pure lib is trivially unit-testable with fixture dirs (as pr-gate-audit / framework-ref-audit are).
- Uses the resolver's own notion of the skeleton, so it can't disagree with resolution.

**Cons**:
- Enumerating "skeleton files that could be shadowed" requires a defined scan set (maintenance point).

**Estimated Complexity**: Low–Medium
**Risk Level**: Low

### Approach 2: Local-driven scan (walk `codev/` overrides, look up each in skeleton)
**Description**: Instead of enumerating the skeleton, walk the project's local `codev/` (and
`.codev/`) framework subtrees and, for each local file, ask the resolver/skeleton whether a skeleton
counterpart exists; diff if so.

**Pros**: Naturally a no-op when the project has no overrides (nothing to walk); closely matches the
"scan the user's overrides" scope of framework-ref-audit.
**Cons**: Symmetric to Approach 1 in effort; both need the same diff + classification. Slightly more
prone to scanning non-framework files that happen to live under `codev/`.

**Estimated Complexity**: Low–Medium
**Risk Level**: Low

*Approaches 1 and 2 are near-equivalent; the plan may combine them (drive by skeleton for
completeness, gate output on "project has overrides" for the no-op property). Left to the Plan phase.*

### Approach 3 (for item 3 / stretch): Ship historical-default hashes
**Description**: Bundle a manifest of SHA hashes of *historical* skeleton versions of each framework
file. A differing local copy whose hash matches a known old default is provably rot → stronger
"safe to delete" recommendation; a local copy matching no known default is (probably) a real
customization.

**Pros**: Turns the ambiguous "customized or stale?" into a definitive verdict for the common rot case.
**Cons**: Requires generating and maintaining a historical-hash manifest (a build/release step);
higher effort and a new maintenance surface. The issue explicitly marks this "(stretch)".

**Recommendation**: Specify the mechanism but **defer to a follow-up** unless it fits cheaply within
this PR. Items 1 (shadow drift) and 3 (staleness) deliver the core value; item 2 (known-default) is
an enhancement layered on the same findings.

## Open Questions

### Critical (Blocks Progress)
- None. The issue's four numbered items define the requirement.

### Important (Affects Design)
- **Exact scan set**: which subtrees/files count as "framework files" for shadow drift? Proposed:
  `protocols/`, `consult-types/`, `roles/`, and prompt/template `.md` files within `protocols/`.
  Explicitly exclude `resources/` (user-evolved). Final enumeration → Plan phase.
- **Staleness data source**: `npm view @cluesmith/codev version` vs a registry HTTP GET. Proposed:
  reuse the CLI/spawn approach doctor already uses for external tools, with a short timeout. → Plan.
- **Should the report also wire into `codev update`?** Issue says "optionally". Proposed: SHOULD,
  implement if low-cost; not a release blocker.

### Nice-to-Know (Optimization)
- Whether to offer a `--fix`-style *suggested* command output (copy-pasteable `rm` for byte-identical
  redundant copies) without ever executing it. Report-only stays the invariant; this is presentation.

## Test Scenarios

### Functional Tests
1. **Identical shadow** → project has `codev/protocols/bugfix/consult-types/x.md` byte-identical to
   skeleton → doctor prints "redundant copy, safe to remove" info line; no adjudication warning.
2. **Differing shadow** → same file, one byte changed → doctor prints "customized or stale? —
   adjudicate" warning naming the file + skeleton version; warning count increments.
3. **No overrides** → project ships no local framework files → doctor prints no drift warnings and
   does not crash (true no-op).
4. **`.codev/` (tier-1) shadow** → a differing copy under `.codev/protocols/...` is detected the same
   as a `codev/` copy.
5. **Resources excluded** → a modified `codev/resources/arch.md` is **not** flagged as drift.
6. **Staleness behind** → installed version < npm latest → "N versions behind" reported.
7. **Staleness offline** → registry unreachable / timeout → check degrades gracefully (no hang, no
   error, doctor still completes and returns its normal exit code).

### Non-Functional Tests
1. Staleness check completes within a bounded timeout even with no network.
2. Drift audit does not mutate any file on disk (verify fixtures unchanged after the run).

## Dependencies
- **Internal**: `lib/skeleton.ts` (resolver primitives), `version.ts` (installed version),
  doctor's warning roll-up. Precedent libs: `lib/pr-gate-audit.ts`, `lib/framework-ref-audit.ts`.
- **External**: npm registry (best-effort, for staleness only); `npm`/`git` already assumed present
  by doctor.
- **Libraries/Frameworks**: Node stdlib (`node:fs`, `node:crypto` for hashing, `node:child_process`).

## Security Considerations
- Read-only over local files and the installed skeleton; no file writes to user content → minimal
  surface.
- The staleness check spawns a network-bound command (`npm view`); must use a bounded timeout and
  must not interpolate untrusted input into a shell (fixed package name; use argv form, not shell
  string) — consistent with doctor's existing `spawnSync(cmd, args)` usage.

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Scan set omits a framework subtree → drift missed | Med | Med | Enumerate explicitly; add a test that every skeleton framework subtree is covered; document the maintenance point (like `PR_PRODUCING_PROTOCOLS`). |
| False positive: a legitimately customized file flagged as "stale" | High | Low | Frame as "customized or stale? — adjudicate", never auto-act; item-3 known-default detection (if built) resolves the ambiguity for the rot case. |
| Staleness check hangs doctor offline | Low | High | Bounded timeout + offline-tolerant, mirroring existing `agy`/`codex` probes. |
| Line-ending / trailing-newline noise causes spurious "differs" | Med | Low | Define byte-comparison semantics in the Plan (raw bytes vs normalized); test with a known-identical fixture to catch normalization bugs. |
| Accidental scope creep into resources/ | Low | Med | Explicit exclusion + test scenario 5. |

## Notes
- This is a diagnostic addition, not a behavior change: the resolver is untouched and no user file is
  modified. The value is purely in **making a silent failure class visible**, which is precisely
  doctor's contract ("diagnose silent misconfiguration").
- The lesson this encodes (per lessons-critical): *single source of truth beats distributed state* —
  a byte-identical local copy is distributed state with no upside, and drift is what happens when it
  rots. doctor can't consolidate for the user, but it can name the divergence.

---

## Amendments

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
