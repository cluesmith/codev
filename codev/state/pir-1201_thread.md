# Thread — pir-1201 (Support Kimi Code CLI as a builder)

## 2026-07-18 — Plan phase

- Spawned in PIR strict mode against issue #1201. Spike `task-Iptx` (findings + addendum + POC script) rode into the worktree from main — used as the design base.
- Architect constraints received mid-turn and folded into the plan: hard scope fence (builder MVI only — no architect parity, no ACP; write-guard is a caveat), evidence rule (documented claims cite the Kimi command reference only; store layout / `session_index.jsonl` / `resume_hint` labeled undocumented, kimi ≥ 0.27.0 pinned), fork flow (pushes land on mohidmakhdoomi/codev via per-worktree pushurl; cross-fork PR to cluesmith/codev; NO self-merge — maintainers merge), live demo required before dev-approval.
- Investigated all seams at HEAD: `harness.ts` (provider interface + #1062 claude fallthrough), `spawn-worktree.ts` script generation, `spawn.ts` `discoverResumeSession`, `message-write.ts` pacing constants, tower-routes/cron delivery paths, `createTerminal` surface (core tower-client + `handleTerminalCreate`), `claude-session-discovery.ts` (pattern for the kimi sibling), `doctor.ts` check structures.
- Key plan decisions:
  - New optional `HarnessProvider.buildBuilderLaunchScript` capability — provider-owned script shape; only Kimi implements; existing harness scripts byte-identical.
  - Seed-session bootstrap in the generated script (idempotent `-s` guard, seed-failure exits before the loop, sentinel re-printed on relaunch).
  - Readiness barrier Tower-side (new `servers/seed-kick.ts`) armed via a `seedKick` field on createTerminal; store-verified BEGIN with Enter-resend → kick-resend → loud-warn ladder.
  - `kimi-session-discovery.ts` scans the store directly (skips `session_index.jsonl` — one undocumented surface instead of two).
  - NO `session` block on KIMI_HARNESS (mint-and-pin `newSessionArgs` unsatisfiable; contract generalization = stage 2). Architect use fails loudly via `buildRoleInjection` throw + doctor warning.
  - Enter-delay: optional `pacing.enterDelayMs` on `writeMessageToSession`, sourced from `HarnessProvider.messagePacing`; bisect 80ms–1s live during implement.
- Plan committed at `codev/plans/1201-support-kimi-code-cli-as-a-bui.md`; sitting at plan-approval gate.

## 2026-07-18 — Implement phase

- Plan approved with one review note: make message-pacing resolution robust to a per-spawn `--builder-cmd` override. Solved without a DB migration: pacing probes the target's cwd for the `.builder-kimi-session` marker FIRST (the marker exists iff the launch script is Kimi-shaped — self-describing, survives Tower restarts, override-proof), then falls back to config-resolved harness by terminal role.
- Full MVI implemented across five commits: harness+discovery+script-shape, Tower seed-kick+pacing, doctor, docs, hardening. All porch checks (build, tests) green; suite 3592 passing after fixing a 500 my pacing hook caused in the /api/send test env (lesson: advisory features must be try/catch-total — pacing can never break delivery).
- Enter-delay bisect (real kimi 0.27.0, POC probe-10 method): 80ms fails (spike-confirmed), 120/250/500ms submit. Threshold ≈ 100ms; shipped constant pinned at 1000ms (~10x margin, POC-validated, latency-only cost).
- Demo driver at `codev/spikes/pir-1201-kimi-builder-demo.mjs` — runs the REAL dist modules (script generator, armSeedKick, writeMessageToSession, buildResume) against a real kimi PTY, covering the architect's 4-point demo checklist without touching the global Tower. Full `afx spawn` path needs the branch build installed into Tower (`pnpm -w run local-install`) — that restarts Tower, so it's the human's call at the gate.
- **Demo executed: ALL 5 steps PASS** (kimi 0.27.0, first run). Seed → sentinel → store-verified BEGIN (`lastPrompt="BEGIN"`); the ack-and-wait-with-task discipline HELD (spike addendum's open question — no fallback needed); multiline submitted with the pinned delay; TUI killed mid-session → `-S` restart recalled both role token and task verbatim; buildResume returned the pinned id. Sitting at dev-approval gate.

## 2026-07-19 — Review phase

- dev-approval approved after the human ran the full afx-spawn-through-Tower demo (all 4 checklist items live).
- Review file written; two lessons routed to COLD lessons-learned.md (advisory-decorator failure-totality; on-disk marker over schema for per-instance runtime facts). Arch already routed during implement (COLD arch.md subsection); no HOT-tier changes.
- Cross-fork PR opened: cluesmith/codev#1203 (head mohidmakhdoomi:builder/pir-1201). No self-merge — maintainers merge.
- CMAP (single advisory pass): gemini APPROVE, claude APPROVE, **codex REQUEST_CHANGES** — a real defect: seed-kick delivery confirmation used substring match on lastPrompt, but the fresh-spawn seed prompt itself contains "BEGIN", so the verifier false-positived before the kick submitted (the happy-path demo had masked it). **Fixed** (`732f04b8`): whitespace-normalized equality + two pinning regression tests; live demo re-run post-fix 5/5 PASS. Disposition recorded in `codev/projects/1201-*/1201-review-iter1-rebuttals.md` and flagged in the review's "Things to Look At" since PIR won't re-review it. Good CMAP catch — the exact class of thing solo review + a passing live demo can miss.
- Sitting at the pr gate.
- pr gate approved by the human; porch protocol wrapped (`verified`, complete). Per the fork flow the merge is NOT ours: PR cluesmith/codev#1203 stays open for the maintainers, so no `--merged` record exists yet (recording one would be false state — it can be added if/when the maintainers merge). Standing by for maintainer feedback relayed via the architect.

## 2026-07-22 — Maintainer review iteration (PR #1203)

- Maintainer (waleedkadous) REQUEST_CHANGES, one finding — real, accepted: the bare launch shape (no role, no prompt) never persisted `.builder-kimi-session`, so pacing resolution fell through to the config-resolved harness and an override-spawned bare Kimi builder (`--builder-cmd kimi` in a claude-configured workspace) got claude's 80ms Enter — the swallowed-Enter bug this PR exists to fix. The implement-phase claim "the marker exists iff the launch script is Kimi-shaped" was wrong for exactly this shape; seed and resume persisted it, bare did not.
- Fix (architect-driven; builder session had wrapped): the bare branch of `KIMI_HARNESS.buildBuilderLaunchScript` now `touch`es the marker before the TUI loop — empty (no id to pin), preserving any previously seeded id, and keeping both the seed `! -s` guard and buildResume's empty-id fallthrough intact. Every Kimi launch shape now persists the marker.
- Regression tests: the spawn-worktree bare-shape test that previously ASSERTED marker absence is flipped into the override-spawn pin, plus a harness-level bare-script pin (both fail pre-fix, verified) and a real-fs pacing test pinning the probe as existence-based (an empty marker must beat claude config — guards against a future content-based "improvement").
- Docs: arch.md pacing paragraph and the message-pacing.ts header now state the accurate, softened claim — every launch shape persists the marker, probe is existence-based, and the converse doesn't hold (a leftover marker is a breadcrumb, not proof of a live Kimi session; cost of staleness is a ~1s-slower Enter).
- Post-fix 3-way CMAP on 2abd362a (architect-run, commit-scoped): gemini APPROVE, claude APPROVE, codex APPROVE with one MINOR — the script-shape regression tests asserted the `touch` exists but not that it stays BEFORE the `while true` loop, so a refactor moving it inside/after the loop would keep them green. Accepted and fixed: ordering assertions added at both layers (harness + spawn-worktree), mirroring the suite's existing exit-1-before-loop precedent. Claude's NIT (thread phrasing) needs no action.
- CMAP iter 2 (commit-scoped, 642b1726): codex APPROVE (none), gemini APPROVE + NIT, claude APPROVE + NIT — two complementary guard gaps in the same tests, both verified against the file and accepted: (1) gemini — the pre-existing exit-1-before-loop precedent lacked a `toContain('exit 1')` guard, so removing `exit 1` would vacuous-pass (`indexOf` → -1, and -1 < anything); (2) claude — the new ordering assertions lacked `toContain('while true')`, sound but with an opaque failure message if the loop construct ever changed. Both fixed (one-line guards). Loop protocol updated per the human: iteration 3+ reviews the ENTIRE cumulative maintainer-response diff (47d12ba9..HEAD), not per-commit.
- CMAP iter 3 (full cumulative maintainer-response diff, 47d12ba9..1de55e13): gemini APPROVE / codex APPROVE / claude APPROVE, all with zero findings — loop converged. Claude's pass verified the no-race property (touch completes before Tower registers the terminal, so no send can precede the marker) and cross-file doc consistency (KIMI_SESSION_FILE JSDoc, message-pacing.ts header, arch.md tell one story). This journal entry is the termination record; it makes no code/doc claims and does not itself re-trigger the review loop.

## 2026-07-23 — Mainline merge resolution

- Human authorized resolving PR #1203 against current `origin/main` without merging the PR. The merge had one conflict, in `packages/codev/src/agent-farm/lib/tower-client.ts`; resolved by retaining all four type re-exports required by both branches: `HuskCandidate`, `HuskPreview`, `HuskSweepResult`, and `SeedKickRequest`. `git diff --name-only --diff-filter=U` confirmed no other conflicts.
- Post-resolution verification: `pnpm build` passed; full `pnpm test` passed (185 files passed, 3 skipped; 3716 tests passed, 48 skipped). Branch is ready to push for CI.

## 2026-07-25T18:04Z — post-approval iteration: adopt #1244 loop tail
- Merged origin/main (brings PR #1244's keypress-gated launch-loop contract).
- Moved LAUNCH_LOOP_TAIL from spawn-worktree.ts (module-local) to utils/harness.ts (exported) so Kimi's provider-owned scripts share it without a circular import; both Kimi loops (pinned -S and bare) now use it.
- Pinned the new tail across all Kimi shapes in harness.test.ts and spawn-worktree.test.ts.
- Suites green (harness+spawn-worktree 169, message-pacing+seed-kick 22); build clean.

## 2026-07-25T18:07Z — CMAP + live verification of the loop-tail adoption
- CMAP (gemini, codex, claude) on the change set: unanimous APPROVE, zero findings, clean in one iteration.
- Full suite: 3802 passed / 48 skipped.
- Live kimi 0.29.1 verification (tmux PTY, real bare launch script from dist): /quit → exit 0 → keypress gate held (no respawn), Enter relaunched; SIGKILL → code 137 → auto-restart after 2s. Both branches behave per the #1244 contract.

## 2026-08-08/09 — Re-integration after parking: merge main + design pivot

The PR sat parked on two upstream blockers; both landed, the branch went stale (901 commits behind), and `kimi` itself drifted 0.27.0 → 0.34.0. This session re-integrates.

**Merged `origin/main`** (10 conflicts). Took main's rewritten `spawn-worktree.ts` / `tower-routes.ts` / `tower-cron.ts` / `tower-client.ts` / `discover-resume-session.test.ts` wholesale — our versions were the retired `SendBuffer` / direct-PTY-write paths that Spec 1313 replaced, plus a launch-loop shape #1233/#1317 superseded. Hand-merged `doctor.ts` and three docs.

**Design pivot** (architect-directed, PR comment 5229238112), validated live 7/7 against real kimi 0.34.0 before any code was committed to it:
- **Role via `--agent-file`** (0.31.0+), composed around `${base_prompt}` so it EXTENDS kimi's own system prompt instead of replacing it. Verified injecting in both `-p` and the interactive TUI — the half never measured in the original spike.
- **Task via the Spec 1313 mailbox**, delivered by the render gate onto a verified-empty composer. Never a direct PTY write.
- **Deleted** `seed-kick.ts`, the sentinel, the `-p` seed bootstrap, `.builder-seed.txt`, the ack-and-wait BEGIN discipline, and (later) the dead `SeedKickRequest` SDK surface.

**The finding that shaped the launch loop.** `kimi -c` does NOT fail with nothing to continue — it prints `No sessions to continue…` and starts a fresh session that never saw `--agent-file`, i.e. a silently ROLELESS builder (#929 hazard class). So every path to `-c` is gated on an inlined `node -e` store probe that fails CLOSED to a role-carrying fresh launch. Pinned by tests that EXECUTE the probe against fixture stores and cross-check it against `findLatestKimiSessionId`, so the hand-written bash snippet cannot drift from the TypeScript it mirrors.

**Pacing re-homed.** Spec 1313 replaced the routes `message-pacing.ts` hooked into, leaving pacing wired to nothing — every `afx send` to a Kimi builder would have been typed and never submitted. Now resolved in `mailbox-wiring.ts` (`resolveHarnessForSession` → `getBuiltinHarness(...).messagePacing`) and threaded through `writeMessagePaced`. Deleted `message-pacing.ts` AND the `.builder-kimi` marker: the harness name now comes out of the generated `.builder-start.sh`, which is generated FROM the resolved harness and so cannot be forgotten — the marker's coverage obligation is exactly what the maintainer's earlier finding was about. `--interrupt` paces too; `--escape` deliberately does not (writes no text; unmeasured on kimi).

**Guardrail 1 (render-gate).** The one shared-code edit: the classifier's marker exemption follows the profile's matched span instead of column 0, because kimi's marker sits at column 3 inside a rounded box. Carries dedicated before/after pins — exact span per shipped profile (claude/codex 1 = literally the old rule, agy 2 whose extra cell is whitespace already skipped), a tightest-possible-draft test per profile proving no over-skip, and a direct demonstration that a span-2 kimi profile classifies the real idle capture `user-text` while the shipped span-4 one classifies it clean. Three REAL 0.34.0 captures added as fixtures (committed raw — they carry only throwaway `/tmp` paths, unlike the agy captures). **Flag this for CMAP.**

**Guardrail 2 (trust).** No sanctioned bypass exists (audited 0.34.0: no `--help` flag; full strings sweep for `KIMI_*` env vars and trust config keys found nothing). Kept fail-soft, and added `inspectKimiTrustLayout` — it validates our undocumented `sha256(root)[:12]` derivation against kimi's OWN records, so a scheme change surfaces as a named `codev doctor` warning instead of silently stranding every new builder on the dialog. Doctor now reports the richer per-surface drift reasons; `kimiStoreLayoutLooksDrifted` deleted as production-dead.

**Version floor raised 0.27.0 → 0.33.0.** `--agent-file` is the hard break (0.31.0), but every measurement here was taken on the agent-core-v2 engine 0.33.0 made default. Claiming 0.31–0.32 support would be unverified. Flagged in the PR as the maintainer's call.

**Corrected an obsolete claim**: kimi DOES have a hook seam (blocking `PreToolUse`, `[[hooks]]` in config.toml, 18 events as of 0.32.0), so "#1018 write-guard parity impossible" was wrong. Docs now say parity is achievable follow-up work; the PR asks the maintainer whether it lands here or separately.

Store drift also fixed (three renames, not one: `workDir`→`cwd`, ISO→epoch-ms timestamps, `lastPrompt` gone) with v1 back-compat retained.

## 2026-08-09 — post-pivot CMAP round: two blocking defects, both fixed

Collected the work left in flight at the context reset (nothing restarted — the demo and both
consultations were still alive and were allowed to finish).

**CMAP: gemini APPROVE, codex REQUEST_CHANGES, claude REQUEST_CHANGES.** Both REQUEST_CHANGES
found the same two defects from opposite directions, and neither is reachable from a happy-path
run — an empty composer and a clean store both behave correctly, which is exactly why three
passing live demos missed them. Full dispositions in
`codev/projects/1201-*/1201-cmap-postpivot-dispositions.md`.

1. **False CLEAN on a multi-row kimi composer (blocking).** kimi's marker `│ >` can match a
   *continuation* row, and `findMarkerRow` takes the last match, so a draft whose final line
   begins with `>` left the real text above the scanned region → clean verdict on a composer
   holding unsent input. Claude reproduced it but had no live kimi to confirm the geometry; I
   measured it — real 0.34.0 renders exactly that shape. Fixed with an optional, *exclusive*
   `regionStartPatterns` upper bound (kimi: the box top). Exclusive was not cosmetic: my first
   attempt included the box-top row, whose `╮` is not an ignorable glyph, and it held every idle
   composer forever — the fixture suite caught it immediately. Claude's second proposed input (a
   marker row inside a second box below the composer) is NOT reachable: measured, kimi's `/` menu
   renders as unclosed `│` rows with no `╰`, so it yields `no-region-end` → held. Four new
   fixtures from live capture: multiline-bare, multiline, menu, picker.
2. **Store probe diverged from the TypeScript (blocking).** codex found the dangerous direction
   (an `archived` session authorized `-c`, which kimi then refuses to continue → fresh, roleless
   session — the #929 class). Claude found the safe-but-harmful direction (one stray `.DS_Store`
   threw ENOTDIR into the single outer try and disabled resume machine-wide, silently). The
   cross-check test had been comparing two implementations of the same omissions. Both now share
   one resumability predicate and per-level error handling, with every case asserted against both.
3. Plus: shell-metacharacter interpolation in the generated script (all three reviewers, from
   different angles), unbounded task re-queueing in a crash loop, drift probes that report healthy
   forever after a migration, and two stale seed-era strings.

**The demo's role oracle was wrong, not the product.** Its two failures (steps 2 and 4b) were a
role that told the model to prefix every reply with a token — that measures K3's formatting
compliance, not role delivery. The live `--agent-file` probe passed 7/7 against a
production-identical agent file, including role survival across `kimi -c`. Rewrote the demo to
ask for a codeword instead (the same oracle the probe uses), with a comment saying why so nobody
restores the weaker one.

**Verification:** `pnpm build` clean; full suite **4900 passed / 48 skipped / 0 failed**; live
demo **7/7** against real kimi 0.34.0, including the crash-resume claim that was withheld until
it passed.

---

## 2026-08-09 — architect integration review, three findings

The architect reviewed the PR at head `4a7e2afe` and returned three non-blocking findings. None
of them touch the three decisions parked for the upstream maintainer (trust pre-write, 0.33.0
floor, write-guard parity as follow-up) — a later architect message fenced those explicitly, and
this round left all three exactly as the branch already implements them.

**Finding 1 was measure-first, and the measurement is the interesting part.** The claim: a
residual false-CLEAN survives the `regionStartPatterns` fix. Enter a newline and then `>` and
kimi renders `│ > ` / `│   >` — row one empty, row two matching `KIMI_MARKER` so its `>` is
span-exempted as chrome. Every cell is whitespace, box chrome, or an exempted marker, so
`userCells` is 0 and the composer reads CLEAN *while holding unsent user input*. Bounding the
region correctly does not help: the draft is real but literally uncountable. That is the
corruption direction, so it mattered.

The proposed fix reads the composer's **shape** instead — a boxed region spanning more than one
interior row is a multi-line draft by construction. Sound only if box growth is exclusive to
multi-line drafts, which is a claim about kimi, not about our code. So I measured it before
writing it (`codev/spikes/pir-1201-kimi-box-growth.mjs`, real kimi 0.34.0):

| state | interior rows |
|---|---|
| idle | 1 |
| single-line draft | 1 |
| `/` menu | 1 |
| `@` picker | 1 |
| **post-reply steady state** | **1** |
| newline + bare `>` | 2 |
| newline only | 2 |
| long soft-wrapped single line | 2 |

**Premise holds.** The steady-state row is the load-bearing one: growth on a composer that has
already carried a turn would hold every later message forever — a liveness bug, which is worse
than the fail-safe direction. The soft-wrap case grows the box too, but it carries text and was
already busy, so its verdict is unchanged.

**One design correction I made against the suggestion.** Implemented as suggested — short-circuit
before the cell scan — the rule changed an *existing* fixture's verdict detail
(`kimi-multiline-bare` went from `user-text` to `multi-row-draft`), because that draft is also
multi-row. That would have masked the cell scan's ground-truth role and quietly retired what the
older guardrail test was actually testing. Moved the rule to **after** the scan: `userCells > 0`
still wins and still reports `user-text`, and `multi-row-draft` is reserved for exactly the case
the count is blind to. Every pre-existing fixture verdict is unchanged.

The arming gate is a shared `hasRegionStart` predicate used by **both** `findRegionStart` and the
rule, so an empty-pattern array cannot be read as "bounded" by one and "unbounded" by the other —
that divergence would fire the rule on claude/codex, whose composer legitimately sits several rows
above its rule line. Pinned with an armed/unarmed differential on identical bytes, so deleting the
rule outright fails the inertness test rather than silently passing it.

**Findings 2 and 3 were wording/comment only.** The fast-fail echo claimed to restart "with the
original task", but that branch leaves `codev_task_queued` set, so nothing is re-queued — correct
behavior (an undelivered row persists on the mailbox), wrong message. Reworded, and the operator
is now told which of the two cases they are in. Finding 3 records the accepted tradeoff in the
other direction: the clean-exit branch *does* reset the flag, so if the first row was never
delivered (quit at the trust dialog before a composer ever rendered) the mailbox ends up holding
the same mission twice. Documented rather than fixed, deliberately.

**Verification:** `pnpm build` clean; full suite **4904 passed / 48 skipped / 0 failed** (+4 =
three new tests and one new fixture); targeted suites (render-gate, harness, harness-integration,
spawn-worktree, mailbox-pacing, kimi-session-discovery) 327 passed.

### The CMAP on that delta found something better than what I built

gemini APPROVE, codex REQUEST_CHANGES, claude APPROVE-with-changes. Every finding from both
non-approving reviews was accepted; nothing was rejected. Full dispositions:
`codev/projects/1201-support-kimi-code-cli-as-a-bui/1201-cmap-architect-review-dispositions.md`.

**The one that mattered.** Both codex and claude independently attacked the same thing: I armed
the geometry rule off `regionStartPatterns`, overloading a field that means "this composer has an
upper boundary" with an unrelated claim, "this composer's height tracks draft lines". They
coincide for kimi. claude then produced evidence that this is not stylistic, and I verified it
myself with a geometry probe over every shipped fixture rather than taking it on trust:

**`codex-idle.clean.txt` — a real, captured, genuinely EMPTY codex composer — already spans two
interior rows** (`marker=18 start=18 end=20`). The rule's geometric predicate is *already true*
on a screen that must stay clean. Only the arming gate stood between that capture and codex mail
being held forever, and the day anyone declared a region start for codex — a header bound, a
boxed redesign — delivery would have died silently. That is the failure mode I was trying to
prevent for kimi, sitting one field declaration away for a different app.

Decoupled into an explicit `growsWithDraft?: true`, set only on `KIMI_PROFILE`. The rule now
requires both: the measured promise *and* the bound that makes the arithmetic mean "interior
rows". codex wanted `maxCleanInteriorRows?: number` instead; I chose the boolean because it
encodes the measured premise rather than a tunable number, and a wrong threshold under it gets
caught by the app's own idle fixture. The three inertness tests now run on codex's **real**
capture under four profile variants, so the hazard is demonstrated on identical bytes rather than
described on a screen I invented.

**Claude also found a gap in my measurement, so I measured it.** The spike had not enumerated the
composer *while the agent is generating* — if the box grew there, "deliver while busy" would have
silently become "hold until idle". It does not: mid-generation at 5s and 13s, shift+tab mode
chrome, and a draft typed during generation are all one interior row
(`pir-1201-kimi-working-states.mjs`). Claude asked for a line documenting what wasn't measured; a
measurement is a better answer than a caveat.

**Two accuracy bugs in my own prose, both real.** The reworded fast-fail hint asserted
unconditionally that a task was still queued — false when `afx send` never succeeded, since the
flag is only set on success, and in that case the fresh launch genuinely does retry. Now branches
on the flag. And "delivered whenever the operator saw a composer" was too strong: seeing a
composer is necessary, not sufficient, since the gate also has to have polled it empty. A
message-accuracy fix on top of a message-accuracy fix, which is a fair thing to have been caught on.

**One silent-omission class fixed:** `isClassifierStuck` enumerated details as a closed `||`
chain, so widening the union never forced a decision. Now a `Record<GateVerdict['detail'],
boolean>` — the next new detail is a compile error rather than a silent `false`.

**Verification:** build + `tsc --noEmit` clean; full suite **4906 passed / 48 skipped / 0 failed**
(+6 on the 4900 this round started from). No live demo re-run needed: the rule can only change
verdicts for a composer past one interior row, and delivery targets the idle composer — measured
at one row in every state, including mid-generation.

---

## 2026-08-09 — finding 4: a clean exit that did not stick

The architect re-verified the maintainer's exit contract against main's landed code and found a
real gap. #1267's contract is "clean exit → fresh rerun, no recovery", and claude's loop enforces
it **by identity**: a clean exit mints a new session id and the superseded one is never named
again. kimi cannot mint on demand and `kimi -c` is cwd-scoped, so identity was never pinned:

1. human cleanly exits conversation A
2. Enter gate → fresh relaunch; kimi 0.33+ mints **no session** until the first message lands
3. kimi crashes in that pre-mint window
4. the old guard asked only "does *any* session exist for this cwd?", found A, and ran `kimi -c`
   → continuing the conversation the human deliberately ended, with the re-queued task delivered
   into it

**Measured before building.** The whole design assumes `-c` continues the NEWEST session when a
cwd holds several — the existing probe only covered the zero-session case. Two live sessions in
one directory on 0.34.0, two independent oracles: content (codewords ALPHA/BRAVO → answered
BRAVO) and store identity (only the newest session's dir was touched; nothing new minted; exit 0,
no prompt). Premise holds, so the documented-residual fallback did not apply.

The fix makes the probe answer **which** session rather than **whether** one exists; the
clean-exit branch records that id; the crash branch resumes only once the newest id differs.

### CMAP: gemini APPROVE, codex REQUEST_CHANGES, claude REQUEST_CHANGES — and they were right

**The blocking one is a defect I introduced, not one I inherited.** Moving the decision from
`$?` onto stdout meant anything *else* writing to stdout counted as "a session exists". Claude
measured it: empty store plus `NODE_OPTIONS=--require <module that prints>` → probe prints a
banner, exits 1, script reads RESUME → `kimi -c` with nothing to continue → a session that never
saw `--agent-file`. A silently roleless builder — the exact #929 class this guard exists to
prevent, reintroduced by the guard's own upgrade. The pre-delta code could not produce it. Fixed
by consuming both signals (`codev_newest=$(...) || return 1`, declaration split from assignment
so `local` cannot mask the status).

**The architect's sketch had one too, and both reviewers caught it.** It said record the id,
"empty on any error — fail-closed", and I repeated that in a comment. It isn't: a *transient*
probe failure records `''`, and the next crash then sees the ended session as "different from
empty" and resumes it. Now failure and empty-store are distinguished by status, and a failed
baseline blocks resume until the next clean exit re-establishes one. Costs crash-resume
continuity in that rare case; never the role, never the task.

Two probe/discovery divergences also fell out, both pre-existing and both found by reading the
two implementations against each other rather than by testing: `j.cwd ?? j.workDir` short-circuits
on a non-string `cwd` where `readStateJson` falls through per-field; and the probe stripped a
trailing slash before `realpathSync` while `sameDir` does not — the unsafe direction, since a
nonexistent `/ghost/` would match in the probe and not in discovery. Removed the strip rather
than documenting it: `realpathSync` already normalizes a trailing slash for any directory that
exists, so it bought nothing and cost fidelity. Exact mirror beats documented exception.

**Claude's sharpest test point:** the pieces were pinned, the composition never was. `decideBranch`
injected the superseded id from the test, so the only evidence the generated clean-exit branch
assigns it was a string match — and a refactor wrapping that assignment in a subshell would pass
everything while the contract was dead. There is now a test that drives the **real `while` loop**
with stubbed launches and asserts the branch sequence `resume, fresh, fresh`.

Non-vacuity is demonstrated, not claimed: `decideBranchLegacy()` runs the pre-fix existence-only
predicate against the same store and the same generated probe, and the regression test asserts it
returns RESUME exactly where the shipped guard returns FRESH.

**Residuals, written down rather than engineered against:** a store GC that dropped the newest
session while keeping an older abandoned one would let `-c` reach the older one (requires
newest-first eviction); and the superseded id is in-memory, so closing and re-creating the
terminal returns to plain entry semantics — which claude pointed out is contract *parity* with
claude's loop, whose minted id is equally per-process, not a kimi shortfall.

**Verification:** build + `tsc --noEmit` clean; generated script passes `bash -n`; full suite
**4915 passed / 48 skipped / 0 failed**. Dispositions in
`codev/projects/1201-support-kimi-code-cli-as-a-bui/1201-cmap-finding4-dispositions.md`.
