# air-1709 — `/arch-save` next task → `/arch-init` starts on it

Issue #1709. AIR protocol, strict mode. Docs-only feature: both halves of the change are
skill documents, so the shipped SKILL.md text *is* the implementation.

## 2026-09-19 — implement

**Surveyed first.** Grepped both trees for prose describing the `/arch-save` cycle. Hits
outside the two skills were all incidental references, not descriptions of the argument
contract or the banner:

- `builder-refresh/SKILL.md` — "Counterpart to the architect's /arch-save" in frontmatter only.
- `codev/resources/commands/agent-farm.md:514`, `packages/sdk/src/tower-client.ts:797`,
  `agent-farm/commands/reset/{constants,self}.ts` — all about the *delayed send* and the
  clear/re-entry ordering, none about arguments. Left alone.
- `codev/roles/architect.md` (identical to `codev-skeleton/roles/architect.md`) — **does not
  mention `/arch-save` at all**. The issue named it as a candidate; it needed no change.
- `codev/specs|plans|reviews/1307-*` — historical artifacts of the original cycle. Not
  living docs; left alone.

**Changes.** `arch-save`: `argument-hint`, the intro (three invocation forms), step 1
rewritten as "resolve your name, then split off the next task", a next-task block at the end
of step 3, and the optional `⏭ NEXT TASK` line in the state-block template. `arch-init`:
old step 3 split into 3 (orient, now naming the next task) / 4 (start on it) / 5 (follow the
state file), plus one sentence in "Saving your state" so that section does not contradict
step 4.

Two decisions worth recording:

1. **`afx whoami` now runs unconditionally**, where before it ran only when `$ARGUMENTS` was
   empty. The split in rule 2 compares the first token *against the whoami name*, so the name
   has to be known before the arguments can be parsed. Consequence: the non-zero-exit branch
   could no longer be an unconditional STOP, or `/arch-save main` would break whenever whoami
   was down. Written as: no name yet → a single validating token is still accepted as one,
   anything else stops and asks. That preserves both the old back-compat path and the
   never-default-to-`main` guard (#1094).
2. **`⏭ NEXT TASK` goes in the banner, not a dated log entry.** `/arch-init` reads the banner
   plus the most recent dated section; the banner is the half that is unambiguously read
   first, and it is where the existing `⭐ THIS /clear IS INTENTIONAL` resume instructions
   already live.

**Tests.** `packages/codev/src/agent-farm/__tests__/air-1709-next-task.test.ts`. Four-copy
parity for *both* skills — repeated for `arch-init` on purpose, since
`spec-1134-arch-init-skill.test.ts` compares only `instance/.claude` against
`skeleton/.claude` and would pass with a stale `.codex` copy. Content assertions pin each
acceptance criterion: the three invocation forms, the three split rules, back-compat, the
verbatim rule, replace-vs-preserve, the template line, the orient label, orient→next→state
ordering, the not-a-pre-spent-approval limits, and the delete + log-the-pickup rule.

Worktree had no `node_modules` on spawn; ran `pnpm install --frozen-lockfile` before testing.

## 2026-09-19 — pr + CMAP

PR #1710. CMAP all three: **gemini=APPROVE, codex=APPROVE, claude=APPROVE**, all HIGH
confidence. (Note for the architect: the agy/gemini lane produced a clean VERDICT block on
a `--type pr` review here — the known "agy consult broken for `--type`" issue did not
reproduce.)

Gemini and codex found nothing. Claude approved with four observations; I verified each
against the files before acting.

**Applied** (additive doc/test only, no behavior change):

- *Next task survives the STOP branch.* whoami down + multi-token `$ARGUMENTS` falls through
  rule 2 (not a single token) and rule 3 (no name from whoami) to "stop and ask". The outcome
  was right but the doc never said the task text is still in hand, so an implementer could
  reasonably make the owner retype it. One sentence added.
- *The pair is asymmetric, and now says so.* `/arch-init` takes no next task, so any argument
  there is unambiguously a name and overrides whoami outright; `/arch-save` weighs the first
  token *against* whoami. `arch-init`'s frontmatter still advertises "an explicit name
  argument overrides" and is still correct for itself — the gap was that `arch-save` did not
  acknowledge the difference. One paragraph added there.
- *Test nit:* `/\*\*first\n\s+action of the resumed session\*\*/` pinned a hard line wrap; a
  pure reflow would have failed it with no semantic change. Relaxed to `\s+`.
- *Parity duplication:* confirmed — `spec-1307-arch-save-skill.test.ts:41` already asserts
  four-copy parity for `arch-save`. Kept the duplicate so both skills of one feature fail
  together, and said so in the file header.

**Referred to the architect, not applied:** claude's first finding. The explicit-name
override is narrower than before — previously *any* non-empty `$ARGUMENTS` was the name, now
only a first token equal to whoami's (or a lone validating token when whoami fails). The
uncovered case is whoami answering with the *wrong* architect: `/arch-save tower` from a
session whoami calls `main` writes to `main`'s file, and the argument cannot override it.
That is the #1094 failure class, and identity misreport is a scar this repo has taken.

It is also exactly what the issue prescribed (rules 3 and 4), so it is a baked decision and
not mine to reverse. Claude suggested an additive guard costing one sentence: *first token
validates as a name, differs from whoami's, and `codev/state/<token>.md` exists → stop and
ask.* Flagged via `afx send`; the architect's call.
