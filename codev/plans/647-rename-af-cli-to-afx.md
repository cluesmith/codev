# Plan: Rename afx CLI to afx

## Metadata
- **ID**: plan-647
- **Status**: draft
- **Specification**: codev/specs/647-rename-af-cli-to-afx.md
- **Created**: 2026-03-29

## Executive Summary

Rename the `afx` CLI command to `afx` using Approach 1 (Rename with Deprecated Alias) from the spec. The work is split into three phases: (1) core CLI rename to make `afx` functional with `afx` as a deprecated alias, (2) source code reference updates, skill directory rename, and test updates, (3) bulk documentation updates across ~197 markdown files.

## Success Metrics
- [ ] `afx` command works identically to current `afx`
- [ ] `afx` prints deprecation warning to stderr then works
- [ ] All source code references updated to `afx`
- [ ] `.claude/skills/af/` renamed to `.claude/skills/afx/`
- [ ] All ~197 documentation files updated
- [ ] All tests pass
- [ ] `.af-cron/` and `af-config.json` left unchanged

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "core_cli_rename", "title": "Core CLI Rename & Deprecated Alias"},
    {"id": "source_and_tests", "title": "Source Code References, Skill Rename & Tests"},
    {"id": "documentation", "title": "Documentation & Skeleton Updates"}
  ]
}
```

## Phase Breakdown

### Phase 1: Core CLI Rename & Deprecated Alias
**Dependencies**: None

#### Objectives
- Make `afx` the primary CLI command
- Keep `afx` working as a deprecated alias with stderr warning
- Update all programmatic invocations of `afx`

#### Deliverables
- [ ] New `bin/afx.js` shim (primary entry point)
- [ ] `bin/af.js` converted to deprecated wrapper
- [ ] `package.json` bin field updated with both entries
- [ ] CLI parser updated (`.name('afx')`, parseAsync args)
- [ ] `codev` CLI alias updated (`afx` → `afx`, keep `afx` as deprecated)
- [ ] Programmatic calls updated (`spawn`, `commandExists`)

#### Implementation Details

**`packages/codev/bin/afx.js`** (new file — copy of current `bin/af.js`):
```js
#!/usr/bin/env node
// afx - Agent Farm CLI (standalone command)
import { run } from '../dist/cli.js';
const args = process.argv.slice(2);
run(['agent-farm', ...args]);
```

**`packages/codev/bin/af.js`** (modified — deprecated wrapper):
```js
#!/usr/bin/env node
// af - DEPRECATED: use afx instead
import { run } from '../dist/cli.js';
console.warn('⚠ `afx` is deprecated. Use `afx` instead.');
const args = process.argv.slice(2);
run(['agent-farm', ...args]);
```

**`packages/codev/package.json`** bin field:
```json
"afx": "./bin/afx.js",
"af": "./bin/af.js",
```

**`packages/codev/src/agent-farm/cli.ts`**:
- `.name('af')` → `.name('afx')`
- `parseAsync(['node', 'af', ...args])` → `parseAsync(['node', 'afx', ...args])`

**`packages/codev/src/cli.ts`**:
- `.alias('af')` → `.alias('afx')` (primary)
- Keep `afx` as additional deprecated alias
- `args[0] === 'af'` → also match `'afx'`, and add `console.warn` deprecation when `args[0] === 'af'`

**`packages/codev/src/commands/porch/index.ts`**:
- `spawn('af', ['open', ...])` → `spawn('afx', ['open', ...])`

**`packages/codev/src/commands/doctor.ts`**:
- `commandExists('af')` → `commandExists('afx')`
- Update string `'installed (via af)'` → `'installed (via afx)'`

#### Acceptance Criteria
- [ ] `afx status` works
- [ ] `afx spawn --help` works
- [ ] `afx status` prints deprecation warning to stderr, then works
- [ ] `codev afx` works as alias
- [ ] Doctor check finds `afx` binary

#### Test Plan
- **Unit Tests**: Verify CLI parser sets name to `afx`
- **Integration Tests**: Verify deprecated `afx` wrapper emits warning to stderr
- **Manual Testing**: Run `afx status` and `afx status`, verify output

#### Rollback Strategy
Revert the bin shim changes, restore original `af.js`, and revert package.json.

---

### Phase 2: Source Code References, Skill Rename & Tests
**Dependencies**: Phase 1

#### Objectives
- Update all hardcoded `afx` references in TypeScript source files
- Rename `.claude/skills/af/` to `.claude/skills/afx/`
- Update test files to reference `afx`

#### Deliverables
- [ ] All help text, error messages, and deprecation warnings updated in source
- [ ] `.claude/skills/af/` renamed to `.claude/skills/afx/` (repo)
- [ ] `codev-skeleton/.claude/skills/af/` renamed to `codev-skeleton/.claude/skills/afx/` (skeleton)
- [ ] Skill content updated to reference `afx`
- [ ] Test describe blocks and assertions updated

#### Implementation Details

**Source files to update** — the list below is a starting point, NOT exhaustive. The builder MUST grep for all `afx ` patterns in `packages/codev/src/` and update every user-facing reference found:

Known files with user-facing `afx` references:
- `packages/codev/src/agent-farm/cli.ts` — deprecation messages (`afx dash`, `afx team`)
- `packages/codev/src/agent-farm/commands/spawn.ts` — help text
- `packages/codev/src/agent-farm/commands/db.ts` — help text
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts` — help text
- `packages/codev/src/agent-farm/commands/status.ts` — help text (3 instances)
- `packages/codev/src/agent-farm/commands/send.ts` — error messages (3 instances)
- `packages/codev/src/agent-farm/commands/rename.ts` — usage text
- `packages/codev/src/agent-farm/commands/tower-cloud.ts` — `afx tower connect` references
- `packages/codev/src/agent-farm/commands/attach.ts` — `afx` references
- `packages/codev/src/agent-farm/commands/team-update.ts` — `afx team update` reference
- `packages/codev/src/agent-farm/commands/open.ts` — `afx open` references
- `packages/codev/src/agent-farm/commands/shell.ts` — `afx` references
- `packages/codev/src/agent-farm/lib/tunnel-client.ts` — error message
- `packages/codev/src/agent-farm/lib/cloud-config.ts` — error messages (2 instances)
- `packages/codev/src/agent-farm/servers/tower-tunnel.ts` — `afx tower connect` references

