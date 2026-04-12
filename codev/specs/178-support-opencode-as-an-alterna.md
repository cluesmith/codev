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

Users *can* configure OpenCode today via a custom harness, but they must know the exact config format and OpenCode's CLI flags. There's no auto-detection, no built-in harness, and no documentation.

## Desired State

OpenCode works as a first-class agent shell alongside Claude, Codex, and Gemini:

1. Setting `"builder": "opencode"` in `.codev/config.json` just works -- the harness auto-detects and injects roles correctly
2. `codev doctor` validates the OpenCode installation
3. Documentation covers configuration and known differences
4. The existing AGENTS.md file (already present in the repo) provides instructions to OpenCode automatically

## Stakeholders
- **Primary Users**: Codev users who prefer OpenCode or alternative LLM providers
- **Secondary Users**: Contributors to Codev who want to test with different agent shells
- **Technical Team**: Codev maintainers
- **Business Owners**: Codev project leads

## Success Criteria
- [ ] `opencode` auto-detected by `detectHarnessFromCommand()` when command basename contains "opencode"
- [ ] Built-in `OPENCODE_HARNESS` provider correctly injects role content via OpenCode's CLI mechanism
- [ ] `codev doctor` checks for `opencode` binary when configured as architect or builder shell
- [ ] Configuration example documented showing how to switch to OpenCode
- [ ] Known capability differences documented (what works, what doesn't)
- [ ] All existing tests pass (no regressions)
- [ ] Unit tests cover the new harness provider and auto-detection

## Constraints

### Technical Constraints
- OpenCode uses `AGENTS.md` for project-level instructions (the repo already has one, identical to `CLAUDE.md`)
- OpenCode's non-interactive mode is `opencode run "prompt"` -- the startup script must use this subcommand
- OpenCode does not have a direct `--append-system-prompt` equivalent for runtime injection; it reads `AGENTS.md` from the project root automatically
- The harness must work within the existing `HarnessProvider` interface (no interface changes)
- The existing auto-restart loop in `.builder-start.sh` must work with OpenCode's CLI

### Business Constraints
- This is a community-requested feature (#178)
- Should not break any existing Claude/Codex/Gemini workflows

## Assumptions
- OpenCode is installed and available on the user's PATH when configured
- OpenCode supports `opencode run "prompt"` for non-interactive execution (confirmed in research)
- OpenCode reads `AGENTS.md` from the working directory automatically (confirmed)
- The `.builder-role.md` file written by spawn-worktree can be injected via an environment variable or CLI flag that OpenCode supports for additional system instructions

## Solution Approaches

### Approach 1: Built-in Harness with AGENTS.md Reliance (Recommended)

Add `OPENCODE_HARNESS` as a built-in provider. OpenCode automatically reads `AGENTS.md` from the project root for its instructions (the repo already maintains `AGENTS.md` identical to `CLAUDE.md`). The harness injects the builder role via a mechanism that appends it to OpenCode's system context.

**Role injection strategy**: Write the role content to `.builder-role.md` (already done by spawn-worktree) and set an environment variable like `OPENCODE_SYSTEM_PROMPT_FILE` pointing to it, or use a CLI flag if available. If OpenCode supports `--system-prompt` or similar, use that. If not, append the role content to a local `AGENTS.md` copy in the worktree.

**Startup command**: The `.builder-start.sh` script needs to use `opencode run "$(cat .builder-prompt.txt)"` instead of `opencode "$(cat .builder-prompt.txt)"`, since OpenCode requires the `run` subcommand for non-interactive execution.

**Pros**:
- Minimal code changes (add harness + auto-detection, ~30 lines)
- Follows established patterns for claude/codex/gemini
- OpenCode gets project context automatically via AGENTS.md
- No changes to spawn-worktree or session management

**Cons**:
- Role injection mechanism depends on OpenCode's specific CLI flags (needs verification)
- If OpenCode changes its CLI interface, the harness breaks

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Custom Harness Documentation Only

Don't add a built-in harness. Instead, document how to configure OpenCode via the existing custom harness mechanism in `.codev/config.json`.

**Pros**:
- Zero code changes
- Users have full control over the configuration

**Cons**:
- Higher friction for users (must know exact config format)
- No auto-detection
- No `codev doctor` validation
- Doesn't signal first-class support

**Estimated Complexity**: Very Low
**Risk Level**: Very Low

### Approach 3: Startup Script Adaptation

In addition to the built-in harness (Approach 1), modify the startup script generation in `spawn-worktree.ts` to detect OpenCode and use `opencode run` instead of passing the prompt as a bare argument.

**Pros**:
- Handles the `run` subcommand requirement cleanly
- More robust than relying on users to include `run` in their config command

**Cons**:
- Adds shell-specific logic to spawn-worktree (currently shell-agnostic)
- Could be handled by having users set `"builder": "opencode run"` in config

**Estimated Complexity**: Medium
**Risk Level**: Medium

## Recommended Approach

**Approach 1** (Built-in Harness) is recommended. The startup script issue (Approach 3) can be handled by documenting that users should configure `"builder": "opencode run"` to include the `run` subcommand, keeping spawn-worktree shell-agnostic.

## Open Questions

### Critical (Blocks Progress)
- [x] Does OpenCode support a CLI flag or env var for injecting additional system prompt content beyond AGENTS.md? **Research indicates**: OpenCode reads AGENTS.md automatically from the project root. For additional runtime instructions, we need to verify if there's a `--system-prompt` flag or if appending to the worktree's AGENTS.md is the cleanest approach.

### Important (Affects Design)
- [ ] Should the harness append role content to the worktree's AGENTS.md rather than using a separate mechanism? This would be the most natural integration since OpenCode already reads AGENTS.md.
- [ ] Does `opencode run` support reading the prompt from stdin or only as a CLI argument? (Affects how long prompts are passed)

### Nice-to-Know (Optimization)
- [ ] What is the exact set of OpenCode tools available, and do any conflict with porch signal expectations?
- [ ] Does OpenCode's `acp` (Agent Client Protocol) mode offer better integration than the PTY-based approach?

## Performance Requirements
- **Startup Time**: OpenCode session should start within the same timeframe as Claude Code sessions (< 10s)
- **Resource Usage**: No additional resource overhead beyond the OpenCode process itself

## Security Considerations
- OpenCode may connect to third-party LLM providers (user's choice) -- this is expected and acceptable
- API keys for providers are managed by the user's OpenCode configuration, not by Codev
- The `--dangerously-skip-permissions` pattern used with Claude Code has no OpenCode equivalent; OpenCode's permission model is different (configurable per-tool allow/deny/ask)

## Test Scenarios

### Functional Tests
1. `detectHarnessFromCommand('opencode run')` returns `'opencode'`
2. `detectHarnessFromCommand('/usr/local/bin/opencode')` returns `'opencode'`
3. `resolveHarness('opencode')` returns the `OPENCODE_HARNESS` provider
4. `OPENCODE_HARNESS.buildRoleInjection()` returns correct args/env
5. `OPENCODE_HARNESS.buildScriptRoleInjection()` returns correct fragment/env
6. Configuring `"builder": "opencode run"` in config.json resolves correctly via `getResolvedCommands()`

### Non-Functional Tests
1. Existing Claude/Codex/Gemini harness tests continue to pass (no regressions)
2. `resolveHarness()` with no args still defaults to claude (backward compatibility)

## Dependencies
- **External**: OpenCode CLI must be installed by the user
- **Internal**: Depends on the existing harness system (`harness.ts`, `config.ts`)
- **Libraries**: No new dependencies required

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| OpenCode CLI interface changes break harness | Low | Medium | Pin to known-working behavior; custom harness as fallback |
| Role injection doesn't work as expected | Medium | High | Verify during implementation; fall back to AGENTS.md append approach |
| OpenCode lacks features porch expects (signal handling) | Low | Low | Document limitations; porch signals are text-based and shell-agnostic |
| Users expect full feature parity with Claude Code | Medium | Low | Document known differences clearly |

## Notes

### OpenCode Key Facts (from research)
- **Version**: 1.4.2 (April 2026), very active development
- **Stars**: 140,000+ on GitHub
- **Providers**: 75+ LLM providers including OpenAI, Anthropic, Google, Ollama, LM Studio
- **CLI modes**: `opencode` (TUI), `opencode run "prompt"` (non-interactive), `opencode serve` (API server)
- **Instructions**: Reads `AGENTS.md` from project root automatically
- **Tools**: 13 built-in tools (read, edit, write, grep, glob, bash, etc.)
- **Config**: `opencode.json` in project root or `~/.config/opencode/`

### Why This Is Low-Risk

The harness abstraction was designed exactly for this use case. Adding a new built-in harness is a well-trodden path (Claude, Codex, Gemini all follow the same pattern). The main risk is getting the role injection mechanism right for OpenCode's specific CLI, which can be validated during implementation and falls back to the custom harness mechanism if needed.
