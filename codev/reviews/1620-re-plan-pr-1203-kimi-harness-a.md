# PIR Review: Re-plan PR #1203 (Kimi harness) against converged main

**Issue**: cluesmith/codev#1620 · **PR**: cluesmith/codev#1203 (author @mohidmakhdoomi)
**Branch**: `builder/pir-1201` — merged, never rebased or squashed.

## Summary

PR #1203 was complete and green on 2026-08-09, then sat un-re-reviewed for 26 days while `main`
advanced 1,606 commits and rebuilt three of its four core seams. The 2026-09-04 3-way review found
the design sound and the branch un-mergeable. This lane merged `main` in, re-derived every moved
seam, closed a security gap and a latent spawn-race, rewrote the stale plan, and left the Kimi-side
live verification to the original contributor.

**PR #1203 is now `mergeable: true`** (GitHub reports `blocked` only in the review-required sense).
Full suite: **5,940 passed, 0 failed**.

## What this lane did NOT do — read this before merging

**Nobody here ran Kimi.** There is no authenticated Kimi CLI on the maintainer side and no
credentials to supply (human decision, 2026-09-05). So:

- The Kimi render-gate profile, the `growsWithDraft` box-growth premise, the 1000 ms Enter delay,
  the trust-record naming scheme, and the `kimi -c` newest-session semantics all still rest on
  **0.34.0** measurements taken 2026-08. Latest is **0.41.0** — seven minors, and 0.33.0 was itself
  an engine change. **This is the same staleness that made #1203 un-mergeable, recurring.**
