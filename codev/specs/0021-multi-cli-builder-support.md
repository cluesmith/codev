# Specification: Multi-CLI Builder Support

## Metadata
- **ID**: 0021-multi-cli-builder-support
- **Protocol**: SPIR
- **Status**: specified
- **Created**: 2025-12-03
- **Priority**: high

## Problem Statement

Currently, all builders use Claude Code as the underlying CLI. This creates several limitations:

1. **Model lock-in**: Can't leverage other models (Gemini, GPT) for specific tasks
2. **Cost optimization**: Can't use cheaper models for simpler tasks
3. **Capability matching**: Different models excel at different tasks (Gemini for research, GPT for certain coding patterns)
4. **Resilience**: If Claude is down, all builders are blocked
5. **Experimentation**: Can't easily compare model performance on the same task

The Architect should be able to spawn builders using different AI CLI tools.

## Current State

```bash
# Only Claude Code is supported
af spawn --project 0009

# config.json only has one builder command
{
  "shell": {
    "builder": "claude"
  }
}
```

The spawn command hardcodes Claude-specific flags:
- `-p` for prompt
- `--append-system-prompt` for role injection

## Desired State

```bash
# Spawn with different CLIs
af spawn --project 0009                    # Default (Claude)
af spawn --project 0009 --cli claude       # Explicit Claude
af spawn --project 0009 --cli gemini       # Gemini CLI
af spawn --project 0009 --cli codex        # Codex CLI

# With 0014 task mode
af spawn "Fix the bug" --cli gemini

# Override default in config.json
{
  "shell": {
    "builder": {
      "default": "claude",
      "claude": "claude",
      "gemini": "gemini-cli",
      "codex": "codex"
    }
  }
}
```

## Stakeholders
- **Primary Users**: Architects wanting model flexibility
- **Secondary Users**: Cost-conscious users, multi-model experimenters
- **Technical Team**: Codev maintainers
- **Business Owners**: Project owner (Waleed)

## Success Criteria

- [ ] `af spawn --cli gemini` spawns a builder using Gemini CLI
- [ ] `af spawn --cli codex` spawns a builder using Codex CLI
- [ ] Default CLI is configurable in config.json
- [ ] Role/prompt injection works correctly for each CLI
- [ ] Builder state tracks which CLI was used
- [ ] Dashboard displays CLI type for each builder
- [ ] Error handling for unsupported/unavailable CLIs
- [ ] Documentation for CLI-specific configuration

## Constraints

### Critical Constraint: Agentic Capability

**This is the most important constraint, identified during expert consultation:**

A "Builder" requires an **agentic CLI** with:
1. **Tool loop**: Ability to iteratively plan, execute, and observe
2. **File system access**: Read and write files in the worktree
3. **Command execution**: Run shell commands (git, tests, builds)

Many CLIs are **text-in/text-out** only (e.g., basic OpenAI CLI, raw Gemini wrappers). These CANNOT function as Builders because they cannot actually modify code.

**Agentic CLIs we can support:**
| CLI | Agentic? | Notes |
|-----|----------|-------|
| Claude Code (`claude`) | Yes | Full tool loop, file I/O, shell execution |
| Gemini CLI (`gemini`) | Partial | Has `--yolo` sandbox mode; needs verification |
| Codex CLI (`codex`) | Partial | Agents SDK mode may support tools |
| Aider | Yes | Supports multiple backends (GPT, Claude, Gemini) |
| Continue | Yes | IDE-integrated, has execution capabilities |

**Non-agentic CLIs (cannot be Builders without wrapper):**
- Basic OpenAI CLI (text completion only)
- Raw gcloud Vertex AI CLI (API wrapper only)
- Simple chat wrappers

### Technical Constraints
- Each CLI has different flag conventions
- Some CLIs may not support system prompt injection
- CLIs have different installation methods and availability
- Must work with existing worktree and tmux infrastructure
- **CLIs must support autonomous execution** (not just text completion)

### Business Constraints
- Should not break existing Claude-only workflows
- Users should only need to install CLIs they want to use
- Non-agentic CLIs should fail with helpful error, not silently break

## Assumptions

- Users have installed the CLIs they want to use
- Each CLI supports some form of prompt/instruction input
- Each CLI supports some form of role/system prompt injection
- CLIs run in terminal sessions similar to Claude Code

