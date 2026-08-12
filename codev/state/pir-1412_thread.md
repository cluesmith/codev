# pir-1412 — Clickable `#N` / `PR #N` terminal refs (VS Code)

## Plan phase (2026-08-12)

Wrote `codev/plans/1412-vscode-terminallinkprovider-ma.md`. Two empirical verifications drove the design:

1. **Discriminator (architect concern #3):** `gh issue view <PR#>` does NOT fail on a PR number — it
   resolves (exit 0) with a `.../pull/N` url. So issue-vs-PR must be decided by the **url path segment**
   (`/pull/` vs `/issues/`), read off `IssueView.url`, not by fetch-failure. This is the faithful reading
   of the decided "if the number resolves as a PR instead" behavior.
2. **API (concern #1):** against pinned `@types/vscode ~1.105.0`, `TerminalLinkContext.line` is the
   **unwrapped logical line** — so no wrap limitation (concern #4). d.ts warns against shared-`RegExp`
   reentrancy → build the regex per call (unlike the sibling `BuilderTerminalLinkProvider`).

Design: extend existing `terminal-link-provider.ts` with `IssueRefTerminalLinkProvider`; new
`commands/open-terminal-ref.ts` holds resolution and delegates to the three sanctioned reuse helpers
(`openPRInBrowser` / `openIssueInBrowser` / `viewBacklogIssue`) — no new fetch code. New setting
`codev.terminalLinks.issueTarget` (editor|browser, default editor). Bare-#N click costs 2 SDK
round-trips (discriminator + helper re-fetch); accepted for single-owner-per-destination — documented.

Registered in extension.ts beside the two existing providers. `vscode/` app only — no skeleton mirror
(this is our extension, not framework template content).

**Status:** plan committed, awaiting `plan-approval` gate. dev-approval will be a live terminal check.

## Implement phase (2026-08-12)

plan-approval approved. Rebased on main first (was 95 behind). Implemented:
- `commands/open-terminal-ref.ts` — resolution: PR#N→openPRInBrowser; bare #N→getIssue discriminator
  (url `/pull/`→PR fallthrough, else editor via `executeCommand('codev.viewBacklogIssue')` or browser
  via openIssueInBrowser per `codev.terminalLinks.issueTarget`).
- `terminal-link-provider.ts` — added `IssueRefTerminalLinkProvider` (regex `/(?<pr>\bPR\s+)?#(?<num>\d+)/gi`,
  built per call).
- `extension.ts` — registered beside the two existing providers.
- `package.json` — `codev.terminalLinks.issueTarget` setting (editor|browser, default editor).
- `__tests__/terminal-ref-link-provider.test.ts` — 12 tests (detection + resolution routing).

**Gotcha caught by tests:** first version imported `viewBacklogIssue` directly from view-issue.js, whose
module-level `new vscode.EventEmitter()` singleton broke `reconnect-link-provider.test.ts` (loads the
provider with a bare vscode mock). Switched to `executeCommand('codev.viewBacklogIssue', N)` — the same
indirection open-issue-by-id.ts already uses, no load-time coupling. Full suite green after.

Verified from worktree: `pnpm compile` (check-types + lint) clean (1 pre-existing tunnel.ts lint warning,
not mine); `pnpm test:unit` 806 passed (68 files). Awaiting `dev-approval` — live terminal demo.

### dev-approval feedback #1 — perceived slowness (2026-08-12)

Reviewer: working but ~2s with no feedback → feels like nothing happens. Root cause: (a) VSCode gives
no click feedback on terminal links; (b) bare #N did TWO gh round-trips (discriminator getIssue + the
reuse helper re-fetching). Fix:
- Wrapped resolution in `withProgress` (status-bar "Opening #N…") for instant feedback.
- Bare #N now fetches once: the discriminator getIssue's `url` is opened directly via `openExternal`
  for the PR-fallthrough and browser-issue paths (no helper re-fetch). Editor preview still fetches once
  to render (that fetch IS the content). Explicit PR #N unchanged (openPRInBrowser, no discriminator).
- Tradeoff: PR can now be browser-opened by two paths (explicit vs fallthrough); still no new fetch code
  (openExternal opens a url already fetched via the sanctioned getIssue). Flagged to reviewer.
Green: check-types + lint clean, 807 unit tests.
