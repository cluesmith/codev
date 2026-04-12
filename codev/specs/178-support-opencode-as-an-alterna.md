# Specification: Support OpenCode as an Alternative Agent Shell

## Metadata
- **ID**: spec-2026-04-11-support-opencode
- **Status**: draft
- **Created**: 2026-04-11
- **Issue**: #178

## Problem Statement

Codev's agent farm currently supports Claude Code, Codex, and Gemini CLI as agent shells via the harness abstraction layer. OpenCode (https://github.com/opencode-ai/opencode) is a popular open-source terminal-based AI coding agent with 140,000+ GitHub stars that supports 75+ LLM providers. Users who prefer OpenCode or need alternative LLM backends (local models, OpenRouter, etc.) cannot use it as a drop-in agent shell without manually configuring a custom harness in `.codev/config.json`.

Adding first-class OpenCode support would reduce configuration friction and signal that Codev is genuinely provider-agnostic.

## Current State

The harness system (`packages/codev/src/agent-farm/utils/harness.ts`) already provides a clean abstraction for agent shell integration:

- **Three built-in harnesses**: `claude` (uses `--append-system-prompt`), `codex` (uses `-c model_instructions_file=`), `gemini` (uses `GEMINI_SYSTEM_MD` env var)
- **Auto-detection**: `detectHarnessFromCommand()` matches command basenames against known CLI names
- **Custom harness support**: Users can define arbitrary harnesses in `.codev/config.json` under the `harness` key with `roleArgs`, `roleEnv`, `roleScriptFragment`, `roleScriptEnv`
- **Configuration hierarchy**: CLI overrides > config.json > defaults (all defaulting to `claude`)
- **Doctor validation**: `codev doctor` checks a static `AI_DEPENDENCIES` array for known CLI tools (claude, codex, gemini) regardless of which shell is configured

Users *can* configure OpenCode today via a custom harness, but they must know the exact config format and OpenCode's CLI flags. There's no auto-detection, no built-in harness, and no documentation.

## Desired State

OpenCode works as a first-class agent shell alongside Claude, Codex, and Gemini:

1. Setting `"shell": { "builder": "opencode run" }` in `.codev/config.json` auto-detects the `opencode` harness and injects roles correctly
2. `codev doctor` validates the OpenCode installation (binary existence check)
3. Documentation covers configuration, required `opencode.json` permissions setup, and known differences
4. The existing AGENTS.md file (already present in the repo) provides project instructions to OpenCode automatically
5. The builder role (`.builder-role.md`) is injected via `opencode.json`'s `instructions` field

## Stakeholders
- **Primary Users**: Codev users who prefer OpenCode or alternative LLM providers
- **Secondary Users**: Contributors to Codev who want to test with different agent shells
- **Technical Team**: Codev maintainers
- **Business Owners**: Codev project leads

