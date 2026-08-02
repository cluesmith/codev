# Review: Builder context reset as a first-class flow (Spec 1273)

**Protocol**: ASPIR (strict, porch-driven) · **Issue**: #1273 · **Branch**: `builder/aspir-1273`

## Summary

`afx reset <builder>` turns the hand-run context-reset procedure into a supported command: request a
save-state, **verify** it, wait for the builder's turn to end, `/clear`, then re-orient with the same
protocol framing a fresh spawn delivers. `afx interrupt <builder>` wraps the ESC-into-PTY recovery that
previously lived only in architect lore. Builder-facing wait discipline moves into the role document so
the wedge that motivated all of this is less likely to recur.

The problem being solved: `afx spawn --resume` reattaches the *same* conversation, so a builder that has
exhausted its context resumes exhausted. There was no supported way to give a long-running builder a fresh
window without losing what it knew.

Seven implementation phases, 3894 → 3976 tests, 48 files.

## What shipped

| Phase | Deliverable |
|---|---|
| 1 | `afx interrupt` — ESC delivery via a new Tower `escape` route |
| 2 | `lastDataAt` surfaced on serialised terminal info — makes output quiescence measurable by a client |
| 3 | Receipt gate — nonce, substance floor, size stability |
| 4 | Builder context resolution — protocol, mode, harness capability, artifact paths |
| 5 | Re-orientation assembly — complete-or-abort |
| 6 | The `afx reset` orchestrator + CLI wiring |
| 7 | Wait discipline in both role docs; `afx reset`/`afx interrupt` in both command-doc and both skill trees |

### The four safety invariants

- **R1** — never clear without a persisted re-orientation. Assembly and the `.builder-reorient.md` write
  precede every destructive step; assembly failure returns with the builder untouched.
- **R2** — never clear without a *verified* receipt. Missing, stale-nonce, undersized and still-growing
  state files each abort with no clear.
- **R3** — the re-orientation is complete or it throws. No code path returns a partial frame.
- **R4** — never clear mid-turn. Bounded wait → **exactly one** ESC escalation → bounded wait → abort.
  No third attempt, no "clear anyway".

Every gate fails toward *not clearing*. A refused reset leaves a builder with its context and a saved
state file; a wrong clear is unrecoverable.

## Architecture Updates

Facts worth carrying into `codev/resources/arch.md` (cold tier — none of these belong in the capped hot
file):

- **Tower's `escape` route ignores the message body.** `POST /api/send` with `escape: true` calls
  `writeEscapeToSession`, which writes a hardcoded ESC and discards `message`
  (`servers/message-write.ts:46`). It is *not* a general raw-write channel — `raw: true` is. Anything that
  needs literal text typed into a PTY (`/clear`, slash commands) must use `raw`.
