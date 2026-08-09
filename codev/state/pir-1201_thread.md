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