## Success Criteria
- [ ] `opencode` auto-detected by `detectHarnessFromCommand()` when command basename contains "opencode"
- [ ] Built-in `OPENCODE_HARNESS` provider registers in `BUILTIN_HARNESSES`
- [ ] Role injection works via `opencode.json` `instructions` field referencing `.builder-role.md`
- [ ] `codev doctor` checks for `opencode` binary (added to static `AI_DEPENDENCIES` list, binary existence only -- no auth check since OpenCode is multi-provider)
- [ ] Configuration example in documentation uses correct `shell.builder` format: `{ "shell": { "builder": "opencode run" } }`
- [ ] Documentation covers required `opencode.json` tool permissions for unattended builder execution
- [ ] Known capability differences documented (what works, what doesn't, permission model)
- [ ] All existing tests pass (no regressions)
- [ ] Unit tests cover: new harness provider, auto-detection, and generated startup script shape

## Constraints

### Technical Constraints
- OpenCode uses `AGENTS.md` for project-level instructions (the repo already has one, identical to `CLAUDE.md`)
- OpenCode's non-interactive mode is `opencode run "prompt"` -- users must include `run` in their `shell.builder` config value
- **OpenCode has no `--system-prompt` or `--append-system-prompt` CLI flag** -- role injection must use `opencode.json`'s `instructions` field (confirmed via OpenCode docs)
- **OpenCode has no `--dangerously-skip-permissions` equivalent** -- unattended execution requires pre-configuring tool permissions in `opencode.json`
- The existing auto-restart loop in `.builder-start.sh` must work with OpenCode's CLI

### Interface Impact
- The `HarnessProvider` interface will be extended with one optional method: `getWorktreeFiles?()` -- this returns files to write in the worktree before launch (e.g., `opencode.json` with `instructions: [".builder-role.md"]`). This is backward-compatible: existing harnesses don't implement it, and `spawn-worktree.ts` calls it conditionally.

### Business Constraints
- This is a community-requested feature (#178)
- Should not break any existing Claude/Codex/Gemini workflows

## Assumptions
- OpenCode is installed and available on the user's PATH when configured
- OpenCode supports `opencode run "prompt"` for non-interactive execution (confirmed)
- OpenCode reads `AGENTS.md` from the working directory automatically (confirmed)
- OpenCode's `opencode.json` `instructions` field accepts file paths and merges them with AGENTS.md content (confirmed)
- Users configure `"builder": "opencode run"` (including the `run` subcommand) in `.codev/config.json`

## Solution Design

### Role Injection: `opencode.json` Instructions Field

**Problem**: OpenCode has no CLI flag or env var for injecting additional system prompt content. Unlike Claude (`--append-system-prompt`), Codex (`-c model_instructions_file=`), or Gemini (`GEMINI_SYSTEM_MD` env var), OpenCode reads instructions only from AGENTS.md files and the `instructions` field in `opencode.json`.

**Solution**: Extend the `HarnessProvider` interface with one optional method:

```typescript
/** Optional: files to write in the worktree before launching the agent */
getWorktreeFiles?(roleContent: string, roleFilePath: string): Array<{
  relativePath: string;
  content: string;
}>;
```

The `OPENCODE_HARNESS` implements this method to write a minimal `opencode.json` in the worktree:

```json
{
  "instructions": [".builder-role.md"]
}
```

This causes OpenCode to load:
1. Project instructions from `AGENTS.md` (automatic, always loaded)
2. Builder role from `.builder-role.md` (via `opencode.json` instructions field)

The harness's `buildRoleInjection` and `buildScriptRoleInjection` return empty args/env/fragment since role injection happens via file, not CLI flags.

`spawn-worktree.ts` gains a small change: after writing `.builder-role.md`, check if the harness implements `getWorktreeFiles()` and write any returned files. This is ~5 lines of code.

**Why this approach**:
- Backward-compatible: existing harnesses don't implement `getWorktreeFiles()` and are unaffected
- Clean abstraction: spawn-worktree doesn't need to know about OpenCode specifically
- Follows OpenCode's documented configuration pattern
- The generated `opencode.json` merges with any user-level OpenCode config (instructions arrays are concatenated and deduplicated)

### Configuration

Users configure OpenCode in `.codev/config.json`:

```json
{
  "shell": {
    "builder": "opencode run"
  }
}
```

Key details:
- The `run` subcommand MUST be included because `opencode` without `run` launches the TUI, which hangs in a PTY builder session
- Auto-detection extracts `opencode` from the command basename and resolves to the `OPENCODE_HARNESS`
- The harness returns empty `fragment` and `env`, so the startup script becomes: `opencode run "$(cat '.builder-prompt.txt')"`

### Doctor Validation

Add `opencode` to the static `AI_DEPENDENCIES` array in `doctor.ts`, following the same pattern as `gemini` and `codex`:
- Check binary existence only (`which opencode`)
- No auth/provider verification (OpenCode supports 75+ providers; auth depends on user's chosen provider)
- No config validation (user's OpenCode config is their responsibility)

This is the simple, consistent approach that matches how Gemini and Codex are currently handled.

### Unattended Builder Execution

**Requirement**: Documentation must cover how to configure OpenCode for unattended builder execution.

OpenCode's permission model uses per-tool `allow`/`deny`/`ask` settings in `opencode.json`. Without pre-configuration, OpenCode will prompt for permission on tool use, hanging the builder indefinitely.

Required documentation content:
- Example `opencode.json` with all tools set to `allow` for builder use
- Warning about security implications (similar to Claude's `--dangerously-skip-permissions`)
- Note that the generated `opencode.json` in the worktree only adds `instructions` -- users must configure permissions separately (in their global `~/.config/opencode/opencode.json` or project-level config)

## Open Questions

### Critical (Blocks Progress)
- [x] Does OpenCode support a CLI flag or env var for system prompt injection? **RESOLVED: No.** OpenCode has no `--system-prompt` flag or equivalent env var. Role injection uses `opencode.json`'s `instructions` field referencing `.builder-role.md`.

### Important (Affects Design)
- [x] Should the harness append role content to the worktree's AGENTS.md rather than using a separate mechanism? **RESOLVED: No.** Use `opencode.json` `instructions` field instead. This avoids modifying AGENTS.md (which is a tracked file) and uses OpenCode's documented configuration mechanism.
- [ ] Does `opencode run` support reading the prompt from stdin or only as a CLI argument? This matters for very long prompts that might hit shell argument length limits. Not blocking -- the current approach (command-line arg) works for typical prompt sizes.

### Nice-to-Know (Optimization)
- [ ] Does OpenCode's `acp` (Agent Client Protocol) mode offer better integration than the PTY-based approach? (Future enhancement, not in scope)

## Performance Requirements
- **Startup Time**: OpenCode session should start within the same timeframe as Claude Code sessions (< 10s)
- **Resource Usage**: No additional resource overhead beyond the OpenCode process itself

## Security Considerations
- OpenCode may connect to third-party LLM providers (user's choice) -- this is expected and acceptable
- API keys for providers are managed by the user's OpenCode configuration, not by Codev
- **Unattended execution**: OpenCode has no `--dangerously-skip-permissions` flag. Users MUST pre-configure tool permissions in `opencode.json` to avoid interactive prompts that would hang builder sessions. Documentation must cover this as a setup requirement.
- The generated `opencode.json` in the worktree contains only `instructions` (no permission changes) -- users are responsible for their own permission configuration

## Test Scenarios

### Functional Tests
1. `detectHarnessFromCommand('opencode run')` returns `'opencode'` (first token `opencode`, basename `opencode`)
2. `detectHarnessFromCommand('/usr/local/bin/opencode')` returns `'opencode'`
3. `resolveHarness('opencode')` returns the `OPENCODE_HARNESS` provider
4. `OPENCODE_HARNESS.buildRoleInjection()` returns `{ args: [], env: {} }`
5. `OPENCODE_HARNESS.buildScriptRoleInjection()` returns `{ fragment: '', env: {} }`
6. `OPENCODE_HARNESS.getWorktreeFiles()` returns `[{ relativePath: 'opencode.json', content: '{"instructions":[".builder-role.md"]}' }]`
7. Configuring `{ "shell": { "builder": "opencode run" } }` in config.json resolves correctly via `getResolvedCommands()`
8. Generated `.builder-start.sh` with opencode produces: `opencode run "$(cat '...')"` (no harness fragment between command and prompt)

### Non-Functional Tests
1. Existing Claude/Codex/Gemini harness tests continue to pass (no regressions)
2. `resolveHarness()` with no args still defaults to claude (backward compatibility)
3. Harnesses without `getWorktreeFiles()` method continue to work (optional method, no errors)

## Dependencies
- **External**: OpenCode CLI must be installed by the user
- **Internal**: Depends on the existing harness system (`harness.ts`, `config.ts`, `spawn-worktree.ts`)
- **Libraries**: No new dependencies required

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| OpenCode CLI interface changes break harness | Low | Medium | Pin to known-working behavior; custom harness config as fallback |
| `opencode.json` instructions merge conflicts with user config | Low | Medium | Generated config only contains `instructions` field; OpenCode concatenates instruction arrays |
| Users forget to configure tool permissions, builders hang | High | Medium | Clear documentation with example `opencode.json`; warn during `codev doctor` if opencode is configured but no `opencode.json` exists |
| Users expect full feature parity with Claude Code | Medium | Low | Document known differences clearly |

## Notes

### OpenCode Key Facts (from research)
- **Version**: 1.4.2 (April 2026), very active development
- **Stars**: 140,000+ on GitHub
- **Providers**: 75+ LLM providers including OpenAI, Anthropic, Google, Ollama, LM Studio
- **CLI modes**: `opencode` (TUI), `opencode run "prompt"` (non-interactive), `opencode serve` (API server)
- **Instructions**: Reads `AGENTS.md` from project root automatically; also reads `instructions` from `opencode.json`
- **Tools**: 13 built-in tools (read, edit, write, grep, glob, bash, etc.)
- **Config**: `opencode.json` in project root or `~/.config/opencode/`
- **Permissions**: Per-tool `allow`/`deny`/`ask` in `opencode.json` -- no global skip-permissions flag

### Why This Is Low-Risk

The harness abstraction was designed for this kind of extension. The main complexity is that OpenCode uses file-based config (`opencode.json`) rather than CLI flags for instruction loading, which requires a small backward-compatible interface extension (`getWorktreeFiles?()`). The custom harness mechanism always exists as a fallback if the built-in harness doesn't work for a user's specific setup.

## Expert Consultation

### Consultation 1 (2026-04-11)
**Models Consulted**: Gemini, Codex, Claude

**Key Feedback Addressed**:
- **Role injection mechanism** (all three): Resolved. OpenCode has no `--system-prompt` flag. Solution uses `opencode.json` `instructions` field via new optional `getWorktreeFiles()` method on `HarnessProvider`.
- **Config contradiction** (Gemini, Codex): Fixed. Config requires `"builder": "opencode run"` (with `run` subcommand). Updated all examples and desired state.
- **HarnessProvider interface** (Gemini, Claude): Acknowledged. Dropped the "no interface changes" constraint. Added one optional backward-compatible method (`getWorktreeFiles?()`) to support file-based config injection.
- **Doctor validation** (all three): Specified. Add to static `AI_DEPENDENCIES` list, binary existence check only (no auth verification for multi-provider tool).
- **Unattended execution** (Claude, Codex): Elevated from informational to requirement. Documentation must cover `opencode.json` tool permission configuration.
- **Config format** (Codex): Fixed all examples to use correct nested `shell.builder` format.
- **Test coverage** (Codex): Added test scenario for generated startup script shape and `getWorktreeFiles()` behavior.
