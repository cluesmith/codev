# Bugfix #481: af send sometimes doesn't send Enter

## Summary

Fixed a race condition where `af send` would type the message into a builder's terminal but sometimes fail to send the Enter key (`\r`), leaving the message typed but unsent.

## Root Cause

The message text and Enter keystroke were sent as **two separate `session.write()` calls**. Each `session.write()` produces a separate DATA frame in the shellper binary protocol (5-byte header: 1 byte type + 4 bytes length + payload). When these frames arrived as separate socket reads on the shellper side, there was a window where the message text reached the PTY but the Enter hadn't arrived yet — causing the message to appear typed but never submitted.

## Fix

Combined message + `\r` into a **single `session.write()` call** so they travel as one DATA frame through the shellper protocol. Applied to all three message delivery paths:

1. **Immediate delivery** (`handleSend()` in `tower-routes.ts`) — when user is idle
2. **Deferred delivery** (`deliverBufferedMessage()` in `tower-routes.ts`) — when user was typing and message was buffered
3. **Cron delivery** (`deliverMessage()` in `tower-cron.ts`) — cron-triggered messages

## Files Changed

| File | Change |
|------|--------|
| `packages/codev/src/agent-farm/servers/tower-routes.ts` | Combined split writes in `handleSend()` and `deliverBufferedMessage()` |
| `packages/codev/src/agent-farm/servers/tower-cron.ts` | Combined split writes in `deliverMessage()` |
| `packages/codev/src/agent-farm/__tests__/tower-routes.test.ts` | Added 2 regression tests |

## Testing

- 2 new regression tests verifying atomic write behavior (with and without `noEnter` flag)
- All 1816 unit tests pass
- TypeScript compiles clean

## CMAP Review

- **Claude**: APPROVE (83.2s)
- **Codex**: APPROVE (32.7s)
- **Gemini**: Incomplete (protocol issue)

## Lessons Learned

- When sending data through a framing protocol, always consider whether split writes can cause interleaving or ordering issues
- The shellper binary protocol creates frame boundaries at each `write()` call — combining logically atomic data into a single write prevents split-delivery bugs
