# Plan 984 — Rebuttal to Iteration-1 Consultation

**Verdicts**: Gemini **APPROVE** · Claude **APPROVE** · Codex **REQUEST_CHANGES** (all HIGH confidence).
**Disposition**: Accepted all of Codex's four points and every actionable note from the two approvers. No disagreements. Plan revised in commit on the builder branch (Plan iter-1).

---

## Codex (REQUEST_CHANGES) — all four accepted

### 1 — Ownership write placed too late (would not prevent side effects)
**Accepted; corrected.** Codex is right: `spawnSpec` creates the worktree/session *before* `upsertBuilder`, so a ledger check/write "after `upsertBuilder`" would only refuse a duplicate *after* the worktree/session already exist. Phase 1 now **claims ownership (dedup check + atomic ledger insert via the partial unique index) before `createWorktree`/session creation**, claiming on `architect + issue_number` (builder_id nullable, backfilled on success), with **rollback** (release the just-claimed row) if a later spawn step fails — so a failed spawn leaves no phantom owner and the gate is genuinely preventive.

### 2 — Phase 6 git sketch would detach the worktree
**Accepted; corrected.** `git branch <branch> <sha>` + `git worktree add <path> <sha>` detaches. Phase 6 now specifies the **attached-branch flow**: `git branch <builder-branch> <base-sha>` then `git worktree add <path> <builder-branch>` — the worktree is attached to a named branch whose tip is the pinned SHA. Added a test assertion that the result is attached (not detached HEAD), and documented that the explicit-`--branch`/resume path (`createWorktreeFromBranch`) is unaffected.

### 3 — Phase 5 board under-scoped (owned-but-unspawned has no row)
**Accepted; corrected.** The who-owes-next "ledger entry with no active builder → architect" case has no builder row to attach to. Phase 5 now **joins the Phase 1 ledger in `overview.ts`** and **synthesizes an overview row** (an `OverviewBuilder`-shaped/`OverviewOwnedIssue` entry) for owned-but-unspawned issues; the payload/types carry the synthesized shape and `WorkView` renders these alongside live builders. (Gemini flagged the same — same fix.)

### 4 — Missing plumbing for new flags/validation
**Accepted.** Added `packages/codev/src/agent-farm/types.ts` (`SpawnOptions.overrideOwner?` / `base?`) and `__tests__/spawn.test.ts` (extending the existing spawn-validation tests) to the Phase 1 file list.

---

## Claude (APPROVE) — minor notes, all applied

- **3a** state-rotation home → committed to `packages/codev/src/lib/` (codev-specific, not a `packages/core` cross-package util).
- **3b** spawn-path scope → Phase 1 now states explicitly it touches only the **numbered** spawn paths (`spawnSpec`, `spawnIssueDrivenBuilder`), not `spawnTask`/`spawnShell`/`spawnWorktree`/`spawnProtocol`.
- **3c** line numbers → corrected: `addArchitect` function ~L868, `removeArchitect` ~L1100 (the ~L987/~L1161 are the `setArchitectByName` calls within).
- **3d** Phase 6 → clarified it modifies `createWorktree()` **only**, not `createWorktreeFromBranch()` (which already fetches; touching it would double-fetch/break resume).
- **3e** default-branch discovery → added the fallback chain: workspace config → `git symbolic-ref refs/remotes/origin/HEAD` → `git remote show origin` → **fail** (never assume `main`).
- **Phase 6 test** → added concrete fixture setup (temp git repo with local HEAD deliberately behind `origin/<default>`; assert builder tip == origin tip).
- **Phase 4 risk** → workspace-relative path resolution elevated to a named risk; `mkdir -p` for the new `codev/state/architects/` and `codev/state/archive/architects/` directories called out (Phase 3 + Phase 4).
- **Closed-issue dedup** → resolved with a stated default (treat closed same as open; block + `--override-owner`), so the Phase 1 gate logic is unambiguous.
- **Ledger-write SSE** → noted as an optional nice-to-have, **out of scope** (the existing overview poll already surfaces changes).

## Gemini (APPROVE) — notes applied

- **Migration** → clarified that `db.exec(LOCAL_SCHEMA)` runs on every init, so `CREATE TABLE/INDEX IF NOT EXISTS` auto-applies to existing DBs; a discrete numbered migration in `db/index.ts` is **optional** (only for column alterations/backfills).
- **Phase 5 ledger-only injection** → addressed by the same ledger-join/synthesized-row fix as Codex #3.
- **Phase 4 rehoming** and **Phase 6 fail-fast/offline `--base HEAD`** → confirmed as designed; no change needed.

---

## Net
Two APPROVE + one REQUEST_CHANGES whose four points were all genuine implementation-ordering/correctness gaps (claim-before-side-effects, attached-branch flow, board ledger join, flag plumbing) — all fixed. The plan now reflects verified integration points and a build-ready phase breakdown. No open disagreements.
