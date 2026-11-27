# Phase 7, iteration 3: response to review

codex asked for changes (HIGH confidence). claude approved (HIGH), with one carry-forward for
phase 8 and one nit. codex's point is taken and fixed, and so is claude's nit. The
carry-forward is recorded for phase 8. Nothing is disputed.

## codex: a delayed `auth_ok` can give a new registration the previous cloud's relay

**Taken.** `connectTunnel` kept the `config` its client connected with, but passed
`onTunnelAuthOk` only the relay. `PeerList.noteAuthOk` then scoped what it noted to the
registration current when the `auth_ok` arrived. Suppose registration B is written while
registration A's handshake is out, and A's `auth_ok` then arrives. Two things went wrong:

- A's relay was noted as B's.
- B's pending switch-state report was cancelled.

If B never connected, the false relay state stayed.

Changed:

- **What the tunnel passes.** `tower-tunnel.ts` gives `onTunnelAuthOk` the registration the
  connection was made under: its client's server URL and Tower id.
- **What `noteAuthOk` notes.** `PeerList.noteAuthOk(status, connectedAs)` notes nothing unless
  that registration's scope is the current one, and says whether it noted. The same Tower on
  the same cloud matches whatever its key, and however its URL ends.
- **What `onTunnelAuthOk` does with a stale one.** For an `auth_ok` that was not noted, it
  logs INFO once and does nothing more. No report is cancelled, and no switch change is
  reported.
- **claude's nit, `lastStatedSwitch`.** It was a module global. It is now per client: each
  `TunnelClient` gets `PEER_OPTIONS` with its own `remoteMessaging`, which records what that
  client's `auth` stated. So a late `auth_ok` from one client cannot carry another client's
  stated switch either. The receiver is still the one shared instance.

Tests:

- `tower-tunnel.test.ts`, with `cloud-wiring` mocked. Another registration is written while a
  connection's handshake is out, and that connection's `auth_ok` then arrives. It is handed
  over with the registration the connection was made under (`https://codevos.ai`,
  `tower-abc`), not the current one.
- `peer-cloud-wiring.test.ts`: an `auth_ok` for a replaced registration leaves the relay
  `unknown`, cancels no report, reports no switch change, and logs the INFO line.
- `peer-list.test.ts`: `noteAuthOk` refuses a replaced registration, takes the current one,
  and takes the current one with its URL written another way.
- With the fix removed, each of the three fails: the tunnel's call has two arguments, and the
  others note the relay and cancel the report.
- In passing, fixed a type error that was already in `tower-tunnel.test.ts`: the `maskApiKey`
  mock spread `unknown[]` into a typed function. The test-file type-check found it; the build
  does not compile tests.

## claude, note 1: the relay call is not tied to its registration (phase 8)

**Recorded for phase 8, not changed here.** `CloudClient.relay` has no production caller in
phase 7. Phase 8's outbox is where an answer meets a row, and it knows the row and the peer. It
will keep the scope a relay call was made under, and resolve a row only from an answer under
the current one. It will also read `relayStated()` for that scope as it stood when the call
began. The carry-forward is in the thread and in my phase 8 notes.

## claude, note 2: `lastStatedSwitch` is a module global

**Taken.** See above.

## claude, notes 3 and 4

Nothing to change. Note 3 describes the intended order. Note 4 is not raised again.
