# Review: afx whoami + ship /arch-init command in codev (multi-architect identity)

## Summary

Implemented issue #1134 in three phases, all unanimously CMAP-approved:

1. **`afx whoami`** (`packages/codev/src/agent-farm/commands/whoami.ts` +
   `cli.ts` registration): reports the current terminal's agent identity
   (workspace, type, name) with the spec's fixed precedence — builder-worktree
   cwd match (via the existing `detectCurrentBuilderId()`) →
   `CODEV_ARCHITECT_NAME` env → fail loud with exit 1. No implicit `main`
   (#1094). Strictly read-only against global.db:
   `lookupBuilderSpawningArchitect()` gained an optional `db?` parameter so
   whoami passes its own readonly connection. `--json` support, spawning
   architect enrichment for builders, `known_workspaces` display name with
   basename fallback, best-effort architect-row cross-check (stderr warning
   only). 20 new unit tests + 1 new lookup test.
2. **`/arch-init` skill** shipped byte-identically in
   `codev-skeleton/.claude/skills/arch-init/` and `.claude/skills/arch-init/`:
   workspace-agnostic generalization of the personal `/architect` command —
   identity via validated explicit `[name]` arg or `afx whoami`, STOP-and-ask
   when neither resolves, state recovery from `codev/state/<name>.md`
   (excluding builder `*_thread.md` files), the four architect guardrails.
   Skill-text assertion tests + the first `copySkills()` regression tests.
3. **Docs sync**: `afx whoami` documented in
   `codev/resources/commands/agent-farm.md`, its skeleton mirror, and both
   afx `SKILL.md` copies (section content verified identical cross-tree),
   plus the allowed drive-by fixing three stale "state.db" wordings in
   `send.ts` to "global.db".

## Spec Compliance

All nine MUST criteria met:

- [x] 1. Architect terminal → workspace/type/name from `CODEV_ARCHITECT_NAME`
  (verified by unit tests + live smoke).
- [x] 2. Builder worktree → canonical id + `architect:` when recorded (live
  smoke from this worktree printed `builder-spir-1134` / `architect: main`).
- [x] 3. Unrecognized context → exit 1, helpful message, never `main` (live
  smoke from `/tmp`).
- [x] 4. Unverifiable builder worktree → exit 1 with the
  `BuilderIdResolutionError` message; env not consulted (unit tests).
- [x] 5. `--json` schema on success; `{ "error": ... }` + exit 1 on failure.
- [x] 6. Skill text: validated `[name]` override → `afx whoami` → ask the
  human; no `ps`/`$PPID` (asserted by tests).
- [x] 7. Skill text: reads `codev/state/<name>.md` per the minimum contract;
  missing-file flow excludes `*_thread.md` (asserted by tests).
- [x] 8. Ships in `codev-skeleton/.claude/skills/arch-init/`, mirrored
  identically in `.claude/skills/arch-init/`; `copySkills()` install path
  regression-tested against the real skeleton.
- [x] 9. No Tower required (whoami reads global.db read-only + env).

Non-functional: read-only db access (enforced by design — `getDb()` never
invoked by whoami), shared builder-identity logic with `afx send` (one
implementation), no Shannon-specific wording in the skill (asserted).

All 12 spec test scenarios are covered: 1–8, 10, 11 by
`spec-1134-whoami.test.ts` (automated), 9 by the `copySkills()` tests in
`scaffold.test.ts`, 12 by `spec-1134-arch-init-skill.test.ts`.

## Deviations from Plan

- **None of substance.** The plan was followed phase-by-phase. One wording
  count correction: the plan said "two 'state.db' strings" in send.ts; three
  were in scope once found in-file (the `describeStateDbOpenFailure` doc
  comment, its message string, and the `BuilderIdResolutionError` doc
  comment). Historical "state.db is retired" migration comments were left
  untouched as planned.

## Lessons Learned

### What Went Well

- **Reusing existing primitives paid off exactly as designed**: whoami is a
  thin composition of `detectCurrentBuilderId`, `detectWorkspaceRoot`,
  `lookupBuilderSpawningArchitect`, and one readonly connection — no new
  resolution logic, so the #1094 fail-loud semantics came for free and the
  test fixtures (`bugfix-774` pattern: mock `getGlobalDbPath`, seed
  `GLOBAL_SCHEMA`, `process.chdir`) transplanted directly.
- **CMAP caught a real spec violation at plan time**: the draft plan accepted
  read-write `getDb()` for the spawning-architect lookup, contradicting the
  spec's read-only requirement. Fixing it at plan time (optional `db?` param)
  cost one paragraph; at PR time it would have been a code churn iteration.
- **Skill-text assertions made a "soft" artifact hard-testable**: byte
  equality across trees + required/forbidden content checks turned the skill
  into a regression-protected artifact.

### Challenges Encountered

- **Concurrent global reinstall broke the codex consult lane mid-phase-1**:
  the machine-global `@cluesmith/codev` install was being rebuilt while my
  CMAP ran (vendored codex binary ENOENT, then SIGKILL, then a 122-byte
  symlink mid-download). Resolved by polling for binary stability before
  retrying — the retry approved cleanly. Environmental, not code.
- **Fresh worktree needed `pnpm install` + full `pnpm build` before tests**:
  vitest imports `@cluesmith/codev-core` subpath exports from `dist/`, so
  unbuilt workspace deps fail module resolution even for mocked packages
  (consistent with the existing [From 936] lesson).

### What Would Be Done Differently

- Verify the toolchain (deps installed, workspace built) immediately after
  spawn instead of at first test run — it cost one wasted test invocation.

### Methodology Improvements

- None proposed for SPIR itself; porch's strict-mode loop (including the
  rebuttal mechanism) worked smoothly across 5 CMAP rounds.

