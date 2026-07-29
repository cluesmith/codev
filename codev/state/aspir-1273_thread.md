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

## Plan CMAP iteration 1 — 2026-07-28

Gemini **APPROVE**, Claude **APPROVE**, Codex **REQUEST_CHANGES** (4 issues). All verified against code
before acting; all accepted. Full detail in `1273-plan-iter1-rebuttals.md`.

**The one that matters for anyone else working in this area** — the builders registry does NOT carry what
you'd assume:

- `builders.protocol_name` is **NULL for spec-type builders**. `spawn.ts:488-492` never passes
  `protocolName`; only the `protocol`-type path (`:620-625`) does. Reading `db/schema.ts` shows the column
  and looks fine — the persistence path is where the truth is. Every SPIR/ASPIR lane, including this one,
  has NULL there.
- **Mode is nowhere in the DB.** `resolveMode` computes it at spawn from flags + protocol defaults and
  discards it; a spawn-time `--soft` is unrecoverable afterwards.
- Where the facts actually live: porch `status.yaml` (protocol, phase), `.builder-prompt.txt` (the literal
  `## Mode: STRICT` line), `.builder-start.sh` (the real harness launch line — per-builder ground truth,
  unlike workspace config which can change mid-run).

Added **phase 4 (context resolution)** for this, with per-field precedence chains each ending in a loud
abort. Deliberately did **not** add a `mode` DB column: it would be NULL for every running builder, so the
worktree derivation is needed anyway, and the column would duplicate a fact the worktree already holds.
Flagged to the architect in the rebuttal as a reversible call.

Also from this round: `longForm` re-orientation is now literally `buildPromptFromTemplate`'s output (the
same function the fresh-launch spawn path uses) rather than a paraphrase, with `buildResumeNotice()`
reused verbatim for the porch re-entry text; `TowerClient.sendMessage` in `packages/core` needs the
`escape` option (it was missing from phase 1); `.codex/skills/afx/SKILL.md` needs updating alongside the
Claude one.

Phase count 6 → 7.

## Implement phase 1 (afx interrupt) — 2026-07-28

Unanimous APPROVE (Gemini, Codex, Claude — all HIGH, no issues). Commit `5ca14db8`.

**Worktree setup gotcha for anyone following**: a fresh worktree has no `node_modules` (needed
`pnpm install --frozen-lockfile`) AND `tower-routes.test.ts` will not even load until
`pnpm --filter @cluesmith/codev-core build` has run — the `@cluesmith/codev-core/tower-client` subpath
export resolves into `dist/`. It presents as "Cannot find package", which reads like a dependency
problem rather than a build-order one.

**Live verification is blocked, and not by anything in the code.** The running Tower is the globally
installed build with no `escape` route handler, so my CLI's `escape: true` would be silently ignored and
the ESC would arrive as an ordinary formatted message — a test that would pass while proving nothing.
A faithful end-to-end run needs `pnpm -w run local-install`, which restarts Tower and affects every
builder in the workspace. That is the architect's call; I have not done it and have notified them. The
same constraint will apply to phase 6's "reset against a disposable builder".

