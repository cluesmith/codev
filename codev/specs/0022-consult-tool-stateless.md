# Specification: Consult Tool (Stateless)

## Metadata
- **ID**: 0022-consult-tool-stateless
- **Protocol**: SPIR
- **Status**: specified
- **Created**: 2025-12-04
- **Priority**: high

## Problem Statement

Currently, multi-agent consultation uses the zen MCP server, which has several drawbacks:

1. **Context overhead**: MCP tools add significant token overhead to every conversation
2. **Indirect access**: API calls through MCP when gemini-cli and codex can access files directly
3. **Complexity**: Running a separate MCP server process adds operational overhead
4. **Capability gap**: gemini-cli and codex have richer capabilities than their APIs (session management, file access, context handling)

The SPIR protocol requires multi-agent consultation at key checkpoints. A simpler, more capable approach would improve this workflow.

## Current State

```bash
# Consultation via MCP server (zen)
mcp__zen__chat(
  prompt="Review this design",
  model="gemini-3-pro-preview",
  ...
)

# MCP tools in context (from /context):
# - mcp__zen__chat: 1.1k tokens
# - mcp__zen__thinkdeep: 1.5k tokens
# - mcp__zen__listmodels: 570 tokens
# - mcp__zen__version: 564 tokens
# Total: ~3.7k tokens of context overhead
```

The MCP server wraps API calls and manages continuation IDs for stateful conversations.

## Desired State

```bash
# CLI usage (human or Claude via Bash)
consult gemini "Review this design approach"
consult codex "What do you think of this API?"

# Model aliases
consult pro "Review this"     # gemini-3-pro-preview
consult codex "Review this"   # gpt-5-codex

# Stdin piping
echo "What does this code do?" | consult pro
```

The consultant role is injected automatically. Each invocation is a fresh process (stateless).

**Autonomous mode**: Both CLIs run in autonomous mode (`--yolo` for gemini, `--full-auto` for codex) to minimize permission prompts during consultation.

**No `--files` flag**: CLIs access the filesystem directly - no need to explicitly pass files.

## Stakeholders
- **Primary Users**: Architect agents using multi-agent consultation
- **Secondary Users**: Developers wanting quick second opinions
- **Technical Team**: Codev maintainers
- **Business Owners**: Project owner (Waleed)

## Success Criteria

- [ ] `consult gemini "query"` invokes gemini-cli with `--yolo` and consultant role
- [ ] `consult codex "query"` invokes codex CLI with `--full-auto` and consultant role
- [ ] Consultant role defined in `codev/roles/consultant.md`
- [ ] Output displayed to stdout (passthrough from underlying CLI)
- [ ] Exit codes propagated correctly
- [ ] Errors normalized to consistent format
- [ ] Basic observability: queries logged to `.consult/history.log`
- [ ] zen MCP server can be removed from configuration after adoption
- [ ] Documentation updated (CLAUDE.md, roles/, etc.)

## Constraints

### Technical Constraints
- Must work with existing gemini-cli and codex installations
- Cannot modify the underlying CLIs
- Must handle different flag conventions between CLIs
- Stateless only (0023 adds statefulness)

### Design Constraints
- Consultant role is collaborative, not adversarial (per user direction)
- CLIs handle their own context management (no token limiting needed)
- Unified interface abstracts CLI differences

### Business Constraints
- Should not break existing MCP-based workflows during transition
- Users must have gemini-cli or codex installed to use those backends

## Assumptions

- gemini-cli is installed and authenticated (`gemini` command available)
- codex CLI is installed and authenticated (`codex` command available)
- Both CLIs can read files when given paths
- Both CLIs accept some form of system prompt injection
- Both CLIs output to stdout

## Consultant Role

The consultant is a **collaborative partner**, not an adversarial reviewer.

### Role Definition (`codev/roles/consultant.md`)

```markdown
# Role: Consultant

You are a consultant providing a second perspective to support decision-making.

## Responsibilities

1. **Understand context** - Grasp the problem and constraints being presented
2. **Offer insights** - Provide alternatives or considerations that may have been missed
3. **Be constructive** - Help improve the solution, don't just critique
4. **Be direct** - Give honest, clear feedback without excessive hedging
5. **Collaborate** - Work toward the best outcome alongside the primary agent

## You Are NOT

- An adversary or gatekeeper
- A rubber stamp that just agrees
- A code generator (unless specifically asked for snippets)

## Relationship to Other Roles

| Role | Focus |
|------|-------|
| Architect | Orchestrates, decomposes, integrates |
| Builder | Implements in isolation |
| Consultant | Provides perspective, supports decisions |

You think alongside the other agents, helping them see blind spots.
```

