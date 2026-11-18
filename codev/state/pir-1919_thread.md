# pir-1919 thread — Windows console windows flashing (#1919)

## 2026-11-18 — plan phase
- Confirmed the reported chain against source: Team view refreshes on every SSE event (views/team.ts:11) -> GET /api/team -> getRepoInfo -> unhidden `git remote get-url` in console-less Tower (team-github.ts:58).
- Why Spec 1658 scenario 15 missed it: the CIM Tower launch (from inside a codev session) gives Tower a *hidden* console, so its children inherit it; the plain `detached` launch (extension / plain shell) gives Tower *no* console, so every unhidden console child gets a visible window.
- Swept by import-graph walk from tower-server.ts, afx spawn, afx tower start, and the VS Code extension entry. Full site list in the plan.
- Rejected "give Tower a hidden console" as the root fix: dropping `detached` puts Tower in libuv's kill-on-close job; always-CIM adds ~1s + WMI dependency. Per-site windowsHide + a static guard test instead.
- Owner ruling relayed by architect: no AI attribution in commits/PRs/comments.

## 2026-11-18 — implement phase
- Plan approved (architect relayed). Notes from architect: prefer census for sessionHasLiveHolder; #1920 also touches session-manager.ts (expect a small rebase).
- sessionHasLiveHolder: chose the skip, not the census. Every production caller of resolveArchitectLaunch passes its own `hasLiveHolder` (main launch + add-architect use the async census-backed reconcile in architect-session-holder.ts; the restart bake passes `() => false`), so the `ps` default only ever ran in tests. On Windows with no detector it now returns false without spawning: no production behaviour change for architect launch. Using the census would have meant making resolveArchitectLaunch async for a path nothing takes.
- Adjacent fix: the extension's `porch approve` (approve.ts) and `afx cleanup` (cleanup.ts) used bare `execFile('porch'|'afx')`, which cannot run an npm `.cmd` shim on Windows. Both now go through `execCodevCli` (cli-process.ts), the same shim resolver `spawnCodevCli` uses, hidden.
- Guard test (windows-console-spawn-guard.test.ts) walks the import graph from tower-server, afx spawn, afx tower start and the extension entry, and parses each module with the TS compiler API. The first version missed inline `promisify(exec)(...)` and destructured `await import('node:child_process')`; fixture tests now cover both. That found the two `pgrep` calls in `tower.ts` stop (POSIX-only, annotated).
- Team view: createTreeView + attachView; SSE-driven fetch only while visible, ≤1 per 30 s trailing; immediate on reveal/connect/manual; no overlapping fetches. getRepoInfo cached per cwd for 5 min.
