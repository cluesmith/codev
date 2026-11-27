# Phase 5, review iteration 2: response

Codex: REQUEST_CHANGES (HIGH), a new point. Claude: APPROVE (HIGH). Nothing is disputed.

## Codex

**Accepted: a valid `auth_ok` could repeat its session secret in a field Tower keeps.**
`towerId`, `slug` and `name` reach `onAuthOk`, and tower-tunnel then persists them to
`cloud-config.json` and logs them. Now the tunnel client checks each of those three fields
before it uses anything from an `auth_ok`. The check compares against the secret as sent
(`relay.sessionSecret`, when it is a string of 16 characters or more) and against the
decoded secret written as base64url, base64 with and without padding, and hex in either case.

If any field repeats it, the response is not used at all:
- no session is opened;
- no identity is emitted;
- `towerId` is not adopted;
- the attempt fails as `auth_ok not used: a field repeats its session secret (not shown)`.

This holds whether or not the secret would have been taken. An offer the client refuses
(malformed, or over an insecure transport) still carries the secret, and that copy must not
be persisted either.

Test: a cloud of the test's own answers `auth` with a clean `auth_ok` first, as a control
that is used, and then with each of these:
- the secret in `name` (base64url, and hex upper-cased);
- in `slug` (hex, and unpadded base64);
- appended to `towerId` (base64);
- a malformed (padded) secret repeated in `name`.

None emits an identity, and no state reason, console line or identity contains the secret
in any form. With the check disabled, the test fails.

## Claude

1. **Not changed; put to the architect:** an unreadable switch fails the connect attempt.
   Stating `off` with a WARN would also be fail-closed for messaging and would keep the rest
   of the tunnel up, but it is a fallback, and the owner's standing rule is fail fast with no
   fallbacks. That makes this an explicit decision for the architect, and the phase report
   asks for it. Until a ruling it stays as built: design choice 5, tested in
   `peer-entry-point.test.ts`.
2. **Taken:** a test now shows the old session's secret going to `null` and its id memory
   being cleared, both on a reconnect (the drop path) and on a disconnect. It holds the
   session object across the change, so deleting the nulling in `cleanup()` fails it.
3. **Done:** Windows re-dispatch 45930869011 at 94b6bd1a2 is green. Both probe legs passed
   with all six `afx://` argv steps, and so did Unit tests (bugfix-1871's teardown included),
   CLI tests and install verification. Recorded in the thread.
4. **Taken:** bugfix-1871's comment and the thread now say the switch is read when the client
   sends `auth`.
5. **No change, as the review says:** a statement that MACs correctly but is not JSON is
   refused `unsupported-version` at step 3, as contract section 5 says.

## Architect ruling on claude's point 1 (2026-11-27T03:05Z)

Keep failing the attempt: Tower states only what it knows, and the back-off recovers by
itself once the read works. Two conditions, now built:

1. **An ERROR line naming the cause.** `tower-tunnel.ts` reads the switch through
   `readSwitchForAuth`. On a failure it logs
   `Cloud connection not made: the remote-messaging switch is unreadable: global.db could not be read (<class> <code>). Retrying on back-off.`
   at ERROR, once per failing run, so a 60-second back-off does not repeat it. It shows the
   error class, plus its SQLite code when the code has the shape of one, but never the
   message. The fixed text it throws becomes the tunnel's state reason.
2. **`afx tower status` shows the reason while it lasts.** `TunnelClient.getLastFailure()`
   keeps the last failed attempt's reason (already sanitized) until the tunnel connects again
   or is disconnected on purpose. `GET /api/tunnel/status` carries it as `lastFailure` (null
   when connected), the SDK's `TowerTunnelStatus` has the optional field, and
   `afx tower status` prints `Last failure` under `Connection` when it is set.

Tests:
- Through tower-tunnel's real wiring:
  - a switch that throws a `SqliteError` with `SQLITE_CORRUPT` gives exactly one ERROR line
    over two failing attempts;
  - no handshake is sent;
  - the status reports the reason;
  - once the read works, the back-off connects and the status clears it;
  - the error's message never appears in the log.
- The client's own test checks `getLastFailure()` while the switch is unreadable, and checks
  it is cleared on `disconnect()`.
- The CLI prints `Last failure` while the connection is down, and nothing when connected or
  for a Tower that predates the field.

