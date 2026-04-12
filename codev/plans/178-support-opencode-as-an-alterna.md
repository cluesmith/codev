# Plan: Support OpenCode as an Alternative Agent Shell

## Metadata
- **ID**: plan-2026-04-12-support-opencode
- **Status**: draft
- **Specification**: codev/specs/178-support-opencode-as-an-alterna.md
- **Created**: 2026-04-12

## Executive Summary

Implement first-class OpenCode support by extending the harness abstraction layer with a new built-in `OPENCODE_HARNESS` provider, adding auto-detection, extending the `HarnessProvider` interface with an optional `getWorktreeFiles()` method for file-based role injection, updating `codev doctor` to check for the `opencode` binary, and documenting the configuration.

This is a low-risk, narrowly scoped change (~100-150 LOC across 4-5 files) that follows established patterns from the Claude, Codex, and Gemini harness implementations.

## Success Metrics
- [ ] All spec success criteria met
- [ ] All existing harness tests pass (no regressions)
- [ ] New unit tests for OpenCode harness, auto-detection, and worktree files
- [ ] `npm run build` succeeds
- [ ] `npm test` passes

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "harness_provider", "title": "Harness Provider and Auto-Detection"},
    {"id": "spawn_integration", "title": "Spawn Worktree Integration"},
    {"id": "doctor_and_docs", "title": "Doctor Validation and Documentation"}
  ]
}
```

## Phase Breakdown

### Phase 1: Harness Provider and Auto-Detection
**Dependencies**: None

#### Objectives
- Add `OPENCODE_HARNESS` as a built-in provider with empty args/env (role injection handled via worktree files)
- Add `getWorktreeFiles?()` optional method to `HarnessProvider` interface
- Implement `getWorktreeFiles()` on `OPENCODE_HARNESS` to return `opencode.json` with `instructions: [".builder-role.md"]`
- Add `opencode` to `detectHarnessFromCommand()` auto-detection
- Add `opencode` to `BUILTIN_HARNESSES` map
- Write comprehensive unit tests

#### Deliverables
- [ ] `HarnessProvider` interface extended with optional `getWorktreeFiles?()` method
- [ ] `OPENCODE_HARNESS` constant exported from `harness.ts`
- [ ] `opencode` added to `BUILTIN_HARNESSES`
- [ ] `detectHarnessFromCommand()` recognizes `opencode` basename
- [ ] Unit tests for all new functionality

#### Implementation Details

**File: `packages/codev/src/agent-farm/utils/harness.ts`**

1. Add optional method to `HarnessProvider` interface:
```typescript
export interface HarnessProvider {
  buildRoleInjection(roleContent: string, roleFilePath: string): {
    args: string[];
    env: Record<string, string>;
  };
  buildScriptRoleInjection(roleContent: string, roleFilePath: string): {
    fragment: string;
    env: Record<string, string>;
  };
  /** Optional: files to write in the worktree before launching the agent */
  getWorktreeFiles?(roleContent: string, roleFilePath: string): Array<{
    relativePath: string;
    content: string;
  }>;
}
```

2. Add `OPENCODE_HARNESS`:
```typescript
export const OPENCODE_HARNESS: HarnessProvider = {
  buildRoleInjection: () => ({ args: [], env: {} }),
  buildScriptRoleInjection: () => ({ fragment: '', env: {} }),
  getWorktreeFiles: () => ([{
    relativePath: 'opencode.json',
    content: JSON.stringify({ instructions: ['.builder-role.md'] }, null, 2) + '\n',
  }]),
};
```

3. Add to `BUILTIN_HARNESSES`:
```typescript
const BUILTIN_HARNESSES: Record<string, HarnessProvider> = {
  claude: CLAUDE_HARNESS,
  codex: CODEX_HARNESS,
  gemini: GEMINI_HARNESS,
  opencode: OPENCODE_HARNESS,
};
```

4. Add to `detectHarnessFromCommand()`:
```typescript
if (basename.includes('opencode')) return 'opencode';
```

**File: `packages/codev/src/agent-farm/__tests__/harness.test.ts`**

Add tests mirroring the existing Claude/Codex/Gemini test structure:
- `OPENCODE_HARNESS.buildRoleInjection()` returns `{ args: [], env: {} }`
- `OPENCODE_HARNESS.buildScriptRoleInjection()` returns `{ fragment: '', env: {} }`
- `OPENCODE_HARNESS.getWorktreeFiles()` returns array with `opencode.json` entry
- `detectHarnessFromCommand('opencode run')` returns `'opencode'`
- `detectHarnessFromCommand('/usr/local/bin/opencode')` returns `'opencode'`
- `resolveHarness('opencode')` returns `OPENCODE_HARNESS`
- Auto-detect from command `'opencode run --model anthropic/claude-sonnet'` returns `'opencode'`
- Existing harnesses don't have `getWorktreeFiles` (verify backward compat)

#### Acceptance Criteria
- [ ] `npm run build` succeeds
- [ ] All existing harness tests pass
- [ ] All new OpenCode harness tests pass
- [ ] `resolveHarness()` with no args still defaults to claude

#### Test Plan
- **Unit Tests**: Direct tests of `OPENCODE_HARNESS` methods, auto-detection, resolution
- **Regression**: Run full existing harness test suite

#### Rollback Strategy
Revert the single commit — no data migrations or external state changes.

#### Risks
- **Risk**: Adding optional method to interface breaks existing custom harnesses
  - **Mitigation**: Method is optional (`?`), so TypeScript won't require existing implementations to add it

---

### Phase 2: Spawn Worktree Integration
**Dependencies**: Phase 1

#### Objectives
- Update `spawn-worktree.ts` to call `getWorktreeFiles()` after writing `.builder-role.md` and write any returned files to the worktree
- Verify the generated `.builder-start.sh` produces the correct command shape for `opencode run`

#### Deliverables
- [ ] `spawn-worktree.ts` calls `getWorktreeFiles()` when available
- [ ] Generated files are written to correct paths in worktree
- [ ] Startup script works with `opencode run` as the base command

#### Implementation Details

**File: `packages/codev/src/agent-farm/commands/spawn-worktree.ts`**

In `startBuilderSession()`, after writing `.builder-role.md` (around line 594), add:

```typescript
// Write any harness-specific worktree files (e.g., opencode.json)
if (harness.getWorktreeFiles) {
  const worktreeFiles = harness.getWorktreeFiles(roleWithPort, roleFile);
  for (const file of worktreeFiles) {
    writeFileSync(resolve(worktreePath, file.relativePath), file.content);
  }
}
```

This is ~5 lines of code. The harness is already resolved at this point (`getBuilderHarness(config.workspaceRoot)` on line 598).

Also do the same in the `buildBuilderStartScript()` function (around line 673) which is the alternate code path for script generation.

**Verification**: With `shell.builder: "opencode run"`, the generated script should be:
```bash
#!/bin/bash
cd "/path/to/worktree"
while true; do
  opencode run  "$(cat '/path/to/worktree/.builder-prompt.txt')"
  echo ""
  echo "Agent exited. Restarting in 2 seconds... (Ctrl+C to quit)"
  sleep 2
