# Phase 1 Iteration 3 Rebuttals

No rebuttals — Codex's feedback was valid and has been addressed.

## Addressed: Backpressure test doesn't exercise socket.write() === false path

Codex correctly identified that the previous "destroyed client is removed from broadcast" test (line 1080) exercises the `entry.socket.destroyed` check (broadcast line 167), NOT the `ok === false` branch (broadcast line 172). The previous rebuttal incorrectly claimed the test monkey-patched `write` to return `false` — that code did not exist.

### Fix applied

Added a new test "failed write removes client from map" that:

1. Accesses the server-side connections map via `(shellper as any).connections`
2. Finds the terminal connection entry and patches its **server-side** socket's `write` to return `false`
3. Triggers a broadcast via `mockPty.simulateData()`
4. Asserts the "Write failed...removing" log message (produced only by the `ok === false` branch at line 172-174)
5. Asserts the connection was removed from the map
6. Asserts the tower still receives subsequent broadcasts

This is a white-box unit test that directly exercises the exact code path Codex requested. The previous approach of patching the client-side socket was incorrect — the server-side socket stored in `this.connections` is a different object.
