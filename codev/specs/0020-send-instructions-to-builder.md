# Specification: Send Instructions to Builder

## Metadata
- **ID**: 0020-send-instructions-to-builder
- **Protocol**: SPIR
- **Status**: specified
- **Created**: 2025-12-03
- **Priority**: high

## Problem Statement

Once a Builder is spawned, the Architect has no way to send follow-up instructions without manually switching to the Builder's terminal tab and typing. This breaks the Architect's workflow and reduces the value of the dashboard as a coordination hub.

Common scenarios where the Architect needs to communicate with a running Builder:
1. **PR feedback**: "PR review complete, address the reviewer's concerns about error handling"
2. **Scope clarification**: "Actually, skip the unit tests for now, focus on the integration"
3. **Context injection**: "Here's additional context: the auth module was refactored in PR #45"
4. **Priority changes**: "Pause this and wait for 0009 to merge first"
5. **Unblocking**: Responding to a Builder's question when they're blocked

## Current State

- Builders run in tmux sessions attached via ttyd
- The Architect can only interact by:
  1. Switching to the Builder's tab in the dashboard
  2. Manually typing in the terminal
- No CLI command exists for sending messages
- No dashboard UI for message input
- No way to broadcast to multiple builders

## Desired State

### CLI Interface
```bash
# Send message to a specific builder
af send 0009 "PR review complete, please address the error handling feedback"
af send --builder 0009 "Message here"

# Send with file attachment (inject file content into message)
af send 0009 "Review this diff:" --file /tmp/review-comments.md

# Send to all builders
af send --all "Stopping for integration - please commit your work"

# Interactive mode (opens a prompt)
af send 0009 --interactive
```

### Dashboard Interface
- Text input field in Builder tab header or footer
- "Send to Builder" button
- Message history visible in tab (optional)

## Stakeholders
- **Primary Users**: Architects coordinating multiple builders
- **Secondary Users**: Solo developers managing parallel work
- **Technical Team**: Codev maintainers
- **Business Owners**: Project owner (Waleed)

## Success Criteria

- [ ] `af send BUILDER_ID "message"` sends text to the builder's terminal
- [ ] Message appears as if typed by user (builder sees it as input)
- [ ] Builder's Claude instance receives and processes the message
- [ ] `af send --all "message"` broadcasts to all active builders
- [ ] `af send --file` can inject file contents into the message
- [ ] Dashboard has text input for sending messages (optional stretch goal)
- [ ] Works with builders in any status (implementing, blocked, etc.)
- [ ] Graceful error handling for non-existent or dead builders

## Constraints

### Technical Constraints
- Must work with existing tmux session infrastructure
- Cannot modify the builder's Claude session directly (only via terminal input)
- Must handle builders that are waiting for input vs. actively running
- Message length may be limited by terminal buffer size

### Business Constraints
- Should be intuitive for Architect users
- Should not require changes to Builder role or prompt

## Assumptions

- tmux `send-keys` command is available and reliable
- Builders are running in tmux sessions (per current spawn implementation)
- Claude processes terminal input in a FIFO manner
- Terminal can handle multi-line messages

## Solution Approaches

### Approach 1: tmux Buffer Paste (Recommended)

**Description**: Use tmux's buffer system (`load-buffer` + `paste-buffer`) to inject text as a paste operation, avoiding shell escaping issues.

```bash
# How it works internally
tmux load-buffer -b architect-msg /tmp/message.txt
tmux paste-buffer -b architect-msg -t "builder-0009"
tmux send-keys -t "builder-0009" Enter
```

**Implementation**:
1. Look up builder's tmux session name from state
2. Validate session exists and is running
3. Write message to temp file (avoids shell escaping entirely)
4. Load into tmux buffer
5. Paste buffer to session
6. Send Enter to submit

**Pros**:
- Handles multi-line, special characters, and long messages reliably
- Uses existing infrastructure
- Treats message as "paste" not "keystrokes" (preserves formatting)
- No shell escaping needed

**Cons**:
- No confirmation that Claude actually processed it
- Requires temp file (trivial overhead)
- If builder is in vim/less, message goes to wrong place

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Structured Message Protocol

**Description**: Define a structured message format that Builders are trained to recognize and respond to.

```
[ARCHITECT MESSAGE]
From: Architect
Time: 2025-12-03 14:30
---
PR review complete, please address the error handling feedback.
[END MESSAGE]
```