done
```

The empty space between `opencode run` and `"$(cat...)"` is correct (empty fragment, harmless in bash).

#### Acceptance Criteria
- [ ] `npm run build` succeeds
- [ ] `npm test` passes
- [ ] When harness has `getWorktreeFiles()`, files are written to worktree
- [ ] When harness doesn't have `getWorktreeFiles()`, no change in behavior (Claude/Codex/Gemini unaffected)

#### Test Plan
- **Unit Tests**: Test that `startBuilderSession` calls `getWorktreeFiles` when present and writes files
- **Regression**: Existing spawn tests pass unchanged

#### Rollback Strategy
Revert the commit — spawn-worktree falls back to not calling `getWorktreeFiles()`.

#### Risks
- **Risk**: Writing `opencode.json` conflicts with an existing user `opencode.json` in the repo
  - **Mitigation**: Builder worktrees are isolated copies. The generated file only affects the builder session, not the main repo. If the repo already has an `opencode.json`, the generated one overwrites it in the worktree — this is acceptable because builder worktrees are ephemeral and the `instructions` field merges with other config sources.

---

### Phase 3: Doctor Validation and Documentation
**Dependencies**: Phase 1, Phase 2

#### Objectives
- Add `opencode` to `codev doctor`'s `AI_DEPENDENCIES` list (binary existence check only)
- Document OpenCode configuration in README or relevant docs
- Document required `opencode.json` permission configuration for unattended builders
- Document known differences vs Claude Code

#### Deliverables
- [ ] `opencode` entry in `AI_DEPENDENCIES` array in `doctor.ts`
- [ ] Configuration documentation with examples
- [ ] Permission setup documentation
- [ ] Known differences/limitations documentation

#### Implementation Details

**File: `packages/codev/src/commands/doctor.ts`**

Add to `AI_DEPENDENCIES` array (after the Gemini entry):
```typescript
{
  name: 'OpenCode',
  command: 'opencode',
  versionArg: '--version',
  versionExtract: () => 'working',
  required: false,
  installHint: {
    macos: 'npm install -g opencode',
    linux: 'npm install -g opencode',
  },
},
```

No `VERIFY_CONFIGS` entry — OpenCode is multi-provider, so auth verification depends on the user's chosen provider. Binary existence is sufficient.

**File: `README.md` (or relevant docs section)**

Add an "Alternative Agent Shells" section covering:

1. Configuration example:
```json
{
  "shell": {
    "builder": "opencode run",
    "architect": "claude --dangerously-skip-permissions"
  }
}
```

2. Required `opencode.json` for unattended execution:
```json
{
  "permissions": {
    "edit": "allow",
    "bash": "allow"
  }
}
```

3. Known differences:
- OpenCode reads `AGENTS.md` for project instructions (already present in Codev repos)
- Must include `run` subcommand in `shell.builder` (plain `opencode` launches TUI)
- No `--dangerously-skip-permissions` — must configure permissions in `opencode.json`
- Multi-provider: uses whatever LLM backend the user has configured in their OpenCode setup

#### Acceptance Criteria
- [ ] `codev doctor` shows OpenCode status when the binary is installed
- [ ] Documentation is clear and has working configuration examples
- [ ] `npm run build` succeeds
- [ ] `npm test` passes

#### Test Plan
- **Manual Testing**: Run `codev doctor` and verify OpenCode appears in output
- **Regression**: Existing doctor tests pass

#### Rollback Strategy
Revert the commit — doctor falls back to not checking OpenCode.

#### Risks
- **Risk**: OpenCode installation method changes
  - **Mitigation**: Install hint is informational only; doesn't affect functionality

## Dependency Map
```
Phase 1 (Harness) ──→ Phase 2 (Spawn) ──→ Phase 3 (Doctor & Docs)
```

## Integration Points

### Internal Systems
- **harness.ts**: New provider + interface extension (Phase 1)
- **spawn-worktree.ts**: Calls `getWorktreeFiles()` (Phase 2)
- **doctor.ts**: New dependency entry (Phase 3)

### External Systems
- **OpenCode CLI**: Must be installed by user; no runtime dependency from Codev

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Optional interface method breaks existing TS consumers | Low | Medium | Method is optional (`?`), fully backward compatible |
| Generated `opencode.json` overwrites user file in worktree | Low | Low | Worktrees are ephemeral; instructions merge with other config |
| OpenCode changes `instructions` field behavior | Low | Medium | Pin to documented behavior; custom harness as fallback |

## Validation Checkpoints
1. **After Phase 1**: All harness tests pass, `resolveHarness('opencode')` works
2. **After Phase 2**: Build succeeds, spawn integration works end-to-end
3. **After Phase 3**: Doctor shows OpenCode, documentation is complete

## Documentation Updates Required
- [ ] README section on alternative agent shells
- [ ] OpenCode permission configuration guide
- [ ] Known differences/limitations
