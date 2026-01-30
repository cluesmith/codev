# Spec 0086: Porch Agent SDK Integration

## Metadata
- **ID**: 0086
- **Status**: conceived
- **Created**: 2026-01-30
- **Protocol**: SPIDER
- **Amends**: 0075 (Porch Minimal Redesign)

---

## Architecture: Builder / Enforcer / Worker

This spec replaces porch's `claude --print` subprocess with the Anthropic Agent SDK. The architecture has three layers, each solving a specific problem.

```
       [ HUMAN ]
           ↕  (natural conversation)
+------------------------------+
|  BUILDER  (Interactive Claude)|  Claude Code in tmux
|  Calls porch, relays results |
+------------------------------+
           |
           |  porch run <id> --single-phase
           v
+------------------------------+
|  ENFORCER  (Porch)           |  Deterministic Node.js state machine
|  Enforces phases, reviews,   |
|  gates, iterations           |
+------------------------------+
      /              \
     / BUILD          \ VERIFY
    v                  v
+-----------+    +-------------+
| WORKER    |    | CONSULT CLI |
| (AgentSDK)|    | (Reviewer)  |
+-----------+    +-------------+
```

### Why Three Layers?

Each layer exists because the alternatives failed:

| Layer | Exists because... | What failed without it |
|-------|-------------------|----------------------|
| **Builder** | Porch is a terrible conversational interface. Humans need Claude's understanding to interact naturally. | Porch REPL had crude commands, no context awareness, couldn't explain what was happening. |
| **Enforcer** | Claude drifts. When given autonomy, Claude skips reviews, bypasses gates, and implements everything in one shot. | Soft mode builders ignored the protocol entirely. Documented in identity-and-porch-design.md. |
| **Worker** | `claude --print` was crippled — no tools, no file editing, stateless, silent 0-byte failures. | Inner Claude couldn't actually do the work. Nested subprocess spawning was fragile. |

### How It Works

1. **Human** talks to the Builder in a tmux session (the builder terminal)
2. **Builder** calls `porch run 0086 --single-phase`
3. **Enforcer** checks state, determines current phase (e.g., "implement phase 2")
4. **Enforcer BUILD**: Invokes the Worker (Agent SDK `query()`) with a phase prompt. The Worker has full tools (Read, Edit, Bash, Glob, Grep) and does the actual work — writing specs, code, tests.
5. **Enforcer VERIFY**: Runs `consult` CLI for 3-way review (Gemini, Codex, Claude). This already works well and is unchanged.
6. **If reviews fail**: Enforcer iterates — invokes Worker again with feedback from reviewers.
7. **If reviews pass**: Enforcer commits, advances state, returns.
8. **`--single-phase` returns** control to the Builder, which tells the human what happened.
9. **Builder** calls `porch run --single-phase` again for the next phase.
10. **At gates**: Enforcer returns a gate-needed status. Builder tells the human and waits.

### Drift Prevention

The Builder **cannot skip the protocol** because:

1. The Enforcer owns the state machine. Without `porch run` advancing state, nothing progresses.
2. The Worker is ephemeral — invoked by the Enforcer, scoped to one task, terminated when done. It has no ability to bypass the Enforcer.
3. 3-way reviews are automatic and mandatory — the Enforcer runs them, not the Builder.
4. `--single-phase` means the Builder re-enters the loop between every phase, creating a ratchet: forward one tooth at a time, never backwards.

### What Changes

| Component | Before (0075) | After (0086) |
|-----------|--------------|--------------|
| Inner Claude invocation | `claude --print -p <prompt>` subprocess | Agent SDK `query()` — programmatic, in-process |
| Inner Claude tools | None (text-only `--print` mode) | Full: Read, Edit, Bash, Glob, Grep, etc. |
| Signal mechanism | XML signals in output file (`<signal>PHASE_COMPLETE</signal>`) | Agent SDK structured messages (`SDKResultMessage`) |
| Error visibility | 0-byte files, silent failures | Typed errors (`error_during_execution`, `error_max_turns`) |
| Output monitoring | File polling + `tail -f` | Async iterator streaming |
| REPL (repl.ts) | Watches subprocess, tail, approve, kill | **Removed** — Outer Claude is the interface |
| claude.ts | Subprocess spawn + management | **Replaced** with Agent SDK wrapper |
| signals.ts | XML signal parsing from output file | **Removed** — SDK provides structured completion |

