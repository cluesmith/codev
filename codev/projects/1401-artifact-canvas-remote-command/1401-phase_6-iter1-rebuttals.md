# Phase 6 (VS Code host wiring) — Iteration 1 Rebuttals

Verdicts: gemini APPROVE · claude COMMENT · codex REQUEST_CHANGES.

Every actionable finding is fixed. One finding corrected *me*, and it is the most useful thing to
come out of this round. One item cannot be closed by a builder and is escalated rather than
waved through.

## 1. (Both) No reconnect handling — up to 30s undrivable after a Tower restart

Accepted. Re-registration triggered only on a heartbeat coming back `unknownView`, so after a
Tower restart every open panel stayed dead until the next beat, up to the full 30-second
interval. The same gap applied at startup: registration at open time is a no-op while there is no
client yet, so a slow first connection left the panel unregistered until a beat rescued it.

Now subscribed to `connectionManager.onStateChange`; on `connected` the stale id is dropped and
registration runs immediately. Two tests: re-register on reconnect, and ignore non-connected
states.

## 2. (Claude) Re-registration race could orphan a fresh view

Accepted, and subtle. Two heartbeats can be in flight at once (the timer and an activation).
If both come back `unknownView`, the first clears the id and registers a replacement, then the
second clears *that* replacement and registers again — leaving the first replacement orphaned in
Tower until its lease lapsed, absorbing nothing but occupying a registry slot and skewing MRU.

Fixed by capturing `beatViewId` before the request and only clearing when `viewId` still equals
it. Test drives two concurrent activations against a heartbeat that always answers unknown-view.

## 3. (Both) Unregister on extension deactivate was named in the plan but missing

Accepted rather than explained away. Panels clean up their own registration on dispose, but
deactivate does not dispose panels individually, so every open view would have sat in Tower until
its lease lapsed. The provider now tracks live registrations, implements `Disposable`, and is
pushed into `context.subscriptions`; `extension.ts` holds it in a local so it can be.

## 4. (Both) The SSE command was forwarded without validating the closed union

Accepted. Tower validates before relaying, so this is defence in depth — but an SSE frame is
untrusted input crossing a process boundary, and forwarding an unchecked string into the webview
pushes the problem into code that does no validation of its own. There is now a runtime
allowlist, pinned to `CanvasCommand` by an `AssertTrue` guard so the contract cannot outgrow it,
plus a sanity check on `count`. The guard promptly earned its place: it failed the build when the
type import was missing, instead of passing silently.

## 5. (Claude) Eleven lint warnings, all in the new file

Accepted. Every brace-less single-line `if` in `registerCanvasView`. They were warnings, so
nothing failed, but the surrounding `markdown-preview/` code braces its guards consistently and
the new file was the only one warning. Braced; `eslint` on the directory is now clean.

## 6. (Claude) My own premise was wrong: the webview *is* typechecked

**This one corrected me, and I have propagated the correction.** I asserted in the plan, in a
phase 3 rebuttal, and in the first draft of the review file that `webview/main.ts` has no
`check-types` coverage, reasoning from `apps/vscode/tsconfig.json` excluding that directory. I
stopped one file too early: `tsconfig.webview.json` covers exactly that directory, and the
package's `check-types` script runs **both** configs.

I verified it myself before accepting. The review file now carries an explicit correction to the
plan's claim. The manual pass is still required, but for the ordinary reason that types do not
prove runtime behavior across three processes — not because the code was unchecked. I had been
overstating the justification.

Claude's related correction about the test script is also recorded: `pnpm --filter codev-vscode
test` maps to `vscode-test` (the Electron harness, which fails in this environment for unrelated
reasons), while the unit tests run under `test:unit` → `vitest run`, which is what CI invokes and
what I ran. The new tests are genuinely executed in CI.

## 7. (Codex) The manual end-to-end pass was not performed

**Accepted as an open item, not fixed — and deliberately not signed off.** It requires a real VS
Code window with the extension loaded, a running Tower, and an open canvas panel, which a builder
in a headless worktree cannot produce. Claiming it was done would be the exact failure mode the
protocol's "tests pass is not it works" lesson exists to prevent.

What is verified: the Tower route end to end against a real booted Tower, the canvas seam by unit
plus Playwright plus a human's own dev-page session, and the sdk and host glue by unit tests with
fakes. What is unverified is only the seam between them in a live VS Code.

It is documented as an outstanding, blocking-for-sign-off item in the review file, with a
four-step script for the reviewer, and it is called out in the PR body. The `pr` gate is a human
gate, which is the right place for a human-only verification to land.

## Verification after the fixes

- 16/16 host-glue tests (4 new), 793/793 vscode unit suite.
- `check-types` clean for the extension (both configs) and repo-wide; `eslint` clean.
- Repo build green; 4847 repo tests pass.
