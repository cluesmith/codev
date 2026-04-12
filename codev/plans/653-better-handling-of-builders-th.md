# Plan: Decouple Worktree/Branch/PR and Add Optional Verify Phase

## Metadata
- **ID**: 653
- **Status**: draft
- **Specification**: `codev/specs/653-better-handling-of-builders-th.md`
- **Created**: 2026-04-12

## Executive Summary

Four slices, six implementation phases. Slice A (pr-exists fix) ships standalone. Slice B (status.yaml commit infra + PR tracking + worktree path) is the foundation. Slice C (verify phase + terminal rename) builds on B. Slice D (TICK removal) is cleanup that ships with or after C.

The hardest part is Phase 2 (status.yaml commit infrastructure) — every `writeState` call in porch must be followed by git commit/push, and there are 18+ call sites across `next.ts` and `index.ts`. The safest approach is a new `writeStateAndCommit` wrapper that replaces all bare `writeState` calls.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "pr_exists_fix", "title": "Phase 1: pr-exists tightening (Slice A)"},
    {"id": "status_commit_infra", "title": "Phase 2: status.yaml commit infrastructure (Slice B foundation)"},
    {"id": "pr_tracking_and_worktree", "title": "Phase 3: PR tracking schema + worktree path (Slice B)"},
    {"id": "verify_phase", "title": "Phase 4: Verify phase + terminal state rename (Slice C)"},
    {"id": "tick_removal", "title": "Phase 5: Remove TICK protocol (Slice D)"},
    {"id": "docs_and_prompts", "title": "Phase 6: Documentation and prompt updates"}
  ]
}
```

## Phase Breakdown

### Phase 1: pr-exists tightening (Slice A)
**Dependencies**: None

#### Objectives
- Fix `pr-exists` forge scripts to exclude `CLOSED`-not-merged PRs
- Standalone correctness fix; ships as its own PR

#### Files to Modify
- `packages/codev/scripts/forge/github/pr-exists.sh` — change `--state all` to filter: pipe through `jq` selecting only OPEN or MERGED state
- `packages/codev/scripts/forge/gitlab/pr-exists.sh` — add state filter excluding closed MRs
- `packages/codev/scripts/forge/gitea/pr-exists.sh` — add jq filter excluding closed PRs
- `packages/codev/src/commands/porch/__tests__/bugfix-568-pr-exists-state-all.test.ts` — **rewrite** to target the `pr-exists.sh` scripts directly (currently the test reads `pr_exists` commands from protocol.json, not the scripts; updating scripts without updating protocol.json would leave the test checking stale data)

#### Implementation Details

**GitHub** (current):
```bash
exec gh pr list --state all --head "$CODEV_BRANCH_NAME" --json number --jq "length > 0"
```
**GitHub** (new): keep `--state all` to fetch all, then filter in jq:
```bash
exec gh pr list --state all --head "$CODEV_BRANCH_NAME" --json number,state --jq '[.[] | select(.state == "OPEN" or .state == "MERGED")] | length > 0'
```
This preserves the bugfix-568 intent (don't miss merged PRs) while excluding abandoned CLOSED PRs.

**GitLab**: similar jq filter on `state` field. **Gitea**: similar jq filter on `state` field.

#### Acceptance Criteria
- [ ] OPEN PR → `pr-exists` returns true
- [ ] MERGED PR → `pr-exists` returns true
- [ ] CLOSED (not merged) PR → `pr-exists` returns false
- [ ] No PR at all → `pr-exists` returns false
- [ ] Existing bugfix-568 regression test updated and passing

---

### Phase 2: status.yaml commit infrastructure (Slice B foundation)
**Dependencies**: None (can develop in parallel with Phase 1)

#### Objectives
- Ensure every porch state mutation commits and pushes `status.yaml`
- This is the hard requirement from spec §B.3: zero gaps

#### Files to Modify
- `packages/codev/src/commands/porch/state.ts` — add `writeStateAndCommit()` function
- `packages/codev/src/commands/porch/next.ts` — replace all 9 `writeState()` calls (lines 324, 358, 378, 606, 688, 695, 706, 725, 733)
- `packages/codev/src/commands/porch/index.ts` — replace all 7 `writeState()` calls (lines 303, 398, 422, 487, 592, 676, 735)

#### Implementation Details

New function in `state.ts`:
```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);

