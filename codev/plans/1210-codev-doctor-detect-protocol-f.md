# Plan: `codev doctor` — detect protocol-file drift

## Metadata
- **ID**: plan-2026-07-22-codev-doctor-detect-protocol-f
- **Status**: draft
- **Specification**: [codev/specs/1210-codev-doctor-detect-protocol-f.md](../specs/1210-codev-doctor-detect-protocol-f.md)
- **Created**: 2026-07-22
- **Issue**: #1210

## Executive Summary

Implements the spec's **Approach 1** (skeleton-driven diff via a new pure audit lib), combined with
Approach 2's quiet-by-default gating (the Framework Drift section prints nothing unless there is
something actionable — a local shadow exists **or** the skeleton is behind; see the "no local
overrides" decision below). The work
splits into three independently-testable phases:

1. A pure **`protocol-drift-audit` library** that detects shadow drift (local `.codev/` / `codev/`
   copies that also exist in the installed skeleton) and classifies each as `identical` (redundant)
   or `differs` (adjudicate) — plus a **staleness** helper (installed vs npm-latest version).
2. **Wiring** the drift report into `codev doctor` as a new section, rolled into the existing warning
   summary; report-only, no file mutation.
3. **Tests** (unit for the lib, e2e/CLI for the doctor integration) covering the spec's seven
   functional scenarios and the two non-functional ones.

