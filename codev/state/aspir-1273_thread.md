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

## CMAP iteration 1 (spec) — 2026-07-28

Gemini **APPROVE** (HIGH), Claude **APPROVE** (HIGH), Codex **REQUEST_CHANGES** (HIGH).

Codex's two blocking gaps were both real and both closed:

1. *Quiesce had no failure semantics.* I had specified "confirm the terminal stopped producing output"
   without saying what happens if it never does — which, under "fail fast, no fallbacks", is exactly
   the kind of hole that becomes a "clear anyway" shortcut at implementation time. Added **R4**:
   bounded wait → exactly one ESC escalation (legal only *after* the R2 receipt, so nothing is at
   risk) → bounded wait → abort non-zero, no clear. Plus tests 9a/9b, one of which pins the ESC
   ordering against R2.
2. *Re-orientation payload contract ambiguous.* "Role frame" could be read as the full role document
   (hundreds of paced lines through a paste-detection-prone channel) or as an identity block. Now
   explicitly the latter, with a fixed inline-vs-referenced division. Also separated `--file`
   (reads from the *caller's* filesystem, like `afx send --file`) from the state-file path override
   (must stay inside the target worktree) — I had conflated the two in Security Considerations.

Claude verified all ~10 factual codebase claims in the spec independently and found them accurate;
its comments (default-path addressability, double-reset, `--resume` wording, content-quality
trade-off, wedged-builder integration test) are all incorporated.

Design decisions locked this iteration:
- State file is `.builder-state.md`, **fixed name** — freshness comes from the in-file nonce, not the
  filename, so resets don't litter the worktree with `.builder-state-<nonce>.md` files.
- Long-form re-orientation goes to `.builder-reorient.md`; the message carries the compact frame.
  Both `.builder-` prefixed, so `afx cleanup` still sees the worktree as clean.

## Status

- [x] Explored afx/Tower internals
- [x] Spec drafted → `codev/specs/1273-builder-context-reset-should-b.md`
- [x] porch verify iteration 1 (3-way CMAP) — 2 APPROVE, 1 REQUEST_CHANGES, all feedback addressed
- [ ] porch verify iteration 2
