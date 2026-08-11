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