- Kimi's behaviour under #1573/#1584 echo verification is **unmeasured on any version**.
- Whether Kimi honours bracketed paste (#1567) is **unmeasured**.

Re-measurement and the live demo are handed to @mohidmakhdoomi, whose evidence attaches to
PR #1203. An eight-step checklist is in the plan. **Checklist step 2 can block the merge**: if a
post-reply steady-state composer grows past one interior row on a current Kimi, the
`multi-row-draft` rule holds every later message forever — a liveness bug, not a fail-safe one —
and must not ship as written.

Our own `dev-approval` was therefore scoped to what *is* verifiable without Kimi: that a change
made **for** Kimi moved nothing **else**. That is the larger risk anyway — `render-gate.ts`,
`message-write.ts` and `hold-verdict.ts` carry claude, codex and agy delivery for every user.

## KEY_ISSUES disposition — 2026-09-04 three-way review

| Lane | KEY_ISSUE | Disposition |
|---|---|---|
| gemini | *(none — APPROVE)* | Both integration notes honoured: the 0.33.0 floor is unchanged, and the write-guard gap is scoped as follow-up **with the bound both other lanes asked for** (below). |
| codex | Trust pre-write silently enables repo-controlled MCP servers | **Fixed.** Two independent refusals; see *Workspace trust* below. |
| codex | The approved plan no longer describes the implementation | **Fixed.** `codev/plans/1201-…md` rewritten to the shipped architecture and re-approved by the human at the `plan-approval` gate on 2026-09-08. |
| codex | Write-guard limitation acceptable *only if maintainers explicitly accept it* | **Accepted explicitly** — see *Write-guard* below. |
| claude | Branch CONFLICTING, 1,603 behind; `writeMessagePaced`, `findMarkerRow`, `launchLoopTail` all moved | **Fixed** for the first two. The third was a **misreading**, verified: `launchLoopTail` is still module-local on `main` at `spawn-worktree.ts:803`, byte-identical to the branch's copy. The PR *relocates* it into `harness.ts` so the provider script can share it — which claude's own integration notes recommend keeping. Kept. |
| claude | New `GateVerdict` details bypass #1482's consolidation | **Fixed.** Local fork deleted; both details added to `MailboxGateDetail`, the schema comment, and `isUnverifiableVerdict`. |
| claude | `multi-row-draft` excluded from the stuck set, so the rule's own failure mode is silent | **Fixed by escalating it** — the first branch of claude's own "escalate *or* add a doctor probe". Note this **supersedes** the `multi-row-draft → false` parenthetical in the same lane's §2, which its §3 then argues against. The doctor premise probe is filed as follow-up. |
| claude | Trust pre-write should refuse on project-level MCP config | **Fixed.** |
| claude | No `PreToolUse` write guard while kimi is documented as supported | **Bounded follow-up** — see below. |
| claude | Kimi echo behaviour unmeasured against #1573/#1584 | **Handed to the contributor** (checklist step 4). The predicted cost is recorded below. |
| claude | §7, filed as "smaller": confirm what a builder self-send attributes to | **Chasing it found a real defect.** See *The spawn race*. |

## What changed

### The delivery path, re-derived twice

`main` moved the write edge under this branch **twice**: #1365 replaced `writeMessagePaced` with
`submitMessagePaced` (per-terminal lock, in-lock precheck, five-way result), and then #1567/PR #1644
replaced per-line pacing with bracketed-paste chunking — taking the 5th parameter slot the branch's
`pacing` occupied. `MessagePacing` survives, re-homed as the 6th/7th parameter.

**The subtle part, and the reason the seam still earns its place.** #1567 gave long frames their own
Enter delay, `PASTE_ENTER_DELAY_MS = 80`, measured at 0/29 losses on claude 2.1.263 and codex
0.146.0. Kimi's own bisect: **80 ms and 100 ms are swallowed and never submit**; 120/250/500/1000 ms
submit. The new default lands *exactly* on Kimi's measured failure value — the original #1201 symptom,
reintroduced by a change that had no reason to know Kimi exists. The override now governs **both**
Enter sites, and the tests pin both: a formatted `afx send` is almost always ≥4 lines, so the long
branch is the one real messages take, and short-frame-only coverage would have stayed green while
the feature was broken for every message anyone sends.

Kimi keeps the default `BRACKETED_PASTE` strategy (owner decision, 2026-09-08). This lane proposed
opting it out until measured and was overruled; the decision is recorded in the plan and pinned by a
test so a later edit to `writeStrategyForApp` has to be deliberate about Kimi.

### Gate details and the deleted fork

The branch re-forked #1482's escalation predicate as a local `Record`. Deleted — two definitions of
"will this hold clear on its own?" is one edit away from an escalation policy and an operator-facing
remedy disagreeing about the same row. `no-region-start` and `multi-row-draft` now land in
`MailboxGateDetail`, the schema comment, and `isUnverifiableVerdict`.

**`multi-row-draft` escalates, and that reverses the branch's choice.** It is defensible on its own
terms: every other detail is a cell *count*, and this is the one verdict reached when the classifier
*could not count* and inferred from box geometry — "could not verify" is the truthful rendering, and
a streak of it is exactly the drift signal. **Accepted cost:** a human genuinely sitting on a
multi-line Kimi draft contributes to a liveness streak. `surfaceLiveness` only alarms on recent
output, which suppresses most of that and, symmetrically, part of the drift case — hence the doctor
premise probe as follow-up.

The fork's *real* value — a compile error when the union grows — is preserved as a type-level
tripwire beside `isClassifierStuck`, in **source**. It cannot live in the test: this package excludes
the `__tests__` glob from `tsc`, so a `satisfies` there compiles nothing and would have read like a
guarantee while enforcing none. Verified by temporarily widening `GateVerdict['detail']`: both
assertions fail with a message naming where to classify it.

### Marker anchoring, and a latent bug found on the way

#1474's cursor/palette anchors and the branch's region-start bounding are orthogonal; both kept.
While reconciling them: `markerFgPalette` read `line.getCell(0, cell)` — a hardcoded column 0,
correct for every marker anchored at the row start and wrong for the first profile whose marker is
not, which is exactly what Kimi's boxed `│ >` (column 3) is. Latent today, a live bug the moment
anyone gave Kimi a palette anchor. Generalized to the marker match's start column, with a test.

### Workspace trust — the security change

`ensureKimiWorkspaceTrust` wrote a record for any worktree, unconditionally, on every Kimi spawn.
The original argument was that this grants strictly less than the `--yolo` the builder already runs
with. That holds for *tool execution* and not for what trust actually controls: whether kimi loads
MCP servers **defined by the folder**. Two independent refusals, both defaulting to doing nothing:

- **`project-mcp-config`** — the worktree ships `.mcp.json` or `.kimi-code/mcp.json`. Refused even
  when opted in. Existence only; the file is never parsed, because a folder shipping a *broken*
  `.mcp.json` is still a folder defining servers.
- **`not-opted-in`** — the default. `harnessOptions.kimi.autoTrustWorkspace`, a new namespace
  deliberately separate from `harness` (whose entries are validated at load against a shape
  requiring `roleArgs`/`roleScriptFragment`, so a settings key there would throw during `loadConfig`
  and break unrelated commands; and built-ins win resolution, making `harness.kimi` inert config).

The MCP check runs **first** so the log states the strongest true reason — someone who *has* opted
in needs to hear "this worktree ships MCP config", not "you did not opt in", which would be false.
The return is a `KimiTrustDecision`, not a boolean, because "no record written" otherwise conflates
a deliberate refusal with a failure.

**Consequence, deliberate:** a repo shipping a root `.mcp.json` hits the refusal on every Kimi
worktree, so unattended Kimi spawning there needs one interactive trust. Documented in both trees.

### The spawn race — a real defect behind a "smaller" review note

claude's §7 asked only what a builder self-send attributes to. Chasing it found worse:

The generated script queues its task with `afx send` from inside the worktree. `spawn.ts` starts the
session (`spawn.ts:482`) and only **then** registers the builder row (`:488`), while
`detectCurrentBuilderId()` **throws** when that row is missing (`send.ts:167`, the #1094
anti-spoofing guard). Lose that race and afx fatals, the script warned once and **never retried
within that launch** — a builder up with a role and no mission, the only trace a line in its own
pane. The sole thing preventing it was node's startup latency exceeding one local HTTP round-trip.

Fixed with a bounded retry (30 s, `CODEV_TASK_QUEUE_DEADLINE_SECS`). Reordering `upsertBuilder` was
the tempting root fix and is rejected: the row carries `terminal_id`, which does not exist until the
session is created, so it would mean two upserts on the path every harness shares.

The attribution question was real too: the sender resolves to the builder's **own** id, so the
opening mission arrived framed `### [BUILDER <id> MESSAGE → <id>] ###`, and there is no self-send
guard in `handleSend`. Now sent `--raw` — `.builder-prompt.txt` is already a fully framed prompt.

### Write-guard: the follow-up, and its bound

Kimi builders have no `PreToolUse` write-guard (#1018 class), so a Kimi builder can write into the
main checkout. **Maintainers explicitly accept this as follow-up rather than a blocker** — codex's
stated condition. claude's stricter condition is also met: the gap is now stated **where kimi is
documented as supported**, in both doc trees, and the follow-up issue is filed before merge rather
than left open-ended. The branch's earlier "no documented hook seam, parity impossible" claim was
obsolete and is corrected: kimi has documented blocking `PreToolUse` hooks since 0.32.0, which is
what makes parity achievable.

### Echo verification cost

Predicted, not measured: `enterDelayMs` 1000 plus two 600 ms verify windows makes a Kimi `afx send`
cost ~2.2 s worst case, and Kimi deliveries may report `delivered-unverified` on every message.
**That is not a fault** — #1584 commits the delivery first and reports rather than retrying, so an
unconfirmed Kimi delivery can never loop. Contributor checklist step 4 supplies the real number.

## Test Results

- `pnpm build`: clean.
- `pnpm test`: **5,940 passed, 48 skipped, 0 failed.**

Three suites broke during the merge, and one is worth recording because it was **not** the merge's
doing. `kimi-session-discovery`'s "ok when at least one session carries the load-bearing shape"
wrote a good session then a bad one and expected `ok` — but the probe *deliberately* reports drift
when the newest session is the broken one. It only ever passed where two `mkdir` mtimes tied, so it
was platform-dependent all along: 5/5 failures on APFS, where `mtimeMs` is sub-millisecond. Both the
test and its implementation are byte-identical to the pre-merge branch. Fixed with the explicit
`touchDir` ordering the very next test in the same `describe` already uses.

New coverage worth naming:
- The pacing override on **both** frame branches (see above for why short-only would have lied).
- `bash -n` parsing of every generated launch-script shape. Generated shell is the one artifact here
  no type checker reads, and this change hit exactly that twice: a backtick in a shell comment
  closed the TypeScript template literal, and an unescaped `${…}` would have been interpolated by JS.
- The spawn race as **behaviour**, not script text: a stub `afx` that fails until a sentinel appears
  reproduces the lost race; a second that never succeeds pins the fail-soft give-up path.
- The Issue #1201 span guardrail's agy case, which #1474 had silently disabled — its synthetic screen
  stopped qualifying as a marker row, so the assertion passed for the wrong reason. Restored with a
  helper that satisfies the anchors. The sibling `>x` test had the same defect and also passed.

## Flaky Tests

None. The one intermittent-looking failure (`inspectKimiStoreLayout`) proved deterministic on this
platform and was a real test defect, not flake — see above.

## Architecture Updates

Routed to the **COLD** tier (`codev/resources/arch.md`), three passages in the Kimi subsection: the
trust paragraph (the old "strictly less than `--yolo`" reasoning is now stated *and* rebutted in
place, since the conclusion changed but the narrowness that motivated it did not); the pacing
paragraph (both Enter sites, with the full bisect numbers beside `PASTE_ENTER_DELAY_MS`'s own
provenance, so the collision is unmissable next time); and the render-gate paragraph, which was
missing `growsWithDraft`, `multi-row-draft`, and the escalation decision entirely.

No **HOT** tier change. Kimi support is subsystem detail; the existing hot facts already cover the
decision surface this touches, and the cap is full of broader rules that would beat these on
displacement.

## Lessons Learned Updates

Routed to the **COLD** tier (`codev/resources/lessons-learned.md`):

1. *A suite that pins only the cheap branch can stay green while the feature is broken on the
   branch real inputs take.* The pacing suite pinned a short frame; every formatted `afx send` is
   ≥4 lines and takes the long one, whose Enter delay is exactly the value Kimi swallows.
2. *A test whose outcome depends on two filesystem operations landing in the same timestamp tick is
   platform-dependent, not flaky* — it passes on one filesystem and fails 5/5 on another, and the
   two have different fixes.

The third finding — that a `satisfies` in a `__tests__` file enforces nothing when the package
excludes that glob from `tsc` — is **not** a new lesson. #1401 already records it as "a guard is not
a guard until you have watched it fail", including the variant where a type-test file sits somewhere
the build never compiles. What was new is only that the same trap survives one directory *inside*
`src/`, where #1401's "outside src/" heuristic does not catch it, so that entry gained a clause (c)
rather than a duplicate. Its own rule was followed: the union was widened and `tsc` watched to go
red before the guard was trusted.

No **HOT** tier change: all of this is testing-practice reference material, not always-on
cross-cutting rules of the caliber currently occupying the cap.

## Things to Look At During PR Review

- **The `multi-row-draft` escalation decision** — reverses the contributor's choice; one line either
  way, and the cost is stated above.
- **`harnessOptions` as a new config namespace** — the alternative (`harness.kimi.…`, as the issue
  originally suggested) throws at config load; reasoning in the plan.
- **The bounded retry's 30 s deadline** — long enough for the race, and it delays nothing on the
  happy path since the first attempt normally succeeds.
- **Everything Kimi-facing is unverified by us.** The contributor's round is not a formality.
