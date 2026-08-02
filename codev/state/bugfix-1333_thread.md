# bugfix-1333 — afx send drops descriptive NOT_FOUND reason

Issue #1333 (area/tower). BUGFIX protocol, strict mode.

## Investigate (complete)

**Bug:** `afx send architect:<name>` from a builder to a non-spawning architect prints
only `[error] NOT_FOUND`. The human/agent can't tell "no such architect" from "not
authorized to address that architect" — both look identical.

**Root cause (verified in code):** Tower *produces* a descriptive message; the client
*drops* it in favor of the machine code.

1. `tower-messages.ts:229-240` `resolveArchitectByName` returns a helpful `message`:
   - spoofing: `builder <id> may only address its own spawning architect`
   - genuinely missing: `Architect '<name>' not found in workspace '<ws>'.`
2. `tower-routes.ts:1472` `handleSend` serializes BOTH → `{ error: code, message }`. Wire OK.
3. **`core/src/tower-client.ts:221`** `error = json.error || json.message || text`
   — prefers `json.error` (the code) over `json.message` (the detail). **← root cause.**
4. `tower-client.ts:695` `sendMessage` → `{ ok:false, error: result.error }` = `'NOT_FOUND'`.
5. `send.ts:329,334` `throw new Error(result.error)` → `fatal('NOT_FOUND')` → bare code.

**Fix decision:** single point, `tower-client.ts:221`. When the response carries both a
machine `error` code and a human `message`, surface `"<message> (<code>)"`; otherwise fall
back to whichever is present, then `text`. This keeps the machine code visible (issue's
"keep the machine code available") and keeps the two cases distinguishable (issue's ask).

**Blast radius (checked):**
- No client-side programmatic comparison of `.error` against code strings — the only
  `=== 'NOT_FOUND'/'AMBIGUOUS'/'NO_CONTEXT'` checks are server-side on `result.code`.
- No existing test exercises `request()`'s extraction: core has no tower-client test and
  no fetch mock; `send.test.ts` mocks `sendMessage` directly; server tests assert on
  `result.code` and the HTTP response body. All unaffected.
- Change is strictly MORE informative for every Tower CLI error, not just send.

**Fix chosen at `request()`** (global) rather than `send.ts` (local): the message is already
collapsed by the time it reaches `send.ts`, so a send-only fix would require plumbing a new
`message` field through `sendMessage` + `request` (3 files, return-type changes). The
one-line-family change at the drop site is smaller and benefits every caller.

Scope: ~10 LOC + regression test. Comfortably within BUGFIX.

## Fix (complete)

**Change:** `packages/core/src/tower-client.ts`
- Extracted a module-private helper `extractTowerError(text)` (the previous
  inline try/catch extraction was duplicated verbatim at TWO sites — `request()`
  and `pasteImage()`; both had the identical drop-the-message defect). Per
  lessons-critical "consolidate duplicates rather than syncing them", one helper
  now feeds both sites.
- New logic: when both a machine `error` code and a human `message` are present
  and distinct → `"<message> (<code>)"`; else `message || code || rawText`.
  `typeof === 'string'` guards also harden against non-string `error` fields.

**Regression test:** `packages/codev/src/agent-farm/__tests__/bugfix-1333-error-surfacing.test.ts`
- Lives in the codev package because porch's `test` check = `npm test` =
  `pnpm --filter @cluesmith/codev test` (codev vitest only; core's own vitest is
  NOT run by porch). It imports `TowerClient` via the codev re-export → built
  core dist → the exact artifact the CLI consumes. So `npm run build` (rebuilds
  core first) must precede `npm test`; porch runs them in that order.
- 6 cases: the #1333 spoofing scenario via `sendMessage`; spoofing-vs-missing
  distinguishability; + 4 backward-compat guards (code-only, message-only,
  equal code==message, non-JSON body).

**Proven fails-without / passes-with:** stashed the core source, rebuilt, re-ran
→ cases 1 & 2 fail with `Received: "NOT_FOUND"` (the exact bug); 4 guards still
pass. Restored + rebuilt → all 6 pass.

Next: full build + full codev suite, then PR + CMAP.
