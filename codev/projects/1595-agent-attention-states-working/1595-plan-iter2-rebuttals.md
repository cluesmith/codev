# Plan 1595, iteration 2: rebuttal and disposition

Verdicts: Gemini APPROVE, Codex COMMENT, Claude REQUEST_CHANGES. All points were verified in the code and accepted.

## Claude

1. **Builder key.** Accepted, verified at `overview.ts:664-668`: `storedRoleId` keeps the stored id only for the `builder-`/`worktree-` shape. The key is now `storedRoleId(row) ?? worktreeNameToRoleId(dirName)`, extracted to one shared function. The resolver shares only the row matcher with `send.ts`, never its returned `row.id`. It is null-returning; `send.ts` keeps its throwing #1094 wrapper.
2. **`prReady` suppression.** Accepted, verified at `builder-helpers.ts:140/152`. A served `needs-input` or `dead` on a `prReady` builder is listed in `waiting`. `idle` and the PTY path stay suppressed for `prReady` as today. The porch-gate case still projects `blocked`.
3. **Census.** Accepted. Liveness uses `listProcessCensus()` (#1227) with the husk-sweep childless predicate and `census` seam. `census.length === 0` means unknown (`alive: null`, no confirmation counted), so a failed `ps` cannot mark the fleet dead.
4. **Double injection.** Accepted, verified at `tower-utils.ts:400/423/438`. The injection lives in `buildArchitectArgs` plus the single resume primary return. Reaching the no-Tower `afx architect` is noted as harmless: no identity, so nothing is sent.
5. **Lookup cost and `liveArchitects` callers.** Accepted. Lookups use Tower's `getGlobalDb()` handle behind a memo, never a new connection per report; both `liveArchitects` callers are updated.

## Codex

- `WorkView.tsx` (passes architects to `NeedsAttentionList`) and the contextual panel webview `main.ts` are added to Phase 7.
- The grep gate is qualified to agent-attention logic; `OpenFilesShellsSection.tsx`'s utility-terminal threshold is out of scope.

## Gemini

- APPROVE, no issues.
