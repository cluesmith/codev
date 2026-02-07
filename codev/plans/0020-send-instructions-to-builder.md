# Implementation Plan: Send Instructions to Builder

## Metadata
- **Spec**: 0020-send-instructions-to-builder
- **Protocol**: SPIR
- **Status**: planned
- **Created**: 2025-12-04

## Overview

Implement `af send` CLI command to send messages to running builders via tmux buffer paste.

## Implementation Phases

### Phase 1: Core Send Command (30 min)

**File**: `agent-farm/src/commands/send.ts`

1. Create send command with signature:
   ```typescript
   send(options: { builder?: string; message?: string; all?: boolean; file?: string; interrupt?: boolean; raw?: boolean; noEnter?: boolean })
   ```

2. Implement `sendToBuilder(builderId, message, options)`:
   - Load state, find builder by ID
   - Verify tmux session exists: `tmux has-session -t "builder-{id}"`
   - Write message to temp file (avoids escaping)
   - `tmux load-buffer -b architect-{id} /tmp/msg.txt`
   - `tmux paste-buffer -b architect-{id} -t "builder-{id}"`
   - `tmux send-keys -t "builder-{id}" Enter`
   - Clean up temp file

3. Implement message formatting:
   ```typescript
   function formatMessage(message: string, fileContent?: string, raw: boolean): string {
     if (raw) return message + (fileContent ? '\n\n' + fileContent : '');
     const timestamp = new Date().toISOString();
     return `### [ARCHITECT INSTRUCTION | ${timestamp}] ###\n${message}${fileContent ? '\n\nAttached:\n```\n' + fileContent + '\n```' : ''}\n###############################`;
   }
   ```

4. Handle `--interrupt` flag: send `C-c` before message

### Phase 2: Broadcast & File Support (15 min)

1. Implement `--all` broadcast:
   ```typescript
   async function sendToAll(message: string, options): Promise<{sent: string[], failed: string[]}> {
     const state = await loadState();
     for (const builder of state.builders) {
       await sendToBuilder(builder.id, message, options);
     }
   }
   ```

2. Implement `--file` option:
   - Read file content
   - Check size limit (48KB)
   - Append to message

3. Implement stdin support (`af send 0009 -`):
   - Detect `-` as message
   - Read from stdin

### Phase 3: CLI Registration (10 min)

**File**: `agent-farm/src/cli.ts`

1. Add send command to CLI:
   ```typescript
   program
     .command('send [builder] [message]')
     .description('Send instructions to a running builder')
     .option('--all', 'Send to all builders')
     .option('--file <path>', 'Include file content')
     .option('--interrupt', 'Send Ctrl+C first')
     .option('--raw', 'Skip structured formatting')
     .option('--no-enter', 'Do not send Enter after message')
     .action(send);
   ```

2. Update help text

### Phase 4: Error Handling (10 min)

1. Builder not found → clear error message
2. tmux session dead → suggest `af status` to check
3. File not found/too large → helpful error
4. No message provided → show usage

### Phase 5: Testing (15 min)

1. Manual test: `af send 0022 "Test message"`
2. Test multi-line: `af send 0022 "Line 1\nLine 2"`
3. Test broadcast: `af send --all "Hello all"`
4. Test file: `af send 0022 "Review:" --file /tmp/test.md`
5. Test interrupt: `af send 0022 --interrupt "Wake up"`
6. Test error cases: non-existent builder, dead session

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `agent-farm/src/commands/send.ts` | Create | Core send implementation |
| `agent-farm/src/cli.ts` | Modify | Register send command |
| `agent-farm/src/types.ts` | Modify | Add SendOptions interface |

## Dependencies

- tmux (already required)
- Existing state management (`loadState`)
- Existing shell utilities (`run`)

## Success Criteria

- [ ] `af send 0022 "message"` delivers to builder terminal
- [ ] `af send --all "message"` broadcasts to all builders
- [ ] `af send 0022 --file comments.md "Review this:"` includes file
- [ ] `af send 9999 "test"` shows clear error for non-existent builder
- [ ] Multi-line and special characters handled correctly

## Notes

- Using buffer paste approach per spec (avoids shell escaping)
- Structured message format helps Claude identify architect instructions
- No acknowledgment waiting - returns success once tmux confirms delivery