export async function writeStateAndCommit(
  statusPath: string,
  state: ProjectState,
  message: string,
): Promise<void> {
  writeState(statusPath, state);
  const cwd = path.dirname(path.dirname(statusPath)); // worktree root
  // Use execFile with args array — no shell injection risk
  await execFileAsync('git', ['add', statusPath], { cwd });
  await execFileAsync('git', ['commit', '-m', message], { cwd });
  // Use -u origin HEAD so new branches get upstream tracking
  await execFileAsync('git', ['push', '-u', 'origin', 'HEAD'], { cwd });
}
```

**No `--allow-empty`**: if status.yaml hasn't changed, the commit should fail — that signals a logic bug (writeState should have mutated the file before calling this). Do not mask it.

Commit messages follow the pattern: `chore(porch): ${state.id} ${phase} → ${event}` where event is one of: `phase-transition`, `gate-requested`, `gate-approved`, `build-complete`, `verify-skip`.

**Risk**: pushing on every state change adds network overhead. Mitigation: porch operations are infrequent (minutes between transitions, not seconds). The reliability of status.yaml on main outweighs the latency cost.

**Completion task overlap**: today the review phase's completion task includes "commit status.yaml." Once `writeStateAndCommit` lands, this manual completion task becomes redundant. Remove the status.yaml commit from review-phase completion tasks — it's now automatic.

**Existing `writeState` calls that don't need commit** (porch init only writes to the worktree before the first push): `porch init` at index.ts:303 can use `writeStateAndCommit` with the initial commit. All other calls must commit.

#### Acceptance Criteria
- [ ] Every `writeState` call in next.ts and index.ts is replaced with `writeStateAndCommit`
- [ ] After each porch operation that mutates state, `git log -1` shows a status.yaml commit
- [ ] `git push` succeeds after each commit (branch exists on remote)
- [ ] Unit tests mock git operations and verify commit/push are called

---

### Phase 3: PR tracking schema + worktree path (Slice B)
**Dependencies**: Phase 2

#### Objectives
- Add PR history tracking to `ProjectState`
- Normalize worktree path to `.builders/<protocol>-<id>/` (subsumes #662)

#### Files to Modify
- `packages/codev/src/commands/porch/types.ts` — add `pr_history` field to `ProjectState`
- `packages/codev/src/commands/porch/index.ts` — extend `porch done` to accept optional `--pr <N> --branch <name>` flags; add `--merged` variant for recording merges
- `packages/codev/src/agent-farm/commands/spawn.ts` — change worktree name from `${protocol}-${strippedId}-${specSlug}` to `${protocol}-${strippedId}` (lines 340-351, 670-683)
- `packages/codev/src/agent-farm/commands/spawn.ts` — update `--resume` path lookup to use ID-only pattern

#### Implementation Details

**PR tracking schema** (added to `ProjectState`):
```typescript
pr_history?: Array<{
  phase: string;          // porch phase when PR was created (e.g. "specify", "implement")
  pr_number: number;
  branch: string;
  created_at: string;
  merged?: boolean;
  merged_at?: string;
}>;
```

**Recording mechanism**: extend `porch done` with optional flags rather than adding a new subcommand (spec constraint: "one new porch subcommand — `porch verify`"):
- `porch done <id> --pr 42 --branch spir/653/specify` — **record-only**: writes a PR entry to `pr_history` in status.yaml and exits immediately. Does NOT run checks, does NOT advance the phase, does NOT mark build_complete. This is metadata recording, not a phase signal.
- `porch done <id> --merged 42` — **record-only**: marks an existing PR entry as merged with a timestamp and exits. Same semantics — no phase advancement.
- `porch done <id>` (no flags) — works exactly as before: sets build_complete, runs checks, advances phase.

The `--pr`/`--merged` flags and the normal `porch done` flow are mutually exclusive. If flags are present, record and exit. If absent, normal flow.

**Worktree path** (lines 340-351 in spawn.ts):
```typescript
// Before:
worktreeName = `${protocol}-${strippedId}-${specSlug}`;
// After:
worktreeName = `${protocol}-${strippedId}`;
```

Same change for bugfix spawns at lines 670-683. Also simplify the `--branch` variant at line 345 (`${protocol}-${strippedId}-branch-${slugify(options.branch)}` → `${protocol}-${strippedId}`). The `--resume` lookup must also search by `${protocol}-${strippedId}` pattern instead of including the title slug.

**Migration for existing worktrees**: `afx spawn --resume` should fall back to the old title-based pattern if the ID-only path doesn't exist. This gives a migration window — old worktrees still work, new ones use the clean path.

#### Acceptance Criteria
- [ ] `porch done --pr 42 --branch stage-1` writes a `pr_history` entry to status.yaml
- [ ] `porch done --merged 42` marks the entry as merged with a timestamp
- [ ] New worktrees are created at `.builders/<protocol>-<id>/` (no title suffix)
- [ ] `afx spawn --resume` finds both old-format and new-format worktree paths
- [ ] Existing worktrees are unaffected (backward compat)

---

### Phase 4: Verify phase + terminal state rename (Slice C)
**Dependencies**: Phase 2 (status.yaml infra), Phase 3 (worktree persists through verify)

#### Objectives
- Add `verify` phase to SPIR and ASPIR protocols
- Rename terminal state from `complete` to `verified`
- Add `porch verify <id> --skip "reason"` command
- Add `verify-approval` human-only gate

#### Files to Modify
- `codev/protocols/spir/protocol.json` — change review phase's `next: null` to `next: "verify"`, add verify phase definition
- `codev/protocols/aspir/protocol.json` — same change
- `codev-skeleton/protocols/spir/protocol.json` — same change
- `codev-skeleton/protocols/aspir/protocol.json` — same change
- `packages/codev/src/commands/porch/next.ts` — rename `'complete'` to `'verified'` at lines 246, 262, 271, 357, 724. **Do NOT rename** `PorchNextResponse.status: 'complete'` (that's response status, not phase) or `PlanPhaseStatus: 'complete'` (plan-phase tracking, separate concept).
- `packages/codev/src/commands/porch/index.ts` — rename `'complete'` to `'verified'` at lines 127, 397, 630; add `porch verify` subcommand; `porch approve` must accept `verify-approval`
- `packages/codev/src/agent-farm/servers/overview.ts` — rename `'complete'` to `'verified'` at lines 287, 299 (progress calculation)
- `packages/codev/src/agent-farm/commands/status.ts` — rename `'complete'` to `'verified'` at line 205 (styling)
- `packages/codev/src/agent-farm/__tests__/overview.test.ts` — update 6 assertions that check `phase: 'complete'` → 100% progress

#### Implementation Details

**Verify phase definition** (added to protocol.json):
```json
{
  "id": "verify",
  "name": "Verify",
  "description": "Post-merge environmental verification",
  "type": "once",
  "gate": "verify-approval",
  "next": null
}
```

Review phase's `next` changes from `null` to `"verify"`.

**handleOncePhase reuse**: the verify phase is `type: "once"`, so `handleOncePhase` at next.ts:741 handles it. The emitted task description is: *"The PR has been merged. Verify the change in your environment, then run `porch done <id>` to signal completion. Porch will then request the `verify-approval` gate — the architect approves it. If verification is not needed, run: `porch verify <id> --skip 'reason'`"*

**Verify flow (step by step)**: builder stays alive → builder runs `porch done` → porch runs checks (none for verify) → porch requests `verify-approval` gate → architect runs `porch approve <id> verify-approval`. This is the standard once-phase → gate flow. The hardcoded "When complete, run: porch done" at next.ts:757 should be overridden for verify to say "When verified, run: porch done <id>".

**Convenience shortcut**: `porch approve <id> verify-approval` should auto-complete the `porch done` step if `build_complete` is false and the current phase is `verify`. This lets the architect approve in one command if the builder is gone. Implementation: in the `approve` handler, check `phase === 'verify' && !build_complete`, and if so, run the done logic before approving.

**`porch verify` subcommand** (index.ts):
```typescript
case 'verify':
  if (args.includes('--skip')) {
    const reason = extractFlag(args, '--skip');
    if (!reason) { error('--skip requires a reason'); }
    state.phase = 'verified';
    state.context = { ...state.context, verify_skip_reason: reason };
    writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} verify skipped: ${reason}`);
    return;
  }
  error('Usage: porch verify <id> --skip "reason"');
```

