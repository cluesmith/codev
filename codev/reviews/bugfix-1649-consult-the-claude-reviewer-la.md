# Bugfix #1649: the consult reviewer lane could edit the code under review

## Summary

A `consult -m claude` review lane reverted three guards in a builder's worktree mid-review — `// REVERTED FOR VACUITY CHECK` — to test whether the tests covering them were vacuous, and carried on reviewing. Two of its five `Edit` calls landed *after* the builder had already restored the files. The builder found out by diffing against HEAD; nothing else would have told anyone.

The owner's decision was to fix this by **instruction rather than restriction**: the lane keeps the capability to write and is told what the right thing is. So the fix is a new section in `consultant.md` (both trees), plus a working-tree tripwire that turns a recurrence from silent into visible.

## Root Cause

Two independent gaps, both confirmed by reproducing the incident against the real Agent SDK rather than reasoning about it.

1. **Nothing told it not to.** `consultant.md` said *"You have filesystem access — use it to verify your claims"* and stopped there. The review prompt demands rigour about test coverage, and the obvious way to establish whether a guard is vacuously covered is to remove it and re-run. Nothing in the role said the tree under review is not the consultant's to change.
2. **Nothing stopped it.** `allowedTools` is the Agent SDK's *auto-approve* list, not a capability restriction. The pinned typings (0.2.105, `sdk.d.ts:1011`) say so outright: *"List of tool names that are auto-allowed without prompting… To restrict which tools are available, use the `tools` option instead."* Under `permissionMode: 'bypassPermissions'`, `Edit`/`Write`/`Bash`/`Agent` all stay reachable regardless of what `allowedTools` lists.
3. **Nothing noticed.** No lane compared the tree before and after, so a mutation was invisible until someone happened to diff.

The reproduction also produced a finding worth keeping: **unprompted, the lane behaved well**. Two milder fixtures provoked no writes even from the pre-fix role. It wrote when the review prompt invited it. The control being probabilistic is not incidental — it is the shape of the whole fix.

## Fix

- **`codev/roles/consultant.md`** and its byte-identical skeleton twin: a section stating that the consultant reads the tree and does not change it — never modify, revert, create or delete under review; never run a state-changing command (with `git fetch` called out explicitly, since "read-only commands are fine" left it ambiguous); a restore afterwards does not make it safe; and it holds even when the review prompt asks for an edit. Plus a subsection answering the vacuity check by reading rather than mutating, because forbidding the mutation without offering the alternative just leaves the reviewer stuck.
- **`packages/codev/src/commands/consult/tree-tripwire.ts`** (new), wrapped around `runConsultation()` so every lane gets it rather than just claude. Snapshots path→content-hash plus HEAD and branch either side of a lane; on a difference, prints a red banner naming what moved and appends the same warning below the review's verdict.
- **`packages/codev/src/commands/doctor.ts`**: the audit's second `bypassPermissions` call site. An auth probe rather than a review, but it carried no system prompt at all and runs in whatever directory the user typed `codev doctor` in. Now says "you are a probe, touch nothing".

### Design notes

**Content hashes, not a `git status` text diff.** The interesting case is a tree that was *already dirty* — a builder mid-phase always is. Porcelain prints ` M src/foo.ts` before and after, byte-identical, while the contents change underneath. Pairing each path git reports with a hash of its bytes is what catches that.

**Repository identity, not just files.** `git commit` takes a dirty tree clean, and a `git checkout` between two refs with identical content changes nothing a file comparison can see. In both cases the review is of a different commit than the builder believes, and in the second there is no local trace at all. HEAD and branch ride along in the snapshot and are reported separately, because the remedy is different: `git reflog`, not `git status`.

**The banner names what moved, not who moved it.** Under cmap the three lanes are concurrent processes in one worktree, so each sees the others' writes — and the author may be editing too. Asserting a culprit we cannot identify would be a claim the evidence does not support.

**Nothing a filename can do gets to move the cursor.** Git path names are bytes; almost anything but `/` and NUL is legal. A file called `\n  - harmless.ts` would add a line to the list, and one carrying a CSI sequence could repaint what is above it. Control characters are escaped before printing.

## Files Changed

| File | Change |
|------|--------|
| `codev/roles/consultant.md` | New "You Read the Tree; You Do Not Change It" section + the vacuity-check alternative |
| `codev-skeleton/roles/consultant.md` | Byte-identical twin |
| `packages/codev/src/commands/consult/tree-tripwire.ts` | New: snapshot, diff, identity, escaping, warning formatting |
| `packages/codev/src/commands/consult/index.ts` | `runConsultation()` wraps `dispatchConsultation()` with the tripwire |
| `packages/codev/src/commands/doctor.ts` | System prompt for the SDK auth probe |
| `packages/codev/src/lib/test-env.ts` | `realClaudeSdkOptIn()` — opt-in for the real-SDK acceptance test |
| `packages/codev/src/commands/consult/__tests__/tree-tripwire.test.ts` | Unit suite against real git repos |
| `packages/codev/src/commands/consult/__tests__/tripwire-wiring.test.ts` | Drives real `consult()`; fails if the wrapper is removed |
| `packages/codev/src/commands/consult/__tests__/tree-tripwire-non-text.test.ts` | Degrades to "unavailable" under a stubbed `child_process` |
| `packages/codev/src/commands/consult/__tests__/consultant-role.test.ts` | Role text + twin byte-identity |
| `packages/codev/src/__tests__/cli/consult-readonly-review.e2e.test.ts` | Opt-in real-SDK A/B acceptance |
| `packages/codev/src/__tests__/consult.test.ts` | `consultant.md` reaches the model as `systemPrompt` |
| `packages/codev/src/__tests__/doctor.test.ts` | Pins the probe instruction |

