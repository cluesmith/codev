# Plan: `afx whoami` + ship `/arch-init` command in codev (multi-architect identity)

## Metadata

- **ID**: 1134
- **Status**: draft
- **Specification**: codev/specs/1134-afx-whoami-ship-arch-init-comm.md
- **Created**: 2026-07-03

## Executive Summary

Implement the spec's chosen Approach A in three small, independently
committable phases:

1. **`afx whoami`** — a new `commands/whoami.ts` that composes the existing,
   already-exported identity primitives (`detectCurrentBuilderId`,
   `BuilderIdResolutionError`, `detectWorkspaceRoot` from `send.ts`;
   `lookupBuilderSpawningArchitect` from `state.ts`), plus a read-only
   `known_workspaces` name lookup. No new resolution logic.
2. **`/arch-init` skill** — one new `SKILL.md` authored once and placed
   identically in `codev-skeleton/.claude/skills/arch-init/` and
   `.claude/skills/arch-init/` (two-tree rule). `copySkills()` enumerates
   skill directories dynamically (`scaffold.ts:361`), so no scaffold code
   changes are needed for init/adopt/update to ship it.
3. **Docs sync** — `afx whoami` added to the CLI reference and the `afx`
   skill, in both trees.

Key implementation decision: `whoami` **imports** the identity helpers from
`commands/send.ts` rather than relocating them to a shared module. They are
already exported and covered by existing tests (`send.test.ts`,
`spec-755-lookup-builder.test.ts`); relocation would churn those imports for
zero behavior gain. (The spec allows either; revisit only if a third consumer
appears.)

## Success Metrics

- [ ] All spec MUST criteria (1–9) met
- [ ] All 12 spec test scenarios covered by automated tests where automatable
      (1–8, 10–12; scenario 9 covered by new `copySkills()` regression tests
      in `scaffold.test.ts` + skill-presence test)
- [ ] No reduction in existing test coverage; all existing tests pass
- [ ] Zero new lint errors
- [ ] Both trees updated (skeleton + instance) for every framework file touched

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "afx whoami command + tests"},
    {"id": "phase_2", "title": "arch-init skill in both trees + tests"},
    {"id": "phase_3", "title": "CLI reference and afx-skill docs sync"}
  ]
}
```

## Phase Breakdown

### Phase 1: `afx whoami` command + tests

**Dependencies**: None

#### Objectives

- Ship the `afx whoami` identity diagnostic with the spec's exact precedence,
  output, and fail-loud semantics.

#### Deliverables

- [ ] `packages/codev/src/agent-farm/commands/whoami.ts` (new)
- [ ] `whoami` registration in `packages/codev/src/agent-farm/cli.ts`
- [ ] `packages/codev/src/agent-farm/__tests__/spec-1134-whoami.test.ts` (new)

#### Implementation Details

**`commands/whoami.ts`** exports `whoami(options: { json?: boolean })` plus a
testable core `resolveIdentity(env)` returning a discriminated result.
`resolveIdentity` takes `env` as a parameter but reads cwd implicitly through
the reused send.ts helpers (`detectCurrentBuilderId` / `detectWorkspaceRoot`
call `process.cwd()` internally — they are NOT parameterized; that churn isn't
worth it for two consumers). Tests control cwd via `process.chdir()` into
tmpdir fixtures, the established pattern in `send.test.ts:108–122`
(consultation feedback, Codex):

```ts
type WhoamiIdentity =
  | { type: 'builder'; workspace: string; name: string; architect?: string }
  | { type: 'architect'; workspace: string; name: string; rowMissing?: boolean };