## CLI Comparison

**Note**: Flag information needs verification against actual CLI versions. These are best-effort approximations.

| Feature | Claude Code | Gemini CLI | Codex CLI | Aider |
|---------|-------------|------------|-----------|-------|
| **Command** | `claude` | `gemini` | `codex` | `aider` |
| **Subcommand** | (none) | `chat` | `agents run` | (none) |
| **Prompt flag** | `-p "text"` | `--input "text"` | `--input "text"` | `--message "text"` |
| **System prompt** | `--append-system-prompt` | `--system` | `CODEX_SYSTEM_PROMPT` env | `--system-prompt-file` |
| **Non-interactive** | (default) | `--quiet` or piped stdin | `--input` mode | `--yes` |
| **Model selection** | `--model sonnet` | `--model gemini-3-pro-preview` | `--model gpt-5` | `--model gpt-4` |
| **Agentic?** | Yes (full) | Partial (needs verification) | Partial (Agents SDK) | Yes (full) |
| **File editing** | Built-in | Unknown | Agents SDK only | Built-in |
| **Shell execution** | Built-in | Unknown | Agents SDK only | Built-in |

## Solution Approaches

### Approach 1: CLI Adapter Pattern (Recommended)

**Description**: Define an adapter interface that each CLI implements, handling flag translation and capability detection.

```typescript
interface CLIAdapter {
  name: string;
  command: string;
  buildArgs(options: BuilderOptions): string[];
  supportsSystemPrompt: boolean;
  supportsModel: boolean;
}

const adapters: Record<string, CLIAdapter> = {
  claude: new ClaudeAdapter(),
  gemini: new GeminiAdapter(),
  codex: new CodexAdapter(),
};
```

**Pros**:
- Clean separation of CLI-specific logic
- Easy to add new CLIs
- Testable in isolation
- Clear capability detection

**Cons**:
- More code to maintain
- Each new CLI requires an adapter

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 2: Configuration-Based Flags

**Description**: Store flag mappings in config.json, no code changes per CLI.

```json
{
  "clis": {
    "claude": {
      "command": "claude",
      "promptFlag": "-p",
      "systemPromptFlag": "--append-system-prompt"
    },
    "gemini": {
      "command": "gemini",
      "promptFlag": "",
      "systemPromptFlag": "--system-instructions",
      "extraFlags": ["--yolo"]
    }
  }
}
```

**Pros**:
- Users can customize without code changes
- Easy to add new CLIs
- Flexible

**Cons**:
- Complex config format
- Hard to validate
- Can't handle complex logic (e.g., env vars for Codex)

**Estimated Complexity**: Low (initial), High (edge cases)
**Risk Level**: Medium

### Recommended Approach

**Approach 1** (CLI Adapter Pattern) is recommended. It provides clean abstractions, handles CLI-specific quirks well, and is easier to maintain and test.

## Technical Design

### CLI Adapter Interface

```typescript
interface CLIAdapter {
  /** Adapter identifier */
  name: string;

  /** Base command (e.g., "claude", "gemini") */
  command: string;

  /** Subcommand if required (e.g., "chat", "agents run") */
  subcommand?: string;

  /** Check if CLI binary is available on the system */
  isAvailable(): Promise<boolean>;

  /** Check if CLI is authenticated (API key, login, etc.) */
  isAuthenticated(): Promise<boolean>;

  /** Validate that CLI has required agentic capabilities */
  validateCapabilities(): Promise<{ valid: boolean; missing: string[] }>;

  /** Build command and arguments for spawning (returns structured, not string) */
  buildSpawnCommand(options: {
    prompt?: string;
    role?: string;
    model?: string;
  }): { cmd: string; args: string[] };

  /** Get environment variables to set */
  getEnv(options: { role?: string }): Record<string, string>;

  /** Features supported by this CLI */
  capabilities: {
    systemPrompt: boolean;
    modelSelection: boolean;
    nonInteractive: boolean;
    fileEditing: boolean;      // Can edit files autonomously
    shellExecution: boolean;   // Can run shell commands
    toolLoop: boolean;         // Has iterative planning loop
  };

  /** Max context window size (for warning on large prompts) */
  maxContextTokens?: number;
}
```

### Claude Adapter