**Terminal state rename**: replace all 8 occurrences of `'complete'` across next.ts and index.ts with `'verified'`.

**Backward compatibility**: when porch loads a status.yaml with `phase: 'complete'`, **unconditionally** rename to `'verified'` and commit. This is universal — applies to ALL protocols (SPIR, ASPIR, BUGFIX, AIR, MAINTAIN) because the terminal state rename is global, not protocol-specific. Without the universal rename, BUGFIX/MAINTAIN projects stuck at `phase: 'complete'` would be stranded in an invalid state.
```typescript
if (state.phase === 'complete') {
  state.phase = 'verified';
  writeStateAndCommit(statusPath, state, `chore(porch): ${state.id} migrate complete → verified`);
}
```

#### Acceptance Criteria
- [ ] SPIR and ASPIR protocol.json files include a `verify` phase after `review`
- [ ] After review gate approval, `porch next` advances to verify phase
- [ ] Verify phase emits a single task via `handleOncePhase`
- [ ] `porch approve <id> verify-approval` works with the human-only guard
- [ ] `porch verify <id> --skip "reason"` transitions to `verified` and records the reason
- [ ] All `phase: 'complete'` references in porch source AND agent-farm consumers renamed to `'verified'` (`PorchNextResponse.status` and `PlanPhaseStatus` are NOT renamed — different concepts)
- [ ] Old projects with `phase: 'complete'` auto-migrate to `'verified'` on load — universally, regardless of protocol
- [ ] `afx status` shows correct progress (100%) and styling for `verified` projects
- [ ] `overview.test.ts` assertions updated and passing

