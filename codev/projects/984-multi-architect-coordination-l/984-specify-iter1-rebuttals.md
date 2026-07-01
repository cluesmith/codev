# Spec 984 — Rebuttal to Iteration-1 Consultation

**Verdicts**: Gemini REQUEST_CHANGES · Codex REQUEST_CHANGES · Claude COMMENT (all HIGH confidence).
**Disposition**: Accepted essentially all feedback. No substantive disagreements; one item narrowed in scope (below). The spec was revised in commit `d7e17715`.

---

## Gemini (REQUEST_CHANGES)

### G1 — Worktree data loss on retire (#6)
**Accepted.** Added a **dirty-worktree guard**: `remove-architect` inspects the architect's `.architects/<name>/` worktree; if it has uncommitted/staged/untracked work it **aborts with a clear error listing the dirty paths** and requires `--force`. `--force` archives the state file (#4) before removal and surfaces (never silently destroys) committed-but-unpushed branches. See #6 approach + #4 step 4 + Test Scenario 14.

### G2 — Architect worktree path unspecified (#6)
**Accepted.** Fixed location: **`.architects/<name>/`** at the workspace root (symmetric with `.builders/<id>/`), added to `.gitignore` and AI-context ignore files so nested worktrees don't pollute the main checkout or AI context. See #6 approach.

### G3 — Markdown truncation safety (#5)
**Accepted.** Rotation no longer does arbitrary line/byte cuts. The template carries a machine-parseable **`<!-- ARCHIVE BOUNDARY -->`** delimiter; rotation operates only on the history region below it, moving **whole entries** (never splitting a fenced code block), into a dated archive. Added a loss-free reconstruction invariant + Test Scenarios 15 and Non-Functional Test 4. See #5 approach.

### Gemini's OQ recommendations — all adopted
State file at `codev/state/architects/<name>.md`; last-activity = max(terminal session, owned-builder `updated_at`); re-home to `main` without killing builders; `--override-owner`. Recorded in **Resolved Design Decisions**.

---

## Codex (REQUEST_CHANGES)

### C1 — Acceptance-critical decisions left open
**Accepted.** Added a **Resolved Design Decisions** section promoting state-file location, override flag, rotation mechanism/cap/trigger, dedup override semantics, retire policy, and last-activity source from "open" to "fixed," so #1/#4/#5 are implementable and testable. Only genuinely architect-level forks (#6 PR-slicing, migration ergonomics) remain open.

### C2 — #6 scope contradiction (own-checkout vs. leave-pre-existing-shared)
**Accepted; contradiction resolved.** Restated the invariant as *"no architect's branch switch disturbs a sibling,"* not *"every architect physically has a worktree."* Concretely: `main` = main checkout; architects **added after this feature** get `.architects/<name>/` by default; pre-existing non-`main` architects keep the shared checkout until migrated via an explicit `afx workspace migrate-architect`. The #6 success criterion was reworded to match. Internally consistent now.

### C3 — Ledger semantics imprecise (override / close / reopen / cleanup / release)
**Accepted.** Added precise rules: first-owner-wins; `--override-owner` = mark prior `released` + insert new live entry with `override_of` (auditable, not silent transfer); issue close does **not** auto-release (ownership = who's working it); builder `cleanup` does **not** release (durability is the point); release happens only via override / `remove-architect` / explicit future command. See #3 "Precise ledger semantics."

### C4 — Degraded/error behavior underspecified (forge unavailable; ambiguous who-owes-next)
**Accepted.** Roster intersects ledger ids against the **existing overview/issue cache** and renders `unknown` when forge data is unavailable — never blocks, stays deterministic. who-owes-next is now a **total function** with an explicit `unknown` fallback for non-standard states. See #1 + #2 approaches.

---

## Claude (COMMENT — 7 gaps, all addressed)

1. **Forge query mechanism for "open issues"** → resolved via overview-cache intersection (no per-issue shell-out; keeps the <1s budget). 
2. **who-owes-next edge cases** (stalled / awaiting-merge / owned-unspawned) → enumerated explicitly in the total function. 
3. **Re-homing semantics concrete steps** → #4 now lists the ordered DB/file steps (archive file → release ledger rows → `UPDATE builders SET spawned_by_architect='main'` → remove row → remove worktree). Routing already falls back to `main` post-#774, so no routing-code change — the column update makes the new home explicit. 
4. **#6 spawn-base resolution sketch** → added: `spawn.ts` resolves the spawning architect's worktree from the `architect` table and runs the worktree-add against it; `main` resolves to the main checkout (unchanged path). 
5. **`CODEV_ARCHITECT_NAME` fallback in N>1** → spawn now **requires** a registered name in multi-architect workspaces (no silent `main`); security note + Test Scenario 13 added. 
6. **Concurrent-spawn race on dedup** → partial unique index on `(workspace_path, issue_number) WHERE released = 0` makes check-then-insert atomic; Test Scenario 12 added. 
7. **No new dashboard deps for #2** → confirmed; grouping reuses existing components + `architectCount`/`spawnedByArchitect` from #823.

---

## Scope narrowing (the one place I didn't expand)

- **Fuzzy "same-symptom" dedup** stays **out of scope** (issue-level only) — this is explicit in the issue and none of the reviewers contested it. The duplicate-investigation failure mode is addressed at the issue grain, which is where the observed overlap actually occurred (3 architects, 3 *issues*).
- **#6 migration of pre-existing architects** is provided as an *explicit, opt-in* command rather than an automatic on-upgrade migration — the least-disruptive choice, flagged for architect confirmation at the gate.

## Net

Two REQUEST_CHANGES → all blocking points resolved in `d7e17715`; one COMMENT → all seven gaps closed. The remaining Open Questions are deliberate architect-level decisions (most prominently: does #6 ship in this PR or its own — all three reviewers recommend its own), not unresolved design gaps.
