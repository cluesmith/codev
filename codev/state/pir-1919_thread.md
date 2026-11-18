# pir-1919 thread — Windows console windows flashing (#1919)

## 2026-11-18 — plan phase
- Confirmed the reported chain against source: Team view refreshes on every SSE event (views/team.ts:11) -> GET /api/team -> getRepoInfo -> unhidden `git remote get-url` in console-less Tower (team-github.ts:58).
- Why Spec 1658 scenario 15 missed it: the CIM Tower launch (from inside a codev session) gives Tower a *hidden* console, so its children inherit it; the plain `detached` launch (extension / plain shell) gives Tower *no* console, so every unhidden console child gets a visible window.
- Swept by import-graph walk from tower-server.ts, afx spawn, afx tower start, and the VS Code extension entry. Full site list in the plan.
- Rejected "give Tower a hidden console" as the root fix: dropping `detached` puts Tower in libuv's kill-on-close job; always-CIM adds ~1s + WMI dependency. Per-site windowsHide + a static guard test instead.
- Owner ruling relayed by architect: no AI attribution in commits/PRs/comments.
