# Builder thread — pir-1620 (re-plan PR #1203, Kimi harness)

## 2026-09-04 — plan phase

**Branch setup.** Spawned on `builder/pir-1620`, but the deliverable is PR #1203 becoming
mergeable, so per the architect's note I ran `gh pr checkout 1203` in this worktree → now on
`builder/pir-1201` (Mohid's fork, `maintainerCanModify=true`, push remote configured by `gh`).
The porch init commit (`2b0d8db12`, `status.yaml` for 1620) lived only on `builder/pir-1620`,
so I cherry-picked it across; `porch status 1620` works again. **No rebase, no squash** —
Mohid's 47 commits are untouched and the `origin/main` merge happens in the implement phase.

**Divergence, measured rather than assumed.** merge-base is `4983ea83`; main is 1,606 commits
ahead, the PR 47. 17 paths changed on both sides, but only five need real thinking:

- `message-write.ts` — `writeMessagePaced` → `submitMessagePaced` (#1365). The PR's pacing
  override rode the old function; `writeMessageToSession` survived underneath, so it re-homes.
- `hold-verdict.ts` (sdk) — #1482 made `isUnverifiableVerdict` the single definition of
  "will this clear on its own?"; the PR re-forked it locally. Fork gets deleted.
- `render-gate.ts` — #1474 rewrote `findMarkerRow` with cursor-row/palette anchors and hoisted
  `top`/`cell`/`cursorRow`. The PR's region-start work is orthogonal and composes.
- `mailbox-wiring.ts` / `mailbox-delivery.ts` — echo verification (#1573) and the
  commit-then-report `delivered-unverified` policy (#1584) landed around the PR's seams.
- `tower-routes.ts` — 463+/95− on main; the `--interrupt` block still has the same shape.

`spawn-worktree.ts` / `harness.ts` / `doctor.ts` diverged by an `afx reset` → `afx refresh`
comment rename only. `kimi-session-discovery.ts` is net-new. So the merge is smaller than
"CONFLICTING in 7 files" suggests.

**Two issue claims that did not survive checking** (both flagged in the plan, neither silently
ignored):

1. *"Drop `launchLoopTail` changes already on main."* Main still has it module-local in
   `spawn-worktree.ts:803`, byte-identical to the PR's relocated copy (diffed). The PR *moves*
   it into `harness.ts` and exports it because the Kimi provider script needs it. Keeping the
   move — dropping it breaks the feature.
2. *"the branch was measured at 0.34.0."* Latest npm `@moonshot-ai/kimi-code` is **0.41.0** —
   seven minors of drift, i.e. the same failure this lane exists to repair, again.

**Blocker raised at the gate.** `kimi` is not installed here, `~/.kimi-code` does not exist,
and there is no Moonshot credential in the environment. Installing is one npm command;
**authenticating is not something I can do.** Issue items 3 (re-measure under verified
delivery) and 5 (7-scenario live demo) are blocked on that. Everything else — merge,
re-derivation, the trust security change, the plan rewrite, all unit tests — is unblocked and
will be delivered in full.

**Two design calls I want the human to see rather than discover.**

- **`multi-row-draft` escalates.** The PR classified it as "a human at the line"; the issue
  says a stuck Kimi hold must escalate. I went with the issue, and I think it is right on its
  own terms: every other detail is a cell count, and `multi-row-draft` is the verdict reached
  when the classifier *could not* count and inferred from box geometry. Cost: a human sitting
  on a real multi-line draft contributes to a liveness streak. One-line reversible.
- **`harnessOptions.kimi.autoTrustWorkspace`, not `harness.kimi.…`.** `harness.*` is the
  custom-harness namespace and `lib/config.ts:337` validates every entry with a validator that
  hard-requires `roleArgs`/`roleScriptFragment` — a settings-shaped entry there throws at config
  load and breaks `afx status` and everything else. Built-ins also win resolution, so
  `harness.kimi` is already dead config. The issue said "e.g.", so this is a gate decision.

**Also spotted, fixing as part of the merge:** main's `markerFgPalette` anchor reads
`line.getCell(0, cell)` — a hardcoded column 0. Correct for agy (`^>`), wrong for the first
profile whose marker is not at column 0, which is exactly what Kimi is (`│ >`, column 3).
Latent today; a trap laid under the next person. Generalizing it to the marker match's start
column, with a test.

**Artifacts written this phase:** `codev/plans/1620-re-plan-pr-1203-kimi-harness-a.md` (this
lane) and a full rewrite of `codev/plans/1201-support-kimi-code-cli-as-a-bui.md` — the approved
1201 plan still described the retired seed/PTY-kick design, so it described nothing the branch
implements. Both go to the `plan-approval` gate together.

**Open question for the architect:** I do not have the raw 2026-09-04 3-way lane output, only
the issue body's distillation of it. Working from the distillation unless the transcript turns up.

## 2026-09-04 (later) — raw CMAP lanes received, plan revised

Architect supplied the three raw lanes (`/tmp/pir-1620-cmap-1203-{gemini,codex,claude}.md`) and
confirmed four of my calls: keep the `launchLoopTail` relocation (his issue line was a misread of
the claude lane, which actually recommends keeping the move); `harnessOptions.kimi.autoTrustWorkspace`
accepted; `multi-row-draft` escalating accepted; the `markerFgPalette` `getCell(0)` generalization
approved as part of the merge.

Auditing my plan against the raw KEY_ISSUES (rather than the issue body's distillation) found
**four gaps**, now closed:

1. **A real defect, found chasing claude's §7** — "confirm what a builder self-send attributes to".
   The generated script queues the task with `afx send <builderId>` from inside the worktree.
   `spawn.ts:482` starts the session and only *then* `spawn.ts:488` calls `upsertBuilder`, while
   `detectCurrentBuilderId()` **throws** when no builder row exists yet (`send.ts:167`). Lose that
   race and the CLI `fatal`s, the script's `if afx send` fails, it warns once and does **not retry
   within that launch** — a Kimi builder starts with a role and no mission. Today only node's
   startup latency saves it. Fix is a bounded retry in `codev_queue_task`; reordering `upsertBuilder`
   is rejected (the row carries `terminalId`, so it would mean two upserts on the path every harness
   shares). Separately the sender resolves to the builder's own id, so the task arrives framed as a
   peer message from itself — `--raw` instead, verified at the gate.
2. **Write-guard follow-up must be bounded.** codex accepts it "if maintainers explicitly accept
   that limitation"; claude says it "should gate documenting kimi as supported, not be open-ended".
   So: file the issue before merge, reference it from the docs *where kimi is documented as
   supported*, correct the stale "no hook seam" claim, and record the maintainer's acceptance in the
   maintainer's own words.
3. **Echo-verification cost** — claude's §6 computes ~2.2 s per Kimi `afx send` (1000 ms Enter + two
   600 ms windows) with possible `delivered-unverified` on every message. Recorded as an accepted
   cost rather than discovered post-merge.
4. **A disposition table** naming every KEY_ISSUE from all three lanes and where the plan answers it —
   the skeleton of the review doc, since the acceptance bar is "addressed or explicitly dispositioned".

One conflict inside the claude lane worth recording: its §2 asserts `multi-row-draft → false` in
`isUnverifiableVerdict`, while its §3 argues that leaving it out of the stuck set makes the rule's
own failure mode silent and permanent, and asks for escalation *or* a doctor probe. We take the
escalate branch, which the architect confirmed. Noted in the table so nobody reads §2 as unaddressed.

Still waiting on the human for: plan approval, and the Kimi-credentials decision (items 3+5).

## 2026-09-05 — human decision on Kimi: items 5+6 handed to Mohid

No authenticated Kimi maintainer-side and no credentials to give. Human's call: this lane does not
run the re-measurement or the live demo; both go to @mohidmakhdoomi, who has an authenticated Kimi
and ran the original 7/7. Plan revised accordingly (still pre-approval — no `porch approve`).

What the revision actually changed, beyond deleting two work items:

- **Item 5–6 became a handoff with its consequences spelled out.** `KIMI_PROFILE` now ships on
  0.34.0-era measurement rather than a fresh capture; `markerRequiresCursorRow` is *not* adopted
  (previously conditional on captures we now can't take — so it becomes a question on Mohid's
  checklist instead of a guess); Kimi's echo behaviour stays unmeasured by us.
- **Our dev-approval gate re-scoped, and it is a better gate for it.** With no Kimi to exercise, the
  thing worth proving is that a change *for* Kimi moved nothing *else* — `render-gate.ts`,
  `message-write.ts` and `hold-verdict.ts` carry claude/codex/agy delivery for every user. Six
  non-Kimi steps now, the load-bearing ones being: generated launch scripts for the existing
  harnesses must be **byte-identical**, live claude delivery still logs `delivered` (not
  `delivered-unverified` — the #1573 echo path is timing-dependent and least likely to be caught by
  a green suite), and a claude draft still holds as `busy:user-text` rather than an unverifiable
  verdict (proves the `isUnverifiableVerdict` edit didn't widen the escalation class).
- **A seven-step checklist for Mohid** in item 7, to be posted on #1203 when the implementation
  commits land: exact commands, the eight fixture filenames, which spike drives each measurement,
  the one question we cannot answer (does anything but the composer match `/^\s*│\s*>/`?), and
  where evidence goes (`codev/evidence/1620-kimi-measurement/`). Step 2 is flagged as the one that
  can block the merge: if a post-reply steady-state composer grows past one interior row, the
  `growsWithDraft` rule holds every later message forever and must not ship.
- **A new risk, named rather than buried**: we ship a Kimi feature none of us ran, on measurements
  seven minors old — the same staleness that made #1203 un-mergeable, recurring. Mitigation is
  procedural and partial and the plan says so.

The review doc will state plainly that live re-verification was not performed by this lane, and
name the 0.34.0 → 0.41.0 drift.

## 2026-09-05 — standing rule: no outward posts from this lane

Architect standing rule: do not post to PR #1203 or any of @mohidmakhdoomi's threads. Every outward
artefact — handoff checklist, PR description, summary comment — is drafted to `/tmp` and the human
approves it before it goes out.

Verified I had not already done so: `gh pr view 1203 --comments` and `--json reviews` show the last
entries are Mohid's (2026-08-09) and Waleed's (2026-09-04, 2026-09-05). My `gh` use has been
read-only (`pr view`, `pr diff`, `pr checkout`); the only writes were the commits the architect
asked for on the branch.

Folded the rule into the plan as its own **Outward communication** section rather than leaving it in
this log, because item 7 previously said the checklist would be "posted as a PR comment the moment
the implementation commits are pushed" — a future reader could have taken that as an instruction to
this lane. The section also names the two things the rule does *not* cover, so they are not
ambiguous later: pushing commits to `builder/pir-1201` continues (that is the deliverable, not a
message), and reading the PR continues.

First outward draft is ready for approval: `/tmp/pir-1620-draft-mohid-checklist.md` — the seven-step
handoff. Written to be received by a contributor whose work sat for 26 days through no fault of his:
opens by owning the delay, states plainly that the live verification is a request rather than an
assignment, flags step 2 as able to block the merge, says a negative echo result is a good outcome
rather than a failure, and surfaces the two places we reversed his judgement (`multi-row-draft`
escalation, the trust refusals) as things to argue with rather than as decisions handed down.