**Pros**:
- Clear separation of Architect messages from other input
- Builder can acknowledge receipt
- Enables message threading/history

**Cons**:
- Requires Builder role to understand the protocol
- More complex implementation
- May confuse Claude if not properly trained

**Estimated Complexity**: Medium
**Risk Level**: Medium

### Approach 3: Dedicated Communication Channel

**Description**: Use a file-based or socket-based side channel instead of terminal input.

**Pros**:
- Cleaner separation of concerns
- Could support rich messages (attachments, formatting)

**Cons**:
- Requires significant infrastructure changes
- Builder would need polling or file watching
- Over-engineered for the use case

**Estimated Complexity**: High
**Risk Level**: High

### Recommended Approach

**Approach 1** (tmux Buffer Paste) is recommended. Both GPT-5 and Gemini Pro strongly recommended this over `send-keys` due to reliability issues with escaping and multi-line content.

**Additionally**, we will use a **structured message format** by default (from Approach 2) to help Claude distinguish Architect instructions from other terminal output.

## Technical Design

### CLI Command Structure

```typescript
interface SendOptions {
  builder?: string;     // Builder ID (required unless --all)
  all?: boolean;        // Send to all builders
  file?: string;        // File to include in message
  interactive?: boolean; // Open interactive prompt
  interrupt?: boolean;  // Send Ctrl+C first to ensure prompt is ready
  raw?: boolean;        // Skip structured formatting
  noEnter?: boolean;    // Don't send Enter after message
}

// Usage: af send [builder] [message] [options]
// Can also read from stdin: echo "message" | af send 0009 -
```

### Message Flow

```
Architect CLI → Load state → Find builder session → Write temp file → tmux load-buffer → tmux paste-buffer → tmux send-keys Enter → Builder terminal
```

### Structured Message Format

By default, messages are wrapped in a structured format to help Claude distinguish instructions:

```typescript
function formatMessage(message: string, fileContent?: string, raw: boolean = false): string {
  let content = message;
  if (fileContent) {
    content += '\n\nAttached content:\n```\n' + fileContent + '\n```';
  }

  if (raw) {
    return content;
  }

  // Structured format helps Claude identify Architect instructions
  const timestamp = new Date().toISOString();
  return `### [ARCHITECT INSTRUCTION | ${timestamp}] ###
${content}
###############################`;
}
```

### tmux Buffer Integration

Using buffers instead of send-keys avoids all shell escaping issues:

```typescript
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

