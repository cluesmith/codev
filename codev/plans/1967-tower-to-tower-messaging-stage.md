# Plan: Tower-to-Tower messaging, stage 2 — the Tower half

**Specification**: [codev/specs/1967-tower-to-tower-messaging-stage.md](../specs/1967-tower-to-tower-messaging-stage.md)
(approved 2026-11-25, decision main-55, at `9978e13a0`; contract revision 4 at `68cff8fe4`, a cloud
correction the owner's approval allowed for). The design it builds is
[codev/specs/1940-tower-to-tower-messaging-proto.md](../specs/1940-tower-to-tower-messaging-proto.md);
"Decision N" below refers to that spec, "the contract" to the spec's Wire Contract section (revision
4), and C/G/K numbers to its Departures.

## Executive Summary

The spec chose both open approaches, and the owner adopted them at the gate:

- **Approach 1A.** The receiving entry point lives inside Tower's tunnel client, on the one path
  `POST /__tower/peer`. The client verifies the statement with its own session's secret and hands
  only a verified request to delivery code inside the process. The path never reaches the local
  listener.
- **Approach 2A.** The Tower half is proven against a stand-in relay that implements the cloud's
  side of the contract, plus shared test vectors the cloud runs too.

The plan builds that in thirteen phases, each one commit on `builder/spir-1967`, with one PR at the
end. Five choices shape the phases.

**1. One module speaks the contract** (architect's item 3). All of the Tower's knowledge of the wire
lives in `packages/codev/src/agent-farm/peer/contract.ts`:

- header names and the protocol constants;
- encoding and decoding the statement, the payload and the answer;
- the MAC and the payload hash;
- every field rule, including the excluded code points;
- the mapping from an HTTP status to an outcome.

Only the TypeScript shapes and the constants go in `codev-types` (`packages/types/src/peer-wire.ts`),
as the server/client isolation rule requires. No other *production* file builds a header, parses a
statement or reads a status code, so a late correction from the cloud is a change to one file and
its tests. The one deliberate exception is test code that plays the cloud: the stand-in relay
(`__tests__/helpers/stand-in-relay.ts`) and the tests that hand-craft requests to it. They must
contain the protocol themselves, for the reason in choice 2.

**2. The stand-in relay is written independently of that module.** It imports the shapes and
constants from `codev-types` and uses `node:crypto` directly. It never imports `contract.ts`. If it
did, a misreading of the contract would be mirrored on both sides and every test would still pass.
For the same reason, the test that checks the shared vectors computes the HMAC and hash with
`node:crypto` and only then compares them with `contract.ts`.

**3. Storage: no mailbox table rebuild.** The spec left three options. The plan takes the precedent
migration v18 set:

- **Columns on `mailbox`.** Remote mail that has *arrived* is a mailbox row like any other (mailbox
  first, render gate, locks). It gains nullable columns that carry its remote provenance, and an
  integer `release_hold` column for mail held for release. None has a `CHECK`; the values are
  enforced in TypeScript.
- **How held-for-release is stored.** Such a row is `status = 'held'`, `reason = NULL`,
  `release_hold = 1`. The API reports its reason as `held-for-release`, a value added to the reason
  union in `codev-types`. The existing `CHECK`s are untouched (the `reason` column's `CHECK` allows
  `NULL`).
- **Mail waiting for a peer lives in its own table, `peer_outbox`.** It never enters `mailbox`, so
  Spec 1313's drainer and escalation cannot see it (criterion 7 holds by construction).
- **Other new tables:** accepted-once records, grants, the switch, the cached peer list with former
  names, and the record.
- **Accepted-once records outlive mailbox retention.** `peer_accepted` is kept for at least 30 days,
  whatever the mailbox retention. It carries the message's current state itself (delivered, held
  with its reason, or dismissed), so the answer to a duplicate never depends on the mailbox row.
  `pruneTerminal` deletes delivered and dismissed rows after `mailbox.retentionDays`, which may be
  shorter than 30 days.
- **Why not a rebuild.** A rebuild would copy every row of every upgraded install's mailbox,
  including held mail. Additive columns and new tables cannot make a fresh install diverge from an
  upgraded one.