// failure path: throws WhoamiError (message for humans) — the command maps it
// to exit 1 + stderr (and `{ "error": ... }` on stdout under --json)
```

Resolution algorithm (spec precedence, verbatim):

**Read-only invariant** (spec non-functional requirement; consultation
feedback, Codex): `whoami` never opens global.db read-write. It opens ONE
`new Database(path, { readonly: true })` connection for all whoami-specific
queries (`spawned_by_architect`, `known_workspaces`, `architect` cross-check)
and closes it before exit. To reuse the shared SQL without the read-write
`getDb()` singleton, `lookupBuilderSpawningArchitect(builderId, workspacePath?)`
gains an optional third parameter `db?: Database.Database` — defaulting to
`getDb()` so all existing callers are byte-for-byte unaffected; whoami passes
its read-only connection. (`detectCurrentBuilderId` already opens its own
read-only connection internally.)

1. `detectCurrentBuilderId()` (import from `./send.js`):
   - returns id → type `builder`; `architect` field from
     `lookupBuilderSpawningArchitect(id, undefined, roDb)` (`state.ts:537`,
     read-only handle per the invariant above), omitted when
     `null`/`undefined`.
   - throws `BuilderIdResolutionError` → rethrow as the failure result
     (message passed through verbatim — it already carries the #1094
     rationale). **No fallthrough to the env check.**
   - returns `null` → step 2.
2. `env.CODEV_ARCHITECT_NAME?.trim()` non-empty → type `architect` with that
   name. **Not** via `currentArchitectName()` (its `main` default is exactly
   what whoami must not do). Best-effort cross-check: query the `architect`
   table for `(workspace_path, id)`; when no row, set `rowMissing` → the
   command prints a warning to **stderr** (never affects stdout/exit code).
   DB errors during this check are swallowed (it is diagnostics only).
3. Neither → failure: message names what was checked (not in a
   `.builders/<id>/` worktree; `CODEV_ARCHITECT_NAME` unset) and likely causes
   (plain shell, terminal not started by Tower, pre-#786 architect terminal).

Workspace field: `detectWorkspaceRoot()` (import from `./send.js`;
`send.ts:30` — handles both the `.builders/` prefix extraction and cwd-to-root
marker walking). If it returns `null` while identity resolved via env, use
cwd basename as the path's display fallback. Display name: open global.db
**read-only** (same pattern as `detectCurrentBuilderId`) and
`SELECT name FROM known_workspaces WHERE workspace_path = ?` (canonicalized);
missing db / no row / open error → directory basename (informational field —
graceful fallback is allowed here by the spec, unlike type/name).

Output (exact formats from the spec):

- Human: `workspace:` / `type:` / `name:` lines (+ `architect:` for builders
  when known) to stdout.
- `--json`: single JSON object, `architect` key omitted when unknown.
- Failure: exit 1; human message to stderr always; under `--json` also
  `{ "error": "<message>" }` to stdout.

**`cli.ts` registration** (after `status`, mirroring its shape):

```ts
program
  .command('whoami')
  .description("Report this terminal's agent identity (workspace, type, name)")
  .option('--json', 'Output machine-readable JSON')
  .action(async (options) => { /* dynamic import, try/catch, exit 1 on error */ });