## Testing

**The issue's stated acceptance criterion turned out to be insufficient.** It proposed asserting the reviewed file's hash is unchanged. On the pre-fix A/B run that assertion *passed*: the lane made six write calls and then restored the files, so the tree came back byte-clean while the review had been conducted against code nobody wrote. The acceptance test asserts the tree **and** that no write tool was called; only the second fails pre-fix.

Real-SDK A/B, identical fixture and prompt, only `consultant.md` differing:

| role | write-tool calls | test |
|---|---|---|
| pre-fix | `Edit`×4, `Write`×2 | FAILS |
| post-fix | none | PASSES |

Opt-in behind `CODEV_ALLOW_REAL_CLAUDE_SDK=1` (skipped otherwise, following the `CODEV_ALLOW_REAL_AGY` precedent), because a check on a model's judgement is probabilistic and a probabilistic CI gate gets muted.

Deterministic pins: role text (fails 10/10 against the pre-fix wording), the tripwire unit suite, and `tripwire-wiring.test.ts` — verified to discriminate by bypassing the wrapper and re-running, where 5 of its 7 original tests fail, and by removing the identity check, where both new ones fail.

Also verified end-to-end through the built CLI: mutated `app.ts` and added `added.ts` during a live `consult -m claude`, which named exactly those two paths and nothing else.

Full suite green; `tsc --noEmit` clean; build clean.

## Known Limits

Stated rather than papered over, and each pinned by a test so it stays a known limit rather than an assumption:

- **A byte-for-byte restore leaves nothing to compare.** `consultant.md` is the only control for that case. There is a test asserting the silence.
- **Gitignored paths are invisible.** Deliberate — it is what keeps consult's own output from tripping its own wire — but a lane writing into an ignored path goes unnoticed.
- **Submodule-internal edits are invisible.** `git status` reports a submodule as one directory entry.
- **The warning cannot attribute.** Concurrent lanes in one worktree; see the design note.
- **Unbounded full-file hashing** under `--untracked-files=all`, twice per lane. Latency only, and it degrades gracefully, but worth watching if a monorepo's dirty set gets large.

## Adopter Risk: a stale local `consultant.md` shadows this fix

Framework files resolve through the four-tier chain — `.codev/` → `codev/` → runtime cache → installed package skeleton. **An adopter who has a local `codev/roles/consultant.md` (customised, or simply copied at install time) will keep getting their own copy, and this fix will never reach them.** The tripwire still runs, because that is code rather than a resolved file — so they get the detection and not the instruction, which is exactly backwards from the owner's intent.

`codev update` merges templates, but nothing today tells a user that their local role file is missing a section the shipped one has. The right shape is a `codev doctor` check: when a local `codev/roles/consultant.md` exists and lacks the read-only section, warn and point at the skeleton. Filed as #1661 rather than folded in here — it is a `doctor` feature, not part of this bug.

## CMAP Review

Three rounds.

- **Round 1** — gemini APPROVE, codex REQUEST_CHANGES, claude REQUEST_CHANGES. Four findings, all verified against source before acting, all real: sibling-lane review files would have false-positived on every adopter cmap round (porch runs three lanes in parallel writing `codev/projects/<id>/…-iter<N>-<model>.txt`, and `CODEV_GITIGNORE_ENTRIES` ships no rule for those); a relative `--output` bypassed the exclusion; an unavailable *post*-review snapshot failed open as "no changes"; and **nothing tested the wiring** — deleting the wrapper left all 5969 tests green.
- **Round 2** — gemini APPROVE, claude APPROVE, codex REQUEST_CHANGES (branch behind main). Merged main; codex's re-review then found something new and correct: `relativeOutputPath` resolved against `workspaceRoot`, but lanes write with a bare `fs.writeFileSync` and `consult` never chdirs, so the file lands relative to **cwd**. My round-1 fix was right about resolving and wrong about the base.
- **Round 3** — gemini, codex, claude all APPROVE. Three of claude's six non-blocking nits taken: git's stderr was being inherited (a bare `fatal: not a git repository` printed over the tripwire's own message), submodule blindness added to the documented limits, and the `git fetch` ambiguity in `consultant.md` resolved.

Architect integration review: repository identity folded into the snapshot, control characters escaped, and this adopter-shadowing risk documented.

## Lessons

1. **The vacuity failure this bug is about happened in my own test for it.** My first acceptance fixture passed against the *pre-fix* role too — it could not tell the fix from the absence of it. Only running the A/B against the old role exposed it. A regression test is a claim, and the claim needs checking in both directions: I now verify every load-bearing test by putting the bug back.
2. **"Assert the artefact is unchanged" is weaker than it sounds when the actor can tidy up.** The pre-fix lane wrote six times and restored the files. Watching state is not the same as watching behaviour; where you can observe the action, observe the action.
3. **Blind spots hide behind this repo's own configuration.** Two separate false positives — `.consult/history.log` and the sibling review files — were invisible here purely because this repo's `.gitignore` carries entries the shipped `CODEV_GITIGNORE_ENTRIES` does not. When a behaviour depends on config, test against the config adopters actually get, not the one in front of you.
4. **A diagnostic wrapped around everything must never be the thing that breaks.** The first cut assumed `execFileSync` returns a string; a suite that stubs `child_process` took down twenty gemini-lane tests before the lane had run at all.
5. **Reviewers found what a solo pass would not have.** Every blocking finding across three rounds was real and verified. The two most valuable — the wiring gap and the cwd resolution base — were things I had already convinced myself were handled.
