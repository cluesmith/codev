# Phase 4 (Tower canvas view registry and command route) — Iteration 1 Rebuttals

Verdicts: gemini APPROVE · codex REQUEST_CHANGES · claude REQUEST_CHANGES.

All findings accepted and fixed; nothing disputed. Both reviewers landed on the same two defects
from different angles, and one of them defeated the phase's central guarantee.

## 1. (Blocking, claude) Command delivery refreshed the liveness lease

Accepted, and this was the serious one. `handleCanvasCommand` set both `lastActiveAt` **and**
`lastSeenAt` on the resolved target. `lastSeenAt` drives lease expiry, so a ghost view kept
renewing itself for exactly as long as a controller kept driving it.

The failure mode is worse than "a stale entry lingers": the guarantee this phase exists to
provide is that a dead host's view ages out and the caller is told `no-canvas`. Under steady
command traffic, which is the normal case for a controller, that guarantee silently inverted —
the view would never expire, and every command would report success at a canvas nobody could see.

Fix: delivery advances `lastActiveAt` only. Liveness now comes exclusively from heartbeats, which
only a live host can send; delivery is fire-and-forget over SSE and proves nothing about the host.
The comment at the assignment now says so, since the omission is the kind a later edit would
"helpfully" restore. Regression test drives a view for four lease-thirds with no heartbeat and
asserts it expires anyway.

## 2. (Blocking, both) A literal `null` body escaped as a 500 with no wire `code`

Accepted. `parseJsonBody` is typed as returning an object but resolves any valid JSON, so `null`,
a number, or an array parse fine and then throw on the first field read. That surfaced as an
unhandled 500 with no `code` — precisely what the error contract forbids, since a caller cannot
distinguish it from anything else.

Fix: an `asObject` guard after every `parseJsonBody`, in all three handlers, returning the
contract's `invalid-request`. Tests cover `null`, a number, a string and an array.

## 3. (Codex) A malformed heartbeat renewed the lease

Accepted, and it belongs with the lease bug above. My handler caught the parse error and fell
back to `{}`, treating a broken payload as a valid bodyless heartbeat. A genuinely bodyless
request already parses as `{}` on its own, so the catch was only ever reachable for malformed
input, and it extended liveness on the strength of a request Tower could not read. Now a 400,
with a test asserting the bad heartbeat buys no time.

## 4. (Codex/claude, non-blocking) Response literals were untyped, and the registration type was wrong

Accepted both parts. Success and failure responses are now annotated with `CanvasCommandResult`
and `CanvasViewRegistrationResult`, so a drift between what Tower sends and what the contract
declares fails the build rather than reaching a client. Building that annotation immediately
surfaced the second half of the finding: `CanvasViewRegistrationResult` omitted the `ok` field
Tower actually sends. The contract was wrong, not the handler, so `ok: true` was added to the
type. An `invalidRequest()` helper now constructs the failure shape, so the `code` cannot be
forgotten at a new call site.

## Gemini (APPROVE)

No issues raised; no changes required.

## Verification after the fixes

- 27/27 unit tests (4 new, covering both defects).
- 5/5 e2e against a real booted Tower.
- Repo-wide `check-types` clean; repo build green.
