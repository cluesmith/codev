# Spec 591: Agent Harness Abstraction

## Problem Statement

When users configure a non-Claude agent harness (e.g., Codex) as their architect or builder shell in `.codev/config.json`, the `afx workspace start` and `afx spawn` commands fail because the codebase hardcodes the Claude-specific `--append-system-prompt` flag in all command construction paths.

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

Five source locations hardcode `--append-system-prompt`:

| File | Lines | Context |
|------|-------|---------|
| `agent-farm/commands/spawn-worktree.ts` | 597 | `startBuilderSession()` — builder launch script with role + prompt |
| `agent-farm/commands/spawn-worktree.ts` | 668 | `buildWorktreeLaunchScript()` — worktree launch script with role (no prompt) |
| `agent-farm/commands/architect.ts` | 29 | `architect()` — architect command args via `spawn()` |
| `agent-farm/servers/tower-utils.ts` | 186 | `buildArchitectArgs()` — Tower architect session args |
| Tests (2 files) | Various | Tests assert presence of `--append-system-prompt` |

Two distinct integration patterns exist:
1. **Bash script generation** (`spawn-worktree.ts`): Generates `.builder-start.sh` scripts with shell expansion `$(cat '<file>')`. Safe for `--append-system-prompt` since bash evaluates the expansion.
2. **Node spawn args** (`architect.ts`, `tower-utils.ts`): Passes args via `child_process.spawn()` or arrays. Currently passes `role.content` directly as string, not via file.

## Verified CLI Mechanisms

Verified via testing on the actual CLIs:

| Operation | Claude CLI | Codex CLI | Gemini CLI |
|-----------|-----------|-----------|------------|
| System prompt injection | `--append-system-prompt "text"` | `-c model_instructions_file="<path>"` (file-based) | `GEMINI_SYSTEM_MD=<path>` env var |
| Initial prompt | positional arg | positional arg or stdin | positional arg or `-p` |
| Auto-approval mode | `--dangerously-skip-permissions` (user-configured) | `--full-auto` or `--dangerously-bypass-approvals-and-sandbox` (user-configured) | `--yolo` (user-configured) |

**Key finding:** Auto-approval flags are NOT hardcoded in source — they come from the user's config command string. Only `--append-system-prompt` is hardcoded.

**Key finding:** Codex's `experimental_instructions_file` is deprecated. The current flag is `model_instructions_file`.

## Proposed Solution: Agent Harness System

Following the pattern established by **forge** (concept commands for repository operations), create an **agent harness** abstraction that encapsulates how different agent CLI tools handle operations like role/system prompt injection.

Just as forge provides built-in providers (`github`, `gitlab`, `gitea`) with configurable concept commands, the harness system provides built-in providers (`claude`, `codex`, `gemini`) with configurable harness operations.

### Harness Provider Definition

Each harness provider defines how to perform two operations:

1. **`role-inject`** — How to inject role/system prompt content when launching via Node's `spawn()` (returns args + env vars)
2. **`role-inject-script`** — How to inject role/system prompt content inside a bash launch script (returns a shell fragment)

Built-in providers are defined as TypeScript objects in `packages/codev/src/agent-farm/utils/harness.ts`:

```typescript
interface HarnessProvider {
  /**
   * For Node spawn() call sites.
   * Returns CLI args and env vars to inject the role.
   * roleContent: the raw role text (for inline injection like Claude).
   * roleFilePath: path to file containing role (for file-based injection like Codex/Gemini).
   */
  buildRoleInjection(roleContent: string, roleFilePath: string): {
    args: string[];
    env: Record<string, string>;
  };

  /**
   * For bash script generation.
   * Returns a shell fragment to append to the base command.
   * roleFilePath: path to the role file.
   * Returns: { fragment: string; envExport: string | null }
   *   fragment: args to append to the command line (e.g., --append-system-prompt "$(cat '...')")
   *   envExport: an export line to prepend to the script, or null
   */
  buildScriptRoleInjection(roleFilePath: string): {
    fragment: string;
    envExport: string | null;
  };
}
```

### Built-in Providers

**`claude`:**
```typescript
{
  buildRoleInjection: (content, filePath) => ({
    args: ['--append-system-prompt', content],
    env: {},
  }),
  buildScriptRoleInjection: (filePath) => ({
    fragment: `--append-system-prompt "$(cat '${filePath}')"`,
    envExport: null,
  }),
}
```