```typescript
class ClaudeAdapter implements CLIAdapter {
  name = 'claude';
  command = 'claude';

  capabilities = {
    systemPrompt: true,
    modelSelection: true,
    nonInteractive: false, // Claude is interactive by default
  };

  async isAvailable(): Promise<boolean> {
    return commandExists('claude');
  }

  buildSpawnArgs(options: { prompt?: string; role?: string; model?: string }): string[] {
    const args: string[] = [];

    if (options.model) {
      args.push('--model', options.model);
    }

    if (options.role) {
      args.push('--append-system-prompt', options.role);
    }

    if (options.prompt) {
      args.push('-p', options.prompt);
    }

    return args;
  }

  getEnv(): Record<string, string> {
    return {};
  }
}
```

### Gemini Adapter

```typescript
class GeminiAdapter implements CLIAdapter {
  name = 'gemini';
  command = 'gemini';

  capabilities = {
    systemPrompt: true,
    modelSelection: true,
    nonInteractive: true,
  };

  async isAvailable(): Promise<boolean> {
    return commandExists('gemini');
  }

  buildSpawnArgs(options: { prompt?: string; role?: string; model?: string }): string[] {
    const args: string[] = ['--yolo']; // Non-interactive mode

    if (options.model) {
      args.push('--model', options.model);
    }

    if (options.role) {
      args.push('--system-instructions', options.role);
    }

    if (options.prompt) {
      args.push(options.prompt); // Positional argument
    }

    return args;
  }

  getEnv(): Record<string, string> {
    return {};
  }
}
```

### Codex Adapter

```typescript
class CodexAdapter implements CLIAdapter {
  name = 'codex';
  command = 'codex';

  capabilities = {
    systemPrompt: true, // Via env var
    modelSelection: true,
    nonInteractive: true,
  };

  async isAvailable(): Promise<boolean> {
    return commandExists('codex');
  }

  buildSpawnArgs(options: { prompt?: string; model?: string }): string[] {
    const args: string[] = [];

    if (options.model) {
      args.push('--model', options.model);
    }

    if (options.prompt) {
      args.push(options.prompt); // Positional argument
    }

    return args;
  }

  getEnv(options: { role?: string }): Record<string, string> {
    const env: Record<string, string> = {};

    if (options.role) {
      env['CODEX_SYSTEM_PROMPT'] = options.role;
    }

    return env;
  }
}
```

### Spawn Integration

```typescript
// In spawn.ts
async function spawn(options: SpawnOptions): Promise<void> {
  const cliName = options.cli || config.defaultCli || 'claude';
  const adapter = getAdapter(cliName);

  if (!adapter) {
    fatal(`Unknown CLI: ${cliName}. Available: ${Object.keys(adapters).join(', ')}`);
  }

  if (!(await adapter.isAvailable())) {
    fatal(`CLI not found: ${adapter.command}. Please install it first.`);
  }

  // Build command
  const args = adapter.buildSpawnArgs({
    prompt: initialPrompt,
    role: roleContent,
    model: options.model,
  });

  const env = adapter.getEnv({ role: roleContent });

  // Create start script with CLI-specific command
  const command = [adapter.command, ...args].join(' ');
  const scriptContent = buildStartScript(command, env);

  // ... rest of spawn logic unchanged
}
```

### Builder State Extension

```typescript
interface Builder {
  // ... existing fields
  cli: string;          // Which CLI is being used (claude, gemini, codex)
  model?: string;       // Model override if specified
}
```

### Config Extension

```typescript
interface UserConfig {
  shell?: {
    architect?: string;
    builder?: string | {
      default: string;
      claude?: string;
      gemini?: string;
      codex?: string;
    };
    shell?: string;
  };
}
```

## Open Questions

### Critical (Blocks Progress)
- [ ] What are the exact flag formats for Gemini CLI? (Need to verify against actual CLI)
- [ ] What are the exact flag formats for Codex CLI? (Need to verify - may need Agents SDK mode)
- [x] Are target CLIs agentic enough? **Decision: Add capability validation; reject non-agentic CLIs with clear error**