Minor: Claude's review says `message-write.ts` was extracted in this phase and wasn't in the plan. It
already existed (Bugfix #584); phase 1 only added `writeEscapeToSession` to it. Non-blocking, recorded
here for accuracy rather than rebutted.

## Implement phase 2 (lastDataAt) — 2026-07-28

Iter 1: Gemini APPROVE, Claude APPROVE, **Codex REQUEST_CHANGES**. Iter 2: unanimous APPROVE.
Commits `3ded0a26` (impl) + `a6115771` (test fix).

**Worth reading if you ever weigh CMAP verdicts by majority**: the two approvers contradicted each
other on the exact point at issue. Codex said the wire-contract test was missing; Claude said
explicitly *"No gap here"* — the handler is a pure `JSON.stringify(session.info)` passthrough, so the
unit test is the right level. Two APPROVEs would have shipped it.

I sided with the single dissenter. Claude's premise was factually right about today's handler, but
"pure passthrough" is a property of the current code, not of the contract — a later projection,
redaction or version envelope at the route would break the wire while every `session.info` test stayed
green. It was also my own acceptance criterion naming the endpoint. Two cheap tests against a silent
break in the signal R4 consumes before typing `/clear` into a live terminal is an easy trade. On iter 2
Claude reviewed the reasoning and agreed.

Lesson candidate for the review: *a majority APPROVE is not consensus — when reviewers disagree, decide
on the argument, and record why.*

## Implement phase 5 (re-orientation assembly) — iterations 1–6, 2026-07-29

Five CMAP rounds on one phase — the most contested in the project. Gemini APPROVEd every round; Codex
REQUEST_CHANGES'd every round; Claude split. Worth recording *why* that pattern held rather than reading
it as reviewer noise: phase 5's contract is "the long form is spawn machinery, not a paraphrase of it",
and every Codex finding was a different way that hand-rolled reconstruction had drifted from what spawn
actually delivers. The verdict pattern was tracking a real recurring defect class, not one bug re-reported.

Iterations 1–4 (all Codex findings accepted): partial porch/issue frames were possible (fixed with
`conditionalInlineMarkers` — markers required *when the lane supplies the fact*); the porch re-entry text
was restated instead of reusing `buildResumeNotice()` and had silently dropped its `porch init` fallback
(fixed with a `ResumeNoticePort`, embedded verbatim in the long form); porch identity is now validated
field by field.

**Iteration 5 is the first finding in this project I partially rejected.** Codex claimed a reset PIR
builder gets blank artifact filenames instead of fresh-spawn framing, because PIR's `builder-prompt.md`
consumes `{{artifact_name}}` and my port never supplies it. Checked it: `artifact_name` is not on
`TemplateContext`, no spawn path in `spawn.ts` sets it, only porch supplies it for per-phase prompts, and
`renderTemplate` renders a missing key as `''`. So PIR's prompt renders that placeholder **blank at spawn
today** — reset reproduces spawn exactly, blanks included, which is what spawn-equivalence means. The
premise ("reset degrades PIR framing") does not hold.

The remedy was adopted anyway, on its own merits: `SpawnPromptPort` is now typed against the canonical
`TemplateContext` rather than a partial local copy. That copy is exactly how issue metadata went missing
in iteration 2 — a duplicated type drifts and no compiler complains. Compile-time coverage of every
present and future field beats the single-field runtime test Codex proposed, which is why the proposed
regression test was declined: it would have asserted behaviour spawn itself does not have.

**There is a real bug — it is just PIR's, not phase 5's.** PIR's spawn-time prompt has referenced an
unpopulated placeholder since it was written. Fixing it means changing another protocol's spawn path,
inside a phase contracted to *match* spawn. Escalated to the architect for a separate issue rather than
silently widening scope. (Escalation re-sent 2026-07-29 — the original send was not recorded here, and an
unrecorded escalation is indistinguishable from one that never happened.)

**Resolved 2026-07-29**: architect verified the finding and filed it as **issue #1293** (blank filenames
in PIR spawn prompts), with the recommended fix being to drop the placeholder in favour of porch's
per-phase naming. Keeping it out of 1273's scope was confirmed correct.

Iteration 6: no new work needed — the iteration-5 fix landed in `5f4d768e` before the round closed.
Re-verified: build clean, **3894 tests passing, 0 failures** (48 pre-existing skips). Signaling complete.

## Status

- [x] Explored afx/Tower internals
- [x] Spec drafted → `codev/specs/1273-builder-context-reset-should-b.md`
- [x] Spec CMAP iteration 1 — 2 APPROVE, 1 REQUEST_CHANGES, all feedback addressed → spec auto-approved
- [x] Plan drafted → `codev/plans/1273-builder-context-reset-should-b.md`
- [x] Plan CMAP iteration 1 — 2 APPROVE, 1 REQUEST_CHANGES, all 4 issues addressed → plan auto-approved
- [x] Phase 1 (afx interrupt) — implemented, 116 tests green, unanimous CMAP APPROVE
- [x] Phase 2 (lastDataAt observability) — 2 iterations, sided with the lone dissenter
- [x] Phase 3 (reset receipt gate)
- [x] Phase 4 (builder context resolution)
- [x] Phase 5 (re-orientation assembly) — 6 iterations, build + 3894 tests green
- [ ] Phase 6 (reset orchestrator + CLI wiring)
- [ ] Phase 7 (wait discipline + command documentation)

**Open for the review phase**: live end-to-end verification of the ESC path and a real reset against a
disposable builder is still blocked on `pnpm -w run local-install` (restarts Tower, affects every builder
in the workspace). That is the architect's call, and it remains the gap between "3894 tests pass" and
"it works" — flagged since phase 1, still unresolved.