**4. Test layers, and what runs where** (architect's item 2). Porch's tests check runs
`npm test -- --exclude='**/e2e/**'` in `packages/codev`. Its `--exclude` adds to the exclude list in
`vitest.config.ts`, and that list already excludes every `*.e2e.test.ts` (the 25 such files today do
not run in porch's check). So a file named `*.e2e.test.ts` is outside porch's check wherever it
lives, and phase 2 confirms it once by running porch's exact command with a new one in place. The
plan uses that boundary:

| Layer | Files | Runs | What it may do |
|---|---|---|---|
| **A. Unit and in-process** | `*.test.ts` | **Inside porch's tests check** (3 workers, 15 minutes) | No Tower process, no socket other than loopback, an injected clock for every time-dependent rule. Includes the stand-in relay talking to an in-process tunnel client, as `tunnel-integration.test.ts` and `tunnel-client.test.ts` already do inside porch's check, and the sender and receiver pipelines over temporary SQLite files |
| **B. Two-Tower end to end** | `*.e2e.test.ts` | **On demand**, after `pnpm build`, with `vitest.e2e.config.ts` and at most 3 workers, at the end of each phase that adds one | Two real Tower processes, each with its own port, database, agent-farm directory, socket directory and `HOME`, both connected to the stand-in over loopback |
| **C. Browser** | `__tests__/e2e/peers-panel.test.ts` (Playwright, only through `playwright.peers.config.ts`), and the held-count suite extended in place, both only through `playwright.peers.config.ts` | **On demand**, in phase 12 and again in phase 13 | Tower's home page and the dashboard, rendered; the peers suite on a throwaway Tower its config starts (never port 4100, never reused) |
| **D. Platform** | The Windows workflow | **On demand**, dispatched on the branch in phases 5 and 13 | The tunnel client and the CLI's argument handling on Windows |

- I run every on-demand run myself, only at a one-minute load average of 20 or less, and record
  the result in the phase's commit message and my thread. A failure is reported to the architect,
  never rerun or skipped.
- Flood, backlog, lifetime and back-off tests are layer A, on an injected clock, never real waits.
  In layer B the Tower processes are started with a test-only back-off base
  (`AF_TEST_PEER_BACKOFF_MS`), honoured only under `NODE_ENV=test` as `AF_TEST_DB` is, so a retry
  there takes milliseconds. Layer B therefore never sleeps for the protocol's real intervals.
- The scenario-to-layer table is below, under "Where each scenario is tested".

**5. The harness is its own early phase** (architect's item 1), phase 2. Every later phase tests
against the stand-in relay and the two-Tower launcher, and both exist before any Tower code speaks
the contract. The shared vectors file ships in phase 1. I send its path and commit to the
architect, who posts it to codev-cloud issue #22, as was done with the contract.

**What no phase does** (architect's item 6):

- No test, script or manual step sends through the real Codev Cloud.
- None touches the live Tower on port 4100 or its sockets, or writes its `global.db`.
- The one step that reads a real database is phase 3's migration check. It reads a *copy* of
  `~/.agent-farm/global.db` made with SQLite's backup API, which only reads the source; that is not
  testing against the live Tower, and the copy is never written back.
- The CLI under test reaches a test Tower by the mocks the stage 1 harness already uses for the
  port and the database path. The built `afx` binary, which always connects to port 4100, is never
  run.
- Test Towers run with a throwaway `HOME`, so none reads the owner's `~/.codev/config.json` or
  writes under the real home directory.

**For the architect's own reading of the verification code** (architect's item 4 of 20:41Z):

- `peer/contract.ts`: decoding the statement, the field rules, the MAC and the hash.
- The `/__tower/peer` interception in `lib/tunnel-client.ts`: steps 1 to 8 in order, the session
  secret, and the statement-id memory.
- `peer/receiver.ts`: steps 9 to 16.

Each is kept small and free of unrelated code so it can be read alone. Each phase that touches them
says so in its commit message.

**Dependencies outside this repository.**

- **Issue #1871** (Tower's canonical slug) has merged (PR #1988, `d84036762`), and `origin/main` is
  merged into this branch. `cloud-config.json` now carries the cloud's slug as `tower_name` and a
  `deregistered_at` time, set when the cloud rejects this registration's key.
  - The name Tower shows while disconnected is that stored `tower_name`. While connected, Tower
    takes its own name from `auth_ok.slug` and the listing's `self.slug`, as the contract says.
  - Phase 8's `not-registered` refusal (C12) reads `deregistered_at` before any call, and a key the
    cloud rejects with `401` refuses the same way.
- `origin/main` is merged in again before phase 3 is committed and before the PR; the branch is
  pushed, so it is never rebased. The migration number is checked each time to be the next free
  one.
- Codev Cloud's half (codev-cloud issue #22) is not needed by any phase. The real-cloud check waits
  at `verify-approval` (Open Question 1, as the owner adopted it).

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Wire contract module and shared test vectors"},
    {"id": "phase_2", "title": "Stand-in relay and two-Tower test harness"},
    {"id": "phase_3", "title": "Peer storage and the mailbox migration"},
    {"id": "phase_4", "title": "The remote-messaging switch and grants"},
    {"id": "phase_5", "title": "Tunnel handshake, session secret and the verified entry point"},
    {"id": "phase_6", "title": "Receiving a message: accepted once, delivery through the mailbox and gate"},
    {"id": "phase_7", "title": "Peer listing and the cloud client"},
    {"id": "phase_8", "title": "The outbox, the sender's checks and the per-peer queue"},
    {"id": "phase_9", "title": "afx send across Towers, end to end"},
    {"id": "phase_10", "title": "Discovery across Towers"},
    {"id": "phase_11", "title": "Inbox, status and record surfaces"},
    {"id": "phase_12", "title": "Dashboard: Peers panel and three-count indicator"},
    {"id": "phase_13", "title": "Docs in both trees, the walkthrough end to end, and Windows"}
  ]
}
```

## Where each criterion is met

| Criterion (spec, Success Criteria) | Phase | Layer |
|---|---|---|
| 1 Headline path; walkthrough and skipped-step table | 9 (path), 13 (walkthrough) | B |
| 2 Switch off: refused before anything leaves | 4 (switch), 8 (refusal), 9 (CLI) | A, B |
| 3 No owner in any address for my own Towers; `owner@` refused | 8, 9 | A, B |
| 4 No remote message until a grant; fresh and upgraded refuse everything | 3, 4, 6 | A, B |
| 5 Outcomes told; refusal exits non-zero, leaves nothing on R | 6, 9 | A, B |
| 6 Held at S, accepted exactly once, then expired | 8 (lifetime, backlog), 9 (offline, deploy, restart) | A, B |
| 7 Sender-held mail is a distinct kind | 3 (by construction), 8, 11 | A, B |
| 8 Order; one message relay call in flight per peer | 8, 9 | A, B |
| 9 Remote header and a reply command that works | 6 (frame), 9 (reply round trip) | A, B |
| 10 Sender identity only from the verified statement | 5, 6 | A, B |
| 11 Local key, `/t/`-style headers, replay and earlier session all refused | 5 | A, B |
| 12 Peer without the protocol, cloud without relay: refused, not held | 7, 8, 9 | A, B |
| 13 `--raw`, `--interrupt`, `--no-enter`, `--delay` refused; control characters never reach a terminal | 6 (normalisation), 8 (options), 9 (CLI) | A, B |
| 14 List my Towers; discovery under a grant | 7 (list), 10 (discovery) | A, B |
| 15 Revoking stops new mail and automatic delivery of accepted mail | 4, 6 | A, B |
| 16 Flooding bounded at R (and S's cap) | 6, 8, 10 | A |
| 17 Records, without bodies | 6, 8, 11 | A, B |
| Stand-in implements the contract exactly | 2 | A |
| Shared vectors in place and posted to #22 | 1 | A |
| Off by default, fresh and upgraded | 3, 4 | A |
| TLS: secret only on `wss:`, calls only on `https:`, loopback excepted | 5, 7 | A |
| Builder rule for remote addresses | 8, 9 | A, B |
| Builders addressable across Towers; discovery lists them | 6, 9, 10 | A, B |
| Frame invariant for arbitrary statement and payload fields (seeded generator) | 6 | A |
| Mailbox first, render gate, per-agent then per-terminal locks | 6 | A, B |
| Secret in memory only; no statements, MACs or bodies in logs | 5 (unit), 13 (whole walkthrough) | A, B |
| Stage 1 carry-overs (the `afx://devvm/…` hint; explicitly named workspaces) | 9 | A, B |
| Windows: `afx://` unquoted in Git Bash, PowerShell, cmd | 5 (the probe, first run), 13 (again) | D |
| Docs, skills and role files in both trees | 13 | — |
| Gaps G10, G12, G15 (runs shown in `afx peer list`, panel, record) | 8 (state), 11 (CLI), 12 (panel) | A, C |

## Phase Breakdown

### Phase 1: Wire contract module and shared test vectors

**Dependencies**: None

#### Objective

Encode the contract once, in the one module that speaks it, and publish the bytes both halves test
against. After this phase the cloud can check its HMAC, hash and field rules against our vectors,
and every later phase builds on a contract module that already passes them.

#### Files to Create / Modify

- `packages/types/src/peer-wire.ts` (new): TypeScript shapes only: the handshake's `peer` and `relay`
  fields, the listing, the relay headers as a type, the message and query payloads, the statement,
  the answer and its outcome and reason unions. Also the protocol-v1 constants of the contract's
  table. It is exported from `packages/types/src/index.ts`.
- `packages/codev/src/agent-farm/peer/contract.ts` (new). The one module:
  - building and reading the four relay headers;
  - encoding a payload: literal UTF-8, with the line-ending rule and removals of Decision 7 applied
    before serialising;
  - decoding the statement from base64url and verifying its MAC in constant time;
  - the field rules of contract section 5 as one table of validators, with the excluded code points
    for the email written out as data;
  - the payload rules of section 4, the payload hash, and encoding and decoding the answer;
  - the mapping from status to outcome and source of section 6, including answers without the body
    and the "relay stated" distinction;
  - the order of S's refusals as an ordered list of named checks, used by phase 8.
- `packages/types/fixtures/peer-contract-vectors.json` (new), in the format of contract section 11,
  with the worked case and the full set: a non-ASCII email; another secret; a payload altered after
  the MAC; another receiving Tower; `issuedAt` just inside and just outside 5 minutes in both
  directions; an unsupported `v`; each statement field just inside and just outside its rule; one
  email per line of the excluded code-point list.
- `packages/codev/src/agent-farm/__tests__/peer-contract.test.ts` (new).
- `packages/codev/src/agent-farm/__tests__/peer-contract-vectors.test.ts` (new).

#### Deliverables

- [ ] The types, the constants and the contract module.
- [ ] The vectors file. Each case's MAC and hash are cross-checked once by hand in Python
  (`python3 -I`, standard library only, run from the scratch directory and not committed), and the
  thread records that it was done.
- [ ] The file's path and commit are sent to the architect for codev-cloud issue #22 (architect's
  item 1).
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] The vectors test computes every case's HMAC-SHA-256 and SHA-256 with `node:crypto`, compares
  them with the file, and then runs each case through `contract.ts`, getting the expected verdict.
  The worked case of section 11 is in the file byte for byte.
- [ ] No production file other than `contract.ts` and `peer-wire.ts` contains a contract header
  name or a status-to-outcome mapping. The structural test greps every non-test source file under
  `packages/*/src` and `apps/*/src`. It exempts `__tests__/` directories, which is where the stand-in
  and the tests that craft raw requests live, and it names that exemption.
- [ ] `codev-types` stays free of runtime dependencies, and the existing boundary tests pass.
- [ ] Build and porch's tests check pass.

#### Test Plan

Layer A only:

- every field rule just inside and just outside;
- a duplicate key in the statement is refused;
- a 48 KiB body of characters JSON escapes, and one of 4-byte emoji, both encode within 102 400
  bytes;
- a body with lone surrogates is refused;
- each status, with and without the body, both before and after a relay has been stated, maps to the
  outcome and source of the section 6 tables;
- the precedence list contains S's checks in the contract's order.

### Phase 2: Stand-in relay and two-Tower test harness

**Dependencies**: Phase 1 (shapes, constants and vectors only; not `contract.ts`)

#### Objective

