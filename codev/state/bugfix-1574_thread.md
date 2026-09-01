# bugfix-1574 — self-attesting message frames

Issue #1574 (BUGFIX, strict). Absorbs #1543 (recipient field), closes the real #1530 defect
(reply-channel discoverability).

## Investigate (2026-09-01)

**Reproduced** against the real module (`node --experimental-strip-types`, importing
`packages/codev/src/agent-farm/utils/message-format.ts`):

```
### [ARCHITECT INSTRUCTION | 2026-09-01T11:51:55.927Z] ###
hello
###############################
### [BUILDER bugfix-1574 MESSAGE | 2026-09-01T11:51:55.928Z] ###
hello
###############################
recipient token present? false false
reply channel stated?    false
```

**Root cause (defect 1 — no recipient).** `utils/message-format.ts` builds all three wrapper
variants from `(sender, timestamp)` only; the recipient is simply never a formatter input.
`formatMessageForTarget` (`servers/tower-routes.ts:1528`) *has* the canonical recipient in scope
at every one of its five call sites (`toAgent`, from `liveTargetIdentity` / `resolveAgentInRegistry`)
and does not pass it. Same at `servers/mailbox-wiring.ts:268` (starvation notice, recipient is
`owner.agent`) and the cron path (`tower-routes.ts:1566`, where the frame is built in `base`
*before* resolution, so the recipient is not yet known at the point the string is made). So a
pane-reader cannot verify a frame on its screen was addressed to it.

**Root cause (defect 2 — no reply channel).** Nothing in the delivered frame names `afx send`.
A protocol-lane builder is taught it repeatedly by porch phase prompts; the task lane's prompt
(`commands/spawn.ts:551`, the no-`--protocol` branch) is `"You are a Builder… # Task\n\n<task>"` —
no reply channel at all. After a context refresh, the re-entry inline frame
(`commands/reset/reorient.ts:buildInline`) does not state one either. A builder told to "reply"
types assistant text into its own terminal, which goes nowhere, with zero feedback.

**Nothing downstream parses the header.** `grep '###############'` across `packages/` finds only
the formatter itself and two tests; no consumer splits or matches on the header line. The only
format-pinning tests are `message-format.test.ts` (asserts `ARCHITECT INSTRUCTION` /
`BUILDER 0158 MESSAGE` substrings + trailing delimiter) and
`bugfix-584-send-multiline-pacing.test.ts` (uses a hand-written frame string as *input* to the
pacer — not an assertion about the formatter). `inbox-routes.test.ts` and
`tower-cron-routes.test.ts` mock the formatters, so their mock signatures move with the API.
No skill doc or role doc quotes the frame; `codev/resources/arch.md:1826` describes it in prose
and will be updated.

**Scope**: ~50 LOC of source + tests. Well inside BUGFIX.

**#1573 overlap (flagged to architect).** The issue names `tower-routes.ts` as a #1573 file, but
threading `to_agent` to the formatter is unavoidable there — the recipient only exists at those
call sites. Footprint kept to one signature line plus six argument lists, and the cron path's
frame construction moved after resolution. bugfix-1573 has no code commits yet
(`git diff --name-only origin/main...HEAD` → status.yaml only).

**#1521 item 3** (inter-architect headers render `BUILDER architect MESSAGE`, unnamed sender):
the sender is the literal string `architect` (`commands/send.ts:317`,
`detectCurrentBuilderId() ?? 'architect'`), so naming *which* architect needs sender-side
resolution in `send.ts` — a #1573 file, and not trivial. Assessing during implement; if it stays
non-trivial it is left open with a note rather than half-done.

## Fix (2026-09-01)

Architect approved both flagged calls: proceed with the narrow `tower-routes.ts` touch (rule:
whichever of 1573/1574 merges second rebases onto main first), and leave #1521 item 3 open —
"include if trivial" bar not met.