- **`status: 'running'` is not evidence a terminal is writable.** A session whose shellper connection died
  reports `running` until teardown while every write is dropped (#1198). `PtySession.writable` is the
  honest signal; it is now serialised into `info` and reaches clients via `TowerTerminal.writable`.
- **The builders registry does not carry protocol or mode for spec-type builders.**
  `builders.protocol_name` is NULL for every SPIR/ASPIR lane (`spawn.ts` never passes it on that path),
  and mode is computed at spawn and discarded — it exists nowhere in the DB. The ground truth is in the
  worktree: porch `status.yaml` (protocol, phase), `.builder-prompt.txt` (`## Mode: STRICT`),
  `.builder-start.sh` (the real harness launch line).
- **The role frame survives `/clear`.** Roles are injected via `--append-system-prompt`, a process flag.
  Only the initial *user* prompt (protocol/spec/porch framing) is lost, which is what re-orientation must
  restore — not the role text.
- **`--resume` re-injects nothing** when a resumable session is found; the builder prompt is only built on
  the fresh-launch path. "Re-inject context the way `--resume` does" therefore means reusing
  `buildPromptFromTemplate` + `buildResumeNotice`, the *fresh-path* machinery.
- **`GET /api/terminals/:id/output` existed with no client binding** until this spec added
  `TowerClient.getTerminalOutput`. Worth remembering as a class: a missing binding makes an existing
  capability invisible.

## Lessons Learned Updates

**A majority APPROVE is not consensus.** Across this project, **four times** two reviewers approved code
that contained a real defect, and each time the single dissenter was correct on the facts. Phase 5's
`input_description` covered half of spawn's entry points; phase 6 shipped addressing that contradicted its
own docstring, a blank `--dry-run` output, CLI flags that silently disabled R2/R4, and a confirmation step
that could only pass in tests. Decide on the argument, not the count — and a reviewer who dissents every
round may be tracking a *defect class* rather than nitpicking.

**Test the boring wiring, not just the dangerous logic.** The orchestrator — the part that got the careful
design, the step log, the ordering proofs — was essentially right from the first iteration. *Every* phase-6
defect was in the thin wrapper. A pure state machine over injected ports is structurally blind to how those
ports are bound: it cannot see whether `sendRaw` went to Tower's `raw` or `escape` route, whether the
builder was resolved by exact id or the shared resolver, or whether an optional port method exists in
production at all. The separate command-surface test file added mid-phase caught four regressions.

**Beware steps that report as attempted but can only succeed in tests.** Two defects had this exact shape:
`/clear` bound to the escape route (reports a clean run; builder keeps its context) and `readRecentOutput`
left unbound (reports `clear-unconfirmed` forever, having never looked). Both had passing tests, because
the mocks supplied what production did not. When a check can only pass under test, it is worse than absent
— it manufactures false confidence.

**Types close the "field is missing" class, not the "field is wrong" class.** Phase 5's structural fix —
typing the port against the canonical `TemplateContext` — was correct and would not have caught the very
next defect, because `input_description` was always present and always type-correct, merely wrong. Values
that must match another module's literal output need tests pinned to those literals.

**A docstring asserting an invariant is not evidence of it.** I wrote "addressing is reused verbatim from
`afx send`" and then used an exact-match lookup. That is worse than the gap: a later reader auditing
addressing consistency would have read the comment and moved on. When a comment says "this reuses X",
open X.

**Distinguish "refuse on unknown" from "refuse what fails silently".** Reset treats an unreported
`lastDataAt` as a refusal but an unreported `writable` as fine. That looks inconsistent and is deliberate:
an unobservable turn state fails silently *and destructively*; an unobservable write path fails loudly and
harmlessly. Conservatism should be spent where failure is quiet.

**An abort that names the wrong cause is a bug even when the invariant held.** A vanished terminal was
reported as "your Tower is too old" — safe, but it sends the operator to check a version number while
their builder is gone. If the argument for a design is that the operator gets evidence, wrong evidence is
a defect.

**Process (strict mode):** take the consultation task from `porch next` and run *that*. I ran consults
directly for six rounds; porch never registered them and its counter drifted five iterations behind. The
files were genuine so the history reconstructed cleanly, but porch does not watch what it did not ask for.

## Deviations from the plan

- **Phase 5's `buildResumeNotice` reuse moved from `inline` to `longForm`.** The plan said the verbatim
  reuse would sit inline. `buildResumeNotice` opens with "This is a **resumed** builder session", which is
  false after a reset, and is seven lines in a frame whose paced-write size is a tested constraint. The
  long form preserves the property the plan was protecting — one copy, no drift, `porch init` fallback
  intact — without telling a freshly-reset builder something untrue about itself.
- **`taskText` was threaded through `ResolvedBuilderContext`** (a phase-4 type) during phase 6's
  `input_description` fix, because the ad-hoc-task spawn lane is otherwise indistinguishable from the
  issue-driven one.
- **Phase 4 deliberately did *not* add a `mode` column to the builders table.** It would be NULL for every
  currently-running builder, so the worktree derivation is required regardless, and the column would
  duplicate a fact the worktree already holds. Flagged to the architect as reversible.

## Known gaps

- **Scenario 14a is covered at the port level, not the PTY level.** The existing terminal harness mocks
  `node-pty` and cannot model an agent's *turn*, which is what a wedge consists of. A PTY-level test would
  assert ESC delivery (phase 1's territory) while appearing to cover wedge recovery. The two port-level
  tests model the wedge where it is observable to reset, with a control proving the flag rather than the
  harness makes the difference. Declared under the plan's explicit escape hatch.
- **The headline path has not been run end-to-end against a live builder.** `afx reset` needs
  `pnpm -w run local-install`, which restarts Tower and affects every builder in the workspace. Per the
  architect, this happens in the **post-merge verify window**, with the restart timing possibly waiting on
  the shannon workspace stabilising. **3976 passing tests is not "it works"**, and nothing in this review
  should be read as claiming otherwise.
- **RESOLVED (2026-08-02): clear-confirmation removed, because the signal does not exist in that stream.**
  The live e2e passed — the clear executes — and it finally supplied the calibration data. Measured
  against the probe's real 10,001-line scrollback rather than reasoned about: the structured markers an
  executed `/clear` produces (`<command-name>/clear</command-name>`) live in the **agent's conversation
  payload, not the PTY bytes** — every occurrence in the buffer was the probe *writing about* them, none
  was the harness emitting one, so matching on them would fire when a builder *discusses* `/clear` and
  never when one executes it. No screen-wipe escape is emitted either (zero hits for ED2/ED3/home+clear/
  RIS across the whole buffer). And the stream is ANSI-fragmented with per-word cursor positioning
  (`CONTEXT\x1b[11GRESET`), so plain substring matching is unreliable even for text that *is* displayed.
  `confirmClear`, both confirmation step names and the `readOutput` port are gone. Four attempts at this
  check produced four wrong answers; the fifth was to stop answering. **A step that can only ever report
  one answer manufactures confidence**, and the honest report says nothing rather than something false.
- ~~**The clear-confirmation *pattern* is unvalidated.**~~ Confirmation now reads only output produced after
  the clear, which structurally excludes reset's own text — that class of false positive is closed. But I
  have never observed what a real Claude Code `/clear` actually emits, so the strings it matches
  (`context cleared`, `conversation cleared`, …) are still an educated guess. `clear-confirmed` should be
  read as *"the harness said something clear-like"*, never as proof the context was discarded. The live
  e2e is what will settle it, and the pattern may need adjusting afterwards. This is why confirmation is
  advisory and report-only: the re-orientation is correct either way.
- **`codev/` and `codev-skeleton/` copies of `agent-farm.md` carry ~375 lines of pre-existing drift**
  unrelated to this work. The sections added here are byte-identical across both trees; the existing drift
  is out of scope and left for a reconciliation pass.

## Verify phase — the e2e found it non-functional (2026-07-31)

The live run vindicated the caveat above: **the headline path failed on every lane in production**, and
every failure was in *resolution*, upstream of the destructive path. The R1–R4 invariants held —
`--dry-run` wrote nothing, every failure was a refusal rather than a corruption, and no builder ever
received a wrong re-orientation.

**F1 — wrong-winner project selection (blocker, all lanes).** `readPorchContext` returned the *first*
directory under `codev/projects` with a parsable `status.yaml`. Correct for a repo with one project dir;
wrong here, because porch history is committed to `main` and every worktree inherits every project ever
run — 203 of them. The alphabetically-first is a `spider`-era project, so every builder resolved protocol
`spider` and died on `Protocol "spider" has no builder-prompt.md`.

The comment I had written at that function — *"when a worktree somehow holds more than one project
directory"* — named the assumption that broke. It was not "somehow": it is the normal state of every
worktree in this repo. **Writing down an assumption is not the same as checking it.**

**F1b — the fix's own regressions, both found by review.** Narrowing the match orphaned the
`--task --protocol` lane (porch stores the raw `builder-task-<id>` there), which produced a *silently
degraded* frame — a porch-driven builder told it had no porch. That is worse than the loud bug it
replaced. Then the first fix's bare-number matching still let issue 799's PIR project claim
`builder-bugfix-799`. **Narrowing a match is as dangerous as widening it**, and the wrong-winner class
took three passes to actually close: alphabetical → numeric collision → protocol corroboration.

**F2 — the task lane could never auto-detect its mode.** Mode detection requires a `## Mode:` line that
`--task` spawns never render. Now defaults to soft with `modeSource: 'task-default'`, scoped to the
no-porch case, because *strict* means porch orchestrates and a builder with no porch project cannot be
strict.

**F3 — reported, but not a defect here.** The printed path came verbatim from the registry and was
correct; the id/directory case divergence originates at spawn. Matching is now case-insensitive anyway so
a case-sensitive filesystem behaves like macOS.

### A deliberate reversal

`status.yaml` is no longer allowed to override the builder id on the **protocol** field. It remains
authoritative for a builder's own project, but it can no longer *decide which project is its own* — the
two principles cannot both hold, because the signal is identical in each case. A hypothetical
protocol disagreement within one project is the cost; adopting a stranger's project was actually
happening.

### The lesson this phase adds

**"Tests pass" and "CI is green" could not have found any of this.** Every F1 variant was a property of
*this repo's data shape* — 203 inherited project directories, a number reused across protocols — that no
unit fixture encoded because I wrote the fixtures from my model of the world rather than from the world.
The e2e was the first thing to run reset against reality, and it failed instantly on every lane. That is
the strongest possible restatement of the hot-tier lesson: *"it compiled" / "tests pass" is not "it
works" — verify the real user path end-to-end.*

### The delivery seam — `/clear` was never executed (2026-08-01)

The live e2e's forensics closed the loop on the headline path. `afx reset`'s `/clear` **never ran**: it
arrived as literal text welded onto the front of the re-orientation, one merged user turn beginning
`/clear### [ARCHITECT INSTRUCTION...`. The probe's context was fully intact — it could still recite a
secret word planted before the "reset" — while every layer reported success.

**Root cause.** `writeMessageToSession` schedules the Enter that submits a message 50–80ms out and
returns that offset without awaiting it; `/api/send` responded off that. So an awaited send resolved
*before its own message was submitted*. Reset awaited the `/clear` write, sampled output, then wrote the
re-orientation — inside the window, into the same composer, ahead of the Enter. One Enter submitted both.

This also retro-explains the phase-6 clear-confirmation defect: at the moment the check sampled output,
the clear had not been submitted. **Two bugs, one seam.**

**Fix**: a per-session submission lock (`servers/session-submit.ts`), wired to the escape and
immediate-delivery paths. `await submitToSession(...)` means *submitted*, not *scheduled*.

**Ordering is not atomicity.** `SendBuffer` already serialises within a flush, and Spec 1307's per-session
FIFO fixes delivery *order*. Neither would have prevented this — the two writes were correctly ordered
and still coalesced. Being second is not the same as being separate. Worth carrying: the two properties
look interchangeable in a design discussion and are not.

**Scope, stated because the first framing was overbroad**: the lock covers what takes it — the two
`/api/send` paths. Buffer flush, cron delivery and the raw write endpoint still write directly; human
keystrokes deliberately always will.

## Flaky Tests

None encountered. No tests were skipped by this work.

## Testing

- 3976 unit tests passing, 48 pre-existing skips; build clean.
- `afx reset --help`, and the invalid-flag rejections (`--quiet-window=-1`, `--timeout=nope`,
  `--min-bytes=0` each exit 1), verified against the real `afx` binary rather than the build output.
- Not run: the live end-to-end reset (see Known gaps).