---

### Phase 5: Remove TICK protocol (Slice D)
**Dependencies**: None (can ship with Phase 4 or independently)

#### Objectives
- Delete TICK protocol from the codebase
- Update all references

#### Files to Delete
- `codev/protocols/tick/` (entire directory — protocol.json, protocol.md, builder-prompt.md, templates/, consult-types/)
- `codev-skeleton/protocols/tick/` (entire directory — same structure)

#### Files to Modify
- `CLAUDE.md` / `AGENTS.md` — remove TICK from protocol selection guide, remove `afx spawn 42 --protocol tick --amends 30` example, remove "Use TICK for" section
- `packages/codev/src/agent-farm/commands/spawn.ts` — remove `tick` from `--protocol` validation
- `packages/codev/src/commands/porch/state.ts` — remove `tick` from worktree path regex (line ~248-251)
- `packages/codev/src/commands/porch/__tests__/next.test.ts` — remove or update tick-related test cases
- Any other files found by a **full-repo** search: `grep -r "tick\|TICK" --include="*.ts" --include="*.md" --include="*.json" .` (not just `packages/codev/src/` — protocol docs, command docs, CLI help, resources, and skeleton can all reference TICK)

#### Implementation Details
Grep for all TICK references, delete/update each one. Check for in-flight TICK projects:
```bash
ls codev/projects/tick-* 2>/dev/null
```
If any exist, note them in the PR description for manual migration.