## Solution Approaches

### Approach 1: Python with Typer (Recommended)

**Description**: A standalone Python CLI using Typer for argument parsing and subprocess for CLI invocation.

```python
#!/usr/bin/env python3
"""Consult tool - wrapper for gemini-cli and codex CLI."""

import os
import shutil
import subprocess
import sys
from pathlib import Path
from datetime import datetime
import typer

app = typer.Typer()

ROLE_FILE = Path("codev/roles/consultant.md")
LOG_DIR = Path(".consult")

def get_role() -> str:
    """Read the consultant role definition."""
    if not ROLE_FILE.exists():
        typer.echo(f"Error: Role file not found: {ROLE_FILE}", err=True)
        raise typer.Exit(1)
    return ROLE_FILE.read_text()

def log_query(model: str, query: str) -> None:
    """Log consultation to .consult/history.log."""
    LOG_DIR.mkdir(exist_ok=True)
    log_file = LOG_DIR / "history.log"
    timestamp = datetime.now().isoformat()
    with open(log_file, "a") as f:
        f.write(f"{timestamp} model={model} query={query[:100]}\n")

@app.command()
def consult(
    model: str = typer.Argument(..., help="Model: gemini, codex (or aliases: pro, gpt)"),
    query: str = typer.Argument(None, help="Query (or pipe via stdin)"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Print command without executing"),
):
    """Consult an external model for a second opinion."""
    # Handle stdin
    if query is None:
        if not sys.stdin.isatty():
            query = sys.stdin.read().strip()
            if not query:
                typer.echo("Error: Empty input from stdin", err=True)
                raise typer.Exit(1)
        else:
            typer.echo("Error: No query provided", err=True)
            raise typer.Exit(1)

    role = get_role()

    # Resolve model aliases
    model_map = {"pro": "gemini", "gpt": "codex"}
    resolved = model_map.get(model, model)

    # Build command with autonomous mode flags
    if resolved == "gemini":
        if not shutil.which("gemini"):
            typer.echo("Error: gemini-cli not found. Install: https://github.com/google-gemini/gemini-cli", err=True)
            raise typer.Exit(1)
        cmd = ["gemini", "--yolo", "--system-instructions", role, query]
        env = None
    elif resolved == "codex":
        if not shutil.which("codex"):
            typer.echo("Error: codex not found. Install: npm install -g @openai/codex", err=True)
            raise typer.Exit(1)
        cmd = ["codex", "--full-auto", query]
        env = {"CODEX_SYSTEM_PROMPT": role}
    else:
        typer.echo(f"Unknown model: {model}. Available: gemini, codex, pro, gpt", err=True)
        raise typer.Exit(1)

    if dry_run:
        typer.echo(f"Command: {cmd}")
        if env:
            typer.echo(f"Env: {env}")
        raise typer.Exit(0)

    log_query(resolved, query)

    # Execute with passthrough stdio, handle Ctrl+C gracefully
    full_env = {**os.environ, **(env or {})}
    try:
        result = subprocess.run(cmd, env=full_env)
        raise typer.Exit(result.returncode)
    except KeyboardInterrupt:
        typer.echo("\nInterrupted", err=True)
        raise typer.Exit(130)

if __name__ == "__main__":
    app()
```

**Pros**:
- No build step required
- Typer handles CLI parsing elegantly (auto-generated help, type conversion)
- `subprocess.run([...])` bypasses shell entirely - eliminates escaping issues
- Good string handling, stdin support is straightforward
- User preference for Typer (per CLAUDE.md)

**Cons**:
- Different language from agent-farm (TypeScript)
- Requires Python 3.x installed

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: TypeScript CLI Command

**Description**: Add `consult` as a command in the agent-farm TypeScript CLI.

**Pros**:
- Consistent with agent-farm architecture
- Type safety
- Single npm install for all tools

**Cons**:
- Requires build step
- Heavier for a simple wrapper
- Near-zero code reuse with agent-farm

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 3: Bash Script (Not Recommended)

**Description**: Shell script wrapper.

