# pir-1354 thread

## 2026-08-11: Plan phase

Investigated the replay data path end to end. The pivotal finding: Spec 1313's render-gate
mirror (`SessionScreen`) already runs a `@xterm/headless` Terminal per live session, fed the
same bytes as the ring buffer at the single output chokepoint, resized in lockstep, with a
monotone flush token (`ringBuffer.bytesWritten`). The emulator #1354 asks for already exists;
the work is a serialize step (`@xterm/addon-serialize`) plus attach-path wiring.

Ran the architect-required empirical library verification in the worktree (gitignored tmp/,
promoted to committed tests in phase 1 of the plan): fed the real captured Claude replay
fixtures (they are alternate-buffer streams) and synthesized 12 MB zero-newline alt-screen
workloads through headless xterm 6.0.0 + serialize addon 0.14.0. Cell-exact round trips on
every stream, including cursor, buffer type, and normal-buffer survival across alt-exit.
Payloads: 1.7-9.2 KB from multi-MB inputs. Serialize under 5 ms. Memory measured: ~215 KB per
filled 200x50 mirror at scrollback 200, ~509 KB at 1000. Alternatives (node-ansiterminal,
terminal.js, headless-terminal, vt100) are all abandonware, last published 2022; rejected on
maintenance alone.

Plan written to `codev/plans/1354-o-screen-replay-headless-termi.md`. Key decisions: Tower-side
only (shellper phase 2 explicitly out of scope); reuse SessionScreen rather than a second
emulator; token-loop flush with a no-await serialize+attach critical section; buffer-type-aware
resume (delta for normal buffer, snapshot for alternate); full-replay mirror seeding on adopt
(shrinks #1361's tear window); WARN `replay-snapshot-fallback` log line as the desync detection
signal; all #1353 caps untouched as defense in depth.

At the plan-approval gate.

Architect review verdict: RECOMMEND APPROVE (independently verified SessionScreen internals,
addon metadata, getSince alt-screen behavior, #1361). One implementation-time note, not a plan
revision: phase 4's full-replay mirror seeding costs ~100 ms per adoption and Tower restart
re-adopts every session at once (30 sessions could add ~3 s). At implement time, measure the
aggregate on a realistic fleet and ensure adoption feeding cannot block Tower's startup/serving
path (async or lazy-on-first-attach both acceptable); document the choice in the review
artifact. Waiting for the human gate decision before implementing.

## 2026-08-11: Implement phase

Plan approved by the human; implemented in five commits matching the plan's phasing:

1. `SessionScreen.serialize()` + `@xterm/addon-serialize@^0.14.0` + round-trip fixture
   tests (scrollback raised 200 -> 1000 for ring-parity history; render-gate suite green,
   confirming gate neutrality). One type-level bridge: the addon's typings bind to the
   full `@xterm/xterm` Terminal, so `loadAddon` needs an explicit cast to the headless
   `ITerminalAddon`; runtime compatibility is proven by the round-trip suite.
2. `PtySession.replaySnapshot()`: flush-until-quiescent `bytesWritten` token loop
   (3 attempts), typed fallbacks (no-mirror / flush-timeout / serialize-error /
   empty-snapshot), `addClient` extracted so attach sites can register a client in the
   same microtask as the token re-check (byte-partition property, tested).
3. Shared `attachWithReplay` routing used by BOTH attach sites (tower-websocket +
   standalone TerminalManager): fresh attach -> snapshot; normal-buffer resume -> delta
   lines (unchanged); alternate-buffer resume -> snapshot; any failure -> raw-ring
   fallback. Detection: WARN `replay-snapshot-fallback` (INFO for the routine no-mirror
   case, a deliberate deviation from the plan's all-WARN wording to avoid log spam from
   silent sessions). Handlers went async; message/close handlers register before the
   await; a close during the flush detaches cleanly.
4. Adoption seeding: ring seed stays `capRingSeed`-capped (client fallback payload);
   the mirror now gets the FULL shellper replay. Architect's startup-cost concern
   resolved by sequential drain in the reconcile loop, applied only to >1 MiB seeds.
   Measured (scratch bench through the real attachShellper path, deleted after use):
   30 sessions x 8 MB = 1.74 s total, 58 ms/session, heap delta 27.6 MB. The #1361
   adopt-tear test now has a companion proving the production call shape classifies
   CLEAN; the HOLD pin remains for tail-cut mirror seeds.
5. Wire-level e2e: real PTY running an alt-screen script, real WS client through
   TerminalManager's upgrade handler; asserts the first replay frame alone (<64 KB, no
   nudge) renders the current screen. The existing tower-websocket unit tests were
   updated for the async handler (mock session gained the new members; legacy raw-path
   expectations preserved via the no-mirror fallback).

In-browser verification (dashboard + VS Code) deferred to the dev-approval gate per the
plan's test plan; the human reviews the running worktree there.