The design deliberately mirrors the three existing precedents — `lib/pr-gate-audit.ts` (#943),
`lib/framework-ref-audit.ts` (#1011), `lib/gitignore.ts` — each a pure lib (findings + formatter)
consumed by `doctor.ts`. It reuses the resolver primitives in `lib/skeleton.ts` so the audit's notion
of "the skeleton" is identical to runtime resolution.

**Item 2 of the issue (known-default / historical-hash detection)** is explicitly marked non-blocking
by the spec and is **deferred to a follow-up** (see Notes) — it layers on the same findings and needs
a release-time hash-manifest step that would inflate this PR.

## Success Metrics
- [ ] All specification success criteria met (shadow-drift identical/differs/no-op, dual override
      roots, resources excluded, staleness behind/offline, no file mutation).
- [ ] New `lib/protocol-drift-audit.ts` is a standalone unit-tested module (findings + formatters).
- [ ] `codev doctor` surfaces a Framework Drift section; drift findings increment the warning count.
- [ ] Existing doctor unit + e2e tests continue to pass; new tests added.
- [ ] Zero file mutation of user content by the drift check (asserted by test).
- [ ] No hang when offline (staleness bounded by a ~2–3s timeout).

## Key Design Decisions (resolving spec open questions + consult feedback)

- **Byte-comparison semantics (Gemini pt 1 / spec risk)**: compare **raw bytes** (SHA-256 of file
  contents). A local copy is called `identical`/redundant **only** when byte-for-byte equal to the
  skeleton file. Anything differing — including EOL-only (CRLF vs LF) or trailing-newline differences
  — is classified `differs` → adjudicate. Rationale: the `identical` verdict carries a "safe to
  remove" suggestion; being conservative (never suggest removing a file that isn't a perfect
  duplicate) is the safe failure direction. This is documented in the lib so the choice is explicit.
- **Dual override roots (Codex pt 1 & 5)**: scan **both** `.codev/<path>` and `codev/<path>` for each
  skeleton file; emit a finding per local copy found, tagged with its tier. Also compute which copy
  the resolver actually resolves (the "winner") via `resolveCodevFile`, and mark it, so the human sees
  which is live. No-op/presence detection checks **both** roots (not just `hasLocalOverride`'s tier-2).
- **Scan set (Codex pt 2)**: pinned in the spec — skeleton `protocols/`, `consult-types/`, `roles/`
  trees, all `.md`/`.json` files. Enumerated via `listSkeletonFiles(subdir)`. `resources/` is
  **excluded** (user-evolved files).
- **Staleness output (Codex pt 3 / Gemini pt 2)**: report explicit `installed X; latest Y` and a
  boolean "behind", not a computed distance. `npm view @cluesmith/codev version` via `spawnSync` in
  **argv form** (no shell string) with a ~2500ms timeout; any failure/timeout/offline → `latest: null`
  and a neutral "could not check (offline?)" line, never a doctor failure or hang.
- **Item 2 non-blocking (Codex pt 4)**: deferred; see Notes.
- **"No local overrides" behavior — single, unambiguous rule (Codex plan review, REQUEST_CHANGES)**:
  the Framework Drift section is **quiet by default**. doctor computes shadows + staleness, then:
  - **No shadows AND not-behind** (up-to-date, or offline/uncheckable) → **print nothing** (no header,
    no lines). This is the spec's "true no-op".
  - **Otherwise** → print the section: shadow lines (differs=warn, identical=info) and, only if
    `behind`, a staleness warning. Staleness is **never** printed unconditionally-per-run: it is
    silent when up-to-date or uncheckable, and a warning only when genuinely behind (the issue's
    sibling failure mode). This removes the earlier draft's self-contradiction (Exec Summary "no-op"
    vs Phase 2 "staleness always shown").

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "protocol-drift-audit library (shadow drift + staleness)"},
    {"id": "phase_2", "title": "Wire drift report into codev doctor"},
    {"id": "phase_3", "title": "Tests: unit (lib) + e2e (doctor integration)"}
  ]
}
```

## Phase Breakdown

### Phase 1: `protocol-drift-audit` library (shadow drift + staleness)
**Dependencies**: None

#### Objectives
- Provide a pure, side-effect-free module that computes framework-file drift and skeleton staleness,
  returning structured findings plus display formatters — the single source of truth both `doctor`
  (and, optionally later, `update`) consume.

#### Deliverables
- [ ] New file `packages/codev/src/lib/protocol-drift-audit.ts` exporting:
  - `FRAMEWORK_DRIFT_DIRS = ['protocols', 'consult-types', 'roles']` (the pinned scan set — documented
    maintenance point).
  - `auditProtocolDrift(workspaceRoot: string): DriftFinding[]` — for each skeleton file under the
    scan set (`listSkeletonFiles(subdir)`), check `.codev/<path>` and `codev/<path>`; for each local
    copy present, hash-compare raw bytes against the skeleton file → `status: 'identical' | 'differs'`;
    record `{ relativePath, tier: '.codev' | 'codev', status, isResolvedWinner }`.
  - `hasFrameworkShadows(workspaceRoot: string): boolean` — true if any local copy of any scanned
    skeleton file exists in **either** root (no-op gate for doctor; checks both tiers).
  - `checkSkeletonStaleness(): StalenessResult` — `{ installed: string, latest: string | null,
    behind: boolean, note?: string }`; `installed` from `version.ts`, `latest` from
    `npm view @cluesmith/codev version` (argv form, ~2500ms timeout, offline-tolerant → `latest:null`).
  - Formatters: `formatDriftFinding(f): string`, `formatStaleness(s): string`.
- [ ] Reuse `getSkeletonDir`, `listSkeletonFiles`, `resolveCodevFile` from `lib/skeleton.ts`; use
  `node:crypto` for hashing and read the installed `version` from `../version.js`.

#### Implementation Details
- Path mapping: skeleton relative path (e.g. `protocols/spir/protocol.md`) maps to local
  `<root>/.codev/<rel>` and `<root>/codev/<rel>`. Only `.md` and `.json` files are compared
  (skeleton dirs contain only these for the scan set; guard defensively).
- `isResolvedWinner`: computed by calling `resolveCodevFile(rel, root)` and checking whether the
  resolved absolute path equals this finding's local path — marks the copy the runtime actually loads.
- Staleness: never throw. `spawnSync('npm', ['view', '@cluesmith/codev', 'version'], {timeout, encoding})`;
  on non-zero/empty/exception → `latest: null, note: 'could not check (offline?)'`. `behind` computed
  with a small semver compare (reuse the `versionGte` shape already in doctor.ts, or a local helper).

#### Acceptance Criteria
- [ ] `auditProtocolDrift` returns `identical` for a byte-identical local copy, `differs` for a
      one-byte-changed copy, and nothing for a skeleton file with no local copy.
- [ ] Findings include tier and `isResolvedWinner`; both `.codev/` and `codev/` copies are reported.
- [ ] `checkSkeletonStaleness` returns explicit installed/latest and never hangs > timeout offline.
- [ ] Module performs **no writes** to disk.

#### Test Plan
- Covered in Phase 3 (kept separate so the lib and its wiring commit independently). Lib is written
  test-first-friendly (pure functions, injectable `workspaceRoot`).

#### Rollback Strategy
- Delete `lib/protocol-drift-audit.ts`; no other module imports it until Phase 2.

#### Risks
- **Risk**: scan set drifts from actual skeleton framework dirs. **Mitigation**: Phase 3 test asserts
  each `FRAMEWORK_DRIFT_DIRS` entry exists in the skeleton; document the maintenance point in-file.

---

### Phase 2: Wire drift report into `codev doctor`
**Dependencies**: Phase 1

#### Objectives
- Surface the drift + staleness findings in `codev doctor`'s output as a new section, integrated with
  the existing warning roll-up — report-only.

#### Deliverables
- [ ] Edit `packages/codev/src/commands/doctor.ts`:
  - Inside the `if (workspaceRoot && existsSync(codev))` block (alongside the framework-ref and
    pr-gate sections), add a **quiet-by-default "Framework Drift"** section. Compute
    `shadows = auditProtocolDrift(root)` and `staleness = checkSkeletonStaleness()`, then:
    - **Guard**: if `shadows.length === 0` **and** `staleness.behind !== true` → **print nothing at
      all** (no header). This is the spec's true no-op (covers no-overrides + up-to-date, and
      no-overrides + offline). Uses `hasFrameworkShadows`/`shadows` for the shadow half and
      `staleness.behind` for the staleness half — the section header is only emitted when at least one
      half has something to say.
    - When the section IS shown:
      - Staleness: if `behind` → `⚠` warning line `installed X; latest Y — behind` (→ `warningDetails`,
        recommend `codev update`). If up-to-date → dim info line `installed X; latest Y (up to date)`.
        If uncheckable → dim `latest: could not check (offline?)`. **Only `behind` is a warning; the
        up-to-date / uncheckable lines are informational and shown only because shadows already forced
        the section open.**
      - `differs` shadows → `⚠` warning lines ("customized or stale? — adjudicate", named file + tier
        + resolved-winner marker), each incrementing `warnings` and pushed to `warningDetails`.
      - `identical` shadows → informational `○`/dim lines ("redundant copy — safe to remove; falls
        back to package"); **not** counted as warnings (per spec).
- [ ] Import the new lib; no change to doctor's exit-code contract beyond the added warnings.

#### Implementation Details
- Mirror the existing section pattern (header via `chalk.bold`, per-finding lines, `warningDetails.push`).
- Recommendation text for `differs`: "review vs installed skeleton; if unintentional, remove local
  copy so resolution falls through to the package (`codev update` migrates unmodified copies)".
- Keep the section ordering sensible: place after the "Framework refs" / "Protocol PR Gates" blocks.

#### Acceptance Criteria
- [ ] Running doctor in a project with a differing shadow prints the adjudicate warning and increments
      the warning count; identical shadow prints an info line and does not.
- [ ] **No shadows AND not-behind (up-to-date or offline) → the Framework Drift section is not printed
      at all** (true no-op); doctor exit code unchanged.
- [ ] **No shadows BUT skeleton behind → the staleness warning is printed** (section shown for
      staleness alone); this is intentionally not a no-op.
- [ ] `codev/resources/arch.md` modifications are never reported (not in scan set).

#### Test Plan
- Phase 3 e2e test drives the built CLI against fixture projects.

#### Rollback Strategy
- Revert the doctor.ts hunk; Phase 1 lib becomes dead code but harmless.

#### Risks
- **Risk**: added output noise for projects with many legitimate customizations. **Mitigation**:
  identical copies are info-only (not warnings); differs are the actionable set the issue targets.

---

### Phase 3: Tests — unit (lib) + e2e (doctor integration)
**Dependencies**: Phase 1, Phase 2

#### Objectives
- Lock in all spec scenarios with automated tests at both the lib and CLI levels.

#### Deliverables
- [ ] `packages/codev/src/__tests__/protocol-drift-audit.test.ts` (unit):
  - identical shadow → `identical`; differing shadow → `differs`; no local copy → no finding.
  - `.codev/` (tier-1) differing copy detected same as `codev/`; both-present → both reported with
    correct `isResolvedWinner` (`.codev/` wins).
  - `resources/` modification not scanned.
  - `hasFrameworkShadows` false when no overrides (no-op property).
  - `checkSkeletonStaleness`: behind when installed < latest (inject/stub latest); offline/timeout →
    `latest: null`, no throw, bounded.
  - EOL-only difference → `differs` (documents the conservative raw-byte decision).
  - No-mutation: fixture dir contents unchanged after audit runs.
  - Scan-set integrity: every `FRAMEWORK_DRIFT_DIRS` entry exists under the skeleton.
- [ ] `packages/codev/src/__tests__/cli/doctor-drift.e2e.test.ts` (or extend `doctor.e2e.test.ts`):
  - fixture project with a differing `codev/protocols/.../*.md` shadow → doctor output contains the
    adjudicate warning; with an identical shadow → info line, no warning.
  - **no overrides + skeleton up-to-date (stub `fetchLatest` = installed) → no "Framework Drift"
    section header in output** (true no-op).
  - **no overrides + skeleton behind (stub `fetchLatest` > installed) → staleness warning present**
    even though there are no shadows (section shown for staleness alone).

#### Implementation Details
- Follow the existing test harness conventions in `packages/codev/src/__tests__/` (fixture temp dirs,
  `getSkeletonDir()` as the source of skeleton fixtures — copy a real skeleton file to build the
  identical case, then mutate one byte for the differs case).
- For staleness, avoid real network: factor the `npm view` call behind an injectable seam (e.g. an
  optional `fetchLatest` param defaulting to the real spawn) so the unit test stubs it deterministically.

#### Acceptance Criteria
- [ ] All seven functional + two non-functional spec scenarios have a corresponding assertion.
- [ ] `pnpm --filter @cluesmith/codev test` passes (new + existing).

#### Test Plan
- **Unit**: the lib test above. **Integration/e2e**: the doctor CLI test above. **Manual**: run
  `codev doctor` in this repo (which has real `codev/protocols/*` overrides) and eyeball the section.

#### Rollback Strategy
- Tests are additive; revert the test files if needed.

#### Risks
- **Risk**: e2e flakiness from real network in staleness. **Mitigation**: staleness offline-tolerant
  by design; e2e asserts on drift lines, not on a specific latest version; unit test stubs the fetch.

## Dependency Map
```
Phase 1 (lib) ──→ Phase 2 (doctor wiring) ──→ Phase 3 (tests)
```

## Integration Points
### Internal Systems
- **`lib/skeleton.ts`** — resolver primitives (`getSkeletonDir`, `listSkeletonFiles`, `resolveCodevFile`).
  Read-only consumption.
- **`version.ts`** — installed package version for staleness.
- **`commands/doctor.ts`** — host of the new section; existing warning roll-up.
- **`commands/update.ts`** — *optional* future consumer (SHOULD, not in these phases).

### External Systems
- **npm registry** — `npm view` for latest version; best-effort, offline-tolerant, bounded timeout.

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| Scan set omits a framework subtree | Med | Med | Explicit `FRAMEWORK_DRIFT_DIRS` + integrity test | builder |
| EOL noise → spurious `differs` | Med | Low | Documented raw-byte decision; `differs` never auto-acts | builder |
| Staleness hangs doctor offline | Low | High | Bounded ~2.5s timeout + null-tolerant | builder |
| Output noise for heavily-customized projects | Med | Low | identical = info-only; differs = actionable | builder |

## Validation Checkpoints
1. **After Phase 1**: lib compiles; can be exercised in a scratch script against this repo's `codev/`.
2. **After Phase 2**: `codev doctor` in this repo prints a Framework Drift section.
3. **Before PR**: full test suite green; manual `codev doctor` eyeball; no file mutations.

## Documentation Updates Required
- [ ] None required to framework docs for core behavior (product code only). If any skeleton/doc text
      is touched, mirror in **both** `codev/` and `codev-skeleton/` (arch-critical mirror rule).
- [ ] Review file (Phase R) documents the feature and the deferred item-2 follow-up.

## Notes
- **Deferred (item 2 / known-default detection)**: ship a manifest of historical skeleton-file hashes
  so a `differs` copy that matches a known *old* default is provably rot → stronger "safe to delete"
  verdict. Deferred because it needs a release-time hash-generation step (new maintenance surface) and
  the spec marks it non-blocking. It layers cleanly onto `DriftFinding` (add an optional
  `matchesHistoricalDefault` field) in a follow-up.
- **`codev update` wiring** is intentionally left out of these phases (spec: SHOULD/optional). The lib
  is structured so update can consume `auditProtocolDrift` later with no refactor.
- Encodes the lessons-critical principle *single source of truth beats distributed state*: a
  byte-identical local copy is pure distributed-state risk; doctor names the divergence rather than
  silently serving rot.

---

## Amendment History

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
