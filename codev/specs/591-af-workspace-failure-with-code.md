# Spec 591: Shell Adapter for Non-Claude CLI Tools

## Problem Statement

When users configure a non-Claude CLI tool (e.g., Codex) as their architect or builder shell in `.codev/config.json`, the `afx workspace start` and `afx spawn` commands fail because the codebase hardcodes the Claude-specific `--append-system-prompt` flag in all shell command construction paths.

**Error reported in issue #591:**
```
error: unexpected argument '--append-system-prompt' found
```

**User's config:**
```json
{
  "shell": {
    "architect": "codex",
    "builder": "codex",
    "shell": "bash"
  }
}
```

The config system (`getResolvedCommands()`) correctly resolves the user's shell choice, but the command construction code unconditionally injects `--append-system-prompt` — a flag that only the Claude CLI supports.

## Current State

Five locations hardcode `--append-system-prompt`:

| File | Lines | Context |
|------|-------|---------|
| `spawn-worktree.ts` | 597 | `startBuilderSession()` — builder launch script with role + prompt |
| `spawn-worktree.ts` | 668 | `buildWorktreeLaunchScript()` — worktree launch script with role |
| `architect.ts` | 29 | `architect()` — architect command args |
| `tower-utils.ts` | 186 | `buildArchitectArgs()` — Tower architect session args |
| Tests (2 files) | Various | Tests assert presence of `--append-system-prompt` |

## CLI Flag Comparison

| Operation | Claude CLI | Codex CLI | Gemini CLI |
|-----------|-----------|-----------|------------|
| Append system prompt | `--append-system-prompt "text"` | Not supported as a flag — uses `experimental_instructions_file` config or file-based approach | Not supported as a flag — uses `--policy` or positional args |
| Pass initial prompt | positional arg | positional arg (or stdin for `exec`) | positional arg or `-p` |
| Non-interactive mode | Not applicable (interactive) | `exec --full-auto` | `-p --prompt` |
| Working directory | implicit (cwd) | `-C <dir>` | implicit (cwd) |

## Proposed Solution

Create a **shell adapter** module that encapsulates how to construct commands and inject role/system prompts for each supported shell type. The adapter detects which shell is configured and returns the appropriate flags.

### Shell Detection

Detect the shell type from the resolved command string:
- Contains `claude` → Claude adapter
- Contains `codex` → Codex adapter  
- Contains `gemini` → Gemini adapter
- Otherwise → Generic adapter (prepend role to prompt, no special flags)

### Role Injection Strategy Per Shell

**Claude:** Use `--append-system-prompt "$(cat '<role-file>')"` (current behavior, preserved as-is).

**Codex:** Write the role content to a file (already done for builders), then pass it via `-c experimental_instructions_file="<path>"`. This matches the approach used in `consult` (`runCodexConsultation()` at `consult/index.ts:383-387`).

**Gemini:** Write the role content to a file, then pass it via `--policy "<path>"`. The policy flag accepts file paths and injects content as system instructions.

**Generic (unknown shell):** Prepend the role content to the prompt file. No special flags are added. This is a best-effort fallback that works for any CLI accepting a text prompt.

### API

```typescript
// packages/codev/src/agent-farm/utils/shell-adapter.ts

export type ShellType = 'claude' | 'codex' | 'gemini' | 'generic';

export function detectShellType(command: string): ShellType;

export function buildRoleArgs(
  shellType: ShellType,
  roleFilePath: string,
): string[];  // Returns CLI args to inject

export function buildLaunchScript(
  shellType: ShellType,
  baseCmd: string,
  worktreePath: string,
  roleFilePath: string | null,
  promptFilePath: string | null,
): string;  // Returns bash script content
```

### Integration Points

Each of the 5 hardcoded locations gets refactored to use the adapter:

1. **`startBuilderSession()`** — Call `buildLaunchScript()` instead of hardcoded template
2. **`buildWorktreeLaunchScript()`** — Call `buildLaunchScript()` instead of hardcoded template
3. **`architect()`** — Call `buildRoleArgs()` instead of hardcoded `args.push()`
4. **`buildArchitectArgs()`** — Call `buildRoleArgs()` instead of hardcoded spread
5. **Tests** — Update to test each shell type via the adapter

## Scope

### In Scope

- Shell adapter module with Claude, Codex, Gemini, and generic support
- Refactor all 5 `--append-system-prompt` hardcoded locations
- Update existing tests
- Add new tests for each shell type

### Out of Scope

- Changes to `consult` command (already handles Codex correctly via SDK)
- Supporting Codex/Gemini as interactive architect shells (they may not support interactive mode identically — this spec only fixes the crash)
- Changes to the config schema (it already supports arbitrary shell commands)
- Adding new config options

## Success Criteria

### MUST

1. `afx workspace start` succeeds when `.codev/config.json` sets `architect: "codex"`
2. `afx spawn` succeeds when builder is configured as `codex`
3. Role/system prompts are correctly passed to Codex via `experimental_instructions_file`
4. Existing Claude-based workflows remain unchanged (no regression)
5. All existing tests pass (updated as needed)

### SHOULD

6. `afx workspace start` succeeds with `architect: "gemini"`
7. `afx spawn` succeeds when builder is configured as `gemini`
8. Unknown shell commands fall back gracefully (role prepended to prompt)

### COULD

9. Validate at startup that the configured shell command exists on PATH
10. Warn users if their configured shell may have limited support

## Test Scenarios

1. **Claude shell (regression):** Builder spawns with `--append-system-prompt` as before
2. **Codex shell:** Builder spawns with `-c experimental_instructions_file=<path>`
3. **Gemini shell:** Builder spawns with `--policy <path>`
4. **Generic shell:** Builder spawns with role prepended to prompt, no special flags
5. **Shell detection:** `detectShellType()` correctly classifies commands like `claude`, `/usr/local/bin/codex`, `codex exec`, `gemini`
6. **No role provided:** All shell types work correctly when no role is configured