### Important (Affects Design)
- [x] Should we support custom/unknown CLIs via config? **Decision: No for MVP; expose adapter interface for contributions**
- [ ] How to handle CLIs that don't support system prompts? (Fallback to prompt injection)
- [ ] Should model selection be part of this spec or separate? (Include basic support)
- [ ] Should we add Aider as a fourth supported CLI? (Strong candidate - fully agentic)

### Nice-to-Know (Optimization)
- [ ] Should there be a "best CLI for task" recommendation feature? (Deferred)
- [ ] Should we track CLI performance metrics? (Deferred)
- [ ] Should we build bridge scripts for non-agentic CLIs? (Deferred - complex)

## Performance Requirements
- **CLI detection**: < 100ms
- **Spawn time**: Same as current (< 5s)

## Security Considerations
- CLI commands come from trusted config, not user input
- Environment variables may contain sensitive data (API keys)
- Adapter implementations should sanitize arguments

## Test Scenarios

### Functional Tests
1. `af spawn -p 0009` - Default CLI (Claude) works
2. `af spawn -p 0009 --cli claude` - Explicit Claude works
3. `af spawn -p 0009 --cli gemini` - Gemini spawns with correct flags
4. `af spawn -p 0009 --cli codex` - Codex spawns with correct env vars
5. `af spawn -p 0009 --cli unknown` - Unknown CLI returns helpful error
6. Missing CLI binary returns helpful installation instructions
7. Builder state correctly tracks CLI type
8. Dashboard shows CLI type for each builder

### Non-Functional Tests
1. CLI availability check completes in < 100ms
2. Adding a new adapter requires < 50 lines of code

## Dependencies
- **Internal Systems**: Spawn infrastructure (0014), Builder state
- **External**: Claude Code, Gemini CLI, Codex CLI (optional)

## References
- `codev/resources/conceptual-model.md` - Platform portability section
- `agent-farm/src/commands/spawn.ts` - Current spawn implementation
- `codev/specs/0014-flexible-builder-spawning.md` - Related flexible spawning

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| CLI flag changes break adapter | Medium | High | Version-specific adapters, test against multiple versions |
| User doesn't have CLI installed | High | Low | Clear error message with install instructions |
| System prompt not supported | Medium | Medium | Graceful degradation, warn user |
| Different output formats confuse dashboard | Low | Medium | Normalize builder state regardless of CLI |
| **CLI is not agentic (critical)** | High | Critical | Add capability validation; reject non-agentic CLIs |
| Authentication state unknown | Medium | High | Add `isAuthenticated()` check before spawn |
| Context window exceeded | Medium | Medium | Track `maxContextTokens`, warn on large prompts |
| CLI version drift | High | Medium | Document tested versions, add version detection |
| Mixed-model concurrency exhausts resources | Low | Medium | Document limits, consider spawn guardrails |
| API quota exhaustion across CLIs | Medium | Medium | Document quota implications per provider |

## Expert Consultation
**Date**: 2025-12-03
**Models Consulted**: GPT-5 Codex, Gemini 3 Pro
**Sections Updated**:
- **Constraints**: Added critical "Agentic Capability" section per Gemini - most CLIs are NOT agentic enough for Builder role
- **CLI Comparison**: Updated flags per GPT-5 corrections (`--system` not `--system-instructions`, subcommands required)
- **Adapter Interface**: Added `isAuthenticated()`, `validateCapabilities()`, `maxContextTokens`, structured command return per both models
- **Capabilities**: Added `fileEditing`, `shellExecution`, `toolLoop` capability flags
- **Risks**: Added 6 new risks (agentic gap, auth state, context window, version drift, concurrency, quotas)
- **Open Questions**: Resolved custom CLI support question (no for MVP)

**Critical Insight from Gemini Pro**: Many "CLIs" (basic OpenAI, raw Gemini wrappers) are text-in/text-out only and CANNOT function as Builders. The spec must validate agentic capabilities before allowing spawn. This is the most important constraint.

**Recommendation from both models**: Consider adding Aider as a supported CLI - it's fully agentic and supports multiple backends.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Expert AI Consultation Complete

## Notes
This spec enables the "Platform Portability" vision described in the conceptual model. It's a stepping stone toward full multi-platform support where not just builders, but the entire Codev framework can run on different AI platforms.

The adapter pattern allows us to start with the three major CLIs (Claude, Gemini, Codex) and easily add others (e.g., local LLMs via llama.cpp, Ollama) in the future.