### What Stays the Same

- **State machine** (state.ts, protocol.ts, plan.ts) — unchanged
- **Protocol definitions** (protocol.json) — unchanged
- **Consultation** (consult CLI, verdict parsing) — unchanged
- **Builder role** (builder.md) — outer Claude still follows this
- **`af spawn`** — still creates worktree, tmux session, starts builder Claude

---

## Problem Statement

Porch's current BUILD step uses `claude --print -p <prompt>` to spawn a headless Claude subprocess. This approach has three critical flaws:

1. **No tools**: `--print` mode produces text only. The inner Claude cannot edit files, run commands, or search code. It can only output text that porch writes to a file.
2. **Silent failures**: The subprocess sometimes produces 0 bytes of output with no error. Debugging requires inspecting process state, file descriptors, and environment variables.
3. **Fragile nesting**: When the builder (itself Claude in tmux) runs `porch run`, which spawns another `claude` subprocess, the nested process often fails. Two Claude processes competing for the same terminal/resources is inherently fragile.

## Proposed Solution

Replace `spawnClaude()` in `claude.ts` with the Anthropic Agent SDK (`@anthropic-ai/claude-agent-sdk`). Porch invokes Claude programmatically via `query()`, which provides:

- Full tool access (Read, Edit, Bash, Glob, Grep, WebSearch)
- Structured `SDKMessage` responses (not text file parsing)
- Typed errors with clear failure modes
- Streaming async iterator for real-time progress
- In-process execution (no subprocess, no nested CLI)

### API Usage

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// Replace spawnClaude() with:
async function buildPhase(prompt: string, cwd: string): Promise<BuildResult> {
  let output = "";

  for await (const message of query({
    prompt,
    options: {
      allowedTools: ["Read", "Edit", "Bash", "Glob", "Grep"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      cwd,
      maxTurns: 200,
    }
  })) {
    if (message.type === "assistant") {
      // Stream output to log file for debugging
      output += extractText(message);
    }
    if (message.type === "result") {
      return {
        success: message.subtype === "success",
        output,
        cost: message.total_cost_usd,
        duration: message.duration_ms,
      };
    }
  }
}
```

### Files to Change

| File | Change |
|------|--------|
| `packages/codev/src/commands/porch/claude.ts` | **Replace**: `spawnClaude()` → Agent SDK `query()` wrapper |
| `packages/codev/src/commands/porch/run.ts` | **Modify**: Use new `buildPhase()` instead of `spawnClaude()`, remove signal watching, remove output file polling |
| `packages/codev/src/commands/porch/repl.ts` | **Remove**: No longer needed — outer Claude is the interface |
| `packages/codev/src/commands/porch/signals.ts` | **Remove**: No longer needed — SDK provides structured completion |
| `packages/codev/package.json` | **Add**: `@anthropic-ai/claude-agent-sdk` dependency |
| `packages/codev/src/commands/porch/run.ts` | **Add**: `--single-phase` flag support (exit after one build-verify cycle) |

### What Stays Unchanged

- `state.ts` — state management
- `protocol.ts` — protocol loading and querying
- `plan.ts` — plan phase management
- `prompts.ts` — prompt building (still generates phase prompts)
- `index.ts` — CLI entry point (add `--single-phase` flag)
- Consultation flow (`runVerification`, `runConsult`, `parseVerdict`)
- State tracking (status.yaml format)

## Success Criteria

1. Porch BUILD step uses Agent SDK instead of `claude --print` subprocess
2. Inner Claude has full tools (can edit files, run bash, search code)
3. No more 0-byte silent failures — errors are typed and visible
4. `--single-phase` flag allows outer Claude to drive porch phase by phase
5. `repl.ts` and `signals.ts` removed — outer Claude replaces the REPL
6. Existing consultation flow (VERIFY step) unchanged
7. All existing porch tests pass (state, protocol, plan, verdict parsing)
8. New tests for Agent SDK integration (mocked)

## Out of Scope

- Changing the consultation/verify flow (consult CLI works well)
- Changing the state machine or protocol definitions
- Multi-turn Agent SDK sessions (each phase is a fresh `query()`)
- Changing `af spawn` or builder worktree creation
- Dashboard or terminal UI changes (that's spec 0085)