**Cons**:
- Shell escaping issues (learned from agent-farm v1)
- Fragile flag parsing
- Limited error handling

**Not recommended** due to past difficulties with shell escaping in agent-farm.

### Recommended Approach

**Approach 1** (Python with Typer). It provides the right balance of simplicity and robustness:
- No build step like Bash
- Proper argument handling unlike Bash
- Simpler than TypeScript for this use case
- Expert consultation (Gemini Pro, GPT-5 Codex) both recommended this approach

## Technical Design

### CLI Interface

```bash
consult <model> [query] [options]

Arguments:
  model       Target model: gemini, codex (or aliases: pro, gpt)
  query       The consultation query (can also be piped via stdin)

Options:
  --files     File paths for the CLI to read (space-separated)
  --help      Show help

Examples:
  consult gemini "Review this architecture"
  consult codex "What's wrong with this code?" --files src/auth.ts
  echo "Review this" | consult pro
```

### Model Aliases

| Alias | Resolved To | CLI Command |
|-------|-------------|-------------|
| `gemini` | gemini-3-pro-preview | `gemini` |
| `pro` | gemini-3-pro-preview | `gemini` |
| `codex` | gpt-5-codex | `codex` |
| `gpt` | gpt-5-codex | `codex` |

### CLI Flag Mapping

| Feature | gemini-cli | codex CLI |
|---------|------------|-----------|
| System prompt | `--system-instructions "text"` | `CODEX_SYSTEM_PROMPT` env var |
| Query | Positional argument | Positional argument |
| Files | Passed as additional args | Passed as additional args |
| Non-interactive | Default behavior | Default behavior |

### File Structure

```
codev/
├── bin/
│   └── consult           # Python CLI (executable via shebang)
├── roles/
│   ├── architect.md      # Existing
│   ├── builder.md        # Existing
│   └── consultant.md     # NEW: Consultant role definition
├── requirements.txt      # Add typer dependency (or use pyproject.toml)
```

### Dependencies

```
# codev/requirements.txt (or add to existing)
typer>=0.9.0
```

### Observability

Log each consultation to `.consult/history.log` (in current directory):

```
2025-12-04T10:30:00Z model=gemini files=src/api.ts query=Review this design...
```

### Error Handling

| Error | Message |
|-------|---------|
| Unknown model | `Unknown model: foo. Available: gemini, codex` |
| CLI not found | `gemini not found. Install: https://...` |
| CLI auth failed | Passthrough CLI error message |
| Empty query | `Usage: consult <model> <query>` |

## Open Questions

### Critical (Blocks Progress)
- [x] What are exact gemini-cli flags for system prompt? **Answer: `--system-instructions` per search results**
- [x] How does codex accept system prompts? **Answer: `CODEX_SYSTEM_PROMPT` env var**

### Important (Affects Design)
- [x] Should we support stdin for piping queries? **Yes**
- [x] Should `--files` use glob patterns? **No, keep simple for now**
- [x] Where should history log live? **`.consult/` in current directory**

### Nice-to-Know (Optimization)
- [ ] Should we add timing to output? (Deferred)
- [ ] Should we support `--json` output mode? (Deferred to 0023)

## Performance Requirements
- **Startup overhead**: < 100ms before invoking underlying CLI
- **No timeout**: Let underlying CLIs handle their own timeouts

## Security Considerations
- File paths passed to `--files` should be validated (exist, readable)
- Query content is passed to external CLIs (user responsibility)
- History log may contain sensitive queries (local file only, consider `.gitignore`)
- Using `subprocess.run([...])` with list args bypasses shell - no injection risk

## Test Scenarios

### Functional Tests
1. `consult gemini "test"` - Invokes gemini-cli with consultant role
2. `consult codex "test"` - Invokes codex with consultant role and env var
3. `consult pro "test"` - Alias resolves to gemini
4. `consult gpt "test"` - Alias resolves to codex
5. `consult gemini "test" --files foo.ts` - Files passed to CLI
6. `consult unknown "test"` - Error message with available models
7. Missing CLI binary - Error with install instructions
8. Empty query - Usage message
9. Piped input: `echo "test" | consult gemini` - Works
10. History log written after each consultation

### Integration Tests
1. Full consultation round-trip with gemini-cli
2. Full consultation round-trip with codex
3. Consultant role visible in CLI behavior (collaborative tone)

