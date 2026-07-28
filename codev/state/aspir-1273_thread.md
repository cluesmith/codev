# aspir-1273 — Builder context reset as a first-class flow

**Protocol**: ASPIR (strict, porch-driven). Issue #1273. Worktree `.builders/aspir-1273`, branch `builder/aspir-1273`.

## Scope (per architect instruction, 2026-07-28)

Issue body **and** its first comment are both requirements:
1. `afx reset <builder>` — save-state → verify → `/clear` → re-orient. **This is where the design effort goes.**
2. `afx interrupt <builder>` — wrap the ESC-into-PTY recovery. **Small; do not over-design.**
3. Builder-facing **wait discipline** guidance in role/protocol docs. Primary copy in `codev-skeleton/`;
   keep the `codev/`-side change minimal to avoid colliding with spir-1252 (concurrently restructuring
   prompt surfaces, may delete `codev/` shadow copies).

Merge is pre-granted for the PR gate given green CI + cleanly-resolved CMAP; anything surprising still
goes to the human.

## Investigation findings (specify phase)

Read of the afx/Tower code before drafting:

- **`afx send` path**: `commands/send.ts` → `POST /api/send` → `handleSend` in `servers/tower-routes.ts:1425`.
  `resolveTarget` (`servers/tower-messages.ts:152`) already resolves short builder ids (`1273` →
  `builder-aspir-1273`) via tail-match with leading-zero stripping. New commands should reuse it, not
  reinvent addressing.
- **ESC survives the send path**: `handleSend` does `body.message.trim()` and rejects empty. JS `trim()`
  strips WhiteSpace|LineTerminator; `\x1b` is neither, so the ESC byte survives. That's *why* the manual
  recipe works — and it's an implicit invariant worth an explicit regression test.
- **Interrupt already half-exists**: `--interrupt` writes `\x03` (Ctrl+C) then sleeps 100ms and bypasses
  the send buffer (`shouldDefer = !interrupt && …`). ESC ≠ Ctrl+C for Claude Code: ESC ends the turn,
  Ctrl+C is a harder signal. `afx interrupt` is the ESC variant.
- **Role injection is `--append-system-prompt`** (`utils/harness.ts:118` CLAUDE_HARNESS). It is a process
  flag, so **the role frame survives `/clear`** — only the initial *user* prompt (protocol/spec/porch
  frame) is lost. That narrows what re-orientation must restore.
- **`--resume` does NOT re-inject anything** when a resumable session is found: `startBuilderSession`
  (`commands/spawn-worktree.ts:820`) skips both prompt and role on the resume path (`claude --resume <uuid>`).
  The full builder prompt is only injected on the fresh-launch fallback. So "re-inject phase context the
  way `--resume` does" = reuse `buildPromptFromTemplate` + `buildResumeNotice`, the fresh-path machinery.
- **Launch loop**: `.builder-start.sh` wraps the agent in `while true`, and a clean `/exit` (status 0)
  prints "Press Enter to relaunch" and waits on `read -r`. That makes an in-PTY relaunch (rewrite
  `.builder-prompt.txt` → `/exit` → Enter) a real third option for reset. Captured as Approach C.
- **`.builder-*` prefix is load-bearing**: `commands/cleanup.ts:136` treats untracked `.builder-*` files
  as "scaffold only, not dirty". Naming the state file `.builder-state.md` keeps cleanup semantics right.
- **PTY observability**: `GET /api/terminals/:id/output` exists; `PtySession.lastDataAt` (Spec 467) gives
  output quiescence. Both usable to verify each reset step instead of blind-firing.
- **Message pacing**: `message-write.ts` — ≥4 lines is written line-by-line at 10ms/line. Large
  re-orientation payloads are slow-ish and risk paste detection (#584); favour a compact frame message
  plus a worktree file for the long form.

## Design invariants chosen for the spec

- **R1 (assemble-before-destroy)**: the complete re-orientation payload must be assembled and persisted
  *before* `/clear` is written. Nothing destructive happens until the replacement context exists.
- **R2 (nonce receipt)**: the save-state request carries a nonce; the state file is only accepted if it
  contains that nonce and is size-stable and substantive. Makes "cleared before the save landed" — and
  "accepted a stale file from a previous reset" — impossible rather than unlikely.
- Fail fast on non-Claude harnesses (no in-session clear) rather than inventing a fallback.

## Status

- [x] Explored afx/Tower internals
- [x] Spec drafted → `codev/specs/1273-builder-context-reset-should-b.md`
- [ ] porch verify (3-way CMAP) on the spec