A cloud we control. It is a stand-in relay that implements the cloud's side of the contract
exactly, independently of the Tower's contract module. With it comes a harness that runs two test
Towers against it. Every later phase is tested with these.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/__tests__/helpers/stand-in-relay.ts` (new). It serves:
  - the `/tunnel` WebSocket handshake, including `peer`, `relay` and a fresh 32-byte secret per
    session, then HTTP/2 over the socket, as `mock-tunnel-server.ts` does today;
  - `POST /api/peer/relay`, with the ten checks of contract section 4 in order, statements built from
    its own records, and its own limits with the counting rules of section 7 on an injected clock,
    including the ceiling of 600 calls a minute per Tower across every `/api/peer/…` route;
  - `GET /api/peer/towers` and `PUT /api/peer/state` (a bad body answered `400 malformed`), with
    their limits.

  For tests it records every call and the number of message relay calls in flight per peer, and it
  can originate a forwarded request itself (so the receiving side can be tested without a sending
  Tower). It also injects faults on demand:
  - a Tower offline, or a forward held past the relay timeout;
  - a stream reset before the answer is complete;
  - a deploy (every tunnel dropped, new secrets);
  - an old cloud (no `relay`, `404` on the peer routes), and `relay: null`;
  - bodyless `401`/`403`/`404`/`429`/`5xx` answers;
  - `409`, `500 cloud-error`, a MAC made with a wrong secret, a statement replayed, a session that
    states no version.
- `packages/codev/src/agent-farm/__tests__/helpers/two-towers.ts` (new). It starts the stand-in and
  two Towers. Each Tower is started through `startTower` in `helpers/tower-test-utils.ts`; spawn,
  readiness and teardown are not re-implemented. `startTower` spreads `extraEnv` last, so the
  harness's own values override its defaults. Tower reads `cloud-config.json` at startup, so for
  each Tower the harness owns, writes before the start, and later removes:
  - an agent-farm directory, passed as `CODEV_AGENT_FARM_DIR`, with `cloud-config.json` (pointing
    at the stand-in's loopback URL) and `local-key` in it;
  - a socket directory (`SHELLPER_SOCKET_DIR`) and a throwaway `HOME`;
  - `AF_TEST_PEER_BACKOFF_MS`.

  `startTower` still sets `NODE_ENV=test` and `AF_TEST_DB` from the port. A restart, which phase 9
  needs, calls it again with the same port and the same `extraEnv`, so it finds the same
  directories and database. The directory `startTower` makes for itself goes unused and its
  `stop()` removes it.

  **A limit of the harness** (found in phase 2; architect's ruling, 2026-11-26). On startup a
  Tower ends the shellpers of every workspace under a temp directory and forgets their sessions
  (`isTemporaryWorkspace`, `servers/tower-terminals.ts`), and the harness's workspaces are all
  under one. They stay there: the reaping is what keeps a crashed test from leaving shellpers on
  the machine. So layer B can show that a restarted Tower's database, `peer_outbox` and
  `peer_accepted` survive and that delivery resumes to an agent activated again after the
  restart, but not that mail reaches a terminal that itself survived the restart, as it does on a
  real Tower. That waits for the walkthrough at `verify-approval` (the last row of "Where each
  scenario is tested"). If anything the harness needs turns out to be missing from `startTower`, it
  gains an option rather than a copy. The harness also provides a CLI runner
  that switches the mocked Tower port and database path per call (the pattern of
  `cross-workspace-addressing.e2e.test.ts`), and helpers for workspaces and inert terminals.
- `packages/codev/src/agent-farm/__tests__/helpers/seeded-generator.ts` (new). A small seeded,
  deterministic generator (a fixed-seed PRNG and string generators by code-point class) for the
  property tests. No new dev dependency, as the architect ruled.
- `packages/codev/src/agent-farm/__tests__/stand-in-relay.test.ts` (new, layer A).
- `packages/codev/src/agent-farm/__tests__/two-towers-harness.e2e.test.ts` (new, layer B).

#### Deliverables

- [ ] The stand-in relay, the two-Tower harness and the seeded generator.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] The stand-in passes the shared vectors as the issuing side: given a case's secret, records and
  payload, it builds the case's statement and MAC.
- [ ] Its order of checks: for each adjacent pair of steps in section 4's table, a call that fails
  both gets the earlier step's answer.
- [ ] `unknown-tower` leaves its per-pair counters unchanged. A call with an invalid kind counts as
  a message. Every authenticated call to an `/api/peer/…` route counts toward the 600-a-minute
  ceiling, and query calls to made-up recipients hit it at step 4.
- [ ] It never answers 200 itself, and it checks R's answer exactly as section 6 says (media type
  without parameters, size, outcome header).
- [ ] The harness starts two Towers that both connect to the stand-in over loopback with today's
  handshake (Tower ignores the new fields until phase 5), restarts one with its state intact, and
  stops both leaving no process, socket or directory behind.
- [ ] `stand-in-relay.ts` does not import `contract.ts` (a grep in the test).
- [ ] Porch's exact tests command, run once with `two-towers-harness.e2e.test.ts` in place, does
  not run it. The run is recorded in the thread.

#### Test Plan

- Layer A: the stand-in's conformance, driven by a bare HTTP/2 and WebSocket client in the test.
- Layer B, run on demand at the end of the phase: the harness smoke test, including a restart.

### Phase 3: Peer storage and the mailbox migration

**Dependencies**: Phase 1

#### Objective

Every table and column stage 2 needs, on fresh and upgraded installs alike, with existing held mail
untouched (architect's item 4: this is the phase where the migration is tested on a copy of a
current database with held rows).

#### Files to Create / Modify

- `packages/codev/src/agent-farm/db/schema.ts` and `db/migrations.ts`. One migration (the next free
  number once `origin/main` is merged in; v21 today), in the PRAGMA-gated additive shape of v16 to v20:
  - `mailbox` gains nullable `remote_tower_id`, `remote_message_id`, `remote_sender` (the verified
    Tower id and slug, and the stated sending address, as JSON validated in TypeScript) and
    `remote_owner_email`, and `release_hold INTEGER NOT NULL DEFAULT 0`. No `CHECK` on any of them,
    following v18's reason.
  - New tables:
    - `peer_settings`: the switch, off by default;
    - `peer_grants`: peer Tower id, workspace key, one of the scopes (front door, one architect,
      every architect, everything), and the mode (deliver or hold for release);
    - `peer_towers` and `peer_tower_names`: the cached listing and every former slug, with when the
      list was last refreshed;
    - `peer_outbox`: message id, peer Tower id, the exact payload bytes, `sentAt`, the sending
      workspace path and agent, state, last outcome, attempt count, next attempt time, and the time
      it was resolved;
    - `peer_accepted`: peer Tower id plus message id as the key, the payload hash, the mailbox row
      id, the message's current state and reason, and the expiry (`sentAt` plus 30 days).
      - **The states** are delivered, held with its reason (`busy`, `no-profile`, `no-live-pty`,
        `held-for-release`), and dismissed. `superseded` cannot happen to a remote row: remote
        inserts always leave `supersede_key` NULL, and only rows with a key are superseded. A test
        asserts this.
      - **The mirror.** The state and reason are written in the same transaction as every change
        to the remote mailbox row that alters what a duplicate would be told: its status, its
        reason, or `release_hold`. Every such write lives in `db/mailbox.ts`. The writers, by name:
        - `enqueue`, the insert, in phase 6's transaction with `peer_accepted`'s own insert;
        - `setHeldVerdict`, which moves a held row's reason (and `detail`) without changing its
          status, on any drain pass. It is mirrored when the reason changes;
        - `markDelivered` (delivered), and `dismiss` and `dismissHeldForAgent` (dismissed). The
          last is set-based, and mirrors with a statement that joins `peer_accepted` to the rows it
          actually changed; it is what `afx cleanup` calls;
        - `holdForRelease` and `release` (new in this phase), which set and clear `release_hold`.
          The reported reason becomes `held-for-release`, then the row's own reason again. Phase
          6's drain-time check and phase 11's `afx inbox release` call them.

        Writes that change nothing a duplicate is told are not mirrored: `markEscalated` and
        `markEscalatedDelivered` (the escalated flag only), and the workspace-path update in
        `db/canonicalize-workspace-paths.ts`. `supersede` and `dismissHeldWithKey` never reach a
        remote row (below). `pruneTerminal` deletes the row; `peer_accepted` outlives it by
        design.
      - **Only real changes are mirrored.** A guarded update (`AND status = 'held'`, or
        `setHeldVerdict`'s own guard) that changes nothing rewrites no accepted-once state.
      - A duplicate is answered from this row alone, so it still answers correctly after the mailbox
        row has been pruned. The row itself is pruned only after its expiry;
    - `peer_records`: one row per attempt, with the aggregate rows of C5 (sender, reason, minute,
      count, first and last time).
- `packages/codev/src/agent-farm/db/mailbox.ts`. Every query that reads held mail lives in this file
  (the only other `mailbox` statement, in `db/canonicalize-workspace-paths.ts`, updates
  `workspace_path` and reads no status). A mapping reports a `release_hold = 1` row's reason as
  `held-for-release`.
  - **These exclude `release_hold = 1`:** `findHeldForAgent` (the local drainer), `findEscalatable`
    and `findStarvingAgents` (the escalation and the starved-agent notice), and
    `heldSummaryForWorkspace` (the held counts).
  - **These must not:** `listHeld`, which backs `afx inbox` and so lists held-for-release mail in
    its own group (it also gives the backstop its agent set, where such a row costs one empty
    pass), and `getById`.
  - **The claim is checked.** The phase's test greps every `mailbox` statement in non-test source
    files under `packages/*/src` (the scope phase 1's structural test uses; one-off scripts under
    `packages/codev/scripts/` are outside it). It fails on one outside these two files and
    `db/schema.ts` and `db/migrations.ts`, which create and migrate the table.
  - **`release_hold = 1` only ever goes with `status = 'held'`.** Release clears it, making the row
    ordinary held mail that the gate then drains. A dismissal clears it in the same statement that
    sets `dismissed`. So a delivered or dismissed row never carries it.
- `packages/types/src/api.ts`: `held-for-release` joins the held-mail reason union.
- `packages/sdk/src/hold-verdict.ts`: renders `held-for-release` by name, rather than falling back to
  a bare `held`.
- `packages/codev/src/agent-farm/peer/store.ts` (new): typed access to the new tables. It is the
  only file that writes them. It includes a prune that takes a retention in days, never fewer than
  30. The prune removes:
  - `peer_records` rows, ordinary and aggregate, older than the retention;
  - resolved `peer_outbox` rows (accepted, refused, dismissed, expired) resolved before it;
  - `peer_accepted` rows past their expiry.

  It never touches a held outbox row. Phase 4 wires it into the existing prune pass, with its
  setting.
- `packages/codev/src/agent-farm/__tests__/peer-storage-migration.test.ts` (new), following the SQL
  text fixture pattern of `spec-1313-migration.test.ts`.

#### Deliverables

- [ ] The migration, the fresh-install schema, the reason value and the store.
- [ ] Off by default: a fresh database and an upgraded one both read the switch as off and hold no
  grant.
- [ ] **The migration on a copy of a current database (on demand).** A copy of my own
  `~/.agent-farm/global.db`, taken with SQLite's backup API into the scratch directory, is migrated.
  Its held rows (every reason present, with `detail` and `not_before`) are still held, unchanged
  and drainable. The counts before and after go in the commit message and the thread. The copy is
  deleted afterwards and its contents are never committed.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] An automated test builds a database with today's schema (the pre-migration schema kept as a
  fixture of SQL text, not a binary), inserts held rows of every reason, with and without `detail`
  and `not_before`, migrates it, and finds every row unchanged and still returned by the drainer's
  query.
- [ ] A fresh install and an upgraded one have the same schema after normalisation. Raw equality is
  not the test, because additive migrations (v17, v18) already append columns in a different order
  and leave different `sqlite_master.sql` text. The comparison covers:
  - the set of tables;
  - for each table, the set of columns, each with its type, nullability, default and primary-key
    position (`PRAGMA table_xinfo`, keyed by name, not by order);
  - each table's foreign keys and unique constraints;
  - the set of indexes with their columns, uniqueness and partial `WHERE` clause;
  - each table's `CHECK` expressions, compared after normalising whitespace. On an upgraded
    database, `mailbox`'s `CHECK` clauses are the same before and after this migration.
- [ ] Running the migration twice changes nothing.
- [ ] A row with `release_hold = 1` is never returned to the local drainer, never escalated, and not
  counted as waiting for a local agent; `listHeld` still returns it.
- [ ] Every change of a remote mailbox row's status, reason or `release_hold` updates its
  `peer_accepted` state and reason in the same transaction. A failure injected after the mailbox
  write rolls both back.
- [ ] Each writer named above, single-row and set-based, has a test that applies it to a remote row
  and checks `peer_accepted`; for `setHeldVerdict`, a move from `busy` to `no-live-pty`. A test
  that lists the writing statements in `db/mailbox.ts` fails when a new one is added without such a
  test.
- [ ] `afx cleanup` of a builder with remote mail held for it (through `dismissHeldForAgent`) leaves
  each `peer_accepted` row reporting `dismissed`, and a duplicate of one is answered `refused`,
  `dismissed`.
- [ ] A guarded update that changes no row leaves `peer_accepted` unchanged.
- [ ] No row with `status` other than `held` has `release_hold = 1` after release, delivery or
  dismissal. A remote row never has a `supersede_key`.
- [ ] `pruneTerminal`, with retention set to 1 day, removes a delivered remote row after a day and
  leaves its `peer_accepted` row, with its state, until 30 days after `sentAt`.
- [ ] The peer prune, asked for 1 day, uses 30. It removes records and resolved outbox rows older
  than that, and never removes a held outbox row.
- [ ] Build and porch's tests check pass.

#### Test Plan

- Layer A: the tests above.
- On demand: the copy check, recorded.

### Phase 4: The remote-messaging switch and grants

**Dependencies**: Phase 3

#### Objective

The receiving Tower's decisions about who may message whom, made by its owner, with default deny.
After this phase a human can turn the switch on and add, list and revoke grants. Nothing can arrive
yet, but the rules arrivals will be checked against are in place and tested.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/peer/grants.ts` (new). Matching a resolved recipient against the
  grants:
  - the front door is resolved when mail arrives;
  - an architect grant follows the name;
  - `--workspace` covers every architect in the workspace;
  - `--all` covers everything.

  It also covers grant creation's own checks (the workspace must be registered; a named architect
  must exist) and the "matches nothing" state of `afx peer grants`.
- `packages/codev/src/agent-farm/peer/switch.ts` (new).
- `packages/codev/src/agent-farm/servers/peer-routes.ts` (new): the local Tower routes for the
  commands. Wired from `servers/tower-routes.ts`, behind the local key like every other route.
- `packages/codev/src/agent-farm/commands/peer.ts` (new): `afx peer on`, `off`, `grants`, `grant`,
  `revoke`, and `limits` (this Tower's own; the cloud's are added in phase 7). Registered in
  `agent-farm/cli.ts`.
  - `afx peer grant <tower-ref> (<address>… | --workspace <name> | --all) [--deliver | --hold]`, as
    Decision 9 signs it. The mode defaults to *deliver* for my own Towers (Decision 4; walkthrough
    step 4, "Mail is delivered directly"). `--hold` makes a hold-for-release grant, which is the
    only way to reach phase 6's held-for-release path. The two flags together are refused.
  - `afx peer grants` shows each grant's mode.
- **Human-only flag.** `afx peer on` and `afx peer grant` require `--a-human-explicitly-approved-this`,
  the flag `porch approve` takes (Decision 9). Without it they refuse with the reason.
- `packages/codev/src/lib/config.ts`, next to `mailbox.retentionDays`:
  - `peer.limits`, with the approved spec's defaults (30 a minute accepted per peer, 50 undelivered
    per peer, 50 waiting at the sender per peer);
  - `peer.recordRetentionDays`, default 30. A smaller value is raised to 30, since the spec requires
    at least 30 days.
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts` resolves `peer.recordRetentionDays`,
  as it resolves `mailbox.retentionDays` today.
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts`: the existing prune pass, where
  `pruneTerminal` runs at boot and periodically, also runs phase 3's peer prune with that setting,
  threaded through the same way as `retentionDays`.
- `packages/sdk/src/tower-client.ts` and `packages/types/src/api.ts`: the client calls and request
  and response types for the new local routes.
- Tests: `__tests__/peer-grants.test.ts` and `__tests__/peer-commands.test.ts` (new).

#### Deliverables

- [ ] The switch, grants, the commands, the routes and the config.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] With no grant, the matcher refuses every recipient.
- [ ] Each scope matches exactly what Decision 4 says it does: the front door follows the default
  architect when `main` is removed; an architect grant stops matching when that architect is removed
  and applies again when the name returns.
- [ ] A grant for an unregistered workspace, or a missing architect, is refused when made.
- [ ] `afx peer on` and `afx peer grant` without the flag refuse and change nothing. `off` and
  `revoke` need no flag.
- [ ] A grant made without a mode flag is *deliver*; one made with `--hold` is hold for release;
  `--deliver --hold` is refused. `afx peer grants` shows the mode.
- [ ] `peer.recordRetentionDays` below 30 is used as 30.
- [ ] Build and porch's tests check pass.

#### Test Plan

- Layer A: the matcher over a table of grants and recipients; the commands driven in-process
  against a route handler with a temporary database.

### Phase 5: Tunnel handshake, session secret and the verified entry point

**Dependencies**: Phases 1, 2, 4

#### Objective

The receiving half's security boundary. The Tower:

- states the protocol in `auth`;
- takes a session secret only over TLS (loopback excepted);
- keeps the secret only in its tunnel session;
- answers `POST /__tower/peer` itself, running steps 1 to 8 of contract section 5;
- passes only a verified request on.

This is the code the architect will read, so it is kept to the interception and the verification.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/lib/tunnel-client.ts`:
  - **Handshake.** `auth` carries `peer: { protocols: [1], remoteMessaging }` from the switch.
    `auth_ok` is read for `slug` (the Tower's own name while connected) and `relay`.
  - **The secret.** It is kept in the per-session state, and only when the tunnel is `wss:` or the
    cloud's host is a loopback address. Otherwise the cloud is treated as having no relay.
  - **The entry point.** `POST /__tower/peer` is intercepted beside `/__tower/metadata`, and any path
    under `/__tower/peer` is never proxied to the local listener. Steps 1 to 8 run in order through
    `contract.ts`.
  - **Statement-id memory.** It is scoped to the session and holds ids for 10 minutes.
  - **Answers.** `not-verified`, or the `unsupported-version` and `clock-skew` refusals, with nothing
    stored.
  - **Handing on.** A verified request goes to a handler injected by the Tower, which phase 6
    supplies; until then the handler answers `refused`, `remote-off`.
  - **An audit hook for everything that stops before the handler.** Every request that reaches the
    entry point produces exactly one structured event through a second injected hook, whatever its
    fate. The event carries:
    - the time and the tunnel session's id;
    - the step that ended it (1 to 8) and the outcome (`not-verified`, `unsupported-version` or
      `clock-skew`), or "handed on";
    - the verified sending Tower id, only once step 2 has passed;
    - the request id and kind, only once step 4 has passed.

    It never carries the secret, the statement bytes, the MAC or the body. Phase 6 wires this hook to
    the record and to the clock-skew surface. Until then the Tower supplies a no-op.
  - **The local listener.** It gains no route for the path.
  - **Removals.** The dead `POST /api/tower/metadata` push is removed (issue #1986, C14), and the
    issue is closed by the PR.
- `packages/codev/src/agent-farm/servers/tower-tunnel.ts`: passes the switch state in and the
  handler; re-announces the switch on reconnect; exposes the session's slug and relay state to the
  rest of Tower (never the secret).
- `packages/codev/src/agent-farm/__tests__/helpers/mock-tunnel-server.ts`: its `lastMetadata` and
  its `POST /api/tower/metadata` handler lose their only writer with the push and are removed.
  Nothing reads them; the `GET /__tower/metadata` serving path the tunnel tests exercise stays.
- **A probe for `afx://` on Windows shells.** Today `windows.yml` runs every step under
  `shell: bash`, and nothing probes the address. The spec's criterion that an address typed
  unquoted in Git Bash, PowerShell and cmd arrives unchanged therefore needs its own check, built
  here so a shell that mangles the form is found before any doc teaches it:
  - `scripts/windows-probe.mjs` gains an `--argv` section. It reports, as JSON, the arguments a
    Node child receives, so the shell under test is the only thing between the typed text and the
    process.
  - The `probe` job in `.github/workflows/windows.yml` gains three steps, one each with
    `shell: bash`, `shell: pwsh` and `shell: cmd`. Each types
    `afx://devvm/codev:architect:local` and `afx://devvm/codev:builder-spir-7` unquoted and fails
    unless both arrive byte for byte.
  - The workflow's header lists the new section.
- Tests: `__tests__/peer-entry-point.test.ts` (new, layer A, an in-process tunnel client against the
  stand-in) and `__tests__/peer-entry-point.e2e.test.ts` (new, layer B).

#### Deliverables

- [ ] The handshake fields, the TLS rule, the secret's home, the interception with steps 1 to 8, and
  the statement-id memory.
- [ ] The metadata push removed.
- [ ] The Windows workflow is dispatched on the branch (the tunnel client is platform code, and the
  new three-shell probe runs in its `probe` job) and linked in the thread:
  `gh workflow run windows.yml --ref builder/spir-1967 -f purpose='Spec 1967 tunnel peer entry point' -f suites=true`.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Each of steps 1 to 8 fails alone and stores nothing:
  - a statement presented again 9 minutes later is refused;
  - a statement whose first presentation was refused by the handler (phase 5's stub, which refuses
    everything) cannot be presented again. The statement is used up whatever the outcome; the real
    `no-grant` case is phase 6's;
  - one from an earlier session fails after a reconnect.
- [ ] `POST /__tower/peer` to the local port, with the local key and the tunnel marker header,
  reaches no handler (layer B).
- [ ] `auth` carries the switch state. An `auth_ok` without `relay`, or with `relay` over `ws:` to a
  non-loopback host, leaves the Tower with no secret and reporting no relay.
- [ ] The secret never reaches a log: a test spies on the logger through a session, a forwarded
  request and a reconnect, and searches every line for it.
- [ ] In the Windows run, the three-shell probe passes, or its failure is reported to the
  architect.
- [ ] For a failure at each of steps 1 to 8, the audit hook receives exactly one event. Each event
  names that step and outcome, and carries a sender only after step 2 and a request id only after
  step 4. No event contains the secret, the statement, the MAC or the body.
- [ ] Build and porch's tests check pass.

#### Test Plan

- Layer A: every check, with the stand-in originating forwards, including the `/t/`-style request
  (arbitrary headers, no valid MAC) and the TLS cases.
- Layer B, on demand: the local listener and the handshake on real Towers.
- Layer D: the Windows run.

### Phase 6: Receiving a message: accepted once, delivery through the mailbox and gate

**Dependencies**: Phases 3, 4, 5

#### Objective

What the receiving Tower does with a verified message: steps 9 to 16 of contract section 5. It
persists the message to the mailbox first and delivers it through the render gate under the
per-agent then per-terminal locks.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/peer/receiver.ts` (new). Steps 9 to 16:
  - accepted once (current state, or `duplicate: true`, or `mismatch`);
  - the switch; `sameOwner`; the payload's rules, with `sentAt` refused as `clock-skew` when ahead
    and `expired` when old, and `too-large`;
  - the recipient (shells `not-addressable`); the grant;
  - R's limits:
    - 30 a minute from one peer, refused as `rate-limited` with `retryAfterSec`;
    - 50 accepted but undelivered from one peer, refused as `rate-limited` *without*
      `retryAfterSec`;
  - then persist and make one gate attempt.

  It answers `held`, `busy` within 5 seconds when the write cannot start (the deadline, below),
  and stores a hold-for-release grant's mail with `release_hold = 1`. It never writes a terminal itself. A query
  is handed to phase 10's discovery; until that phase lands it is refused, a state no shipped build
  ever has, since all phases land in one PR.
- `packages/codev/src/agent-farm/peer/records.ts` (new): inbound records, with the aggregation rule
  for floods and no body anywhere. It is fed from two places:
  - phase 5's audit hook, for every request that stopped at steps 1 to 8. A request that failed
    before step 2 is recorded against the tunnel session with the sender `unverified`, aggregated
    per session, reason and minute; after step 2 it is recorded under the verified sending Tower;
  - the receiver, for every request handed on.
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts`: when the drainer is about to deliver a
  remote row, it checks the switch and the grant again. If either no longer allows it, the row moves
  to held for release instead (criterion 15, and the approved spec's "switched off while held busy"
  scenario). The local rows' path is unchanged.
- **The deadline.** The mailbox row is persisted before any wait, so a missed deadline answers
  `held` and never loses mail; the backstop drains the row later. Today only the per-terminal lock
  is non-blocking: a contended terminal makes a pass hold `busy` at once. The per-agent serializer
  is not: `deliverAgentMailSerialized` queues behind `KeyedSerializer.run`, which waits without
  limit. So:
  - `packages/codev/src/agent-farm/servers/write-queue.ts`: `KeyedSerializer` gains
    `runWithin(key, ms, fn)`. It queues `fn` exactly as `run` does, but if `fn`'s turn has not come
    within `ms`, the returned promise resolves as not started, and `fn` is skipped when its turn
    arrives, so it never runs late. `run` is unchanged.
  - `packages/codev/src/agent-farm/servers/mailbox-delivery.ts`: `deliverAgentMailSerializedWithin`
    beside `deliverAgentMailSerialized`, using `runWithin` on the same serializer.
  - The receiver calls it with what is left of the 5 seconds. Not started: it answers `held`,
    `busy`. Started: the answer is that pass's outcome.
  - `packages/codev/src/agent-farm/__tests__/write-queue.test.ts`: `runWithin`'s cases.
- `packages/codev/src/agent-farm/utils/message-format.ts`:
  - the remote header and footer of Decision 7, built only from validated values;
  - Decision 7's normalisation applied to remote bodies only. Local frames stay byte-identical, which
    the tests assert.
- `packages/codev/src/agent-farm/servers/tower-tunnel.ts`: supplies the receiver as the tunnel
  client's handler, and the record and the clock surface as its audit hook.
- R's clock surface (G12), fed by both the audit hook (step 7) and the receiver (a `sentAt` ahead of
  the clock). While any relayed request in the last 10 minutes was refused as `clock-skew`, the
  Tower carries that state for phases 11 and 12.
- **Persisting is one transaction** (in `peer/store.ts` and `db/mailbox.ts`). The `peer_accepted`
  row and the mailbox row are inserted in one SQLite transaction, `peer_accepted` first:
  - its primary key (peer Tower id, message id) is what decides a race between two arrivals of one
    message;
  - an insert that conflicts rolls back, and the arrival is answered as a duplicate (the existing
    row's state) or a `mismatch` (a different payload hash).

  The gate attempt is made only after the transaction commits. So no mailbox row can exist without
  its accepted-once record, and no record can exist without its row.
- Tests:
  - `__tests__/peer-receiver.test.ts` and `__tests__/peer-frame-invariant.test.ts` (new, layer A;
    the property test runs on the seeded generator);
  - `__tests__/peer-receive.e2e.test.ts` (new, layer B: real gate, real locks, inert and live
    terminals).

#### Deliverables

- [ ] The receiver, inbound records, the drain-time recheck, the remote frame and normalisation, and
  the clock surface.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] **Accepted once.** A second arrival answers the first message's current state, including
  after a dismissal and after a Tower restart. With `mailbox.retentionDays` set to 1, a retry on
  day 5 of a message delivered on day 1 (its mailbox row already pruned) answers `delivered` with
  `duplicate: true`, and creates no new row. With the same short retention, a message past its
  30-day lifetime is refused as `expired` (the approved spec's short-retention scenario). A different payload under the same id is `mismatch`,
  is recorded, and changes nothing. A retry after the switch or the grant changed still gets the
  true state (the ordering the owner adopted).
- [ ] **Atomic acceptance.**
  - A failure injected before the first insert, between the two inserts, and after both but before
    the commit leaves neither row. A retry of the same message is then accepted once.
  - A failure injected after the commit leaves both rows, and a retry is answered as a duplicate.
  - Two arrivals of one message processed concurrently produce one mailbox row; one is answered as
    the duplicate of the other.
- [ ] **Unverified requests are recorded.** A failure at each of steps 1 to 8 is recorded with the
  right attribution (the session and `unverified` before step 2, the sending Tower after it), and
  floods are aggregated per minute. None leaves a mailbox row or an accepted-once record. A step 7
  refusal sets the clock surface.
- [ ] **No grant.** The answer is `refused`, `no-grant`, and there is no mailbox row and no
  accepted-once record. The same statement presented again is `not-verified` (used up), and a
  retry under a new statement after the grant is added is accepted.
- [ ] **Release.** A hold-for-release grant's mail is held and never drained. Revoking a grant, or
  turning the switch off, while mail is held `busy` moves it to held for release.
- [ ] **A duplicate reports the current reason.** A duplicate is answered `held` with the row's
  reason as it is now after each of: a verdict move by `setHeldVerdict` (`busy` to `no-live-pty`), a
  grant revocation and a switch-off (once the drainer has moved the row to held for release), and a
  release (back to its own reason).
- [ ] **The frame invariant.** It holds for arbitrary values of every statement and payload field
  (seeded generator, a fixed number of cases per run, the seed printed on failure). A body that is
  not valid UTF-8 is refused. Same-Tower frames are unchanged.
- [ ] **Delivery.** A remote message takes the per-agent then per-terminal locks, in that order.
  With the terminal lock held by another delivery, the answer is `held`, `busy` within 5 seconds,
  and the message is delivered once the lock frees (layer B, and layer A on an injected clock).
- [ ] **Per-agent contention** (layer A, injected clock). With another delivery to the same agent
  holding the per-agent serializer past the deadline, the answer is `held`, `busy` within 5
  seconds. The queued pass never runs late, the row stays held, and the backstop delivers it once
  the serializer frees.
- [ ] `runWithin`: a turn that comes in time runs and returns its result; one that does not
  resolves as not started and its function is never called; a rejected predecessor does not wedge
  the key; `run`'s existing tests pass unchanged.
- [ ] **R's limits, on an injected clock** (layer A):
  - the 31st message in a minute from one peer is `rate-limited` with `retryAfterSec`;
  - with 50 messages from one peer accepted but undelivered, the next is `rate-limited` with no
    `retryAfterSec`, and once one is delivered or dismissed the next is accepted.
- [ ] Build and porch's tests check pass.

#### Test Plan

- Layer A: every step and outcome, the property test, both limits and the clock-skew surface, all
  on an injected clock.
- Layer B, on demand: delivery through the real gate and locks, held reasons, builders by id,
  shells refused.

### Phase 7: Peer listing and the cloud client

**Dependencies**: Phases 2, 3, 4, 5

#### Objective

The sending Tower's view of the cloud. All three calls from a Tower to the cloud live in one place,
over HTTPS only (loopback excepted). The peer list is cached with former names, so a send can be
resolved and refused correctly even when the cloud is unreachable. A human can list their Towers.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/peer/cloud-client.ts` (new). The relay call, `GET /api/peer/towers`
  and `PUT /api/peer/state`, each through `contract.ts`:
  - the TLS rule;
  - S's 20-second call timeout;
  - the listing's call budget (on demand at most every 10 seconds, at most every 30 while holding
    mail);
  - the switch-state report's three retries at 5 seconds, 30 seconds and 2 minutes (K5), a newer
    change replacing a pending one.
- `packages/codev/src/agent-farm/peer/peer-list.ts` (new). The cached listing with every former slug
  (C13), the Tower's current name from `self.slug` (G4), and the rule for whether the cloud has a
  relay: the last `auth_ok`, the last listing, or a bodyless `404` from a cloud that never stated
  one. A send does not need the Tower's own tunnel to be up (an approved-spec scenario).
- `packages/codev/src/agent-farm/commands/peer.ts`:
  - `afx peer list`: the online hint, the switch, and what each Tower may message here. The
    not-verifying, clock and cloud-error marks are set by phase 8 and added to this output in
    phase 11;
  - `afx peer limits` gains the cloud's limits from the listing.
- `packages/codev/src/agent-farm/commands/peer.ts` and `peer/switch.ts`: `afx peer on`/`off` now
  report the change to the cloud.
- Tests: `__tests__/peer-cloud-client.test.ts` and `__tests__/peer-list.test.ts` (new, layer A,
  against the stand-in).

#### Deliverables

- [ ] The cloud client, the cached peer list, `afx peer list`, the cloud's limits and the switch
  report.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Against an `http:` cloud that is not on loopback, no call is made and the cloud is reported as
  having no relay.
- [ ] An old cloud (no `relay`, a bodyless `404` on the peer routes) is reported as having no relay.
  A cloud that has stated one and then answers a bodyless `404` is reported as unreachable.
- [ ] With the cloud unreachable, a name in the cache resolves, and a name not in it fails, saying
  when the list was last refreshed. A former name fails naming the current one.
- [ ] After a rename in the stand-in, the next listing's `self.slug` becomes the Tower's own name.
- [ ] `afx peer list` works while this Tower's switch is off, and says it is off (walkthrough step
  1).
- [ ] A failed switch-state report is retried three times on an injected clock, then not until the
  next connect.
- [ ] Build and porch's tests check pass.

#### Test Plan

- Layer A: the client against the stand-in's normal and fault modes, on an injected clock.

### Phase 8: The outbox, the sender's checks and the per-peer queue

**Dependencies**: Phases 1, 2, 3, 4, 6, 7

#### Objective

The sending Tower's engine, proven in-process before any Tower routes to it. It:

- refuses what it must, in the contract's order;
- persists everything else;
- sends one message relay call at a time per peer, in order;
- holds what cannot be delivered;
- resolves each row exactly as section 6's table says, so every message is accepted exactly once or
  ends visibly.

Everything time-dependent is proven here, on an injected clock (layer A).

#### Files to Create / Modify

- `packages/codev/src/agent-farm/peer/outbox.ts` (new). The per-peer queue over `peer_outbox`:
  - one message relay call in flight per peer, in acceptance order;
  - the back-off from 5 seconds to 2 minutes, brought forward by a listing that shows the peer back;
  - rate-limited held mail from either source pauses that peer's queue for `retryAfterSec`, or the
    next back-off interval without one (C4);
  - "How S resolves its row" exactly;
  - the 30-day lifetime marks a row expired;
  - the runs of five `not-verified` (G10) and five `cloud-error` (G15), and the clock mark on a
    `clock-skew` answer (G12), set and cleared as the contract says;
  - it resumes from the durable rows on Tower start;
  - all on an injected clock.
- `packages/codev/src/agent-farm/peer/sender.ts` (new). S's checks in the contract's order:
  - the address as text, the switch, not connected;
  - not registered: `deregistered_at` set in `cloud-config.json` (#1871), read before any call, or
    a key the cloud rejects with `401`;
  - no relay, an option, too large, unknown Tower, the builder rule, and the 50-waiting cap.

  Then it persists and queues. It records every outbound attempt, with aggregation.
- Tests:
  - `__tests__/peer-outbox.test.ts` and `__tests__/peer-sender.test.ts` (new, layer A);
  - `__tests__/peer-pipeline.test.ts` (new, layer A): the sender, the stand-in, an in-process tunnel
    client and the phase 6 receiver over two temporary databases, on an injected clock.

#### Deliverables

- [ ] The outbox and the sender.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] **The backlog.** 50 held messages drain in order with none refused, once against the
  stand-in's per-pair limit and once against R's own limit with the stand-in's raised. A fresh send
  refused for rate, from either source, ends refused. A message `429` from the cloud's ceiling is
  handled like any other `429`.
- [ ] **The lifetime.** A row is marked expired at 30 days and is not sent.
- [ ] **Back-off.** The back-off's shape is correct, and a listing that shows the peer back brings
  the retry forward.
- [ ] **Row resolution.** Each answer class resolves the row as the table says. A lost answer
  followed by `duplicate: true` resolves it as the state reported.
- [ ] **Runs.** The not-verified, cloud-error and clock marks set and clear as the contract says.
- [ ] **Refusal order.** For each adjacent pair in S's list, a send meeting both conditions gets the
  earlier refusal.
- [ ] **One in flight.** Twenty sends queued at once for one peer are sent in acceptance order,
  never two in flight.
- [ ] **Restart.** A queue rebuilt from its durable rows resumes in order.
- [ ] **Not registered.** With `deregistered_at` in `cloud-config.json`, a send is refused as
  `not-registered` and the cloud is not called. A key the cloud rejects with `401` refuses the same
  way.
- [ ] Build and porch's tests check pass.

#### Test Plan

Layer A only, as listed.

### Phase 9: afx send across Towers, end to end

**Dependencies**: Phases 5, 6, 8

#### Objective

`afx send afx://<tower>/<workspace>:<agent> "…"` works between two real Towers. Tower routes such an
address to the phase 8 sender, the CLI prints the new outcomes, and the headline path runs in both
directions with a reply command that works.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/servers/tower-messages.ts` and `servers/tower-routes.ts`: an
  `afx://` address naming another Tower goes to the sender instead of `CROSS_TOWER_UNAVAILABLE`. One
  naming this Tower's own slug resolves locally, without the cloud. `afx://owner@…` is still refused
  as not yet available.
- `packages/codev/src/agent-farm/commands/send.ts`:
  - prints the new outcomes (held on this Tower, with where and why; refused, exiting non-zero);
  - adds the stage 1 carry-over hint, "write `afx://devvm/codev:architect`" when the first of two
    components before `architect` is one of my Towers;
  - the explicitly named workspace carry-over resolves.
- `packages/codev/src/agent-farm/utils/agent-names.ts`, `commands/interrupt.ts`, `commands/reset.ts`
  and `servers/tower-cron.ts`. Their refusals now say the command takes a local address. They stop
  saying cross-Tower messaging is not available, which is no longer true. Cron targets,
  `afx interrupt` and `afx refresh` stay local-only, as stage 1 left them.
- `packages/sdk/src/tower-client.ts` and `packages/types/src/messaging.ts`: the new outcomes in the
  send response.
- `packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts` (new, layer B), plus layer A tests
  of the routing and the CLI output beside the existing ones.

#### Deliverables

- [ ] The routing change, the CLI outcomes, the carry-overs and the refusal-message updates.
- [ ] Tests for this phase.

#### Acceptance Criteria

Layer B, two Towers and the stand-in:

- [ ] **The headline path, in both directions.** Each direction needs its own grant, and the reply
  command printed in the footer, sent unchanged, reaches the sender.
- [ ] **Offline, then online.** The message is held at the sender, not touched by the local drainer
  and not escalated, then delivered once.
- [ ] **Order.** Three messages to an offline peer arrive in order, and a fourth sent as the peer
  returns arrives after them.
- [ ] **Concurrency.** Twenty concurrent sends by two agents arrive in acceptance order, and the
  stand-in never sees two message calls to that peer in flight.
- [ ] **Failures in flight.** For a lost answer, a deploy, no answer, a stream reset and a
  just-reconnected session, the message arrives once.
- [ ] **Restart.** The sending Tower restarts with three messages waiting; they resume in order and
  are each accepted once.
- [ ] **Refused on retry.** A message refused on retry because its grant was removed ends refused.
- [ ] **Mixed versions.** A peer that does not speak the protocol, and a cloud with no relay, are
  refused and not held.
- [ ] **Remote-only refusals.** The four options are refused for a remote recipient. A builder naming
  another Tower's architect that is not its own is refused, with no call made. A shell on another
  Tower is refused.
- [ ] **Names.** `afx://<own slug>/…` resolves locally, and `afx://owner@…` is refused.
- [ ] **Waiting cap.** With 50 waiting for a peer, the next send is refused and stores nothing.
- [ ] **Tunnel down.** A sender whose own tunnel is down still sends.
- [ ] **A refusal exits non-zero** through the CLI.
- [ ] Build and porch's tests check pass.

#### Test Plan

- Layer A: routing and CLI output.
- Layer B, on demand: the list above.

### Phase 10: Discovery across Towers

**Dependencies**: Phases 4, 6, 7, 9

#### Objective

From one Tower, `afx peer show <tower>` lists what runs on a peer that I may message, as addresses,
answered by the peer from its grants (Decision 6). Queries are never held.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/peer/discovery.ts` (new), at R. The `answered` list:
  - covers exactly what the asker's grant covers: one architect, a workspace's architects, or under
    `--all` every workspace's architects and builders by id;
  - never a shell;
  - includes `live`;
  - is trimmed to 65 536 bytes and marked `truncated`.

  Without a grant the answer is `no-grant` with the command to add one (C8). R limits queries to 10
  a minute per peer.
- `packages/codev/src/agent-farm/peer/receiver.ts`: hands queries to discovery.
- `packages/codev/src/agent-farm/peer/sender.ts` and `commands/peer.ts`: `afx peer show`, made through
  the cloud client and not queued behind messages. Every answer but `answered` refuses with its
  reason; an offline peer is refused, not held. Queries are recorded like messages.
- Tests: `__tests__/peer-discovery.test.ts` (new, layer A) and `__tests__/peer-discovery.e2e.test.ts`
  (new, layer B).

#### Deliverables

- [ ] Discovery at R and `afx peer show` at S.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Discovery lists exactly what the grant covers, builders by id under `--all`, never a shell. An
  oversized answer is trimmed and marked.
- [ ] `afx peer show` for an offline peer, or through an unreachable cloud, is refused, not held. A
  query that gets the cloud's ceiling `429` is refused with the reason and never held (contract
  revision 4).
- [ ] Without a grant, the refusal names `no-grant` and the command to add one.
- [ ] The 11th query in a minute from one peer is `rate-limited` (injected clock).
- [ ] Build and porch's tests check pass.

#### Test Plan

- Layer A: every grant scope, truncation, the limit and the refusals.
- Layer B, on demand: `afx peer show` between two Towers under each scope.

### Phase 11: Inbox, status and record surfaces

**Dependencies**: Phases 6, 9

#### Objective

A human can see and act on everything stage 2 holds, from the CLI, per Decision 9's stage 2 rows.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/commands/inbox.ts`:
  - `afx inbox` in three groups: waiting for a local agent, held for release, waiting for a peer;
  - `afx inbox show <id>`: for remote mail, the sender's full address and the owner's email;
  - `afx inbox release <id>` (new; human only, with the flag);
  - `afx inbox dismiss <id>` for held-for-release mail and mail waiting for a peer.

  A dismissed remote row answers a later duplicate with `refused`, `dismissed`.
- `packages/codev/src/agent-farm/commands/peer.ts`:
  - `afx peer log [--peer <tower-ref>]`, which reads the record, shows aggregate rows as counted
    lines, and never shows a body;
  - `afx peer list` gains the not-verifying, clock-out-of-range and cloud-error marks set by phase 8
    and phase 6 (G10, G12, G15).
- `packages/codev/src/agent-farm/commands/status.ts`: one remote-messaging line: on or off, peers
  online, held for release, waiting for a peer.
- `packages/codev/src/agent-farm/commands/tower.ts`: `afx tower status` shows this Tower's name
  (the slug while connected; the stored name otherwise) and the switch.
- **The three held counts.** All are scoped to the workspace, as `heldCount` is today:
  - `heldCount` keeps its meaning: held rows waiting for a local agent in this workspace, eligible
    only. It now excludes `release_hold = 1`, so current clients are unaffected.
  - `heldForReleaseCount` (new): remote mail held for release for recipients in this workspace.
  - `waitingForPeerCount` (new): `peer_outbox` rows still held whose sending workspace is this one.

  They touch:
  - `packages/types/src/api.ts` (`OverviewData`), where each field is documented with its scope, as
    `heldCount` is;
  - `packages/codev/src/agent-farm/servers/overview.ts`, where the counts are computed and
    `OverviewData` is assembled;
  - `servers/tower-routes.ts`, whose empty fallback overview object gains the two fields.
- Tests: `__tests__/peer-inbox.test.ts` (new, layer A), the existing overview tests extended, and
  `__tests__/peer-surfaces.e2e.test.ts` (new, layer B).

#### Deliverables

- [ ] The inbox groups and commands, `afx peer log`, the status lines and the three counts in the
  API.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Each kind of held mail appears in its own group and only there.
- [ ] Release delivers through the gate. Dismissing a waiting-for-peer row stops it being sent.
- [ ] `afx peer log` shows a flood as one counted line, and no body appears in its output.
- [ ] `afx peer list` shows each mark while it is set and drops it when it clears.
- [ ] `afx status` and `afx tower status` show the stated lines.
- [ ] `OverviewData` carries the three counts with the stated scope, and `heldCount`'s existing
  consumers (`NeedsAttentionList.tsx`, `sdk/builder-helpers.ts`, the VS Code indicator) see no
  change in meaning.
- [ ] Build and porch's tests check pass.

#### Test Plan

- Layer A: the commands against a temporary database; the overview counts.
- Layer B, on demand: on two Towers after a set of sends that leaves one message of each kind.

### Phase 12: Dashboard: Peers panel and three-count indicator

**Dependencies**: Phases 7, 11

#### Objective

The human's read-only view of the feature (architect's item 5: the Playwright check is part of this
phase). The Peers panel goes on Tower's home page, and the dashboard's held-mail indicator shows
three counts, with mail held for release putting it in its attention state.

#### Files to Create / Modify

- `packages/codev/templates/tower.html` (Tower's home page): a read-only Peers panel showing:
  - each of my other Towers with the online hint and what it may message here;
  - the switch;
  - a peer that is not verifying, a clock out of range, or a cloud error.

  The stage 3 parts (the invitation link, other owners' Towers) are not built.
- `packages/codev/src/agent-farm/servers/peer-routes.ts`: the read-only route the panel uses.
- The dashboard's held-mail indicator and every consumer of the counts in `apps/web`:
  - `apps/web/src/components/HeldCountBadge.tsx`: three counts; held for release is the attention
    state;
  - `apps/web/src/lib/heldMail.ts`;
  - `apps/web/src/lib/api.ts`;
  - `apps/web/src/components/App.tsx`.
- Tests: `apps/web/__tests__/HeldCountBadge.test.tsx` and `apps/web/__tests__/heldMail.test.ts`,
  updated.
- `packages/codev/src/agent-farm/__tests__/e2e/spec-1313-held-count-indicator.test.ts`, extended in
  place for the three counts. It route-mocks `/api/state` and `/api/overview`, but the page itself
  comes from whatever Tower the config points at, and the default config falls back to port 4100
  with `reuseExistingServer: true`. So the extended suite runs only through the peers config
  below, like the peers suite.
- `packages/codev/src/agent-farm/__tests__/e2e/peers-panel.test.ts` (new, Playwright).
  - **The marked states** (not verifying, clock out of range, cloud error, one peer and several)
    come from route-mocking the panel's one read-only route, which is deterministic and follows the
    held-count suite's precedent.
  - **One case reads the real route unmocked**: a fresh Tower with the switch off and a cloud with
    no relay. So the route itself is exercised, not only its rendering.

  Because that case needs a running Tower, this suite runs only through the peers config below.
- `packages/codev/playwright.config.ts`: `testIgnore` becomes an array holding `DECISIONS_SUITE` and
  a new exported `PEERS_SUITE`, which names the peers suite and the held-count suite. Nothing else
  in the default run changes.
- `packages/codev/playwright.peers.config.ts` (new), modelled on `playwright.decisions.config.ts`.
  The default `playwright.config.ts` falls back to port 4100 with `reuseExistingServer: true`, which
  could reuse the live Tower, so the peers suite and the extended held-count suite run only through
  this file.
  - **The port.** It refuses unless `TOWER_TEST_PORT` is set and is not 4100.
  - **The directories are the config's own**, not taken from the caller. In Playwright's main
    process it creates an agent-farm directory, a socket directory and a `HOME` with `mkdtemp`
    under the system temp directory. It passes them to the Tower through `webServer.env`.
  - **Workers reuse them.** Playwright evaluates the config again in every worker process. So the
    config first looks for paths already recorded in its own environment variables, and calls
    `mkdtemp` only when there are none, which is true only in the main process. Workers inherit the
    variables, reuse the same three paths, and pass the same path check. A test of the config
    module, loaded twice with the variables set by the first load, finds one set of directories.
  - **A check before the Tower starts.** It resolves each path with `realpath` and refuses if any is
    not under the system temp directory, or is or contains the live agent-farm directory
    (`~/.agent-farm`), the default socket directory or the real home. The database lives in the
    agent-farm directory, so that directory isolates it from the live `global.db`.
  - **Cleanup.** Its `globalTeardown` removes exactly the directories it created, whose paths it
    holds, after checking again that each is under the system temp directory.
  - **A fresh Tower every run.** Its `webServer` uses `reuseExistingServer: false`, so a server
    already on the port fails the run instead of being reused.
  - **No repository workspace.** It runs without the default global setup, which activates the
    repository workspace. It needs no setup of its own: the marked states are route mocks, and the
    unmocked case wants a fresh Tower as it starts.

  The invocation, written in the file's header, needs no directories from the caller:

  ```
  TOWER_TEST_PORT=14102 npx playwright test --config playwright.peers.config.ts
  ```

#### Deliverables

- [ ] The panel and the indicator.
- [ ] The Playwright runs, with screenshots attached to the thread:
  - the peers suite through `playwright.peers.config.ts` only, on a throwaway test Tower;
  - the extended held-count suite, through the same config.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Running the peers suites with `TOWER_TEST_PORT` unset or 4100 fails before any Tower is
  started or reused. The path check, given the live agent-farm directory, the real home or a path
  outside the system temp directory, refuses (a unit test of the check). After a run, none of the
  config's directories remain.
- [ ] Rendered in a browser: the panel shows the peer list, the switch, a not-verifying peer, a peer
  with its clock out of range, and a cloud-error peer.
- [ ] The indicator shows three counts and enters its attention state for held-for-release mail
  only.
- [ ] With one peer and with several; with nothing held and with each kind.
- [ ] Build, porch's tests check and the web app's tests pass.

#### Test Plan

- Layer A: component tests.
- Layer C, on demand: Playwright, per `codev/resources/testing-guide.md`.

### Phase 13: Docs in both trees, the walkthrough end to end, and Windows

**Dependencies**: Phases 1 to 12

#### Objective

Agents and people are taught stage 2, and the approved spec's stage 2 walkthrough runs as written
between two test Towers and the stand-in. The whole branch passes its final checks.

#### Files to Create / Modify

Docs, found by grepping both trees for the addressing forms, `afx peer`, `afx inbox` and the stage
1 refusal text, not from memory:

- `CLAUDE.md` and `AGENTS.md` (byte-identical): the addressing table's `afx://<tower>/…` row.
- `codev/templates/` and `codev-skeleton/templates/`, the `CLAUDE.md` and `AGENTS.md` pairs.
- The `afx` skill: `.claude/skills/afx/SKILL.md`, `.codex/skills/afx/SKILL.md` and both copies under
  `codev-skeleton/`. Hashes are regenerated with
  `pnpm --filter @cluesmith/codev generate-skill-hashes`.
- `codev/resources/commands/agent-farm.md` and `codev-skeleton/resources/commands/agent-farm.md`:
  `afx peer …`, the inbox changes, and the new send outcomes.
- `codev/roles/architect.md`, `codev/roles/builder.md` and both under `codev-skeleton/roles/`:
  - what a `REMOTE, your Tower` header means;
  - that only the Tower part of a remote address is verified (Decision 7);
  - that `afx peer on`, `afx peer grant` and `afx inbox release` are human-only acts (with the
    architect-override carve-out the role files use for such rules).
- `codev/resources/arch.md`: the cross-Tower relay, the contract module, and the peer tables. The
  hot tier is not grown.

Tests and checks:

- `packages/codev/src/agent-farm/__tests__/peer-walkthrough.e2e.test.ts` (new, layer B).

#### Deliverables

- [ ] The docs above.
- [ ] **The walkthrough**, step by step, with each row of its skipped-step table, on two test Towers
  and the stand-in, through the CLI's own commands.
- [ ] **Secrets and bodies**, after the walkthrough:
  - neither Tower's `global.db` contains the session secret, any statement or any MAC (the mailbox
    holds bodies there by design);
  - neither Tower's logs, `cloud-config.json` nor records contain the secret, a statement, a MAC or
    any body text.
- [ ] **Windows**: the workflow again on the finished branch, with the suites on. Its `probe` job
  runs phase 5's three-shell check that an `afx://` address typed unquoted in Git Bash, PowerShell
  and cmd arrives unchanged. Linked in the PR:
  `gh workflow run windows.yml --ref builder/spir-1967 -f purpose='Spec 1967 stage 2 remote addressing' -f suites=true`.
- [ ] The full layer B and C suites run once more on the finished branch (on demand, load 20 or
  less), with the results in the review.
- [ ] A scenario-to-test table in the review: every scenario in the spec and every inherited stage 2
  scenario beside the test that covers it. The four that wait for the real cloud are marked as such.

#### Acceptance Criteria

- [ ] `diff CLAUDE.md AGENTS.md` is empty, and so is each template pair's.
- [ ] The skill-hash check passes.
- [ ] The walkthrough and the secrets check pass. The Windows run is green, or its failure is
  reported to the architect.
- [ ] Build and porch's tests check pass.

#### Test Plan

Layers B, C and D, all on demand.

## Where each scenario is tested

Every scenario in the spec's Test Scenarios, and the inherited stage 2 scenarios, by layer.
**A** runs inside porch's tests check; **B**, **C** and **D** are on demand.

| Scenario | Phase | Layer |
|---|---|---|
| Contract vectors | 1 | A |
| R's checks, one at a time; replay at 9 minutes; replay after a refusal (phase 5's stub, then the real `no-grant` in phase 6) | 5, 6 | A |
| The local listener | 5 | B |
| Handshake; switch-state report and its three retries | 5, 7 | A |
| Mixed versions | 7, 9 | A, B |
| No answer; a stream that dies after the forward | 8, 9 | A, B |
| A deploy | 8, 9 | A, B |
| Caps (102 400, escapes, emoji, a truncated discovery answer) | 1, 10 | A |
| Rate-limited backlog, from both sources | 8 | A (injected clock) |
| A restart of the sending Tower | 8, 9 | A, B |
| How S resolves its row | 8 | A |
| S's refusal order | 8 | A |
| Statement and payload field rules | 1, 5 | A |
| Answers without the body; who decided | 1, 7 | A |
| A wrong clock (G12) | 6 (R), 8 (S), 11, 12 | A, C |
| Record aggregation (C5) | 6, 8, 11 | A |
| Clock (C10, C11) | 5, 6 | A |
| Unregistered sender (C12) | 8 (`deregistered_at`, and the cloud's `401`) | A |
| Cached peer list (C13) | 7 | A |
| Own name | 7, 9 | A, B |
| Stage 1 carry-overs | 9 | A, B |
| TLS | 5, 7 | A |
| Builders across Towers; shells | 6, 9, 10 | A, B |
| Field validation, with the property test | 1, 6 | A |
| R's deadline | 6 | B |
| A run of `not-verified`; a run of `cloud-error` | 8 | A |
| The stand-in's order of checks | 2 | A |
| The Peers panel and held-mail indicator | 12 | C |
| Secrets and bodies | 5 (logger), 13 (whole walkthrough) | A, B |
| Locks | 6 | A, B |
| Inherited: headline path both ways; no grant; offline then online; order; twenty concurrent | 9 (and 8) | A, B |
| Inherited: 50 waiting; lifetime, including on a receiver with shorter mailbox retention; refused on retry; mismatch; lost answer after restart and dismissal | 3, 6, 8, 9 | A, B |
| Inherited: forged, replayed, altered, misaddressed, stale, earlier-session requests | 5 | A, B |
| Inherited: just-reconnected session reported held, then accepted; a sender with its tunnel down | 9 | B |
| Inherited: hostile bodies satisfy Decision 7's invariant; invalid UTF-8 refused | 6 | A |
| Inherited: the four options refused | 8, 9 | A, B |
| Inherited: a peer renamed in the cloud | 7, 9 | A, B |
| Inherited: grant removed, or switch off, while mail is held `busy` | 6 | A, B |
| Inherited: discovery limited to the grant; `afx peer show` offline refused | 10 | A, B |
| Inherited: exceeding the per-peer limit, at the Tower with the cloud's raised | 6, 8 | A |
| Inherited: the walkthrough and its skipped-step table | 13 | B |
| Inherited: `afx://` unquoted on Windows shells | 5, 13 | D |
| Waits for the real cloud: same name on another account; `/t/` refusal at the cloud; the cloud's per-peer limit; behind NAT | — | at `verify-approval` |
| Waits for real Towers: mail reaching a recipient's terminal that itself survived a Tower restart (a restarted test Tower ends its temp-directory workspaces' terminals; layer B shows the database, `peer_outbox` and `peer_accepted` surviving and delivery resuming to an agent activated again; phase 2) | — | at `verify-approval`, in the real-Tower walkthrough |

**Budget for porch's check.** Layer A adds no Tower process and no real wait. The pipeline test
(phase 8) is the largest: two temporary databases, the stand-in and an in-process receiver on an
injected clock. Each phase records the suite's wall time in its commit message. If layer A's
additions ever exceed one minute in total on this machine, I report it to the architect before the
next phase rather than moving tests silently.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| The cloud corrects the contract after Tower code speaks it | Medium | Medium | One module speaks it (choice 1); the stand-in and the vectors change with it; the correction is a local change and a vectors update posted to #22 |
| The stand-in and the Tower share a misreading of the contract | Medium | High | The stand-in never imports `contract.ts`; the vectors test computes with `node:crypto` first; the cloud runs the same vectors |
| The mailbox migration damages held mail on upgrade | Low | High | Additive only, no rebuild; tested on a fixture of today's schema with held rows and on a backup copy of a real database (phase 3) |
| A migration-number collision with another branch (e.g. issue #1871) | Medium | Low | The number is chosen after `origin/main` is merged in, immediately before phase 3 is committed, and checked again before the PR |
| Porch's 15-minute tests check is exceeded | Low | Medium | Only layer A runs there, with no Tower processes and no real waits; phase 2 confirms `*.e2e.test.ts` stays out; each phase records the suite time; any growth over a minute is raised first |
| The tunnel client grows tangled, hiding the verification code | Medium | High | The interception and steps 1 to 8 are one function calling `contract.ts`; delivery is an injected handler; the architect reads these files at phases 5 and 6 |
| The secret leaks through a log or an error message | Low | High | It lives only in the session object; logger spy tests in phase 5; the whole-walkthrough check in phase 13 |
| A test Tower reads the owner's own config or home | Low | Medium | Every test Tower runs with a throwaway `HOME`, agent-farm and socket directory (phase 2); the peers Playwright config creates its own and refuses any path that is not a throwaway one (phase 12) |
| Two Tower processes in one test are flaky on a loaded machine | Medium | Medium | Layer B runs only on demand at load 20 or less, at most 3 workers; a failure is reported, not rerun |
| The Windows run finds a shell that mangles `afx://` | Low | Medium | Phase 5 adds the three-shell probe (`scripts/windows-probe.mjs --argv`, one step per shell in `windows.yml`) and runs it before any doc teaches the form; a failure is reported to the architect |

## Documentation Updates

- Phase 13 updates the files listed there in both trees: the addressing table, the `afx` skill, the
  command reference, the role files and `arch.md`.
- The review routes any new lesson by tier at review time. The hot files are not grown.
- Issue #1986 is closed by the PR (the dead metadata push removed in phase 5).