```

Error handling in the action must distinguish "identity unknown" (already
formatted, exit 1) — print without a redundant `logger.error` prefix under
`--json`.

#### Acceptance Criteria

- [ ] Spec test scenarios 1–8, 10, 11 pass as automated tests
- [ ] Existing `send.test.ts` / `spec-755-lookup-builder.test.ts` unaffected
- [ ] `afx whoami` manual smoke: from this worktree prints
      `type: builder / name: builder-spir-1134`; from a plain shell in `/tmp`
      exits 1 with a helpful message

#### Test Plan

- **Unit tests** (`spec-1134-whoami.test.ts`, vitest): drive
  `resolveIdentity(env, cwd)` and the output formatter against a temp
  `global.db` fixture (pattern: `spec-755-lookup-builder.test.ts` /
  `send.test.ts` — point `AGENT_FARM_DIR`/db-path helper at a tmpdir):
  - architect via env (trimmed; whitespace-only = unset) → scenario 1, 7
  - builder row match incl. `spawned_by_architect` present/NULL → scenarios 2, 3
  - builder worktree, no row / unopenable db → `BuilderIdResolutionError`
    surfaces, env NOT consulted → scenario 4
  - no signals → failure → scenario 5
  - env + builder cwd → builder wins → scenario 6
  - `known_workspaces` name vs basename fallback → scenario 8
  - subdirectory cwd for architect → scenario 10
  - env architect with no `architect` row → `rowMissing` warning, exit 0 →
    scenario 11
  - `--json` success shape and `{ "error": ... }` failure shape
- **Manual**: the two smokes in acceptance criteria.

#### Rollback Strategy

Single additive command; revert the phase commit. No state, schema, or
behavior changes to existing commands.

#### Risks

- **Risk**: the optional `db?` parameter on `lookupBuilderSpawningArchitect`
  changes a long-lived API signature.
  - **Mitigation**: additive optional parameter with `getDb()` default —
    existing callers (grep before commit) and their tests are unaffected;
    `spec-755-lookup-builder.test.ts` gains a case passing an explicit
    read-only handle.
- **Risk**: importing from `commands/send.ts` creates a command→command
  dependency.
  - **Mitigation**: exports are already public and tested; noted in code
    comment; extraction deferred until a third consumer exists.

---

### Phase 2: `/arch-init` skill in both trees + tests

**Dependencies**: Phase 1 (the skill instructs running `afx whoami`)

#### Objectives

- Ship the workspace-agnostic `/arch-init` identity-adoption command to every
  codev project via the skeleton, mirrored in our instance.

#### Deliverables

- [ ] `codev-skeleton/.claude/skills/arch-init/SKILL.md` (new)
- [ ] `.claude/skills/arch-init/SKILL.md` (new, byte-identical)
- [ ] `packages/codev/src/agent-farm/__tests__/spec-1134-arch-init-skill.test.ts` (new)
- [ ] `copySkills()` regression tests added to
      `packages/codev/src/__tests__/scaffold.test.ts` (none exist today —
      consultation feedback, Codex): copying from the real skeleton into a
      tmp target installs `arch-init/SKILL.md`; `skipExisting: true`
      preserves an existing customized copy

#### Implementation Details

Frontmatter follows the existing skeleton-skill pattern (`name`,
`description`; description written for trigger accuracy: "adopt an architect
identity and recover its state… use when a terminal needs to know which
architect it is"). `argument-hint: "[name]"`.

Body (generalized from the personal `~/.claude/commands/architect.md`, per
spec):

1. **Resolve name**: explicit `$ARGUMENTS` wins — but first validate against
   `[a-z][a-z0-9-]*`, ≤64 chars (the `validateArchitectName` rule); reject
   slashes/`..`/uppercase/spaces with the rule spelled out (path-traversal
   guard). Else run `afx whoami`: `type: architect` → adopt `name`;
   `type: builder` → STOP, report mismatch (this command is for architect
   terminals); non-zero → STOP and ask the human. Never guess; never default
   to `main`. No `ps`/`$PPID` ancestry matching anywhere.
2. **Read state**: `codev/state/<name>.md` at the workspace root. Missing →
   list architect state files in `codev/state/` **excluding `*_thread.md`**
   (builder threads share the directory), tell the human, ask before creating
   anything. Never fabricate state.
3. **Confirm + orient**: report adopted name, file read, resume summary
   (opening role/banner line + most recent dated section, or leading content —
   the spec's minimum contract); then follow the state file's own resume
   instructions.
4. **Guardrails** (workspace-agnostic): never auto-approve porch gates; touch
   only your own builders/spawns/filings; never `cd` into a builder worktree
   (use `git -C` + absolute paths); stay on the default branch at the
   workspace root.

No Shannon-specific wording (no workspace names, rosters, or
workspace-specific architect examples).

No scaffold code changes: `copySkills()` (`packages/codev/src/lib/scaffold.ts:361`)
enumerates `codev-skeleton/.claude/skills/*` dynamically, so `codev init` /
`adopt` / `update` pick the new directory up automatically (spec scenario 9).

#### Acceptance Criteria

- [ ] Spec test scenario 12 passes: both copies byte-identical; text
      references `afx whoami` and the name-validation rule; no `ps -p` /
      `$PPID` / ancestry matching; no "Shannon"
- [ ] Skill loads in Claude Code (manual: `/arch-init` visible from this repo)
- [ ] Spec MUST criteria 6–8 satisfied by the shipped text

#### Test Plan

- **Unit tests** (`spec-1134-arch-init-skill.test.ts`): read both SKILL.md
  files from the repo; assert byte equality; assert required content
  (`afx whoami`, `[a-z][a-z0-9-]*`, `_thread.md` exclusion, the four
  guardrails) and forbidden content (`ps -p`, `$PPID`, `Shannon`). This is the
  spec's "skill-text assertions" approach — the shipped text is the testable
  artifact.
- **Scaffold tests** (`scaffold.test.ts`): `copySkills()` from the real
  skeleton dir into a tmpdir target installs `arch-init/SKILL.md` (proves the
  init/adopt/update install path — spec scenario 9); `skipExisting: true`
  leaves a pre-existing target copy untouched.
- **Manual**: run `/arch-init` with an explicit name in an architect terminal
  (happy path) and confirm it reads `codev/state/<name>.md`; run with a
  path-shaped arg (`../../foo`) and confirm rejection.

#### Rollback Strategy

Delete the two skill directories (additive files only).

#### Risks

- **Risk**: skill copies drift between trees over time.
  - **Mitigation**: the byte-equality unit test fails on any future drift.
- **Risk**: skill description triggers too eagerly/rarely in Claude Code.
  - **Mitigation**: description follows the existing afx/porch skill style;
    invocation is primarily explicit (`/arch-init`).

---

### Phase 3: CLI reference and afx-skill docs sync

**Dependencies**: Phase 1 (documents the shipped command)

#### Objectives

- Make `afx whoami` discoverable everywhere the afx surface is documented, in
  both trees.

#### Deliverables

- [ ] `codev/resources/commands/agent-farm.md` — add `afx whoami` section
      (syntax, output fields, `--json`, exit codes, precedence note)
- [ ] `codev-skeleton/resources/commands/agent-farm.md` — same addition
- [ ] `.claude/skills/afx/SKILL.md` — add `whoami` to the command reference
- [ ] `codev-skeleton/.claude/skills/afx/SKILL.md` — same addition
- [ ] Drive-by (allowed by spec Consultation Log): fix the two "state.db"
      strings in `describeStateDbOpenFailure()` / `BuilderIdResolutionError`
      doc comment in `send.ts` to say global.db (post-#1118 wording; whoami
      surfaces these messages)

#### Implementation Details

Documentation-only phase plus the one-line message-wording drive-by. The
agent-farm.md section mirrors the spec's output examples verbatim so docs and
behavior share one source of shape. Cross-tree grep before commit:
`grep -rn "whoami" codev/ codev-skeleton/ .claude/` to confirm both trees
carry the same content (lessons-critical: grep BOTH trees after any framework
change).

#### Acceptance Criteria

- [ ] `afx whoami` documented in all four files, examples matching actual
      output
- [ ] Instance and skeleton copies of each doc pair carry the same whoami
      content
- [ ] `send.ts` user-facing messages no longer say "state.db"; existing send
      tests still pass (update any message-text assertions)

#### Test Plan

- **Unit tests**: existing send tests re-run (message-text assertions updated
  if they pin the old wording). No new tests — docs phase.
- **Manual**: render check of the four markdown files.

#### Rollback Strategy

Revert the phase commit (docs + string literals only).

#### Risks

- **Risk**: a test pins the exact "state.db" message text.
  - **Mitigation**: grep `__tests__` for the string in the same commit.

## Dependency Map

```
Phase 1 (whoami) ──→ Phase 2 (arch-init skill)
        └──────────→ Phase 3 (docs sync)
```

(Phases 2 and 3 are independent of each other; both need Phase 1.)

## Integration Points

- **global.db (`~/.agent-farm/global.db`)**: strictly read-only — `builders`
  via `detectCurrentBuilderId` (own readonly connection) and
  `spawned_by_architect` / `known_workspaces` / `architect` via whoami's
  single shared readonly connection. `getDb()` (read-write) is never invoked
  by whoami. No schema changes.
- **Scaffold pipeline**: consumed as-is (`copySkills` dynamic enumeration);
  no changes.
- **Tower**: not required at runtime (spec constraint); no API changes.

## Validation Checkpoints

1. **After Phase 1**: full vitest suite green; manual smoke from this
   worktree (`builder`) and `/tmp` (failure path).
2. **After Phase 2**: byte-equality + content tests green; `/arch-init`
   loads and resolves via whoami manually.
3. **Before PR**: `pnpm --filter @cluesmith/codev build` clean;
   cross-tree grep for `whoami`/`arch-init` shows both trees in sync; all 12
   spec scenarios accounted for.

## Documentation Updates Required

- [ ] `codev/resources/commands/agent-farm.md` + skeleton mirror (Phase 3)
- [ ] `.claude/skills/afx/SKILL.md` + skeleton mirror (Phase 3)
- [ ] `codev/resources/arch.md` routing of any durable facts — deferred to
      Review phase per SPIR (with hot/cold tier discipline)

## Expert Review

### Iteration 1 (plan review): Gemini APPROVE, Codex REQUEST_CHANGES, Claude APPROVE

**Key feedback and adjustments:**

- **Codex — read-only violation (accepted)**: the draft accepted
  `lookupBuilderSpawningArchitect()` via read-write `getDb()`, contradicting
  the spec's "opens global.db read-only" requirement. Fixed: whoami uses one
  shared read-only connection for all its queries;
  `lookupBuilderSpawningArchitect` gains an optional `db?` parameter
  (defaults to `getDb()`, existing callers unaffected).
- **Codex — scenario 9 coverage overstated (accepted)**: no `copySkills()`
  tests exist today. Added Phase 2 deliverable: `copySkills()` regression
  tests in `scaffold.test.ts` (installs `arch-init`, respects
  `skipExisting`).
- **Codex — `resolveIdentity` purity under-specified (accepted)**: clarified
  that the send.ts helpers are NOT parameterized; `resolveIdentity(env)`
  reads cwd through them, and tests control cwd via `process.chdir()`
  (send.test.ts pattern). Claude's review raised the same purity point.
- **Gemini — test assertions pinned to old "state.db" wording must update in
  the same Phase 3 commit**: already covered under Phase 3 risks; kept.
- **Claude — drive-by scope**: confirmed only the user-facing message +
  doc comment change to "global.db"; historical "state.db is retired"
  migration comments stay.

Full reviews: `codev/projects/1134-afx-whoami-ship-arch-init-comm/1134-plan-iter1-{gemini,codex,claude}.txt`;
rebuttal: `1134-plan-iter1-rebuttals.md`.

## Change Log

| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-07-03 | Initial plan | — | builder spir-1134 |

## Notes

- **No time estimates** by protocol.
- Phase commits use `[Spec 1134][Phase: <name>]` format; all phases ship in a
  single PR (per spawn-prompt PR strategy).
- The spec's scenario 9 (`codev init` installs the skill) rides on existing
  `copySkills` behavior, which gets its first regression tests in Phase 2
  (none exist today); the presence/equality tests cover the artifact itself.

---

## Amendment History

<!-- TICK amendments, if any, chronologically below this line -->