**`codex`:**
```typescript
{
  buildRoleInjection: (content, filePath) => ({
    args: ['-c', `model_instructions_file=${filePath}`],
    env: {},
  }),
  buildScriptRoleInjection: (filePath) => ({
    fragment: `-c model_instructions_file='${filePath}'`,
    envExport: null,
  }),
}
```

**`gemini`:**
```typescript
{
  buildRoleInjection: (content, filePath) => ({
    args: [],
    env: { GEMINI_SYSTEM_MD: filePath },
  }),
  buildScriptRoleInjection: (filePath) => ({
    fragment: '',
    envExport: `export GEMINI_SYSTEM_MD='${filePath}'`,
  }),
}
```

### Harness Resolution

The harness provider is resolved in this order:

1. **Explicit config** (first priority): New optional fields in `.codev/config.json`:
   ```json
   {
     "shell": {
       "architect": "/opt/custom/my-agent --flags",
       "architectHarness": "codex",
       "builder": "codex",
       "builderHarness": "codex"
     }
   }
   ```
   This handles wrappers, custom paths, aliases, and any case where auto-detection fails.

2. **Auto-detection** (fallback): Extract the basename of the first token of the command string and match:
   - Basename contains `claude` → `claude`
   - Basename contains `codex` → `codex`
   - Basename contains `gemini` → `gemini`
   - Otherwise → no harness (warn and skip role injection)

   Examples: `claude --dangerously-skip-permissions` → `claude`, `/opt/homebrew/bin/codex` → `codex`, `my-wrapper` → none.

3. **No match**: Log a warning that role injection is not supported for the configured shell, but do not crash. The agent launches without role content injected.

### Future Extensibility: Custom Harness Providers

While not in scope for this spec, the design supports a future `harness` section in `.codev/config.json` for defining custom harness providers:

```json
{
  "harness": {
    "my-agent": {
      "role-inject-args": ["--system", "${ROLE_FILE}"],
      "role-inject-env": {}
    }
  }
}
```

This mirrors how forge allows custom concept command overrides. The `architectHarness: "my-agent"` config would then route to the custom definition.

### Integration Points

#### 1. `startBuilderSession()` (spawn-worktree.ts:568)
Currently generates bash script with hardcoded `--append-system-prompt "$(cat '${roleFile}')"`.

**Change:** Resolve the harness provider for the builder command. Call `provider.buildScriptRoleInjection(roleFile)`. Insert the returned `fragment` after `${baseCmd}` and prepend `envExport` (if any) before the command line.

Also change "Claude exited" restart message to "Agent exited."

#### 2. `buildWorktreeLaunchScript()` (spawn-worktree.ts:655)
Same pattern as #1.

**Change:** Same approach via `buildScriptRoleInjection()`.

#### 3. `architect()` (architect.ts:29)
Currently: `args.push('--append-system-prompt', role.content)`.

**Change:** Write role to `.architect-role.md` (aligning with `tower-utils.ts`). Resolve harness provider for architect command. Call `provider.buildRoleInjection(role.content, roleFilePath)`. Spread args and merge env into spawn options.

#### 4. `buildArchitectArgs()` (tower-utils.ts:175)
Currently writes role to `.architect-role.md` then appends `'--append-system-prompt', role.content`.

**Change:** Resolve harness provider. Call `provider.buildRoleInjection()`. Return both args and env. The return type changes from `string[]` to `{ args: string[]; env: Record<string, string> }`, and the caller must forward env vars.

#### 5. Tests
Update existing tests. Add parameterized tests for each built-in harness provider.

### Side Fix: Deprecated Codex Flag in `consult`

The `consult` command's `runCodexConsultation()` at `consult/index.ts:383` uses `experimental_instructions_file` which Codex now reports as deprecated. Update to `model_instructions_file`.

## Scope

### In Scope

- Harness provider module (`harness.ts`) with `claude`, `codex`, `gemini` providers
- Harness resolution: explicit config (`architectHarness`/`builderHarness`) → auto-detection → graceful fallback
- Refactor all 5 `--append-system-prompt` locations to use harness providers
- Update `buildArchitectArgs()` return type to include env vars
- Update `architect.ts` to write role to file before calling harness
- Update existing tests, add per-harness tests
- Change "Claude exited" to "Agent exited" in restart messages
- Fix deprecated `experimental_instructions_file` in `consult`

