<!--
  Behavioural baseline for Spec 1252 (criterion M12a).

  GENERATED — do not hand-edit, EXCEPT the final "B5 forward snapshot" section,
  which is appended at capture time (it comes from a rolling machine-local DB
  the script deliberately does not read). Reproduce B1–B4 with:
    cd packages/codev && npx tsx scripts/measure-prompt-behavior.ts ../..

  Captured in Phase 1, BEFORE any phase altered served prompt content
  (Phase 3 reconciles drift, Phase 5 compresses scar rules, Phase 7 dedups).
  The verify phase re-runs the same script over the next N=10 post-merge
  builder projects (>=3 SPIR) and compares against these numbers.

  SELF-EXCLUSION: project 1252's own status.yaml, thread, and review files are
  excluded from B1–B4 and B3 by default (SELF_PROJECT_DIR / SELF_FILE_PREFIXES
  in prompt-behavior-metrics.ts). The baseline is the PRE-PROJECT state; the
  measuring project's own artifacts grow during the run and would otherwise
  contaminate it — the iter-1 capture had one such B3 hit and 3 of its own
  verdicts before this exclusion existed.

  Sample note: 18 projects carry non-empty `history`. 17 are SPIR and supply
  all 160 verdicts; the 18th (0092, legacy `spider`) has history but zero
  recorded verdicts, so it contributes to B4's project count only.
-->

# Behavioural metrics (Spec 1252, M12 / Appendix D)

## B1 — CMAP verdict distribution

Total verdicts: **160** across 18 projects with review history.

| Verdict | Count | Share |
|---|---:|---:|
| REQUEST_CHANGES | 83 | 51.88% |
| APPROVE | 66 | 41.25% |
| COMMENT | 11 | 6.88% |

**B1 REQUEST_CHANGES rate: 51.88%** — the load-bearing metric.

## B2 — review rounds per plan phase

mean **1.12**, median 1, max 2 (n=49 phases)

> Advisory only. The observed range is too narrow to detect a subtle
> regression. Note also that phases advance on builder *rebuttal*, not on
> unanimous approval — 0 terminal phases in this corpus end with 3x APPROVE —
> so a "rounds to unanimity" metric would never resolve.

## B4 — review rounds per project

mean **3.06**, median 3 (n=18 projects). Advisory.

## B3 — candidate scar-rule violations

Scanned **349** files (codev/reviews + codev/state threads).
Candidate hits: **44**

> **These are CANDIDATES, not findings.** Keyword mining cannot distinguish
> "we did this" from "never do this". Every hit requires human adjudication
> before the hard rollback trigger fires. B3 is the metric that matters most —
> it is the only one that would catch a compressed scar rule losing its force.

| Rule | Candidate hits |
|---|---:|
| restart-tower | 21 |
| destructive-git | 9 |
| auto-approve-gate | 7 |
| kill-shellper | 6 |
| afx-from-worktree | 1 |

### Excerpts for adjudication

