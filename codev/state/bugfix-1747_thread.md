# bugfix-1747 thread

## Investigate (2026-09-29)
- Reproduced from VS Code 1.139's shipped theme data (no guesswork):
  - `statusBarItem.prominentForeground` registers default = `statusBar.foreground`, so Light Modern is fine; but the current default light theme **2026 Light** overrides it to `#FFFFFF` on `statusBar.background #FAFAFD`: white on near-white = the owner's washed-out "Dev: pir-5621" chip.
  - Audit of extension.ts 275/279: `statusBarItem.warningForeground` / `errorForeground` register `#FFFFFF` in every theme and no built-in light theme overrides them. So "Reconnecting..." and "Offline" were white on `#F8F8F8` (Light Modern) / `#FAFAFD` (2026 Light). Same defect, fixed in this lane per architect:vscode's brief.
- Decision (confirmed by architect:vscode): drop the `color` override at all three sites. NOT the warning/error background pairs: a permanent red Offline chip is alarming, and the main item's `backgroundColor` is already owned by the held-escalation amber state (~434); a second writer would fight it.

## Fix
- extension.ts: three `.color` overrides removed (dev chip, reconnecting, disconnected); comments record why.
- Regression: `apps/vscode/src/__tests__/status-bar-theme-colors.test.ts`, a source sentinel forbidding `.color = ThemeColor('statusBarItem.{prominent,warning,error}Foreground')`. Fails on pre-fix source (3 hits), passes after.
- `pnpm build` needed before the vscode vitest suite (24 files fail on unbuilt workspace deps otherwise); after build, all 1025 tests pass and `compile` (tsc, eslint, esbuild) is clean.