Also owner-directed, mid-phase: the running Tower (3.3.1, pre-#1573) truncates long sends. My
965-char message to the architect arrived as its last ~25 chars. Workaround for the rest of this
lane: any message over ~400 chars goes to a file, with a one-line pointer sent instead.

**Changes.**

- `utils/message-format.ts` — `toAgent` is now a REQUIRED first argument on all three variants,
  rendering `→ <toAgent>` in the header. Required, not optional: a silently-omitted recipient is
  the defect itself. New `formatArchitectToBuilderMessage` = the architect frame plus the trailing
  `REPLY_HINT` line. It is separate from `formatArchitectMessage` because that function ALSO
  frames the unknown-sender → architect fallback (`tower-routes.ts`, last branch), and telling an
  architect to "reply: afx send architect" points it at itself.
- `servers/tower-routes.ts` — `formatMessageForTarget` takes `toAgent`; 5 call sites pass the
  canonical recipient already in scope. Cron's frame moved out of `base` into each resolved
  branch, because the recipient is not known until after resolution.
- `servers/mailbox-wiring.ts` — starvation notice passes `owner.agent`.
- `commands/spawn.ts` — new exported `TASK_REPLY_CHANNEL`, added to the no-protocol task prompt.
- `commands/reset/reorient.ts` — `- Reply channel: ...` bullet in the inline re-entry frame, and
  `'Reply channel:'` added to `REQUIRED_INLINE_MARKERS` so assembly REFUSES a frame that loses it.
  Phrased as a channel, not an instruction to reply — an automatic re-entry frame explicitly says
  nobody is waiting on one.
- `codev/resources/arch.md` — "Sender attribution" section updated to describe the new frame.
  No skill doc or role doc quoted the frame; `codev/roles/builder.md` already teaches
  `afx send architect`, so neither role doc needed a change (skeleton included).

**Regression evidence.** Restored the three source files to HEAD (originals backed up to the
scratchpad first, then copied back) and re-ran: **15 tests fail without the fix**, including
`formatArchitectToBuilderMessage is not a function`, the three `→ <recipient>` header regexes,
the reply-hint assertions, and all five re-entry/task-prompt tests. All pass with it.

**Test surface.** `message-format.test.ts` (rewritten call sites + two new describes),
`send-delivery.test.ts` (the one integration assertion: real formatter → real row → real
`deliverAgentMail` → captured write contains `→ ${stored.to_agent}`), new
`bugfix-1574-reply-channel.test.ts`. `inbox-routes.test.ts` / `tower-cron-routes.test.ts` mock
signatures moved with the API.

**Not done, deliberately.** #1521 item 3 stays open: an architect sender is the literal string
`architect` (`commands/send.ts:317`), so naming *which* architect needs sender-side resolution in
a #1573 file. Half-doing it would relabel the header without adding information.

**Side effect worth noting.** `afx send --all` loops per builder through the same route, so a
broadcast now attests per-recipient rather than sending N identical anonymous frames.

### Surfaced during the fix: the hint crosses the paced-write threshold

The trailing reply line takes the builder-bound frame from 3 lines to 4, and
`message-write.ts` paces any message of `PACED_WRITE_LINE_THRESHOLD = 4`+ lines line-by-line.
So single-line architect→builder messages now take the paced path instead of the single-write
path (~40ms, 3 extra `session.write` calls). Multi-line messages — already most real traffic —
are unchanged.

Two `tower-routes.test.ts` tests caught it. They were NOT loosened: rewritten to pin the paced
sequence exactly — Enter still its own final `\r`, every line whole with no embedded `\r`, and
the reassembled writes must equal the exact line split of the frame. That is Bugfix #481's real
invariant (never fused, never split mid-line), pinned harder than before.

Flagged to the architect (/tmp/bugfix-1574-msg-001.md) with a 3-line alternative — fold the
hint onto the closing delimiter.

**Architect ruling: take the alternative.** "A formatter lane must not shift short messages onto
the paced multi-write path as a side effect — that widens the exact exposure window #1573 is
closing." So the builder-bound frame is now:

```
### [ARCHITECT INSTRUCTION → bugfix-1574 | 2026-09-01T...] ###
hello
###############################  (reply: afx send architect "…")
```

3 lines; the delivery write path is byte-identical to before this change. The two
`tower-routes.test.ts` edits were reverted (`git checkout HEAD --`) and that file passes
untouched — the best available evidence that the write path really is unchanged. A new test pins
the line count at 3 with the reason, so a future trailing-line "improvement" fails here rather
than silently re-crossing the threshold. `FOOTER` is now a named constant carrying the same
rationale.

## PR + CMAP (2026-09-01)

PR #1575. **CMAP: gemini=APPROVE, codex=APPROVE, claude=APPROVE** — all three HIGH confidence,
no blocking issues. Claude's review independently verified the things worth verifying: no stale
formatter callers anywhere in `packages/`, nothing downstream parses the frame, both reset lanes
(`self.ts:792` and `index.ts:355`) route through `assembleReorientation` so the reply channel
reaches self-refresh *and* architect-driven resets, and the skeleton mirror is already correct.

Four non-blocking findings; acted on three, filed one.

1. **`arch.md` paragraph scrambled — real, mine, fixed.** My paragraph split carried three #1494
   sentences into the new #1574 paragraph, stranding "That third class exists…" from its
   antecedent. Restored to the end of the #1494 paragraph.
2. **Builder→builder sends carry a misdirecting reply hint.** `!isArchitectTarget` is *any* →
   builder, so if builder A sends to builder B, B reads `(reply: afx send architect "…")` —
   routing B's reply to B's architect, not back to A. Filed as **#1576**, with the analysis that
   it is the same underlying gap as #1521 item 3 (the frame knows its recipient but not its
   sender's kind) and the two are worth doing together. Not fixed here: it needs sender-identity
   work in `commands/send.ts`, a #1573 file.
3. **`toAgent` type-required but not runtime-validated — fixed.** `formatBuilderMessage('x', '',
   body)` rendered `[BUILDER x MESSAGE →  | ts]`: a frame that looks self-attesting and attests
   to nothing, which is exactly the defect class this lane closes. `recipient()` now throws.
   Checked the blast radius before adding it: `handleRequest` wraps route dispatch in a
   try/catch → 500, and formatting happens BEFORE `enqueueMailbox`, so an empty recipient fails
   loudly to the sender rather than persisting or delivering a bogus frame. Matches the repo's
   fail-fast-no-fallbacks rule and the doctrine `reorient.ts:176` already states.
4. **Test nit — fixed.** The "bare task lane" case re-ran the identical unconditional
   `lines.push`; `buildInline` has no bare-task branch, so the test documented a branch that
   does not exist. Replaced with a porch-lane case, which does exercise a different tail of the
   frame (and needs `buildResumeNotice`, or R3 refuses to assemble).
