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
- Add `OPENCODE_HARNESS` as a built-in provider
- Add `getWorktreeFiles?()` optional method to `HarnessProvider` interface
- Implement `getWorktreeFiles()` on `OPENCODE_HARNESS` to return `opencode.json` with `instructions: [".builder-role.md"]`
- Make `buildRoleInjection()` throw for OpenCode (architect use is unsupported -- see rationale below)
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
  buildRoleInjection: () => {
    throw new Error(
      'OpenCode is only supported as a builder shell, not as an architect shell. ' +
      'OpenCode uses file-based role injection (opencode.json instructions field) ' +
      'which requires an ephemeral worktree. Configure a different shell for ' +
      'the architect (e.g., "claude --dangerously-skip-permissions").',
    );
  },
  buildScriptRoleInjection: () => ({ fragment: '', env: {} }),
  getWorktreeFiles: () => ([{
    relativePath: 'opencode.json',
    content: JSON.stringify({ instructions: ['.builder-role.md'] }, null, 2) + '\n',
  }]),
};
```

**Rationale for throwing in `buildRoleInjection()`**: This method is called only for architect sessions (in `tower-utils.ts:buildArchitectArgs()`). OpenCode has no CLI flag for system prompt injection, and writing `opencode.json` to the main workspace root (non-ephemeral) is unsafe -- it could overwrite user config and persist after the session. Throwing early with a clear error message prevents a silent failure where the architect launches without its role instructions.

Builders use `buildScriptRoleInjection()` (called in `spawn-worktree.ts`), which returns empty fragment/env since role injection happens via `getWorktreeFiles()`.

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
- `OPENCODE_HARNESS.buildRoleInjection()` throws with descriptive error message
- `OPENCODE_HARNESS.buildScriptRoleInjection()` returns `{ fragment: '', env: {} }`
- `OPENCODE_HARNESS.getWorktreeFiles()` returns array with `opencode.json` entry containing valid JSON
- `detectHarnessFromCommand('opencode run')` returns `'opencode'`
- `detectHarnessFromCommand('/usr/local/bin/opencode')` returns `'opencode'`
- `detectHarnessFromCommand('opencode run --model anthropic/claude-sonnet')` returns `'opencode'`
- `resolveHarness('opencode')` returns `OPENCODE_HARNESS`
- Auto-detect from command `'opencode run'` resolves to `OPENCODE_HARNESS`
- Existing harnesses (`CLAUDE_HARNESS`, `CODEX_HARNESS`, `GEMINI_HARNESS`) don't have `getWorktreeFiles` (verify backward compat)

#### Acceptance Criteria
- [ ] `npm run build` succeeds
- [ ] All existing harness tests pass
- [ ] All new OpenCode harness tests pass
- [ ] `resolveHarness()` with no args still defaults to claude

#### Test Plan
- **Unit Tests**: Direct tests of `OPENCODE_HARNESS` methods, auto-detection, resolution
- **Regression**: Run full existing harness test suite

#### Rollback Strategy
Revert the single commit -- no data migrations or external state changes.

#### Risks
- **Risk**: Adding optional method to interface breaks existing custom harnesses
  - **Mitigation**: Method is optional (`?`), so TypeScript won't require existing implementations to add it

---

### Phase 2: Spawn Worktree Integration
**Dependencies**: Phase 1

#### Objectives
- Update `spawn-worktree.ts` to call `getWorktreeFiles()` and write returned files to the worktree, with merge support for existing files
- Verify the generated startup script produces the correct command shape for `opencode run`

#### Deliverables
- [ ] `startBuilderSession()` calls `getWorktreeFiles()` when available
- [ ] `buildWorktreeLaunchScript()` calls `getWorktreeFiles()` when available
- [ ] Generated files merge with existing worktree files (read/merge/write for JSON files)
- [ ] Startup script works with `opencode run` as the base command

#### Implementation Details

**File: `packages/codev/src/agent-farm/commands/spawn-worktree.ts`**

In `startBuilderSession()` (line 570), AFTER the harness is resolved (line 598: `const harness = getBuilderHarness(config.workspaceRoot)`), add the `getWorktreeFiles()` call:

```typescript
// Write any harness-specific worktree files (e.g., opencode.json for OpenCode)
if (harness.getWorktreeFiles) {
  const worktreeFiles = harness.getWorktreeFiles(roleWithPort, roleFile);
  for (const file of worktreeFiles) {
    const targetPath = resolve(worktreePath, file.relativePath);
    // Merge with existing file if it's JSON and already exists
    if (file.relativePath.endsWith('.json') && existsSync(targetPath)) {
      const existing = JSON.parse(readFileSync(targetPath, 'utf-8'));
      const incoming = JSON.parse(file.content);
      // Shallow merge: incoming properties override, arrays are concatenated for 'instructions'
      const merged = { ...existing, ...incoming };
      if (Array.isArray(existing.instructions) && Array.isArray(incoming.instructions)) {
        merged.instructions = [...new Set([...existing.instructions, ...incoming.instructions])];
      }
      writeFileSync(targetPath, JSON.stringify(merged, null, 2) + '\n');
    } else {
      writeFileSync(targetPath, file.content);
    }
  }
}
```

Also apply the same logic in `buildWorktreeLaunchScript()` (line 666), after the harness is resolved (line 679: `const harness = getBuilderHarness(workspaceRoot)`).

**Why merge**: If the repo has a project-level `opencode.json` with `permissions: { "edit": "allow", "bash": "allow" }`, a naive overwrite would destroy those permissions, causing the builder to hang on permission prompts. The merge strategy preserves existing keys while adding/deduplicating the `instructions` array.

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
- [ ] When harness has `getWorktreeFiles()`, files are written/merged in worktree
- [ ] When harness doesn't have `getWorktreeFiles()`, no change in behavior (Claude/Codex/Gemini unaffected)
- [ ] Existing `opencode.json` permissions are preserved after merge

#### Test Plan
- **Unit Tests**: Test merge logic (new file, merge with existing JSON, non-JSON file)
- **Integration**: Verify `buildWorktreeLaunchScript()` with OpenCode harness produces correct script shape
- **Regression**: Existing spawn tests pass unchanged

#### Rollback Strategy
Revert the commit -- spawn-worktree falls back to not calling `getWorktreeFiles()`.

#### Risks
- **Risk**: JSON merge has unexpected behavior for edge-case configs
  - **Mitigation**: Merge is shallow and only special-cases `instructions` array. All other fields use standard object spread.

---

### Phase 3: Doctor Validation and Documentation
**Dependencies**: Phase 1, Phase 2

#### Objectives
- Add `opencode` to `codev doctor`'s `AI_DEPENDENCIES` list
- Add minimal `VERIFY_CONFIGS` entry to avoid misleading "unknown model" skip output
- Add doctor warning if OpenCode is configured as architect shell
- Document OpenCode configuration, permissions, and known differences

#### Deliverables
- [ ] `opencode` entry in `AI_DEPENDENCIES` array in `doctor.ts`
- [ ] `VERIFY_CONFIGS` entry for OpenCode (`opencode --version`, exit 0 = OK)
- [ ] Doctor warning for OpenCode-as-architect misconfiguration
- [ ] Configuration documentation with examples
- [ ] Permission setup documentation
- [ ] Known differences/limitations documentation

#### Implementation Details

**File: `packages/codev/src/commands/doctor.ts`**

1. Add to `AI_DEPENDENCIES` array:
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

2. Add to `VERIFY_CONFIGS`:
```typescript
'OpenCode': {
  command: 'opencode',
  args: ['--version'],
  timeout: 10000,
  successCheck: (r) => r.status === 0,
  authHint: 'Run "opencode --version" to verify installation',
},
```

This ensures `codev doctor` shows `[OK] OpenCode - operational` instead of `[SKIP] OpenCode - unknown model`.

3. Add architect-shell warning: After the AI dependency checks, if OpenCode is installed and configured as the architect shell (via `getResolvedCommands().architect` containing `opencode`), emit a warning that OpenCode is only supported as a builder shell.

**File: Documentation**

Add to `README.md` under a new "Alternative Agent Shells" section:

1. **Configuration example**:
```json
{
  "shell": {
    "builder": "opencode run",
    "architect": "claude --dangerously-skip-permissions"
  }
}
```

2. **Required permissions for unattended execution** (in global `~/.config/opencode/opencode.json` OR project-level `opencode.json`):
```json
{
  "permission": {
    "edit": "allow",
    "bash": "allow"
  }
}
```

3. **Known differences**:
- OpenCode reads `AGENTS.md` for project instructions (already present in Codev repos)
- Must include `run` subcommand in `shell.builder` (plain `opencode` launches TUI)
- No `--dangerously-skip-permissions` -- must configure permissions in `opencode.json`
- Multi-provider: uses whatever LLM backend the user has configured
- **Only supported as builder shell** -- architect sessions require a different shell (e.g., Claude, Codex)

#### Acceptance Criteria
- [ ] `codev doctor` shows OpenCode as `[OK]` when binary exists (not `[SKIP]`)
- [ ] `codev doctor` warns if OpenCode is configured as architect shell
- [ ] Documentation is clear and has working configuration examples
- [ ] `npm run build` succeeds
- [ ] `npm test` passes

#### Test Plan
- **Manual Testing**: Run `codev doctor` and verify OpenCode appears correctly
- **Regression**: Existing doctor tests pass

#### Rollback Strategy
Revert the commit -- doctor falls back to not checking OpenCode.

#### Risks
- **Risk**: OpenCode install method or `--version` flag changes
  - **Mitigation**: Version check is best-effort; binary existence is the primary check

## Dependency Map
```
Phase 1 (Harness) ──→ Phase 2 (Spawn) ──→ Phase 3 (Doctor & Docs)
```

## Integration Points

### Internal Systems
- **harness.ts**: New provider + interface extension (Phase 1)
- **spawn-worktree.ts**: Calls `getWorktreeFiles()` with merge logic (Phase 2)
- **doctor.ts**: New dependency + verification entry (Phase 3)
- **tower-utils.ts**: `buildArchitectArgs()` will throw if OpenCode harness detected for architect (Phase 1, no code change needed -- the throw is in the harness itself)

### External Systems
- **OpenCode CLI**: Must be installed by user; no runtime dependency from Codev

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Optional interface method breaks existing TS consumers | Low | Medium | Method is optional (`?`), fully backward compatible |
| Generated `opencode.json` conflicts with user config | Medium | Medium | JSON merge strategy preserves existing config while adding instructions |
| User configures OpenCode as architect shell | Medium | Low | `buildRoleInjection()` throws clear error; doctor emits warning |
| OpenCode changes `instructions` field behavior | Low | Medium | Pin to documented behavior; custom harness as fallback |

## Validation Checkpoints
1. **After Phase 1**: All harness tests pass, `resolveHarness('opencode')` works, throw on architect use
2. **After Phase 2**: Build succeeds, spawn integration writes/merges files correctly
3. **After Phase 3**: Doctor shows OpenCode correctly, documentation complete

## Documentation Updates Required
- [ ] README section on alternative agent shells
- [ ] OpenCode permission configuration guide
- [ ] Known differences/limitations (including builder-only support)

## Expert Review

### Consultation 1 (2026-04-12)
**Models Consulted**: Gemini, Codex, Claude

**Key Feedback Addressed**:
- **opencode.json overwrite** (all three): Changed from naive overwrite to read/merge/write strategy that preserves existing config (esp. permissions) while adding instructions.
- **Wrong function name** (Codex, Claude): Corrected `buildBuilderStartScript()` to `buildWorktreeLaunchScript()` (actual name at line 666 of spawn-worktree.ts).
- **Architect silent failure** (Gemini): `buildRoleInjection()` now throws with clear error explaining OpenCode is builder-only.
- **Doctor verification output** (Codex, Gemini): Added `VERIFY_CONFIGS` entry so doctor shows `[OK]` not `[SKIP] unknown model`.
- **Doctor architect warning** (Gemini): Added warning if OpenCode configured as architect shell.
- **Snippet placement** (Codex): Clarified that `getWorktreeFiles()` call goes AFTER harness is resolved, not before.
- **More integration tests** (Codex): Added tests for script shape generation and merge behavior.