### Out of Scope

- Custom harness definitions in config (future extensibility — the design supports it but we don't implement config parsing for it now)
- Changes to how the `consult` SDK handles Codex — already works correctly
- Full interactive parity for Codex/Gemini as architect shells
- A standalone `harness` CLI command (may be useful later for testing harness configs)

## Success Criteria

### MUST

1. `afx workspace start` does not crash when `architect: "codex"` — role is injected via `model_instructions_file`
2. `afx spawn` does not crash when `builder: "codex"`
3. Existing Claude-based workflows remain unchanged (no regression)
4. All existing tests pass (updated as needed)
5. Harness auto-detection correctly handles full paths, commands with flags, and known CLI names

### SHOULD

6. `afx workspace start` works with `architect: "gemini"` — role injected via `GEMINI_SYSTEM_MD` env var
7. `afx spawn` works with `builder: "gemini"`
8. Unknown harnesses produce a clear warning but do not crash
9. Explicit `architectHarness` / `builderHarness` config overrides auto-detection

### COULD

10. Validate at startup that the configured shell command exists on PATH

## Test Scenarios

1. **Claude harness (regression):** `buildRoleInjection()` returns `--append-system-prompt` with content. `buildScriptRoleInjection()` returns `--append-system-prompt "$(cat '...')"`.
2. **Codex harness:** `buildRoleInjection()` returns `-c model_instructions_file=<path>`. `buildScriptRoleInjection()` returns `-c model_instructions_file='<path>'`.
3. **Gemini harness:** `buildRoleInjection()` returns env `{ GEMINI_SYSTEM_MD: '<path>' }`. Script returns env export line with empty fragment.
4. **Unknown harness:** No role injection, warning logged, agent launches without role.
5. **Harness detection:**
   - `claude` → `claude`
   - `claude --dangerously-skip-permissions` → `claude`
   - `/opt/homebrew/bin/codex` → `codex`
   - `codex exec --full-auto` → `codex`
   - `gemini` → `gemini`
   - `my-custom-agent` → none (warning)
6. **Config override:** `builderHarness: "codex"` returns `codex` provider regardless of command string
7. **No role provided:** All harnesses work correctly when no role is configured
8. **Call-site integration:** Tests verify that `architect()`, `buildArchitectArgs()`, `startBuilderSession()`, and `buildWorktreeLaunchScript()` produce correct commands for each harness

## Consultation Log

### Iteration 1 (3-way review: Claude, Codex, Gemini)

All three reviewers gave **REQUEST_CHANGES**.

**Key feedback incorporated:**
- **Codex `-c experimental_instructions_file` is deprecated** — verified via CLI testing that `model_instructions_file` is the replacement.
- **Gemini `--policy` is wrong** — verified it's for safety policies. Correct mechanism is `GEMINI_SYSTEM_MD` env var (matching `consult` implementation).
- **Array escaping breaks Claude in spawn()** (Gemini reviewer) — `$(cat '...')` in spawn args gets literal-quoted. Split into two methods: `buildRoleInjection()` for Node spawn (passes content directly for Claude) and `buildScriptRoleInjection()` for bash scripts (uses shell expansion).
- **Generic fallback for interactive modes** (all reviewers) — no prompt file to prepend to. Changed to warn-and-skip.
- **Shell detection fragility** (all reviewers) — added explicit `architectHarness`/`builderHarness` config with auto-detection as fallback using basename of first token.
- **`architect.ts` doesn't write role to disk** (Gemini reviewer) — spec requires writing role to `.architect-role.md` before calling harness.
- **`buildArchitectArgs()` return type** (Codex reviewer) — returns `{ args, env }` for Gemini env-var injection.

### User Feedback

- **Extensibility requirement** — must support arbitrary agent harnesses, not just hardcoded tools. Addressed via the harness provider pattern (matching forge's concept-command pattern), explicit harness config, auto-detection, and graceful fallback for unknown harnesses.
- **Terminology** — "shell adapter" → "agent harness" to match established terminology.
- **Forge pattern** — design follows the same provider-based extensibility pattern as forge (built-in providers + config overrides).