## Technical Debt

- `whoami` imports identity helpers from `commands/send.ts` (a
  command→command dependency). Deliberate: they're already exported and
  tested there; extraction to a shared module is deferred until a third
  consumer appears (noted in whoami.ts's header comment).
- The `codev whoami` top-level alias was declined as out of scope (agents use
  `afx`); can be a follow-up if humans ask.

## Consultation Feedback

### Specify Phase (Round 1) — Gemini APPROVE, Codex REQUEST_CHANGES, Claude APPROVE

#### Gemini
- **Suggestion**: warn on stderr when the env-resolved architect has no
  `architect` table row. — **Addressed**: adopted as a non-gating SHOULD.
- **Suggestion**: `--json` failures should emit JSON on stdout AND a human
  message on stderr. — **Addressed**: adopted.
- **Suggestion**: add a `codev whoami` alias. — **Rebutted**: out of scope;
  the issue asks for `afx whoami` and agents are the primary consumers.

#### Codex
- **Concern**: architect state-file contract underdefined (`codev/state/`
  holds builder threads today). — **Addressed**: added a minimum contract +
  `*_thread.md` disambiguation; narrowed acceptance to shipped-text
  assertions.
- **Concern**: explicit `[name]` unvalidated → path traversal. —
  **Addressed**: `validateArchitectName` rule required before any path use.
- **Concern**: "workspace root is cwd" wrong for subdirectories. —
  **Addressed**: spec now names `detectWorkspaceRoot()`.
- **Concern**: `/arch-init` testing underspecified. — **Addressed**: new test
  scenarios 10–12 (skill text, scaffold, subdirectory cwd).

#### Claude
- **Concern (minor)**: same workspace-root gap as Codex. — **Addressed** (see
  above).
- **Note**: stale "state.db" wording in `describeStateDbOpenFailure`. —
  **Addressed**: allowed as a Phase 3 drive-by, executed there.

### Plan Phase (Round 1) — Gemini APPROVE, Codex REQUEST_CHANGES, Claude APPROVE

#### Gemini
- **Suggestion**: update any tests pinning old "state.db" text in the same
  commit. — **Addressed**: covered in Phase 3 risk; grep found no pinning
  tests.

#### Codex
- **Concern**: read-write `getDb()` path violated the spec's read-only
  requirement. — **Addressed**: optional `db?` param on
  `lookupBuilderSpawningArchitect`; whoami uses one readonly connection.
- **Concern**: scenario 9 coverage overstated (no `copySkills()` tests
  exist). — **Addressed**: first `copySkills()` regression tests added as a
  Phase 2 deliverable.
- **Concern**: `resolveIdentity` purity vs `process.cwd()`-reading helpers
  under-specified. — **Addressed**: pinned to `resolveIdentity(env)` +
  `process.chdir()` test pattern; helpers not parameterized.

#### Claude
- **Note**: same purity observation; drive-by scope (2 of 5 "state.db"
  occurrences are stale wording). — **Addressed**: scope honored (3 stale
  wordings found in-file; historical comments kept).

### Implement Phase — phase_1 (Round 1)

- **Gemini**: APPROVE (HIGH) — no concerns.
- **Codex**: APPROVE (HIGH) — no concerns. (First two attempts failed on the
  environment: the global codev install was mid-reinstall and the vendored
  codex binary was ENOENT/churning. Retried after the install settled.)
- **Claude**: APPROVE (HIGH) — no concerns.

### Implement Phase — phase_2 (Round 1)

- **Gemini**: APPROVE (HIGH); **Codex**: APPROVE (MEDIUM); **Claude**:
  APPROVE (HIGH) — no concerns raised.

### Implement Phase — phase_3 (Round 1)

- **Gemini**: APPROVE (HIGH); **Codex**: APPROVE (HIGH); **Claude**: APPROVE
  (HIGH) — no concerns raised.

## Architecture Updates

Routed to the **COLD** tier (`codev/resources/arch.md`): new Core Components
subsection "8. Identity Resolution (`afx whoami`) (Spec 1134)" documenting the
identity precedence, the read-only invariant (optional `db?` handle on
`lookupBuilderSpawningArchitect`), output contract, and the `/arch-init`
skill relationship. This is subsystem reference detail, not a cross-cutting
invariant a builder must know before any task, so the **HOT** tier
(`arch-critical.md`) is unchanged — the hot file is at its cap and nothing
here displaces an existing entry.

## Lessons Learned Updates

Routed to the **COLD** tier (`codev/resources/lessons-learned.md`, Testing
section): `[From 1134]` — declarative agent artifacts (skills, prompts) are
testable by pinning the shipped text (cross-tree byte equality, required
content, forbidden content) and spec acceptance criteria for skills should be
phrased as text assertions. Spec-narrow testing recipe → cold by the routing
rule; **HOT** tier (`lessons-critical.md`) unchanged.

## Flaky Tests

No flaky tests encountered.

## Follow-up Items

- Optional `codev whoami` alias if humans (vs agents) want it on the codev
  CLI surface.
- The user's personal `~/.claude/commands/architect.md` can now be retired in
  favor of the shipped `/arch-init` (their call; out of scope here).
- Consider extracting the send.ts identity helpers to a shared module if a
  third consumer appears.