- `codev/reviews/0078-porch-e2e-testing.md:43` **[auto-approve-gate]** — 3. Auto-approve mechanism inconsistency (flag vs env var) - **NOTED**: Env var is more flexible for testing
- `codev/reviews/0078-porch-e2e-testing.md:51` **[auto-approve-gate]** — 3. Spec/plan inconsistency on auto-approve - **NOTED**: Env var approach is valid
- `codev/reviews/0078-porch-e2e-testing.md:56` **[auto-approve-gate]** — Chose `PORCH_AUTO_APPROVE` environment variable over `--auto-approve-gates` flag because:
- `codev/reviews/0078-porch-e2e-testing.md:79` **[auto-approve-gate]** — | Full Lifecycle | ✅ | End-to-end with auto-approve |
- `codev/reviews/0116-shellper-resource-leakage.md:25` **[kill-shellper]** — - E2E test: Tower periodic cleanup timer removes stale sockets during runtime (2s interval, externally killed shellper)
- `codev/reviews/0118-shellper-multi-client.md:41` **[kill-shellper]** — - **Removed stale tests from session-manager.test.ts**: Two tests were removed (`repeated calls are idempotent` and `kills child process when readShellperInfo fails`). These were fragile timing-based 
- `codev/reviews/1096-vscode-codev-openissuebynumber.md:53` **[restart-tower]** — - Manual verification: the human approved the running worktree at the `dev-approval` gate. Note the GitHub browser-open path requires the running Tower to serve the updated `issue-view` script (rebuil
- `codev/reviews/1096-vscode-codev-openissuebynumber.md:99` **[restart-tower]** — from the worktree root, `pnpm build && pnpm -w run local-install` (rebuilds + restarts Tower with the new `issue-view` script), then reload the VSCode window.
- `codev/reviews/1118-consolidate-state-db-tables-in.md:144` **[afx-from-worktree]** — Nesting is an unsupported anti-pattern (`afx spawn` from inside a worktree), so this is a
- `codev/reviews/1140-afx-workspace-recover-respawne.md:52` **[kill-shellper]** — 2. Kill that builder's shellper (or reboot), run `afx workspace recover --apply` from main's terminal
- `codev/reviews/1145-codev-adopt-launchinstance-mai.md:73` **[restart-tower]** — - **Run locally**: `pnpm build && pnpm -w run local-install` (restarts Tower)
- `codev/reviews/1149-tower-recovery-claude-architec.md:59` **[restart-tower]** — - **Run**: `pnpm build && pnpm -w run local-install` (restarts Tower with this branch)
- `codev/reviews/1149-tower-recovery-claude-architec.md:63` **[kill-shellper]** — 3. Kill the architect's claude process (not the shellper)
- `codev/reviews/1149-tower-recovery-claude-architec.md:66` **[restart-tower]** — 6. Escape hatch: repeat the corruption, restart Tower with `CODEV_SKIP_RESUME=1`, verify the architect starts fresh with no crash cycle at all
- `codev/reviews/438-aspir-protocol.md:31` **[auto-approve-gate]** — - **Phase 3 documentation wording**: The plan suggested specific bullet points for the CLAUDE.md/AGENTS.md ASPIR section. During implementation, the root CLAUDE.md was written first with slightly diff
- `codev/reviews/438-aspir-protocol.md:127` **[auto-approve-gate]** — - **Concern**: CLAUDE.md says gates are "auto-approved" which contradicts protocol.json (gates are absent)
- `codev/reviews/841-feat-vscode-architects-tree-ad.md:63` **[destructive-git]** — None skipped. Note (not flaky — pre-existing and unrelated): `packages/vscode/src/__tests__/terminal-adapter.test.ts` and `reconnect-link-provider.test.ts` fail to *collect* under plain vitest (dynami
- `codev/reviews/883-vscode-builder-cleanup-no-long.md:107` **[restart-tower]** — - **Build + install**: `pnpm build && pnpm -w run local-install` (restarts Tower, picks up the patched extension)
- `codev/reviews/916-vscode-sidebar-data-builders-b.md:116` **[restart-tower]** — - Simulate a transient blip (stop/restart Tower, or toggle network so the SSE drops then reconnects):
- `codev/reviews/920-vscode-editor-tab-webview-for-.md:83` **[restart-tower]** — 1. `cd .builders/pir-920 && pnpm -w run local-install` — rebuilds + restarts Tower so it serves `/api/issue-search` and resolves the `issue-search` concept.
- `codev/reviews/930-vscode-mark-recently-created-b.md:67` **[destructive-git]** — behavior (confirmed via `git stash` that the `status.ts`/`workspace.ts`/
- `codev/reviews/961-core-extract-transport-agnosti.md:73` **[restart-tower]** — - Restart Tower; confirm a fresh connect resets the counter on both surfaces.
- `codev/reviews/982-vscode-tower-no-active-termina.md:59` **[kill-shellper]** — - Persistent: kill a builder's shellper so its session can't reconnect → after the retries, the actionable toast appears; **Retry** re-attempts, **Recover Builders** opens a terminal running `afx work
- `codev/reviews/983-vscode-tower-detect-installed-.md:7` **[restart-tower]** — The v3.1.7 #791 preflight verifies the *installed* `codev` CLI version but is blind to whether the *running* Tower process is executing that same code — after an `npm install -g` upgrade without a Tow
- `codev/reviews/983-vscode-tower-detect-installed-.md:59` **[restart-tower]** — - **Codex REQUEST_CHANGES (3-way consult, addressed)** — Codex (HIGH confidence) flagged that the `too-old` (404) path had the same futile-remedy bug we'd already fixed for the ext-version comparison:
- `codev/reviews/983-vscode-tower-detect-installed-.md:63` **[restart-tower]** — - **Self-invoked restart safety** — the in-extension `Restart Tower` action is only safe because #991 (already on main) scoped `afx tower stop` to the listening Tower process; before it, the unfiltere
- `codev/reviews/983-vscode-tower-detect-installed-.md:73` **[restart-tower]** — - Stale: bump the globally-installed `@cluesmith/codev/package.json` version (simulates an upgrade) without restarting Tower, reload the Ext Dev Host → divergence toast with `Restart Tower`; clicking 
- `codev/reviews/983-vscode-tower-detect-installed-.md:75` **[restart-tower]** — - Unreachable: stop Tower → only the existing "not connected" path, no new toast
- `codev/reviews/991-terminal-stale-tab-on-a-pre-re.md:67` **[restart-tower]** — - **Deploy ordering:** the host-kill fix lives in `afx tower stop`; the id-preservation lives in the Tower server. Both ship via `local-install`, which restarts Tower using the freshly-installed `afx`
- `codev/reviews/997-tower-reconcile-terminal-sessi.md:58` **[restart-tower]** — - **Run / verify** (this repo restarts Tower to pick up the change):
- `codev/reviews/997-tower-reconcile-terminal-sessi.md:59` **[restart-tower]** — 1. `pnpm -w run local-install` with a builder/architect terminal active (rebuilds + restarts Tower)
- `codev/state/air-1238_thread.md:67` **[restart-tower]** — Did NOT restart Tower to observe the startup sweep live — that would kill every running
- `codev/state/aspir-1210_thread.md:86` **[auto-approve-gate]** — - **STOPPED at pr gate — awaiting human approval.** Not auto-approving (human-only gate). Architect
- `codev/state/bugfix-1122_thread.md:21` **[destructive-git]** — While proving the regression test fails without the fix, I ran a `git stash push`
- `codev/state/bugfix-1122_thread.md:23` **[destructive-git]** — then a paired `git stash pop` — which popped the PRE-EXISTING `stash@{0}: On main:
- `codev/state/bugfix-1122_thread.md:35` **[destructive-git]** — - `git reset --hard HEAD` reverted the 12 tracked modifications and removed the 32
- `codev/state/bugfix-1122_thread.md:39` **[destructive-git]** — - Verified `git stash list` still shows `stash@{0}` intact afterward.
- `codev/state/bugfix-1224_thread.md:104` **[kill-shellper]** — - SessionManager maxRestarts give-up: logStderrTail (capture child reason) + kill shellper group
- `codev/state/bugfix-838_thread.md:36` **[destructive-git]** — Both fail against pre-fix package.json (verified via `git stash`); both
- `codev/state/pir-1118_thread.md:158` **[destructive-git]** — (a git stash pop unstaged it); committed the deletion (14604d24). CI now GREEN.
- `codev/state/pir-933_thread.md:11` **[destructive-git]** — - `git reset --hard fcea5028` (pristine porch-init commit) → porch back in the
- `codev/state/pir-983_thread.md:34` **[restart-tower]** — - **vscode**: `decideTowerStatus` + `towerDivergenceMessage` (pure, in preflight-core, 8 new unit tests); `probeTowerVersion` fired on each `connected` transition in `extension.ts`; dedicated `showTow
- `codev/state/pir-983_thread.md:48` **[restart-tower]** — **Rebased on main (picked up PIR #991 / PR #999).** Clean rebase, no conflicts. Re-verified every line ref in the plan — all still accurate (RouteContext tower-routes.ts:131, routeCtx tower-server.ts:
- `codev/state/pir-991_thread.md:66` **[restart-tower]** — Pending reviewer re-test with a freshly-built vsix (reload window once, then restart Tower only): expect Codev output `Tower reconnected — re-syncing N terminal(s)` → `recoverSuccessor(...): poll 1/5 

## B5 — consult cost/duration

**Not captured here.** `consult stats` is a rolling 30-day machine-local DB,
so it is not reproducible from a commit. Capture it separately as advisory
context; it is excluded from T14 determinism and drives no rollback trigger.

## Sample provenance

- 0092-terminal-file-links
- 0120-codex-sdk-integration
- 0124-test-suite-consolidation
- 403-af-send-typing-awareness
- 456-dashboard-statistics-tab-in-ri
- 462-add-spike-protocol-for-technic
- 467-add-open-files-shells-section-
- 468-af-rename-command-to-rename-cu
- 589-support-non-github-repositorie
- 723-improve-arch-md-lessons-learne
- 746-spir-architect-s-baked-archite
- 755-multi-architect-support-per-ar
- 761-surface-multiple-architects-in
- 778-gemini-cli-antigravity-cli-jun
- 786-multi-architect-feature-is-und
- 823-multi-architect-coordination-b
- 927-needs-attention-surface-prs-vi
- 987-engineering-wisdom-is-write-on


---

## B5 — consult cost/duration: forward snapshot (advisory)

**Captured 2026-07-27 via `consult stats --json` (rolling 30-day machine-local
DB). NON-DETERMINISTIC: this section is appended at capture time, not
regenerated by the measurement script, and it is excluded from T14's
determinism assertion and from every rollback trigger.** It exists as advisory
context for interpreting a B1 movement in the verify phase — e.g. a REQUEST_CHANGES
rise accompanied by a duration collapse suggests degraded review quality rather
than degraded prompts.

| Model | Calls (30d) | Avg duration | Total cost | Success rate |
|---|---:|---:|---:|---:|
| gemini | 1272 | 23.3s | n/a (no cost data) | 89.8% |
| claude | 971 | 107.6s | $900.06 | 91.9% |
| codex | 875 | 77.5s | $577.95 | 87.9% |
| **total** | **3349** | — | **$1478.01** (1278 of 3349 with cost data) | 90.6% |

Verify-phase comparison: capture the same snapshot at verify time and compare
per-model averages directionally only. No threshold keys off this table.
