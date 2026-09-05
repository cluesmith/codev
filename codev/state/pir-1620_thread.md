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