#### Acceptance Criteria
- [ ] `codev/protocols/tick/` and `codev-skeleton/protocols/tick/` do not exist
- [ ] `afx spawn 42 --protocol tick` fails with "unknown protocol"
- [ ] No remaining `tick` or `TICK` references in protocol selection docs
- [ ] Protocol list in CLAUDE.md/AGENTS.md: SPIR, ASPIR, AIR, BUGFIX, MAINTAIN, EXPERIMENT

---

### Phase 6: Documentation and prompt updates
**Dependencies**: Phases 3, 4, 5

#### Objectives
- Update builder prompts and role documentation for multi-PR workflow and verify phase
- Update CLAUDE.md/AGENTS.md for the new protocol list and workflow

#### Files to Modify
- `codev-skeleton/protocols/spir/builder-prompt.md` — add multi-PR workflow guidance. **Important**: git worktrees cannot `git checkout main` when main is checked out in the parent repo. Prompts must instruct: `git fetch origin main && git checkout -b <next-branch> origin/main` (branch off the remote tracking ref, not a local checkout)
- `codev-skeleton/protocols/aspir/builder-prompt.md` — same
- `codev/roles/builder.md` and `codev-skeleton/roles/builder.md` — document multi-PR lifecycle, verify phase, `afx spawn --resume` as recovery path
- `CLAUDE.md` / `AGENTS.md` — update protocol list (remove TICK, add verify phase to SPIR/ASPIR descriptions), update `afx cleanup` documentation to emphasize architect-driven cleanup
- `codev/resources/arch.md` — note architectural change: worktree ≠ branch ≠ PR

#### Acceptance Criteria
- [ ] Builder prompt mentions multi-PR workflow and verify phase
- [ ] Protocol selection guide reflects TICK removal and verify addition
- [ ] `afx cleanup` docs emphasize it's architect-driven, not auto-on-merge

---

## Dependency Map
```
Phase 1 (pr-exists) ─────────────────────────────────────┐
Phase 2 (status commit) ──→ Phase 3 (PR tracking) ──→ Phase 4 (verify) ──→ Phase 6 (docs)
                                                          │
Phase 5 (TICK removal) ──────────────────────────────────→┘
```

Phases 1, 2, and 5 have no inter-dependencies and can develop in parallel.

## Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| `writeStateAndCommit` push fails (network, auth) | Medium | High | Catch errors, retry once, log clearly. Don't swallow — fail the porch operation. |
| #662 worktree path change breaks `--resume` on old worktrees | Medium | High | Fallback: `--resume` tries ID-only path first, then old title-based path. Migration window. |
| Terminal state rename breaks dashboard/reporting | **Certain** | Medium | Concrete files: `overview.ts` (287, 299), `status.ts` (205), `overview.test.ts` (6 assertions). Already in Phase 4 file list. |
| TICK removal breaks an in-flight project | Low | Medium | Check `codev/projects/tick-*` before deleting. Migrate or close any found. |

## Notes

- **No cold-start mechanism**: per architect's final feedback, there is no "read status.yaml from main without a worktree" path. Recovery is always via `afx spawn --resume`.
- **State alignment is future work**: making porch's phase + gate the canonical project state for all consumers (afx status, dashboard, reporting) is a follow-up spec.
- **`porch verify` is the only new subcommand**: PR recording extends `porch done` with optional flags rather than adding a second new command.
- **The verify phase prompt question** (from spec Open Questions): the task content should be inline in `handleOncePhase` output, not a separate prompt file. It's one sentence — a prompt file is overkill.
