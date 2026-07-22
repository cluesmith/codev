# Design comparison — `AskUserQuestion` detection (interaction-model §8.1)

**Status**: Co-design input for main, not a decision. This mechanism serves web, VS Code, and mobile equally; ownership sits with main per the scope-lock's prerequisite 1 (#1147) and anti-pattern 9 ("do not design Tower's structured-event plumbing mobile-shaped").
**Date**: 2026-07-19
**Ground truth**: every repo claim below verified 2026-07-19 (file references inline).

## The problem, restated

To render a native question card, a surface needs the *structured* `{question, options[], multiSelect}` payload when an agent calls `AskUserQuestion`, plus a resolution signal when it's answered. Tower today does zero PTY content inspection (`pty-session.ts` `onPtyData`: timestamp + ring-buffer + broadcast, nothing else), so this is new plumbing whatever mechanism we pick.

## Mechanism A — harness-side hooks (recommended)

Claude Code hooks run a command on tool events, receiving the tool payload as JSON on stdin. Two hooks cover the whole lifecycle:

- **`PreToolUse` matching `AskUserQuestion`** fires the moment the agent asks — the hook reads the structured question from `tool_input` and POSTs it to Tower: this *is* the `question_pending` event, with zero parsing.
- **`PostToolUse`** fires when the question resolves — `question_resolved`, carrying the selection from the tool response.

**Why this is low-risk in this repo specifically — the precedent already ships.** Codev generates and installs a Claude Code `PreToolUse` hook per builder today: the worktree write-guard (#1018). `buildWorktreeGuardFiles()` (`agent-farm/utils/worktree-write-guard.ts`) writes `.claude/hooks/worktree-write-guard.cjs` + `.claude/settings.local.json` into each worktree, wired through `CLAUDE_HARNESS.getWorktreeFiles` (`utils/harness.ts`) at spawn (`spawn-worktree.ts`). An AskUserQuestion emitter is the same shape: one more generated hook script, one more settings entry, riding a seam that already exists and is already harness-abstracted.

**Fit with the repo's signaling philosophy.** The established agent→system idiom here is *explicit emission*, never stream inference: porch signals via CLI commands writing `status.yaml` with structured commits (`gate-requested`, `build-complete`, …), review comments via on-disk markers. Hooks are that same idiom applied to tool events.

**Fit with #1194.** The emitted event should be the second member of the `BusEventMeta` discriminated union (after `gate-event`), delivered through the same system-sender `/api/send` path — the envelope, sender-type exemption, and typed-metadata machinery all get reused, not reinvented.

Costs and open edges (the co-design questions, below): architects don't currently get spawn-written hook config; hooks are Claude-specific (the Tower contract must stay harness-neutral); and porch's `status.yaml` has an unused reserved field `awaiting_input` that this event could finally populate or supersede.

## Mechanism B — PTY-stream parsing (rejected)

Tower would watch terminal bytes for the rendered question. Ground truth kills it:

- The TUI renders an *interactive ANSI menu* (cursor movement, redraws, box drawing) with **no semantic delimiter**; no fixture of the rendered form even exists in-repo to code against.
- The structured payload isn't recoverable from the rendering (option descriptions collapse/expand, text wraps to terminal width).
- It's version-fragile against every TUI restyle, and it inverts the repo's explicit-emission idiom into inference.
- Tower currently inspects nothing; building its first content parser for the hardest possible content is the wrong first parser.

## Mechanism C — transcript tailing (viable fallback, not preferred)

Claude Code writes JSONL transcripts per session (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`); Codev already discovers these files for `--resume` (`claude-session-discovery.ts`) but reads only names/mtimes. A tailer could watch for `AskUserQuestion` tool-use entries — structured, no agent-side config, works for architects immediately. Rejected as primary because it couples Tower to an **undocumented internal file format** of one harness (exactly what the HarnessProvider abstraction exists to avoid), adds polling latency, and still needs per-session file discovery. Keep in the back pocket: it needs no spawn-path changes, so it could bridge the architect gap (Q1 below) if that plumbing lags.

## Recommendation

**A, with the Tower contract designed harness-neutrally**: a Tower ingestion endpoint (or the #1194 system-sender `/api/send` path with a new `BusEventMeta` member) that accepts `question_pending` / `question_resolved` from *any* emitter. The Claude hook is merely the first emitter; a future harness implements its own; C can serve as a stopgap emitter where hook injection doesn't reach. Persistence lands in `global.db` per `q3-offline-behavior.md` (lifecycle `pending → answered | expired | superseded`, compare-and-set resolution).

## Open questions for the co-design (main's call)

1. **Architect coverage.** Builders get hook files at spawn via `getWorktreeFiles`; architect launch (`buildRoleInjection`) writes no settings. Options: extend architect spawn with the same generated-settings mechanism; a checked-in repo-level hook (applies to every Claude session in the checkout, including the human's own — probably wrong); or Mechanism C as the architect-side bridge. Needs main's read on architect-spawn plumbing appetite.
2. **Response injection is a separate, harder problem than detection.** Hooks *observe*; they can't answer. A selection made on another surface must reach the TUI, realistically as synthesized PTY input (the menu is arrow-keys + enter; Tower knows the option order). That's spike-worthy on its own and fragile enough that v0 mobile might ship detect-and-notify first, answer-on-desktop, with remote answering as its own gated step. The interaction-model §8.3 "Tower injects tool_result" framing was wrong and should be amended once this decision lands.
3. **Event transport**: dedicated Tower endpoint vs the #1194 system-sender path. Riding #1194 reuses the envelope and exemption; a dedicated endpoint keeps question lifecycle (compare-and-set resolution) out of the messages route. Leaning dedicated-endpoint-for-resolution + bus-frame-for-notification, but this is exactly the seam main should shape.
4. **`status.yaml` `awaiting_input`**: porch reserved this field ("worker signaled it needs human input") but nothing sets it. Should the question lifecycle populate it (making porch/overview aware a builder is question-blocked), or is that conflating two state machines?

## Consumer note (mobile)

Whatever lands, mobile consumes `question_pending`/`question_resolved` exactly as designed in `q3-offline-behavior.md` and `q6-session-presence.md`: server-held pending state, compare-and-set resolution, definitive-tier presence. Detection mechanism choice doesn't change the consumer contract — which is the point of designing the contract first.