## Dependencies
- **External**: gemini-cli, codex CLI (user-installed)
- **Internal**: `codev/roles/` directory structure

## References
- [Gemini CLI Session Management](https://geminicli.com/docs/cli/session-management/)
- [Codex CLI Reference](https://developers.openai.com/codex/cli/reference/)
- `codev/roles/architect.md` - Example role definition
- `codev/roles/builder.md` - Example role definition

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| CLI flag changes break wrapper | Medium | High | Document tested versions, pin in README |
| User doesn't have CLI installed | High | Low | Clear error with install link |
| System prompt format differs | Medium | Medium | Test with actual CLIs before release |
| Python/Typer not installed | Medium | Low | Document in prerequisites, provide install instructions |
| Different output formats | Low | Low | Passthrough only, no parsing |

## Expert Consultation

**Date**: 2025-12-04
**Models Consulted**: GPT-5 Codex, Gemini 3 Pro

### Key Feedback

**From Gemini Pro**:
- CLI wrapper approach is superior for this use case (removes "middleman tax")
- Go stateless for Phase 1 (atomic consults don't need history)
- Risk: Shell injection - ensure proper escaping
- Consultant role should differentiate from Builder

**From GPT-5 Codex**:
- Worth rebuilding MCP's hidden features (observability, error normalization)
- Hybrid statefulness recommended (default stateless, opt-in sessions) - deferred to 0023
- Risk: Capability drift as CLIs update silently
- Store role in repo, version with codebase

**User Corrections**:
- Consultant is NOT antithesis of Builder - it's a collaborative partner
- Context management handled by CLIs (no need for token limiting)
- zen MCP already has continuation IDs (pattern exists for 0023)

### Sections Updated Based on Consultation
- Consultant role rewritten as collaborative partner
- Removed token estimator/context management (CLIs handle it)
- Simplified wrapper approach (CLIs do heavy lifting)
- Added observability via history log

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [x] Expert AI Consultation Complete

## Notes

This is Phase 1 of the consult tool. Phase 2 (0023) will add stateful sessions via stdio communication with persistent CLI processes.

After this is implemented and validated, the zen MCP server can be removed from configuration, significantly reducing context overhead.
The consultant role is intentionally different from both Architect and Builder - it provides perspective rather than orchestrating or implementing.

---

## Amendments

This section tracks all TICK amendments to this specification.

### TICK-001: Architect-Mediated PR Reviews (2025-12-08)

**Summary**: PR reviews are now architect-mediated - consultants receive a prepared overview instead of exploring the filesystem.

**Problem Addressed**:
The original design had consultants running in autonomous mode (`--yolo`, `--full-auto`) with full filesystem access. This led to:
1. **Slow reviews**: Codex took 200-250s as it ran 10-15 sequential shell commands
2. **Redundant exploration**: Each consultant independently explored the same files
3. **Inconsistent coverage**: Different consultants examined different aspects
4. **Cost overhead**: Tool calls multiply tokens used

**Spec Changes**:

1. **New workflow for PR reviews**:
   - Architect prepares comprehensive PR overview (diff, context, key changes)
   - Architect passes overview to `consult` via stdin or `--context` flag
   - Consultant analyzes the provided context and gives feedback
   - Consultant does NOT access the filesystem

2. **Updated CLI interface** (PR subcommand):
   ```bash
   # Before: Consultant explores filesystem
   consult --model gemini pr 68

   # After: Architect provides context
   consult --model gemini pr 68 --context overview.md
   # Or via stdin:
   cat overview.md | consult --model gemini pr 68
   ```

3. **New Success Criteria**:
   - [ ] `consult pr` accepts `--context` flag or stdin for overview
   - [ ] When context provided, consultant runs without filesystem tools
   - [ ] PR reviews complete in <60s per consultant (vs 200s+ before)

4. **Updated consultant role** for PR reviews:
   - Analyze the provided overview
   - Focus on design, architecture, and spec compliance
   - Ask clarifying questions rather than exploring files
   - Provide verdict: APPROVE or REQUEST_CHANGES

**Plan Changes**:
- Added Phase 6: Architect-Mediated PR Reviews
- Updated Phase 2 to add `--context` flag handling
- Added context passthrough to consultant role

**Review**: See `reviews/0022-consult-tool-stateless-tick-001.md`