Source code comments referencing `afx` commands (e.g., in `send-buffer.ts`, `tower-terminals.ts`, `tower-cron.ts`) should also be updated for consistency.

**Skill directory rename**:
- `git mv .claude/skills/af .claude/skills/afx`
- `git mv codev-skeleton/.claude/skills/af codev-skeleton/.claude/skills/afx`
- Update content in `SKILL.md` to reference `afx` commands

**Test files to update** — same as source: grep for all `afx` patterns, not just the list below:

Known test files:
- `packages/codev/src/agent-farm/__tests__/tower-cloud-cli.test.ts` — assertions
- `packages/codev/src/agent-farm/__tests__/af-architect.test.ts` — describe block
- `packages/codev/src/agent-farm/__tests__/status-naming.test.ts` — describe block
- `packages/codev/src/agent-farm/__tests__/bench.test.ts` — describe block
- `packages/codev/src/agent-farm/__tests__/spawn.test.ts` — test data
- `packages/codev/src/__tests__/team-cli.test.ts` — `afx team` references
- Any e2e tests and bugfix tests referencing `afx` commands

#### Acceptance Criteria
- [ ] No source files contain `afx ` in user-facing messages (except deprecation text in `bin/af.js`)
- [ ] `/afx` skill discovered correctly
- [ ] All existing tests pass with updated references

#### Test Plan
- **Unit Tests**: Run full test suite to catch any broken references
- **Manual Testing**: Verify `/afx` skill works in Claude Code

#### Rollback Strategy
Revert source file changes, rename skill directories back.

---

### Phase 3: Documentation & Skeleton Updates
**Dependencies**: Phase 2

#### Objectives
- Update all ~197 markdown files referencing `afx` commands
- Update skeleton files deployed to user projects

#### Deliverables
- [ ] All markdown files in `codev/` updated
- [ ] CLAUDE.md and AGENTS.md updated
- [ ] Skeleton markdown files in `codev-skeleton/` updated
- [ ] No false positives (words like "after", "safari", "leaf" preserved)

#### Implementation Details

**Search-replace strategy**: Target patterns that specifically reference the CLI command:
- `` `afx `` → `` `afx `` (backtick-prefixed command)
- `` `afx` `` → `` `afx` `` (backtick-wrapped standalone)
- `"afx ` → `"afx ` (quoted command references)
- `afx spawn`, `afx status`, `afx send`, `afx open`, `afx cleanup`, `afx tower`, `afx workspace`, `afx dash`, `afx team`, `afx bench` → `afx` equivalents

**Key files** (highest priority):
- `CLAUDE.md` and `AGENTS.md` (root-level)
- `codev/resources/commands/agent-farm.md` (primary AF documentation)
- `codev/resources/commands/overview.md`
- `codev/resources/arch.md`
- `codev/resources/cheatsheet.md`
- `codev/resources/workflow-reference.md`
- `codev/roles/builder.md`
- `codev/protocols/` (protocol files)

**Skeleton files**:
- `codev-skeleton/CLAUDE.md` and `codev-skeleton/AGENTS.md`
- `codev-skeleton/` protocol and resource files

**Historical specs/plans/reviews**: Update for consistency since they serve as living documentation.

**Exclusions**:
- `.af-cron` references (directory name, not CLI command)
- `af-config.json` references (deprecated file name, not CLI command)

#### Acceptance Criteria
- [ ] `grep -rn '\baf\b' --include='*.md' | grep -v af-cron | grep -v af-config` returns no CLI command references
- [ ] No false positive replacements in natural language text
- [ ] All markdown renders correctly (no broken formatting)

#### Test Plan
- **Automated**: Grep for remaining `afx` command patterns
- **Manual**: Spot-check 10-15 files for correct replacement

#### Rollback Strategy
Git revert the documentation commit.

---

## Dependency Map
```
Phase 1 (Core CLI) ──→ Phase 2 (Source & Tests) ──→ Phase 3 (Documentation)
```

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| False positive replacements in docs | Medium | Medium | Use targeted patterns, avoid broad regex |
| Missed programmatic `afx` reference | Low | Medium | Grep for all `afx` patterns after Phase 2 |
| Skill discovery breaks after rename | Low | Medium | Test `/afx` skill before committing |

## Validation Checkpoints
1. **After Phase 1**: `afx status` works, `afx status` shows deprecation warning
2. **After Phase 2**: Full test suite passes, `/afx` skill works
3. **After Phase 3**: No remaining `afx` CLI references in documentation