async function sendToBuilder(builderId: string, message: string, options: SendOptions): Promise<void> {
  const state = await loadState();
  const builder = state.builders.find(b => b.id === builderId);

  if (!builder) {
    throw new Error(`Builder ${builderId} not found`);
  }

  if (!builder.tmuxSession) {
    throw new Error(`Builder ${builderId} has no tmux session`);
  }

  // Verify session exists
  const sessionExists = await run(`tmux has-session -t "${builder.tmuxSession}" 2>/dev/null`)
    .then(() => true)
    .catch(() => false);

  if (!sessionExists) {
    throw new Error(`tmux session ${builder.tmuxSession} not found (builder may have exited)`);
  }

  // Optional: Send Ctrl+C first to interrupt any running process
  if (options.interrupt) {
    await run(`tmux send-keys -t "${builder.tmuxSession}" C-c`);
    await sleep(100); // Brief pause for prompt to appear
  }

  // Write message to temp file (avoids all escaping issues)
  const tempFile = join(tmpdir(), `architect-msg-${randomUUID()}.txt`);
  const formattedMessage = formatMessage(message, options.fileContent, options.raw);
  writeFileSync(tempFile, formattedMessage);

  try {
    // Load into tmux buffer and paste
    const bufferName = `architect-${builderId}`;
    await run(`tmux load-buffer -b ${bufferName} "${tempFile}"`);
    await run(`tmux paste-buffer -b ${bufferName} -t "${builder.tmuxSession}"`);

    // Send Enter to submit (unless --no-enter)
    if (!options.noEnter) {
      await run(`tmux send-keys -t "${builder.tmuxSession}" Enter`);
    }

    // Log outbound message for debugging
    logger.debug(`Sent to ${builderId}: ${message.substring(0, 50)}...`);
  } finally {
    // Clean up temp file
    unlinkSync(tempFile);
  }
}
```

### Broadcast Implementation

```typescript
async function sendToAll(message: string): Promise<{sent: string[], failed: string[]}> {
  const state = await loadState();
  const results = { sent: [], failed: [] };

  for (const builder of state.builders) {
    try {
      await sendToBuilder(builder.id, message);
      results.sent.push(builder.id);
    } catch (error) {
      results.failed.push(builder.id);
    }
  }

  return results;
}
```

### Dashboard Integration (Optional)

Add to dashboard API:
```typescript
// POST /api/builders/:id/send
app.post('/api/builders/:id/send', async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;

  try {
    await sendToBuilder(id, message);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
```

## Open Questions

### Critical (Blocks Progress)
- [x] What mechanism to use? **Decision: tmux load-buffer + paste-buffer (per GPT-5 and Gemini recommendation)**

### Important (Affects Design)
- [x] Should messages have a structured format? **Decision: Yes, use `### [ARCHITECT INSTRUCTION | timestamp] ###` wrapper by default, with `--raw` flag to disable**
- [x] Should we wait for/detect Claude's acknowledgment? **Decision: No, too brittle. CLI returns success once tmux confirms delivery.**
- [x] How to handle very long messages (file attachments)? **Decision: Use buffer approach (handles up to 48KB), enforce size limit, warn on large files**

### Nice-to-Know (Optimization)
- [ ] Should there be a message history feature? (Deferred)
- [ ] Should dashboard show sent messages inline with terminal output? (Deferred)

## Performance Requirements
- **Send latency**: < 500ms from CLI to terminal
- **Broadcast latency**: < 2s for 10 builders

## Security Considerations
- Message content is not sanitized (sent as-is to terminal)
- File attachments should have size limits
- No sensitive data should be logged

## Test Scenarios

### Functional Tests
1. `af send 0009 "Hello"` - Message appears in builder terminal
2. `af send 0009 "Line 1\nLine 2"` - Multi-line message works
3. `af send --all "Pause"` - All builders receive message
4. `af send 9999 "Test"` - Non-existent builder returns error
5. `af send 0009 "Review:" --file comments.md` - File content included
6. Message with special chars ($, `, ", \) handled correctly

### Non-Functional Tests
1. Send completes in < 500ms
2. Broadcast to 5 builders completes in < 2s

## Dependencies
- **Internal Systems**: tmux sessions, builder state management
- **External**: tmux CLI

## References
- `agent-farm/src/commands/spawn.ts` - Builder session creation
- `codev/roles/architect.md` - Architect responsibilities
- tmux documentation: `man tmux` (send-keys section)

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| tmux session not found | Medium | Low | Verify session before sending, clear error message |
| Message truncated by buffer | Low | Medium | Enforce 48KB limit, warn on large files |
| Builder in vim/less ("Vim trap") | Medium | High | Add `--interrupt` flag to send Ctrl+C first; warn in docs |
| Shell expansion ($, !, `) | High | High | Use buffer approach instead of send-keys (eliminates this) |
| Auto-indent garbles pasted code | Low | Low | Buffer paste preserves formatting; document limitation |
| Builder doesn't see message (scrolled away) | Low | Low | Message is still processed by Claude |
| Race condition with builder output | Low | Low | Accept as inherent to terminal-based IPC |
| Sending secrets via --file | Low | High | Warn for files outside workspace or >10KB |
| Builder at shell prompt (not Claude) | Medium | High | Document risk; message may execute as command |

## Expert Consultation
**Date**: 2025-12-03
**Models Consulted**: GPT-5 Codex, Gemini 3 Pro
**Sections Updated**:
- **Solution Approach**: Changed from `send-keys` to `load-buffer + paste-buffer` per both models' strong recommendation
- **Structured Message Format**: Added `### [ARCHITECT INSTRUCTION | timestamp] ###` wrapper per both models
- **CLI Options**: Added `--interrupt`, `--raw`, `--no-enter` flags per GPT-5
- **tmux Integration**: Complete rewrite using buffer approach per both models
- **Risks**: Added "Vim trap", shell expansion, auto-indent, secrets risks per both models
- **Open Questions**: Resolved all critical questions based on consultation

Note: Both models independently recommended the same approach (buffer-based, no acknowledgment waiting, structured format). High agreement increases confidence in the design.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Expert AI Consultation Complete

## Notes
This feature completes the bidirectional communication loop between Architect and Builder. Combined with 0014 (Flexible Builder Spawning), it enables a more dynamic workflow where the Architect can spawn builders and then guide them through complex tasks with follow-up instructions.
