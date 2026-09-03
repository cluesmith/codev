# pir-1482 — F1: Tower-vs-PTY dimension divergence (render gate)

## 2026-09-03 — PLAN phase

Investigated #1482 against HEAD (`cc83b6a3`) before writing anything. Findings that
changed the framing versus the issue body:

- **The gate does not read `session.info.cols/rows`.** `classifyAgentScreen`
  (`mailbox-wiring.ts:185-190`) classifies at the *mirror's* own dims
  (`SessionScreen.read()` → `_cols/_rows`). The architect's pre-spawn comment noted line
  drift; this is a semantic drift too. Conclusion is unchanged but sharper: the mirror's
  geometry has exactly two sources, and both take Tower's belief on faith
  (`pty-session.ts:568-572` on resize, `:488` on lazy mirror creation).
- **`shellper-main.ts:89` is the weakest of the four claims.** `ShellperProcess.handleResize`
  (`shellper-process.ts:447-459`) already caches dims and guards `this.pty && !this.exited`,
  and re-applies them across a SPAWN relaunch (`:495`). The `ptyInstance?.` no-op window is
  between `createPty()` and `.spawn()` — synchronous and adjacent. Kept in scope (cheap, makes
  the adapter honest) but not sold as the live defect.
- **The reconciliation channel already exists and is being thrown away.** WELCOME carries
  `cols`/`rows` (`shellper-process.ts:386-387`); `ShellperClient` parses the frame and adopts
  `command`/`args`/`lastDataAt` from it but drops the dims (`shellper-client.ts:342-381`).
  That is the natural fix for the post-restart case, and it follows an existing precedent
  (`welcomeCommand`/`welcomeArgs`, PIR #1475).
- **Two columns' worth of design pressure, resolved to one.** `detail` needs no CHECK
  constraint (SQLite can't ALTER one in; a CHECK in `GLOBAL_SCHEMA` only would break the
  migration suite's fresh-vs-upgraded convergence invariant). Precedent: v16 `command`,
  v17 `not_before`. And no `detail_since` column — the changed-only guard on the new
  `setHeldVerdict` keeps `updated_at` meaning "when the verdict last moved", and the
  drainer's existing `notCleanStreak` supplies the confirmation count for the
  "composer occupied since" hint.

Plan: 4 phases in one PR. Phase 1 is #1483's "first slice" (detail on the held row + every
surface) and stands alone; Phase 2 makes `resize()` commit only what landed (with
requested-vs-applied dims so a pre-spawn resize is still honoured); Phase 3 adopts and
reconciles the shellper's WELCOME dims on attach; Phase 4 pins it all with tests, including
a dims-sensitivity characterization test over an already-committed gzipped fixture.

Conflict surface noted and mitigated in the plan: PR #1491 owns `render-gate.ts` (so Phase 4
adds a test there and changes no behaviour), PR #1486 owns `commands/inbox.ts` FROM → TO
(so the inbox edit is confined to the REASON column).

Constraint carried from the issue: we are not cluesmith/codev maintainers. Do not merge,
do not close, do not clean up the worktree.

**Gate: plan-approval pending.**

## 2026-09-03 — IMPLEMENT phase

Plan approved by the human; architect confirmed one PR, four commits, and re-verified every
load-bearing claim against HEAD independently.

### Two things the plan did not anticipate

**1. The attach re-send undid the adoption it was paired with.** Phase 3 adopts the shellper's
WELCOME geometry, then re-sends the requested geometry so a viewer still wins. Written as
"re-send when requested !== applied", that fires for a session whose *constructor defaults*
merely differ from the running geometry — which is Tower's memory, the very thing the adoption
just corrected. The first attach test caught it (adopted 139×63, immediately reverted to
104×101). Fixed with an explicit `resizePending` flag: set when a resize is dropped, cleared
when one lands, and the only thing that authorizes a re-send. Adoption re-bases the request
unless one is genuinely outstanding. Worth noting because "requested vs applied" felt like
enough state and was not — the missing bit was *outstanding*, not *different*.

**2. `setWelcomeGeometry` briefly got cleared inside `setIdentity`'s reject path.** A scripted
edit landed the geometry reset in the wrong function — an invalid *identity* would have thrown
away a perfectly good *geometry*. Caught on read-back before building. They are independent
capabilities and stay that way.

### Design decisions taken during implementation

- `formatVerdict` / `isUnverifiableVerdict` live in a NEW `agent-farm/utils/hold-verdict.ts`
  rather than in `utils/message-format.ts` — the latter is about formatting message bodies for
  PTY delivery, and it is one of PR #1486's files. New module, zero conflict surface.
