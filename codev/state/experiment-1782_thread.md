# experiment-1782 thread (Spike: Claude Code mods for Codev, #1782 / #1761)

## 2026-10-05

- Spawned soft-mode EXPERIMENT. No spec file existed at codev/specs/1782-*; the issue body is the spec (hypothesis, criteria, method all there).
- Mod written to codev/experiments/1782-claude-code-mods-spike/mod/, deliberately NOT to the session dev-mods folder: writing there would offer hot reload into this builder session, which #1761 decision 2 forbids. Validate + plugin test + a headless `claude -p` child only; no mod ever loaded into this session.
- Contradiction found: method said keep the worked FORBIDDEN list unwidened, criteria required denying `git checkout -- .` (not in the list). Raised; vscode architect ruled A (add exactly one entry, record as the deviation).
- Routing surprise: `afx send architect` run from the MAIN root (per the "afx only from main root" rule) resolved me as a non-builder and landed on main. vscode clarified: afx send runs from the builder's own worktree root (identity from cwd); the main-root rule is for spawn/cleanup. vscode filing the doc footgun.
- Results: validate passes; 12/12 plugin tests pass on terminal + desktop; every hook's own time 0-1 ms (kit), 7-9 ms for the fetch command in a real engine; Tower GET /api/issue ~0.93-1.18 s uncached (Tower has no cache, spawns gh each call), $.store hit 0-1 ms. Budget never at risk; prefetch-on-timer chosen for user wait, not budget.
- Surprises worth carrying: Tower needs the local key (mod reads ~/.agent-farm/local-key); workspace param must be a repo (scratchpad cwd -> 404 on every issue); JSX drops `key` on Text/Markdown; dismissing $.ui.ask lands in .catch with a misleading "guard failed" reason.
- Now: four live-session questions handed off to the vscode architect (commands in notes.md "Live-session handoff"). Waiting for their report to record answers.
- vscode re-verified (validate pass, 12/12). New finding recorded as #8: stale mods rollout switch refuses plugin test until one networked claude -p run; CI must warm claude first. Live questions need a human watching the TUI: runbook posted on #1782 for Amr (afx shell --name spike). Holding for answers.
