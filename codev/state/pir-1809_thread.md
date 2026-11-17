# pir-1809 thread

## 2026-10-13 plan phase
- Architect is `vscode` (not main). Tower + sdk plan sections (A, B, C) route to main before plan-approval.
- Decision recommended: worktree window ATTACHES READ-ONLY to parent root (no activate, no Tower auto-start). Keeps dev controls (dev PTY under parent = single-slot swap works; picks up gitignored config.local.json) and canvas registration; preview review comments are local markers either way.
- Defaults flagged for owner: suppress activity hooks in worktree windows; trim Workspace view to Dev/Dev URL/Dashboard there.
- Agents view clause chosen as `!codev.isBuilderWorktree` (not `hasWorkspace && ...`) so empty-window onboarding welcome survives.
- Cleanup = Tower startup prune pass after reconcile (liveness-aware), not a global.db migration (migrations run before liveness is known). Live stray architects are WARN-reported, never killed.
- Found: boot reconcile re-registers known_workspaces for reattached live worktree architects (tower-terminals.ts:894); registerKnownWorkspace gets a worktree no-op guard.

## 2026-10-16 implement phase
- Plan gate approved by Amr (relayed by vscode architect, attested). Both defaults adopted: hooks suppressed + Workspace view trimmed in worktree windows.
- sdk: `@cluesmith/codev-sdk/builder-worktree` (parseBuilderWorktreePath / isBuilderWorktreePath), last-segment rule, both separators.
- Tower: launchInstance refuses worktree paths (raw + realpath, before adopt); registerKnownWorkspace no-op for worktrees; getKnownWorkspacePaths filtered, new getAllKnownWorkspacePaths used ONLY by /deactivate (main's condition B).
- Deviation (location only): pruneBuilderWorktreeWorkspaces lives in tower-terminals.ts, not tower-instances.ts — tower-terminals already imports tower-instances, so the plan's location would have made an import cycle (it needs processExists + the in-memory map, both in tower-terminals). Boot order reconcile -> prune -> #341 orphan sweep; one INFO count line per boot.
- vscode architect's live repro (pir-1802 window, 10-16): phantom architect row has pid 0. Prune liveness never reads architect.pid, only in-memory map + terminal_sessions pids, so that shape prunes; covered by a test.
- Extension: detectWorkspace() tagged result; ConnectionManager attaches to parent root, no activate, no Tower auto-start; codev.isBuilderWorktree context key; codev.agents when = !codev.isBuilderWorktree. Updated contributes-view-gating.test.ts, which pinned the old "agents stays ungated" invariant the ruling reverses.
- mainCheckoutRoot keeps leaf-only semantics (existing test pins it); dev-shared mainRootOf now delegates to it.
- Pre-existing unrelated failure: packages/codev cloud-config.test.ts "enforces 0600 on pre-existing files" (expected 384 to be 420), deterministic, file untouched by this branch.