- The dashboard gets a PORTED copy (`formatHoldVerdict` in `apps/web/src/lib/heldMail.ts`),
  not an import: the web app must not import from codev-core (#1189), and `heldMail.ts` already
  documents that exact precedent for its age formatters.
- `CronDeliveryResult` gained `detail` too. Not in the plan, but a cron send has no human
  waiting on a response, so its log line is the ONLY place that hold is ever described.
- The REST resize routes now answer **409 RESIZE_DROPPED**, distinguished from 404 by an
  existence check. The old code answered 200 and echoed back the requested dimensions, which is
  precisely how a divergence became invisible.

### Measurement recorded in the test suite

Swept the committed `claude-smallring-idle` fixture (true 139×63) over columns 131/135/139/143
× rows 61/63/65. At the true row count, **139 and 143 classify CLEAN; 135 and 131 classify
`busy:no-region-end`**. A four-column disagreement is enough, and `no-region-end` never clears
on its own. That measurement is now `render-gate.test.ts`'s dimension-sensitivity suite — it
changes no behaviour, it is the executable statement of the premise the rest of the issue rests
on.


## 2026-09-03 — dev-approval evidence round

Architect asked for running evidence rather than description. Induced 5 of 6 items live from
this worktree's build against an ISOLATED database (`NODE_ENV=test` + `AF_TEST_DB`), so the
user's live `global.db` was never opened. Full transcript committed at
`codev/projects/1482-f1-tower-vs-pty-dimension-dive/1482-dev-approval-evidence.md`.

**Item 3 (`afx send` held line) could not be induced.** `send.ts:340` is `new TowerClient()`
with no port, so the CLI reaches only the live Tower on 4100. Declined to point evidence at a
real Tower with real agents behind it. Worth noting as a testability observation, not a defect
of this change: `inbox.ts` takes `options.port` and is drivable against a stub; `send.ts` is
not. Nothing in scope here, but it is why one item has no live transcript.

**The architect caught that my reported test gap was too narrow.** I said "no test asserts the
send CLI's held sentence"; the truth was that NOTHING referenced `utils/hold-verdict.ts` at
all — the whole new module was untested, including `isUnverifiableVerdict`, which gates a
user-visible warning about permanently-stuck mail. Lesson for me: when I notice one uncovered
line, check whether the module around it is covered before reporting the gap's size. I
reported the symptom I happened to trip over rather than sweeping for the boundary.

Added `hold-verdict.test.ts` (9) and `send-hold-warning.test.ts` (6). The latter drives the
real `send()` with a mocked Tower client, and had two wrinkles worth recording:
- `vi.mock` of `lib/tower-client.js` must spread `importOriginal()` — the module also exports
  `AGENT_FARM_DIR` and `DEFAULT_TOWER_PORT`, and a bare factory breaks unrelated imports.
- `detectCurrentBuilderId()` keys off cwd and ABORTS inside a `.builders/<id>/` path when it
  cannot resolve a canonical id from global.db (#1094 anti-spoofing). The suite runs from
  exactly such a path, so the tests chdir to a temp dir; the sender then resolves as
  `architect`, which is what an operator in a workspace root actually is.

**Mutation-checked both new suites** rather than trusting green: forced `isUnverifiableVerdict`
to `return false` and `formatVerdict` to drop the detail → 8 failures. Restored byte-for-byte
(`git diff` empty), re-ran green. Worth doing for any test written to close a gap someone else
found — a test that cannot fail is worse than the gap, because it ends the conversation.

### The evidence file's home — I was right to flag it, wrong about where it goes

I committed the evidence under `codev/state/` with `git add -f`, because that was the path I
was given and `.gitignore:15` ignores `codev/state/*.md`. I flagged the override in the commit
message rather than doing it silently. The architect's answer: the instinct was right, the path
was wrong. `.gitignore:14-16` states the reason for that rule outright — *architect state files
are per-person; builder `*_thread.md` files ARE versioned (#1192)*. Gate evidence is neither of
those things, so it was never in scope for that directory.

Correct home is the versioned per-project directory, which already existed for this project and
is where `.md` supporting artifacts have always shipped (only `*.txt` iteration logs are ignored
there, `.gitignore:65`):

    codev/projects/1482-f1-tower-vs-pty-dimension-dive/1482-dev-approval-evidence.md

`git mv`'d, and the un-forcing was *proved* rather than assumed: `git check-ignore -v` on the new
path exits 1 with no output (on the old path it still prints `.gitignore:15`), and I unstaged the
new path so it fell back to untracked `??`, then re-added it with a plain `git add` — no `-f`.
It is tracked by the normal rules. `codev/state/` holds only this thread log again.

**The generalisable bit:** an ignore rule carries a *reason*, and the reason is usually written
next to it. When a path fights you, read the comment above the rule before reaching for `-f`.
Here it said "per-person", and one glance would have told me a gate evidence record is not that —
the override was avoidable, not just flaggable. Flagging a smell beats suppressing it silently,
but diagnosing it beats both.

### Three things the architect asked be carried into the review doc

Recording verbatim so they survive a context refresh. **These are directions for
`codev/reviews/1482-f1-tower-vs-pty-dimension-dive.md`, not optional colour.**

1. **Item 4 leads the Summary.** The user-visible harm this issue removes is not diagnosability
   in the abstract — it is that *"the old single body offered `afx interrupt` for every hold. In
   the first case above that is advice to interrupt a human mid-draft."* The owner starvation
   notice told an operator to interrupt someone who was simply typing. Splitting the notice into
   a safe branch and a defect branch is the strongest argument in the PR; lead with it.
2. **Keep the FROM→TO truncation note.** Evidence item 1 calls out that `architect:main -> pir-1`
   is the PRE-EXISTING 22-char FROM→TO truncation, not a regression from widening the REASON
   column 13→20. The architect's point: that distinction is what stops a reviewer filing a false
   bug against this PR, and it is the kind of thing that usually goes unsaid. Say it.
3. **Keep my own correction verbatim in the evidence file.** I had earlier summarised the dropped-
   resize WARN as firing from `resizeSession`; it actually fires on the WebSocket control-message
   paths. The architect explicitly thanked me for correcting my own summary rather than letting a
   wrong claim ride into the human's review, and asked that the correction stay in the evidence
   file word-for-word. Do not tidy it away when writing the review — a corrected claim with its
   correction attached is more trustworthy than a claim that was quietly right the second time.

Also noted by the architect, worth keeping as a habit rather than an anecdote: mutation-checking
the new suites was the right instinct, because *a test that cannot fail is the defect #1471 exists
to fix.* Writing a test to close a gap someone else found, and not checking that it bites, would
have shipped a second instance of the bug the repo already has an issue open about.
