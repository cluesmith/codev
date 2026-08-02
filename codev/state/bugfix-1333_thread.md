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

Full build + full codev suite: 4047 passed, 48 skipped, 0 failed. porch check ✓.

## PR (in progress)

Two atomic commits (Fix, Test). Pushed to `origin` (cluesmith/codev).
**PR #1334** → https://github.com/cluesmith/codev/pull/1334 (base main, "Fixes #1333").
Remote topology: origin = cluesmith/codev (PR target), fork = mohidmakhdoomi/codev.

CMAP (gemini/codex/claude, --protocol bugfix --type pr) run in background.
NOTE: `consult` couldn't auto-resolve the project in this worktree — the
disambiguator regex expects `.builders/<digits>-<suffix>` but our worktree is
`.builders/bugfix-1333` (no suffix after the digits), so it errored "Multiple
projects found". Worked around with `--project-id 1333` (matches `bugfix-1333-…`
via the `bugfix-` branch in consult/index.ts:285). Possible separate bug.

⚠️ BASE-SCOPE FLAG (for architect, not mine to fix): this branch was spawned
from an architect HEAD that is 2 commits ahead of origin/main — `fef6bddf
[Spec 1313] Initial specification draft` sits BELOW the porch-init commit. So
`origin/main...HEAD` includes `codev/specs/1313-afx-send-mailbox-first-delivery.md`
(+240 lines) — unrelated to #1333. Merging PR #1334 with --merge would land that
spec in main too. Not rewriting porch-tracked history unilaterally; flagged the
architect to decide (drop via rebase onto origin/main, or intentionally land it).
My own diff is exactly: tower-client.ts, the new test, the thread, + porch's
status.yaml.

### CMAP verdicts (PR #1334)
- **gemini = REQUEST_CHANGES** (HIGH): code + tests "excellent"; sole blocker =
  the unrelated Spec 1313 file.
- **codex = REQUEST_CHANGES** (HIGH): implementation "correct", tests "sound";
  sole blocker = same Spec 1313 file.
- **claude = APPROVE** (HIGH): independently verified the root-cause chain +
  blast radius against source (confirmed no client-side `result.error===CODE`
  consumers; the `.error?.includes` sites at tower-routes 562/621/1923/2580 are
  server-side; typeof guards are genuine hardening). Spec 1313 flagged
  NON-blocking.

**Unanimous on the code: fix + test are correct and well-scoped.** The only
blocker is the inherited Spec 1313 file. Key de-risking fact (from claude):
`fef6bddf` is ALSO an ancestor of open PR #1330 (builder/spir-1313), so dropping
it here is LOSSLESS — the spec still lands via #1330.

### Escalated to architect (queued via mailbox, main busy)
Asked for go-ahead before `git rebase --onto origin/main fef6bddf
builder/bugfix-1333` + force-with-lease — because that force-pushes already-pushed
history on a shared branch (outward-facing / hard-to-reverse → confirm first).
HOLDING the porch `pr`-gate request (`porch done`) until the base-scope question
is resolved. Awaiting architect decision: rebase-to-clean vs. merge-as-is.
