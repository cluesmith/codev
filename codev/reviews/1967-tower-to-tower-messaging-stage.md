# Review: Tower-to-Tower messaging, stage 2 — the Tower half

## Summary

The Tower half of stage 2 (issue #1967; the cloud half is codev-cloud #22): an agent on one of my
Towers sends `afx send afx://<tower>/<workspace>:<agent> "…"` to an agent on another of my Towers,
both behind NAT, through Codev Cloud. The receiving Tower takes the sending Tower from the cloud's
MAC-verified statement, accepts nothing without an owner's grant, and frames the message so no
body can counterfeit a header. The sending Tower holds what cannot go now and sends it in order,
one relay call at a time per peer. Built in 13 plan phases, four of them closed by porch's
force-advance (5, 7, 9, 12), and tested against a stand-in relay that implements the wire
contract. Every criterion's Tower share is verified here, in layers A to D. The cloud's share
waits for the real-cloud run at verify-approval.

## Spec Compliance

The spec sorts each criterion as **Here** (verified in this repository), **Cloud** (needs the real
Codev Cloud) or **Split**. For a Split criterion, the box is ticked for the Tower's share, and the
cloud's share is on the list for the real-cloud run below.

**Inherited from Spec 1940 (stage 2).**

- [x] 1. The headline path between two Towers on one account; the stage 2 walkthrough as written
  (Phases 9, 13). Split: behind NAT, through the real cloud, at verify-approval.
- [x] 2. With remote messaging off, an `afx://` send to another Tower is refused before anything
  leaves the machine, naming the command that turns it on (Phases 4, 8, 9).
- [x] 3. No address, header, listing or reply command for one of my own Towers contains an owner;
  `afx://owner@…` is refused as not yet available (Phases 8, 9). Split: names unique per account
  only is codev-cloud #22 item 8, at verify-approval.
- [x] 4. No remote message is accepted until the owner grants a peer; a fresh and an upgraded
  install refuse everything (Phases 3, 4, 6).
- [x] 5. The sender is told `delivered`, `held` with where and why, or `refused` with the reason;
  a refusal exits non-zero and leaves nothing on the receiving Tower (Phases 6, 9; the rate
  refusal's exit rows in phase 13).
- [x] 6. Mail for an offline Tower, or sent while the cloud is unreachable, is held on the sending
  Tower, shown in `afx inbox`, accepted exactly once when the route returns, and shown as expired
  after 30 days (Phases 8, 9).
- [x] 7. Mail held on the sending Tower is a distinct kind: the local drainer never types it, it
  never escalates, and `afx inbox` and the indicator show it apart (Phases 3, 8, 11, 12).
- [x] 8. Order from one Tower to one recipient, with one message relay call in flight per peer
  (Phases 8, 9).
- [x] 9. The recipient's header marks the message remote and names the sending Tower and the
  sender's address; the reply command works (Phases 6, 9; the builder footer rows in the review
  phase). Split: through the real cloud at verify-approval.
- [x] 10. The sending Tower shown to the recipient comes only from the verified statement; no
  payload field changes it (Phases 5, 6; Gap 7's named cases in the review phase). Split: that the cloud builds the statement from its own
  records, at verify-approval.
- [x] 11. Accepted only under a MAC that verifies with the current tunnel session's secret; the
  local caller, `/t/`-style headers, a replay and an earlier session's secret are each refused
  with nothing stored (Phase 5). Split: that the cloud strips the headers on `/t/`, at
  verify-approval.
- [x] 12. A peer that does not speak the protocol, or a cloud with no relay, is refused with that
  reason and not held (Phases 7, 8, 9). Split: that the real cloud reports an old Tower.
- [x] 13. `--raw`, `--interrupt`, `--no-enter` (and `--delay`) are refused for a remote recipient,
  and control characters in a remote body never reach a terminal (Phases 6, 8, 9).
- [x] 14. Listing my other Towers, and a granted Tower's workspaces and agents (Phases 7, 10).
  Split: against the real listing, at verify-approval.
- [x] 15. Removing a grant refuses further mail at once and stops automatic delivery of accepted,
  undelivered mail (Phases 4, 6).
- [x] 16. Flooding is bounded at the receiving Tower, with the sending Tower's own cap on waiting
  mail (Phases 6, 8, 10). Split: the cloud's limits, at verify-approval.
- [x] 17. Both Towers record every cross-Tower attempt and its outcome, with no bodies in logs
  (Phases 6, 8, 11, 13).

**This project's own criteria.**

- [x] The stand-in relay implements the wire contract exactly; no test sends through the real
  cloud or touches the live Tower on port 4100 (Phase 2).
- [x] The MAC, hash and statement rules are pinned by the shared vectors of contract section 11,
  and the full set is posted to codev-cloud #22 (Phase 1; the architect posted the file).
- [x] Remote messaging is off, with no grant, on a fresh and on an upgraded install (Phases 3, 4).
- [x] The session secret only from a `wss:` tunnel; relay, listing and switch-state calls only
  over HTTPS, loopback excepted; any other plain-HTTP cloud reports no relay (Phases 5, 7).
- [x] The builder rule for remote addresses: a named architect on another Tower refused, the
  front door reached, and each of Decision 7's footer rows for a builder prints a command the
  builder's own send accepts (Phases 8, 9; the footer round trip in the review phase, Gap 2).
- [x] Builders addressable across my Towers under a grant that covers them; discovery lists them
  by id (Phases 6, 9, 10).
- [x] Nothing in a statement or payload can forge a frame: a seeded property test (600 cases, seed
  1967) with the project's own generator and no new dev dependency (Phase 6).
- [x] Every remote message goes to the mailbox first and is delivered only through the render
  gate, under the per-agent then per-terminal locks (Phase 6).
- [x] The session secret is in memory only; statements, MACs and bodies are never logged
  (Phases 5, 13).
- [x] Stage 1's two carry-overs: the `afx://devvm/codev:architect` hint, and an `afx://` address
  naming a workspace by its explicit name (Phase 9).
- [x] An `afx://` address typed unquoted in Git Bash, PowerShell and cmd arrives unchanged (Phases
  5, 13; Windows run 46009240887 green).
- [x] Docs, skills and role files in both `codev/` and `codev-skeleton/`, including Decision 7's
  role guidance that only the Tower part of a remote address is verified (Phase 13).

### For the real-cloud run at verify-approval

Each of these is checked here only against the stand-in or a mocked answer, and waits for the
real Codev Cloud and real Towers:

- the same Tower name on another account; the cloud's refusal of a relay request through `/t/`;
  the cloud's per-peer limit; both Towers behind NAT (the plan's four);
- a recipient's terminal that itself survived a Tower restart, receiving the mail held across it
  (layer B shows the database, `peer_outbox` and `peer_accepted` surviving, and delivery resuming
  to an agent activated again);
- the Peers panel's no-relay state, browser-checked only with a mocked answer (the architect's
  note at phase 12 close, 2026-11-27T12:54Z).
- the full `afx status` command, run in a workspace on a real Tower. Layer A checks the command
  with a mocked client, and layer B checks its remote messaging line through
  `renderRemoteMessagingLine`. Layer B cannot run the full command: Tower leaves every workspace in
  a temp directory out of the workspaces it reports (`getInstances`, `isTempDirectory`), and every
  harness workspace is in one. So on a harness Tower the command stops at "Workspace: not active
  in tower", before the held-mail and remote messaging lines (phase 13, the run the claude review
  of phase 11 asked for).
- what the real Codev Cloud stores of a relayed message: no body. The stand-in keeps payload
  bytes in its own records, so it says nothing about the cloud's half.
- on the real cloud, a real builder messaged under `--all` sends its footer's command back and it
  arrives (the architect's ruling on gap 2, main, 2026-11-27T14:10Z).

### Runs on the finished branch (phase 13)

Run on demand on the finished branch, after merging `origin/main` (`9f2048c78`, with #1977 and
#1992) and `npm run build`:

- **Layer A** (porch's tests check, `npm test -- --exclude='**/e2e/**'`): 11 022 passed, 116
  skipped, 242 s. Run again in the review phase on `a2f660715`, after the phase 13 review round's
  rows, the gap 2 test and the PR review's fixes, with `npm run build` green first: 11 028
  passed, 116 skipped, in 482 files, 244 s.
- **Layer B**, the seven two-Tower files (`two-towers-harness`, `peer-entry-point`,
  `peer-receive`, `peer-send`, `peer-discovery`, `peer-surfaces`, `peer-walkthrough`, all
  `*.e2e.test.ts`) with `vitest.e2e.config.ts`: 63 passed in 59 s, at a load of 2.8. Nothing was
  left in the temp directory.
- **Layer C**, `playwright.peers.config.ts` on port 14102: 17 passed in 5.5 s, at a load of 2.0.
  No run folder was left, and the port was free afterwards.
- **Layer D**, the Windows workflow, twice:
  - **First run**, on `63624ca42`
    ([46006429938](https://github.com/cluesmith/codev/actions/runs/46006429938)):
    - Passed: both probes (the three-shell `afx://` check on windows-latest and windows-11-arm),
      the CLI tests and the install verification.
    - Failed: 6 of 11 138 unit tests, in two of this spec's files on their first Windows run.
      This went to the architect before any rerun.
    - `peer-inbox.test.ts`, 5 failures. Its workspace was the POSIX literal `/work/codev`. On
      Windows `/api/inbox` normalizes that to a drive-letter path, so the rows stored under the
      literal never matched. Fixed in the test (`b5123888d`, through `resolve()`). The architect
      confirmed that production rows are stored canonical.
    - `peer-pipeline.test.ts`, 1 failure. A 50-message backlog passed its 30 s limit; the whole
      file took 172 s on Windows against 1.9 s here.
  - **Second run**, on `914765b38`
    ([46009240887](https://github.com/cluesmith/codev/actions/runs/46009240887)): every job
    passed. Unit tests: 10 712 passed, 426 skipped, none failed. `peer-inbox` passed 24/24, and
    `peer-pipeline` passed 15/15 in 145 s under a Windows-only limit of 120 s per test
    (`47e830c3a`).
  - **Where the pipeline's time goes on Windows.** Measured by temporary test-side timing in
    `47e830c3a`, and removed afterwards. Totals for one 50-message backlog against C's per-pair
    limit. The backlog against R's own limit was 4 to 17% higher on each number but its
    set-up, which was shorter (2.3 s).
    - 50 sends: 2.3 s, so 46 ms each.
    - 51 drain relay calls: 6.6 s over HTTP, so 129 ms each. Of that, R's receiver took 6.35 s
      (124 ms a call), and nearly all of the receiver's time was its SQLite writes (6.26 s).
    - S's SQLite writes: 3.6 s, so 71 ms a message.
    - Set-up: 3.1 s.
    - The stand-in's own loopback HTTP: about 5 ms a call.
    - Locally the same relay call is about 3.8 ms, of which R's receiver is about 1.5 ms.
    - **So the cost is SQLite commits.** Each transaction waits on a sync to disk, which is slow
      on the Windows runner. It is made dearer by the test's own databases: they use SQLite's
      default rollback journal, while production's `global.db` runs WAL with
      `synchronous = FULL`.
    - Per message that is about 0.25 s, with R's part about 0.12 s against its 5 s deadline,
      well under the second a message the architect set as the point at which it would be a
      product matter on Windows. The Windows limit stays, and the timing is gone.

### Scenarios and their tests

Each scenario in Spec 1967's Test Scenarios, and each stage 2 scenario in Spec 1940's Test Scenarios, with the tests that cover it.

**Layers.** A = porch's unit test check (plain `*.test.ts`, apps/web unit tests). B = `*.e2e.test.ts`: two real Towers on the stand-in, run on demand. C = Playwright through `playwright.peers.config.ts` (its `PEERS_SUITE` is `peers-panel.test.ts` and `spec-1313-held-count-indicator.test.ts`). D = the Windows workflow probe.

**Names.** In the "Test name(s)" column, `[file]` is the basename of a file in the "Test file(s)" column. A title written with `${…}` is a template literal or a loop over a table in the source, and the row it means is given in quotes. `$name`, `%s` and `%i` are `it.each` patterns.

| Scenario | Test file(s) | Test name(s) | Layer | Notes |
|---|---|---|---|---|
| 1967: Contract vectors: the worked case of section 11 verifies; the full set passes, including a non-ASCII email (verifies) and a statement MACed with another secret (does not) | packages/codev/src/agent-farm/__tests__/peer-contract-vectors.test.ts<br>packages/codev/src/agent-farm/__tests__/stand-in-relay.test.ts | [peer-contract-vectors] `carries the worked case of section 11 byte for byte`<br>[peer-contract-vectors] `agrees with node:crypto: every verified case has a good MAC and hash, every refusal a good MAC`<br>[peer-contract-vectors] `$name` (it.each over every case; including "a non-ASCII email, verified" and "a MAC made with another secret: not verified (step 2)")<br>[stand-in-relay] `builds every verified case written in its own serialisation, statement and MAC byte for byte, from the case's secret, records and payload` | A | The cases are in `packages/types/fixtures/peer-contract-vectors.json`. |
| 1967: R's checks, one at a time: each of steps 1 to 8 fails alone and stores nothing; a statement presented again 9 minutes later is refused; one first refused for want of a grant cannot be presented again | packages/codev/src/agent-farm/__tests__/peer-entry-point.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-contract.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-receive.e2e.test.ts | [peer-entry-point] describe `steps 1 to 8, each failing alone, hand nothing on` (every test in it), which includes `%s` (step 1 it.each), `a body over 102 400 bytes, with a statement issued for exactly that body`, `a MAC under another secret`, `step 3: a version this Tower does not speak, refused with the versions it does, a sender but no request id`, `step 4: a field outside its rule, a sender but no request id`, `step 5: addressed to another Tower, with the sender and the request id`, `step 6: a body other than the one the statement was issued for`, `step 7: issued more than 5 minutes either side of this clock, refused as clock-skew; 5 minutes exactly passes`, `a statement is used up by its first presentation, even one the handler refused`, `is refused when presented again 9 minutes later (a statement still fresh by its issuedAt)`<br>[peer-contract] describe `R's checks, steps 1 to 7`<br>[peer-receive.e2e] `without a grant: refused no-grant, nothing stored; the statement is then used up; a new one after the grant is accepted` | A, B | In A, "stores nothing" means the handler is never called, and each test's afterEach checks nothing reached the local listener. In A the first presentation is refused by a stub handler (`remote-off`). The real `no-grant` refusal is tested in B. |
| 1967: The local listener: `POST /__tower/peer` to the local port, with the local key and the tunnel marker header, reaches no handler and stores nothing | packages/codev/src/agent-farm/__tests__/peer-entry-point.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-entry-point.test.ts | [peer-entry-point.e2e] `POST /__tower/peer on the local port, with the local key and the tunnel marker, reaches no handler`<br>[peer-entry-point] `every spelling of the path is answered by the entry point, and only other paths reach the listener` | B, A | B checks a 404 `Not found` for POST, GET and path variants. It does not query the database separately. The A test covers the tunnel side of the split. |
| 1967: Handshake: `auth` carries `peer` with the switch state; `auth_ok` without `relay` makes every `afx://` send to another Tower refuse as no relay; a switch change while connected makes one `PUT /api/peer/state`, and its failure is not retried in a loop | packages/codev/src/agent-farm/__tests__/peer-entry-point.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-list.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-sender.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-cloud-client.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-commands.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-entry-point.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts | [peer-entry-point] `states the protocol and the switch in auth, read afresh on every reconnect`<br>[peer-list] `is unknown until the cloud says, and then what the last auth_ok said`<br>[peer-sender] `${check} alone: refused by this Tower with that reason, nothing persisted, no call` ("no-relay")<br>[peer-cloud-client] `tells the cloud, which then lists the switch for this Tower`<br>[peer-cloud-client] `makes one call at a time, and after one in flight sends only the newest change, not each one in between`<br>[peer-cloud-client] `retries a failed report three times, at 5 s, 30 s and 2 min, then not until the next connect`<br>[peer-commands] `reports each change, and only a change, with nothing more printed while the report is under way`<br>[peer-entry-point.e2e] `states protocol 1 and the switch (off on a fresh install) in auth, and holds the relay`<br>[peer-send.e2e] `mixed versions: a peer that does not speak the protocol, and a cloud with no relay, are refused and not held` | A, B | In A, the no-relay refusal is checked in two parts: the relay state taken from `auth_ok`, then the sender's `no-relay` check. B covers the whole path for an `auth_ok` with `relay: null` and for one with no `relay`. |
| 1967: Mixed versions: the stand-in answers `peer-unsupported`: refused, not held. An old cloud (no `relay`, `404` on `/api/peer/…`): refused as no relay | packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-list.test.ts<br>packages/codev/src/agent-farm/__tests__/stand-in-relay.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts | [peer-outbox] `${name}: ${state}, and never sent again` ("C's 409"; "a 404 without the body, from a cloud that never stated a relay")<br>[peer-outbox] `a 404 without the body from an old cloud tells the peer list it has no relay`<br>[peer-list] `takes a bodyless 404 from a cloud that never stated a relay as an old cloud with none`<br>[stand-in-relay] `step 8: a live session that states another version, or none, is 409 peer-unsupported`<br>[stand-in-relay] `an old cloud: no relay field, and 404 without a body on every peer route`<br>[peer-send.e2e] `mixed versions: a peer that does not speak the protocol, and a cloud with no relay, are refused and not held` | A, B | |
| 1967: No answer: the stand-in holds a forward past the relay timeout: held at the sender as `no-answer`, then delivered once on retry; the receiving Tower has one mailbox row | packages/codev/src/agent-farm/__tests__/peer-pipeline.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts<br>packages/codev/src/agent-farm/__tests__/stand-in-relay.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts | [peer-pipeline] `the message is held here; the retry is told duplicate: true and resolves it as delivered, stored once at R`<br>[peer-outbox] `${name}: still held here, retried with the same id and bytes` ("C's 504 no-answer")<br>[stand-in-relay] `a forward held past the relay timeout: R acts on it, and S is told 504 no-answer`<br>[peer-send.e2e] `no answer: the receiving Tower is still writing when the relay times out`<br>[peer-send.e2e] `a lost answer: the receiving Tower acted, the cloud answered no-answer; the retry is a duplicate` | A, B | |
| 1967: A deploy: the stand-in drops both tunnels mid-send and issues new secrets; the message holds, then arrives once, under the new secret, with a new statement and the same message id | packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/stand-in-relay.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-entry-point.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts | [peer-send.e2e] `a deploy mid-send: the tunnels drop and the secrets change; the retry is a new statement for the same message`<br>[stand-in-relay] `a deploy: every tunnel dropped, and each reconnect gets a new secret`<br>[peer-entry-point] `a statement from an earlier session fails after a reconnect, at step 2; a new one verifies`<br>[peer-outbox] `${name}: still held here, retried with the same id and bytes` ("not-verified") | B, A | Only B tests the whole scenario. The A tests each cover one part of it. |
| 1967: Caps: a payload of 102 400 bytes is relayed and one byte more is refused as too large; a 48 KiB body of JSON-escaped characters fits, and so does one of 4-byte emoji written as literal UTF-8; a discovery answer over 65 536 bytes is trimmed and marked truncated | packages/codev/src/agent-farm/__tests__/stand-in-relay.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-entry-point.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-contract.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-discovery.test.ts | [stand-in-relay] `step 3: at most 102 400 bytes, from Content-Length and again while reading`<br>[peer-entry-point] `a body over 102 400 bytes, with a statement issued for exactly that body`<br>[peer-contract] `a 48 KiB body of %s fits the payload cap with the longest addresses` (it.each rows: `characters JSON escapes (")`, `characters JSON escapes (\\)`, `tabs`, `line feeds`, `4-byte emoji`)<br>[peer-contract] `writes non-ASCII as literal UTF-8, never as a \\u escape`<br>[peer-contract] `trims discovery addresses to the 65 536-byte answer, keeping as many as fit, in order`<br>[peer-contract] `marks a discovery answer truncated only when an address was left out, at the exact cap`<br>[peer-discovery] `is trimmed, keeping the first addresses in order, and marked truncated` | A | Titles are given as written in the source, with its escapes. |
| 1967: Rate-limited backlog (C4): 50 held messages drain in order with none refused, once against the stand-in's per-pair `429` and once against R's own per-peer limit with the stand-in's raised; a fresh send refused for rate, from either source, exits non-zero; injected clock | packages/codev/src/agent-farm/__tests__/peer-pipeline.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send-cli.test.ts | [peer-pipeline] `drains in order against C's per-pair limit, none refused; this Tower's own cap holds it at 50`<br>[peer-pipeline] `drains in order against R's own limit with C's raised, none refused`<br>[peer-pipeline] `by C: it ends refused, and the next minute sends again`<br>[peer-pipeline] `by R: it ends refused, with R's retryAfterSec`<br>[peer-outbox] `held mail stays held: the queue waits the cloud's retryAfterSec, then retries the same row first`<br>[peer-outbox] `held mail refused for rate by R without retryAfterSec waits the next back-off interval`<br>[peer-outbox] `a fresh send refused for rate ends refused, from either source; the next send is still made`<br>[peer-send-cli] `prints a refusal by %s (%s) in its own words, and exits non-zero` | A | Every test here runs on an injected clock. The exit-code part: `peer-send-cli`'s `rate-limited` rows for the peer and Codev Cloud (added in phase 13, see Gaps). |
| 1967: A restart of the sending Tower: S holds three for an offline peer and restarts; queue, order, one call per peer and back-off resume from the durable rows; the three arrive in order, each accepted once | packages/codev/src/agent-farm/__tests__/peer-pipeline.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-cloud-wiring.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts | [peer-pipeline] `resumes S's queue from its rows, in order, one at a time`<br>[peer-outbox] `resumes in order, one at a time, each at its own due time`<br>[peer-outbox] `a head whose retry is not yet due waits out what is left of it`<br>[peer-cloud-wiring] `resumes held mail from its rows when Tower starts it, and tells what shows held mail`<br>[peer-send.e2e] `the sending Tower restarts with three waiting: they resume in order, each accepted once` | A, B | |
| 1967: How S resolves its row: `delivered` and `held` at R each end the row accepted, never sent again; a lost answer then `duplicate: true` with `held` resolves it held at the recipient; one with `refused`, `dismissed` ends it refused | packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-pipeline.test.ts | [peer-outbox] `${name}: ${state}, and never sent again` ("delivered", "held at the recipient, busy", "held at the recipient for release", "a duplicate, held", "a duplicate, dismissed", and the rest of that table)<br>[peer-outbox] `a lost answer followed by duplicate: true resolves the row as the state reported`<br>[peer-pipeline] `a message held at R and then lost is the same: the duplicate reports it still held` | A | |
| 1967: S's refusal order: for each adjacent pair in contract section 4's list, a send meeting both gets the earlier refusal | packages/codev/src/agent-farm/__tests__/peer-sender.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-contract.test.ts | [peer-sender] `the contract names ten checks, address first and the cap last`<br>[peer-sender] `${first} before ${second}` (one test per adjacent pair)<br>[peer-contract] `lists S's checks in the contract's order (section 4, checks 0 to 9)` | A | |
| 1967: Statement and payload field rules: each field, just inside and just outside its rule; inside accepted, outside `not-verified` (statement) or `malformed` (payload), nothing stored | packages/codev/src/agent-farm/__tests__/peer-contract.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-contract-vectors.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-entry-point.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts | [peer-contract] `has a rule for exactly the statement fields of section 5, in its order`<br>[peer-contract] `${field}: accepts values just inside its rule and refuses values just outside` (one test per statement field)<br>[peer-contract] `reads a payload that fits, ignoring unknown fields, and returns fresh addresses`<br>[peer-contract] `refuses %s as malformed` (it.each in describe `R's step 12 for a message`)<br>[peer-contract-vectors] `$name` (the step-4 cases, such as "fromOwnerEmail of 254 bytes: verified" and "fromOwnerEmail of 255 bytes: not verified (step 4)")<br>[peer-entry-point] `step 4: a field outside its rule, a sender but no request id`<br>[peer-receiver] `refuses ${label}, storing nothing` ("a payload that is not JSON") | A | The statement tests check the rule functions directly. "Nothing stored" for a statement field is shown by the entry-point step 4 test, in which the handler is never called. |
| 1967: Answers without the body: after a stated relay, bodyless `401`, `403`, `404`, `429`, `502` each hold; with a cloud that never stated one, a bodyless `404` refuses as no relay | packages/codev/src/agent-farm/__tests__/peer-contract.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts<br>packages/codev/src/agent-farm/__tests__/stand-in-relay.test.ts | [peer-contract] `${when}: each status without the body is held, except a bare 404 before a relay is stated`<br>[peer-outbox] `${name}: still held here, retried with the same id and bytes` ("a 401 without the body, once a relay was stated", "a 403 without the body", "a 404 without the body", "a 429 without the body", "a 502 without the body")<br>[peer-outbox] `${name}: ${state}, and never sent again` ("a 404 without the body, from a cloud that never stated a relay")<br>[stand-in-relay] `bodyless 401, 403, 404, 429 and 5xx from something in front of C, each consumed once` | A | |
| 1967: Who decided: a non-200 whose body claims `delivered` is not delivered; a 200 whose body's `outcome` differs from its header is `tower-error` and held | packages/codev/src/agent-farm/__tests__/peer-contract.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts | [peer-contract] `takes who decided from the status, never the body: C's status with R's outcome has no body`<br>[peer-contract] `${when}: a 200 that does not fit the shape is treated as tower-error`<br>[peer-contract] `refuses a C answer whose outcome header differs from its body`<br>[peer-outbox] `${name}: still held here, retried with the same id and bytes` ("a 200 whose body claims another outcome than its header", "a non-200 whose body claims delivered") | A | |
| 1967: A stream that dies after the forward: the stand-in resets the stream before R's answer is complete: `504 no-answer`, held, then accepted once on retry | packages/codev/src/agent-farm/__tests__/stand-in-relay.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts | [stand-in-relay] `a stream reset before the answer is complete: 504 no-answer, and R sees its stream reset`<br>[stand-in-relay] `answers 504 no-answer when R gives no complete answer within the relay timeout, or its stream dies first`<br>[peer-outbox] `${name}: still held here, retried with the same id and bytes` ("C's 504 no-answer")<br>[peer-send.e2e] `a stream reset before the answer is complete` | A, B | |
| 1967: A wrong clock (G12): R's clock 6 minutes off: every relayed request refused `clock-skew`, nothing stored; R's `afx peer list` and Peers panel say its clock may be out of range; S marks the peer "clock out of range" until a later answer | packages/codev/src/agent-farm/__tests__/peer-entry-point.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-commands.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts<br>packages/codev/src/agent-farm/__tests__/e2e/peers-panel.test.ts | [peer-entry-point] `step 7: issued more than 5 minutes either side of this clock, refused as clock-skew; 5 minutes exactly passes`<br>[peer-receiver] `records step 3 and step 7 one row each; a step 7 refusal raises the clock surface for ten minutes`<br>[peer-receiver] `the receiver's sentAt-ahead refusal raises the clock surface too; none stores mail`<br>[peer-commands] `says this Tower's own clock may be out of range while a request was refused as clock-skew in the last 10 minutes`<br>[peer-commands] `shows the marks set now first, and drops them when they clear`<br>[peer-outbox] `a clock-skew answer marks the peer clock out of range at once, until a later message gets another answer`<br>[peers-panel] `several peers: each mark on its own peer, and this Tower's own clock` | A, C | The clock offset is simulated: the statement's `issuedAt` or the payload's `sentAt` is set off from R's injected clock. |
| 1967: Switch-state report: a failed `PUT /api/peer/state` is retried three times, at 5 s, 30 s and 2 min on an injected clock, then not again until the next connect | packages/codev/src/agent-farm/__tests__/peer-cloud-client.test.ts | [peer-cloud-client] `retries a failed report three times, at 5 s, 30 s and 2 min, then not until the next connect`<br>[peer-cloud-client] `drops a pending retry when a new connection states the switch` | A | |
| 1967: Record aggregation (C5): 1 000 not-verified requests in one minute add one record row at the receiving Tower, count 1 000 | packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-storage-migration.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-surfaces.e2e.test.ts | [peer-receiver] `1 000 requests not verified in one minute add one row, with a count of 1 000`<br>[peer-storage-migration] `counts a flood as one row per sender, outcome, reason and minute`<br>[peer-surfaces.e2e] `afx peer log shows a flood as counted lines at both ends, and no body in either Tower's output` | A, B | A writes the 1 000 entry events straight to the record function. The B flood is made of `rate-limited` refusals, not `not-verified` ones. |
| 1967: Clock (C10, C11): a send time 6 minutes ahead is refused as `clock-skew` | packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-contract.test.ts | [peer-receiver] `refuses ${label}, storing nothing` ("a sentAt six minutes ahead")<br>[peer-receiver] `the receiver's sentAt-ahead refusal raises the clock surface too; none stores mail`<br>[peer-contract] `applies the clock: at most 5 minutes ahead, at most 30 days old, both inclusive` | A | |
| 1967: Unregistered sender (C12): a Tower never connected, and one marked deregistered, each refuse an `afx://` send to another Tower with the stated remedy, and make no call | packages/codev/src/agent-farm/__tests__/peer-sender.test.ts<br>packages/codev/src/agent-farm/__tests__/tower-routes.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-pipeline.test.ts | [peer-sender] `a registration marked deregistered is refused with no call, telling the human how to register again`<br>[peer-sender] `${check} alone: refused by this Tower with that reason, nothing persisted, no call` ("not-connected", "not-registered")<br>[tower-routes] `refuses a Tower never connected to Codev Cloud, once the switch is on`<br>[peer-pipeline] `a registration marked deregistered: refused here, and no call is made` | A | |
| 1967: Cached peer list (C13): cloud unreachable: a known name holds, an unknown one refuses naming the time of the last listing; a former name fails naming the current one | packages/codev/src/agent-farm/__tests__/peer-list.test.ts | [peer-list] `resolves a cached name with the cloud unreachable, and refuses one not in it saying when the list was refreshed`<br>[peer-list] `says so when this Tower has never listed its peers and the cloud is unreachable`<br>[peer-list] `refuses a former name, naming the current one, with the cloud unreachable` | A | "A known name holds" is tested as the name resolving from the cache (`fresh: false`). The hold that follows is the outbox's cloud-unreachable path (see the 1940 "cloud unreachable at send time" row). |
| 1967: Own name: `auth_ok` with `slug: "ana-s-mbp"`, `name: "Ana's MBP"` makes the own name `ana-s-mbp`; `afx://ana-s-mbp/…` resolves locally without the cloud; after a rename in the stand-in, the next listing's `self.slug` makes the new name local and the old one fail | packages/codev/src/agent-farm/__tests__/peer-entry-point.test.ts<br>packages/codev/src/agent-farm/__tests__/bugfix-1871-cloud-identity.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-list.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-cloud-wiring.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-sender.test.ts<br>packages/codev/src/agent-farm/__tests__/tower-routes.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts | [peer-entry-point] `takes its own name from auth_ok's slug and reports the relay available, without the secret`<br>[bugfix-1871-cloud-identity] `rewrites cloud-config.json when the cloud renamed the tower`<br>[peer-list] `follows the listing's self.slug after a rename in the cloud, and the old name no longer resolves here`<br>[peer-cloud-wiring] `writes the listing's self.slug into the cloud config, and logs the change`<br>[peer-sender] `this Tower's own name is a local address: none of the checks applies`<br>[tower-routes] `resolves this Tower's own name locally, with remote messaging off and no cloud asked`<br>[peer-send.e2e] `afx://<own slug>/… resolves on this Tower, with no call; afx://owner@… is refused, exiting non-zero` | A, B | The values `ana-s-mbp` / `Ana's MBP` appear only in the peer-list fixture, where the Tower is registered on the stand-in. The `auth_ok` slug-not-name tests use other values (`devvm-2`/`devvm`, `studio`/`Studio`). |
| 1967: Stage 1 carry-overs: the `devvm` hint; an `afx://` address using a workspace's new explicit name resolves where the basename could not | packages/codev/src/agent-farm/__tests__/peer-send-cli.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts | [peer-send-cli] `says to write the afx:// address when the first component is one of my Towers`<br>[peer-send-cli] `counts this Tower's own name as one of my Towers`<br>[peer-send.e2e] `a workspace reached by the name it was given: afx://devvm/<name>:architect` | A, B | In the e2e test the workspace's basename is `Team Notes`. It contains a space, so it cannot be written in an `afx://` address. |
| 1967: TLS: a Tower whose cloud is `http:` on a non-loopback host ignores `relay` in `auth_ok`, makes no peer call, refuses an `afx://` send to another Tower as no relay; on loopback it works | packages/codev/src/agent-farm/__tests__/peer-entry-point.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-cloud-client.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-list.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-sender.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts | [peer-entry-point] `%s is a secure transport: %s`<br>[peer-entry-point] `keeps the secret only for a relay it can use, on a transport the rule allows, having stated the protocol`<br>[peer-entry-point] `over ws: to a host that is not loopback, refuses the secret, reports no relay, and verifies nothing`<br>[peer-cloud-client] `calls over https:, and over plain HTTP only to a loopback host`<br>[peer-cloud-client] `makes none of the three calls to a plain-HTTP cloud that is not on loopback`<br>[peer-list] `applies the TLS rule first: a plain-HTTP cloud off loopback has none, and is never called`<br>[peer-sender] `no relay says why: a plain-HTTP cloud, or one with none`<br>[peer-outbox] `a call the client could not make (a cloud that fails the TLS rule) is no attempt` | A | |
| 1967: Builders across Towers: a builder's send to a named architect on another Tower that is not its own is refused by its own Tower, no call; its send to that workspace's front door is delivered under a grant; a message to a builder under `--all` is delivered and its footer's reply command is accepted when the builder sends it; discovery under `--all` lists builders by id, under a one-architect grant it does not | packages/codev/src/agent-farm/__tests__/peer-sender.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-discovery.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-receive.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-discovery.e2e.test.ts | [peer-sender] `a builder naming an architect on another Tower is refused, told that Tower's front door`<br>[peer-sender] `a builder reaches the front door, and another Tower's builders`<br>[peer-sender] `each footer row for a builder messaged from another Tower prints a command the builder's own send accepts`<br>[peer-receiver] `frames a builder recipient with the footer it may use: the front door for a main sender`<br>[peer-discovery] `--all: every workspace's architects and builders by id, live or not, never a shell or an unnamed workspace`<br>[peer-discovery] `one architect: that architect alone`<br>[peer-send.e2e] `a builder naming another Tower's architect is refused with no call; a shell on another Tower is refused there`<br>[peer-receive.e2e] `delivers to a builder by its id through the real gate, in the remote frame`<br>[peer-discovery.e2e] `--all: every workspace's architects and builders by id, never the shell; each address is one afx send accepts`<br>[peer-discovery.e2e] `one architect: that architect alone` | A, B | Each footer row's reply command is handed to the real sender as the builder (layer A, review phase; Gap 2). The sends are against a scripted outbox. |
| 1967: Shells: `afx://<tower>/<workspace>:<shell-id>` refused by the receiving Tower as `not-addressable`, nothing stored, even under `--all` | packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-receive.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts | [peer-receiver] `refuses ${label}, storing nothing` ("a shell")<br>[peer-receive.e2e] `refuses a shell as not-addressable and an unknown agent as no-such-agent, storing nothing`<br>[peer-send.e2e] `a builder naming another Tower's architect is refused with no call; a shell on another Tower is refused there` | A, B | Only B tests "even under `--all`": both e2e files grant `all: true` before these tests run. The A fixture holds a front-door grant. |
| 1967: Field validation: a non-canonical request id is refused by the stand-in and, injected past it, by R; a seeded property test over every statement and payload field: refused with nothing stored, or a frame whose header and footer hold only validated values | packages/codev/src/agent-farm/__tests__/stand-in-relay.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-contract.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-contract-vectors.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-frame-invariant.test.ts<br>packages/codev/src/agent-farm/__tests__/seeded-generator.test.ts | [stand-in-relay] `step 2: the request id, the kind, the recipient, Content-Encoding and the version`<br>[peer-contract] `refuses a request id that is not a canonical lower-case UUID`<br>[peer-contract-vectors] `$name` ("requestId in upper case: not verified (step 4)", "requestId without hyphens: not verified (step 4)", "requestId in braces: not verified (step 4)", "requestId one character short: not verified (step 4)", "requestId containing \"g\": not verified (step 4)")<br>[peer-frame-invariant] `holds for ${CASES} arbitrary statements and payloads (seed ${SEED})`<br>[seeded-generator] describe `seeded generator` | A | R's side is tested through `verifyRelayedRequest`, the function R uses (the vectors), and through the property test. No test sends a bad request id through the stand-in to a running Tower. The property test runs 600 cases, seed 1967. |
| 1967: R's deadline: with the recipient's terminal lock held by another delivery, a remote message is answered `held`, `busy` within 5 s and delivered once the lock is free | packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-receive.e2e.test.ts | [peer-receiver] `with the terminal lock held by another delivery, answers held busy at once and delivers once it frees`<br>[peer-receiver] `with the per-agent serializer held past the deadline, answers held busy at the deadline; the queued pass never runs late`<br>[peer-receive.e2e] `with the terminal lock held by an interrupt still writing, answers held busy within 5 s; delivers once it frees`<br>[peer-receive.e2e] `answers by the deadline while a long write is still on the wire, which runs on and delivers` | A, B | |
| 1967: A run of `not-verified`: the stand-in MACs with a wrong secret; after five attempts the peer shows "not verifying"; once fixed, the next retry delivers and the mark clears | packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-surfaces.e2e.test.ts | [peer-outbox] `${PEER_RUN_MARK_LENGTH} not-verified in a row mark the peer not verifying, until any other answer`<br>[peer-outbox] `runs are "in a row": a different answer starts again; no answer, or one without the body, neither extends nor ends one`<br>[peer-surfaces.e2e] `afx peer list shows the not-verifying mark while it is set, and drops it when it clears` | A, B | B uses the stand-in's `wrong-secret` fault. A uses scripted answers. |
| 1967: A run of `cloud-error` (G15): the stand-in answers `500 cloud-error` for one peer: the message stays held; after five attempts the peer shows "cloud error" in `afx peer list`, the Peers panel and the record; once normal, the next retry delivers and the mark clears | packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-commands.test.ts<br>packages/codev/src/agent-farm/__tests__/e2e/peers-panel.test.ts<br>packages/codev/src/agent-farm/__tests__/stand-in-relay.test.ts | [peer-outbox] `${PEER_RUN_MARK_LENGTH} cloud-error in a row mark the peer cloud error, until any other answer`<br>[peer-outbox] `${name}: still held here, retried with the same id and bytes` ("C's 500 cloud-error")<br>[peer-commands] `shows each mark under its Tower while it is set, and drops it when it clears`<br>[peers-panel] `several peers: each mark on its own peer, and this Tower's own clock`<br>[stand-in-relay] `step 9 before step 10: a record outside its rule is 500 cloud-error, and nothing is forwarded` | A, C | Partly covered (see Gaps): no test shows the mark "in the record" (`afx peer log`), and A drives the run with scripted answers, not the stand-in. |
| 1967: The stand-in's order of checks: for each adjacent pair in section 4's table, a call failing both gets the earlier step's answer; `unknown-tower` leaves the per-pair counters unchanged | packages/codev/src/agent-farm/__tests__/stand-in-relay.test.ts | describe `section 4: C's checks, in order`: `step 1 before step 2: a caller without a valid key learns nothing about its headers`; `step 2 before step 3: malformed headers on an oversized payload`; `step 3 before step 4: an oversized payload once the per-Tower limit has tripped`; `step 4 before step 5: the per-Tower limit, for a recipient that is no Tower of the account`; `step 5 before step 6: a recipient that has left the account, after its per-pair counter tripped`; `step 6 before step 7: the per-pair limit for a recipient that has gone offline`; `step 7 before step 8: no live session, for a Tower whose last session stated no version`; `step 8 before step 9: a session that states no version, from a sender whose record does not fit`; `step 9 before step 10: a record outside its rule is 500 cloud-error, and nothing is forwarded`<br>`unknown-tower counts against the sender's per-Tower limit and never touches a per-pair counter` | A | |
| 1967: The Peers panel and held-mail indicator, in a browser: peer list, switch state, a peer not verifying, a peer whose clock is out of range, a peer shown "cloud error", and the three counts | packages/codev/src/agent-farm/__tests__/e2e/peers-panel.test.ts<br>packages/codev/src/agent-farm/__tests__/e2e/spec-1313-held-count-indicator.test.ts<br>apps/web/__tests__/HeldCountBadge.test.tsx<br>packages/codev/src/agent-farm/__tests__/peer-panel-template.test.ts | [peers-panel] (test.describe `Spec 1967: the Peers panel on Tower home`) `a fresh Tower, unmocked: no cloud registration and the switch off, so the section is absent`; `one peer: its name, the online hint, its own switch and what it may message here`; `several peers: each mark on its own peer, and this Tower's own clock`; `through Codev Cloud: turning on and granting are done at the machine, and the panel has no control`; `why the list is not a fresh one, a cloud with no relay, and this Tower's own tunnel down`; `an account with no other Towers says so`; `names, recipients and an unknown mode from the route are text, never markup`; `an answer slower than the next request never replaces the newer list`; `a route failure is said as one, not shown as an empty list`<br>[spec-1313-held-count-indicator] `shows the three counts apart, and enters the attention state for mail held for release`; `mail held for release alone: its count, and the attention state with nothing escalated`; `mail waiting for a peer alone: its count, never the attention state`<br>[HeldCountBadge] describe `HeldCountBadge — Spec 1967 three counts`<br>[peer-panel-template] `is hidden on a Tower with no Codev Cloud registration while remote messaging is off`; `is shown on a registered Tower with the switch off, and on an unregistered one with it on` | C, A | The C states come from a mocked `GET /api/peer/panel`, except the first test, which reads the real route. |
| 1967: Secrets and bodies: after a full walkthrough, neither `global.db` holds the session secret, a statement or a MAC; neither Tower's logs, `cloud-config.json` nor records hold the secret, a statement, a MAC or any body text | packages/codev/src/agent-farm/__tests__/peer-walkthrough.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-entry-point.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-entry-point.test.ts | [peer-walkthrough.e2e] `no session secret, statement or MAC anywhere a Tower wrote, and no body outside the mailbox and outbox`<br>[peer-entry-point.e2e] `the session secret appears nowhere in either Tower's output`<br>[peer-entry-point] describe `the secret never reaches a log`: `through a session, forwarded requests of every fate, and a reconnect, in the tunnel client`; `a handler error that quotes the statement and the payload is logged by its class alone`; `an auth response that is not an object of a known type is reported without its text, whatever it carries`; `an auth_ok that repeats its session secret in a field Tower keeps is not used, and nothing of it is kept or logged` | B, A | |
| 1967: Locks: a remote message takes the per-agent then per-terminal locks, in that order | packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-receive.e2e.test.ts | [peer-receiver] `takes the per-agent serializer before the terminal lock: a pass queued behind the agent never touches the terminal`<br>[peer-receiver] `with the terminal lock held by another delivery, answers held busy at once and delivers once it frees`<br>[peer-receive.e2e] `with the terminal lock held by an interrupt still writing, answers held busy within 5 s; delivers once it frees` | A, B | B shows that the terminal lock is taken, but not the order of the two locks. |
| 1940 (inherited): Headline path, both directions, each direction needing its own grant | packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-walkthrough.e2e.test.ts | [peer-send.e2e] `the headline path, in both directions: each needs its own grant, and the footer reply is delivered to the sender`<br>[peer-walkthrough.e2e] `steps 1 to 9, as written: the same commands, in that order, with those results` | B | Run on the stand-in, over loopback. |
| 1940 (inherited): Headline path behind NAT, through the real cloud | — | — | at verify-approval | Named in Spec 1967's Test Scenarios preamble as needing the real cloud. |
| 1940 (inherited): Another account holds a Tower with the same name as mine: my registration is not bumped, and `afx://<that name>/…` reaches mine | — | — | at verify-approval | Real cloud only. |
| 1940 (inherited): `afx://mbp/…` written on my own `mbp` resolves as the local address, without the cloud; `afx://ana@mbp/…` is refused in stage 2 as not yet available | packages/codev/src/agent-farm/__tests__/peer-sender.test.ts<br>packages/codev/src/agent-farm/__tests__/tower-routes.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts | [peer-sender] `this Tower's own name is a local address: none of the checks applies`<br>[peer-sender] `an owner's Tower is refused as stage 1 refuses it, before this Tower's state, and not recorded`<br>[tower-routes] `resolves this Tower's own name locally, with remote messaging off and no cloud asked`<br>[tower-routes] `still refuses an address with an owner as not available, on any Tower`<br>[peer-send.e2e] `afx://<own slug>/… resolves on this Tower, with no call; afx://owner@… is refused, exiting non-zero` | A, B | "Resolves the same way in stage 3" belongs to stage 3 and is out of scope. |
| 1940 (inherited): An `afx://` address typed unquoted in Git Bash, PowerShell and cmd arrives unchanged | .github/workflows/windows.yml<br>scripts/windows-probe.mjs | [windows.yml] job `probe`, steps `Probe afx:// addresses typed unquoted (Git Bash)`, `Probe afx:// addresses typed unquoted (PowerShell)`, `Probe afx:// addresses typed unquoted (cmd)`<br>[windows-probe.mjs] `probeArgv()` (section `argv`, run by `--argv`) | D | These are workflow steps, not `it()` tests. Each step fails unless both addresses (`afx://devvm/codev:architect:local`, `afx://devvm/codev:builder-spir-7`) reach the process byte for byte. Matrix: `windows-latest`, `windows-11-arm`. |
| 1940 (inherited): No grant: refused, nothing persisted on the receiving Tower | packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-grants.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-receive.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-walkthrough.e2e.test.ts | [peer-receiver] `refuses ${label}, storing nothing` ("no grant for the recipient")<br>[peer-grants] `refuses every recipient when there is no grant at all (default deny)`<br>[peer-receive.e2e] `without a grant: refused no-grant, nothing stored; the statement is then used up; a new one after the grant is accepted`<br>[peer-walkthrough.e2e] `skipped step 4 (the grant on devvm): refused by devvm, naming the command to run there` | A, B | |
| 1940 (inherited): Recipient Tower offline, then online: held at the sender, then delivered once; while held, not attempted by the local drainer, no escalation after the escalation age, listed apart from local held mail | packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-walkthrough.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-inbox.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-surfaces.e2e.test.ts<br>apps/web/__tests__/HeldCountBadge.test.tsx<br>packages/codev/src/agent-farm/__tests__/e2e/spec-1313-held-count-indicator.test.ts | [peer-send.e2e] `offline, then online: held at the sender, never in its mailbox, then delivered once`<br>[peer-walkthrough.e2e] `devvm switched off or asleep: held on mbp with its mailbox id, and sent once when devvm returns`<br>[peer-inbox] `lists each kind of held mail in its own group, and only there, with why the queues are paused`<br>[peer-surfaces.e2e] `afx inbox lists each kind of held mail in its own group, and only there, and no body`<br>[HeldCountBadge] `does not enter the attention state for mail waiting for a peer, however much`<br>[spec-1313-held-count-indicator] `mail waiting for a peer alone: its count, never the attention state` | B, A, C | The drainer and escalation are excluded by construction: the row is never in the sender's mailbox, and B asserts that. No test waits past the escalation age (see Gaps). |
| 1940 (inherited): Three messages sent to an offline peer arrive in the order sent; a fourth sent as the peer returns arrives after them | packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts | [peer-send.e2e] `order: three to an offline peer arrive in order, and a fourth sent as it returns arrives after them`<br>[peer-outbox] `a send behind held mail is told at once that it is held here, and goes after it` | B, A | |
| 1940 (inherited): Twenty sends issued concurrently by two agents to one recipient on an online peer arrive in acceptance order; never two relay calls to that peer in flight | packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-pipeline.test.ts | [peer-send.e2e] `twenty concurrent sends by two agents arrive in acceptance order, one message call at a time`<br>[peer-outbox] `twenty sends queued at once are sent in acceptance order, never two in flight`<br>[peer-pipeline] `twenty sends at once go in acceptance order, never two in flight` | B, A | Only the B test uses two sending agents. |
| 1940 (inherited): With 50 waiting for an offline peer, the next send is refused locally as rate limited and nothing is stored; after one is dismissed, a send is held again | packages/codev/src/agent-farm/__tests__/peer-sender.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-pipeline.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts | [peer-sender] `one under the cap is queued; at the cap it is refused, and the refusal counted per minute`<br>[peer-sender] `two sends at once for the last place: one is queued, the other refused`<br>[peer-sender] `${check} alone: refused by this Tower with that reason, nothing persisted, no call` ("rate-limited")<br>[peer-pipeline] `drains in order against C's per-pair limit, none refused; this Tower's own cap holds it at 50`<br>[peer-send.e2e] `with 50 waiting for a peer, the next send is refused, exiting non-zero, and stores nothing` | A, B | Partly covered: the "after one is dismissed" half is not tested (see Gaps). |
| 1940 (inherited): A shell on another Tower cannot be addressed, including on one of my own | packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-receive.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-grants.test.ts | [peer-receiver] `refuses ${label}, storing nothing` ("a shell")<br>[peer-receive.e2e] `refuses a shell as not-addressable and an unknown agent as no-such-agent, storing nothing`<br>[peer-send.e2e] `a builder naming another Tower's architect is refused with no call; a shell on another Tower is refused there`<br>[peer-grants] `refuses a builder or a shell, pointing at --all` | A, B | Same coverage as 1967 "Shells". |
| 1940 (inherited): Cloud unreachable at send time: held at the sender; delivered once after reconnect | packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-cloud-client.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-contract.test.ts | [peer-outbox] `${name}: still held here, retried with the same id and bytes` ("no answer at all", which is `cloud-unreachable`)<br>[peer-cloud-client] `gives up at S's 20-second call timeout, counting the answer's body, and that is no answer: held as the cloud unreachable`<br>[peer-contract] `${when}: no answer at all is held as cloud unreachable` | A | Partly covered: the unreachable cloud is a scripted "no answer", not a stand-in that is actually down (see Gaps). |
| 1940 (inherited): The relay's answer is lost after the receiving Tower accepted: the retry does not deliver twice and is answered with the first message's current state, including after the owner dismissed it and after a Tower restart | packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-pipeline.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-inbox.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts | [peer-receiver] `answers a second arrival with the first message state, marked duplicate, and stores nothing new`<br>[peer-receiver] `answers a duplicate of a dismissed message with refused, dismissed`<br>[peer-receiver] `answers a duplicate after a Tower restart from the database alone`<br>[peer-pipeline] `the message is held here; the retry is told duplicate: true and resolves it as delivered, stored once at R`<br>[peer-inbox] `dismisses mail held for release; a later duplicate of it from the peer is answered refused, dismissed`<br>[peer-send.e2e] `a lost answer: the receiving Tower acted, the cloud answered no-answer; the retry is a duplicate` | A, B | The dismissal and restart variants are tested in A only. |
| 1940 (inherited): A second message from the same peer reusing an accepted id with a different body, or a different recipient, is refused as a mismatch and recorded; the first row unchanged | packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts | [peer-receiver] `refuses a different payload under the same id as mismatch, records it, and changes nothing` | A | Partly covered: only a different body is tested (see Gaps). |
| 1940 (inherited): A message past its 30-day lifetime is refused as expired by the receiver, including one with a shorter mailbox retention; a sender-held row reaching that age is marked expired and not sent | packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-contract.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-storage-migration.test.ts | [peer-receiver] `refuses a retry past the 30-day lifetime as expired, whether or not the prune has run`<br>[peer-receiver] `with a one-day mailbox retention, a day-5 retry of a day-1 delivery is a duplicate and creates no row`<br>[peer-receiver] `refuses ${label}, storing nothing` ("a sentAt 31 days old")<br>[peer-contract] `applies the clock: at most 5 minutes ahead, at most 30 days old, both inclusive`<br>[peer-outbox] `a row is marked expired at 30 days from sentAt and is not sent again`<br>[peer-outbox] `a row behind the head expires on time while the head waits`<br>[peer-outbox] `on start, a row already past its lifetime is expired without a call`<br>[peer-storage-migration] `pruneTerminal at 1 day removes a delivered remote row, and its accepted-once row lives to 30 days after sentAt` | A | The receiver lifetime test prunes with a 1-day retention (`pruneTerminal(f.db, 1, …)`). |
| 1940 (inherited): A sender-held message is refused by the peer on retry (grant removed meanwhile): the row ends refused and is not retried | packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts | [peer-send.e2e] `a message refused on retry, its grant removed meanwhile, ends refused`<br>[peer-outbox] `${name}: ${state}, and never sent again` ("R's refusal", which is `no-grant`) | B, A | |
| 1940 (inherited): A message whose payload claims a different sending Tower is shown with the Tower the cloud authenticated | packages/codev/src/agent-farm/__tests__/peer-frame-invariant.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-contract.test.ts | [peer-frame-invariant] `holds for ${CASES} arbitrary statements and payloads (seed ${SEED})`<br>[peer-receiver] `refuses ${label}, storing nothing` ("a payload whose sender claims another sending Tower")<br>[peer-contract] `refuses %s as malformed` ("from naming a Tower", "from naming an owner") | A | By design a payload address that names a Tower is refused as `malformed` (`readWireAddress` in `peer/contract.ts`), so the claim never reaches a header. The named cases were added in the review phase (Gap 7). About 5% of the property test's generated addresses also carry `{ tower: 'mbp', … }`. |
| 1940 (inherited): A relayed request is refused, nothing stored, when: from localhost with the local key and tunnel marker; MAC with another secret; payload altered after the MAC; names another receiving Tower; statement over five minutes old; same statement presented twice (incl. one first refused for want of a grant); secret of a tunnel session since reconnected | packages/codev/src/agent-farm/__tests__/peer-entry-point.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-entry-point.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-receive.e2e.test.ts | localhost: [peer-entry-point.e2e] `POST /__tower/peer on the local port, with the local key and the tunnel marker, reaches no handler`<br>another secret: [peer-entry-point] `a MAC under another secret`; [peer-entry-point.e2e] `verifies a forward down the real tunnel and hands it to the Tower's handler; replays and /t/-style requests are not verified`<br>altered: [peer-entry-point] `step 6: a body other than the one the statement was issued for`<br>other Tower: [peer-entry-point] `step 5: addressed to another Tower, with the sender and the request id`<br>stale: [peer-entry-point] `step 7: issued more than 5 minutes either side of this clock, refused as clock-skew; 5 minutes exactly passes`<br>twice: [peer-entry-point] `a statement is used up by its first presentation, even one the handler refused`; [peer-receive.e2e] `without a grant: refused no-grant, nothing stored; the statement is then used up; a new one after the grant is accepted`<br>reconnected: [peer-entry-point] `a statement from an earlier session fails after a reconnect, at step 2; a new one verifies`; [peer-entry-point.e2e] `a human turning the switch on is stated on the next reconnect; a statement from the earlier session then fails` | A, B | Same tests as 1967 "R's checks" and "The local listener". The Tower-side refusal of a `/t/`-style request is also tested here, in [peer-entry-point] `a /t/-style request: arbitrary headers, the local key and the tunnel marker, a real statement, no valid MAC`. |
| 1940 (inherited): On the cloud side: a request through the `/t/` proxy to the relay's path is refused, and an attestation header sent by a browser does not reach the Tower | — | — | at verify-approval | Real cloud only. The Tower's own refusal is covered in the row above. |
| 1940 (inherited): A statement made with the secret of a tunnel session that just reconnected is reported to its sender as held, not refused; the retry is accepted under the new secret; a retry of an already-accepted message finds the existing mailbox row | packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts | [peer-send.e2e] `a session that has just reconnected`<br>[peer-send.e2e] `a deploy mid-send: the tunnels drop and the secrets change; the retry is a new statement for the same message`<br>[peer-outbox] `${name}: still held here, retried with the same id and bytes` ("not-verified")<br>[peer-receiver] `answers a second arrival with the first message state, marked duplicate, and stores nothing new` | B, A | `a session that has just reconnected` asserts one row, sent over the new session, but not that the first answer was `held`. The deploy test asserts the held answer. |
| 1940 (inherited): A Tower whose tunnel is down sends successfully to an online peer, and is not reported as talking to a cloud without a relay | packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-commands.test.ts<br>packages/codev/src/agent-farm/__tests__/e2e/peers-panel.test.ts | [peer-send.e2e] `a sender whose own tunnel is down still sends`<br>[peer-commands] `says when the cloud has no relay, and when this Tower can send but not receive`<br>[peers-panel] `why the list is not a fresh one, a cloud with no relay, and this Tower's own tunnel down` | B, A, C | |
| 1940 (inherited): A message in an unknown protocol version is refused naming the supported versions; a send to a peer that predates the protocol is refused, not held; an address sent as a string by an older client is parsed by Tower and resolves | packages/codev/src/agent-farm/__tests__/peer-entry-point.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-contract.test.ts<br>packages/codev/src/agent-farm/__tests__/stand-in-relay.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/tower-routes.test.ts<br>packages/sdk/src/__tests__/tower-client-send.test.ts | [peer-entry-point] `step 3: a version this Tower does not speak, refused with the versions it does, a sender but no request id`<br>[peer-contract] `requires supported in R's unsupported-version refusal, and S reads it back`<br>[stand-in-relay] `step 2: the request id, the kind, the recipient, Content-Encoding and the version`<br>[stand-in-relay] `step 8: a live session that states another version, or none, is 409 peer-unsupported`<br>[peer-outbox] `${name}: ${state}, and never sent again` ("C's 409")<br>[peer-send.e2e] `mixed versions: a peer that does not speak the protocol, and a cloud with no relay, are refused and not held`<br>[tower-routes] `hands the sender the parsed address, the body, the options and who sends`<br>[tower-client-send] `passes the address through as text, for Tower to read` | A, B | The SDK always sends the address as text, and the Tower route parses `afx://DevVM/…` from that text. |
| 1940 (inherited): A body with escape sequences, a bracketed-paste terminator, C1 controls, bidi overrides, zero-width characters, a forged header line (also indented), or a leading `!` or `/` arrives inert under a genuine header (Decision 7); a body that is not valid UTF-8 is refused | packages/codev/src/agent-farm/__tests__/peer-frame-invariant.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-contract.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts | [peer-frame-invariant] `holds for ${CASES} arbitrary statements and payloads (seed ${SEED})`<br>[peer-frame-invariant] `refuses a body that is not valid UTF-8, storing nothing`<br>[peer-contract] describe `Decision 7's normalisation of a remote body`: `turns CR LF, a lone CR, U+2028 and U+2029 into one line feed each, before removing`; `removes every listed code point and keeps tab, line feed and everything else`; `is idempotent and leaves nothing it removes`<br>[peer-receiver] `stores the body normalised: line endings, removed code points, and frame-marker lines`<br>[peer-receiver] `refuses ${label}, storing nothing` ("a body that is not valid UTF-8") | A | ESC, C1, bidi and zero-width characters are covered by the removal-list test. Indented forged headers are covered by the receiver test (two-space indent) and by the invariant's `^[ \t]*###` check. A leading `!` or `/`, and the bracketed-paste terminator as such, have no named case (see Gaps). |
| 1940 (inherited): `--raw`, `--interrupt`, `--no-enter` and `--delay` with a remote recipient are refused | packages/codev/src/agent-farm/__tests__/peer-sender.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts | [peer-sender] `each option is refused by name`<br>[peer-sender] `${check} alone: refused by this Tower with that reason, nothing persisted, no call` ("option-not-allowed")<br>[peer-send.e2e] `the four options are refused for a recipient on another Tower, with no call and nothing stored` | A, B | |
| 1940 (inherited): A recipient Tower renamed in the cloud: the old name fails naming the new one; mail already held for it still reaches it | packages/codev/src/agent-farm/__tests__/peer-list.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-sender.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-commands.test.ts | [peer-list] `keeps the listing, its time and the cloud's limits, and every name a Tower has had`<br>[peer-list] `refuses a former name, naming the current one, with the cloud unreachable`<br>[peer-sender] `an unknown Tower is refused in the peer list's own words, naming its current name`<br>[peer-commands] `finds the grants of a renamed Tower by its former name` | A | Partly covered: the "mail already held still reaches it" half is not tested (see Gaps). |
| 1940 (inherited): Exceeding the per-peer limit is refused as rate limited: at the Tower, with the cloud's limit raised | packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-pipeline.test.ts | [peer-receiver] `refuses the 31st message in a minute from one peer as rate-limited, with the seconds left`<br>[peer-pipeline] `by R: it ends refused, with R's retryAfterSec` | A | The pipeline test raises the stand-in's per-pair limit to 1000. |
| 1940 (inherited): Exceeding the per-peer limit is refused as rate limited: at the cloud | — | — | at verify-approval | Spec 1967 lists "the cloud's half" as needing the real cloud. |
| 1940 (inherited): Removing a grant while mail from that peer is held `busy`: it does not deliver; it waits for release | packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts | [peer-receiver] `at the delivery instant, a revoked grant or a covering hold grant withdraws too; local mail is untouched`<br>[peer-receiver] `revoking the grant moves its held mail to held for release at once`<br>[peer-receiver] `is delivered after a revocation and with the switch still off; the unreleased one waits` | A | The plan's map gives A, B. No B test covers this. |
| 1940 (inherited): Remote messaging off on the receiving Tower: everything refused. Off on the sending Tower: refused locally, no relay call; mail already waiting stays held and is sent once the switch is on | packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-discovery.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-sender.test.ts<br>packages/codev/src/agent-farm/__tests__/tower-routes.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-outbox.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-commands.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-walkthrough.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-discovery.e2e.test.ts | [peer-receiver] `refuses ${label}, storing nothing` ("the switch off")<br>[peer-discovery] `the switch off: remote-off, before the grant is looked at`<br>[peer-sender] `${check} alone: refused by this Tower with that reason, nothing persisted, no call` ("remote-off")<br>[tower-routes] `refuses while remote messaging is off, and says how a human turns it on (criterion 2)`<br>[peer-outbox] `${name}: nothing is sent and no attempt counted; it goes once that changes` ("the switch is off")<br>[peer-commands] `wakes the outbox when, and only when, the switch turns on`<br>[peer-walkthrough.e2e] `skipped step 2 (the switch on mbp): refused on mbp, and nothing leaves the machine`<br>[peer-walkthrough.e2e] `skipped step 3 (the switch on devvm): refused by devvm, exiting non-zero, and nothing left there`<br>[peer-discovery.e2e] `a peer whose switch is off refuses, and says so` | A, B | |
| 1940 (inherited): Remote messaging switched off while mail from a peer is held `busy`: it does not deliver; it waits for release, and still does after the switch is turned on again | packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts | [peer-receiver] `at the delivery instant, mail whose switch or grant was withdrawn moves to held for release, not to the terminal`<br>[peer-receiver] `switching off moves held mail to held for release at once; switching on releases nothing`<br>[peer-receiver] `is delivered after a revocation and with the switch still off; the unreleased one waits` | A | The plan's map gives A, B. No B test covers this. |
| 1940 (inherited): The stage 2 walkthrough, step by step, and each row of its skipped-step table | packages/codev/src/agent-farm/__tests__/peer-walkthrough.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-list.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-commands.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send-cli.test.ts | [peer-walkthrough.e2e] `steps 1 to 9, as written: the same commands, in that order, with those results`; `skipped step 2 (the switch on mbp): refused on mbp, and nothing leaves the machine`; `skipped step 3 (the switch on devvm): refused by devvm, exiting non-zero, and nothing left there`; `skipped step 4 (the grant on devvm): refused by devvm, naming the command to run there`; `skipped step 5 (the grant on mbp): step 7 succeeds, and the reply in step 9 is refused, naming the command to run on mbp`; `devvm switched off or asleep: held on mbp with its mailbox id, and sent once when devvm returns`<br>[peer-list] describe `walkthrough step 1: 'afx peer list' on mbp, with the switch off`<br>[peer-commands] `turns it on with the flag, as walkthrough step 2 prints, and says so when it already was`; `adds a deliver grant by default, as walkthrough step 4 prints, and afx peer grants shows its mode`<br>[peer-send-cli] `prints a delivery as walkthrough step 7 does`; `prints a message held on this Tower for a peer that is asleep, as the skipped-step table does` | B, A | All five rows of Spec 1940's skipped-step table have a test. |
| 1940 (inherited): Discovery lists what the grant covers and nothing more; `afx peer show` for an offline peer is refused, not held | packages/codev/src/agent-farm/__tests__/peer-discovery.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-discovery.e2e.test.ts | [peer-discovery] describe `what each grant covers` (every test in it, such as `one architect: that architect alone` and `only the asking peer's grants`)<br>[peer-discovery] `it(name)` row "an offline peer", in describe `every answer but answered refuses: a query is never held`<br>[peer-discovery.e2e] `one architect: that architect alone`; `a front door: the architect it reaches now`; `a workspace's architects: each of them, and no builder`; `--all: every workspace's architects and builders by id, never the shell; each address is one afx send accepts`; `an offline peer is refused, and nothing is held` | A, B | |
| 1940 (inherited, non-functional): No message body appears in a Tower log or in anything the cloud stores | packages/codev/src/agent-farm/__tests__/peer-walkthrough.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-send.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-receive.e2e.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-sender.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts | [peer-walkthrough.e2e] `no session secret, statement or MAC anywhere a Tower wrote, and no body outside the mailbox and outbox`<br>[peer-send.e2e] `records every send without its body`<br>[peer-receive.e2e] `records every answer without its body`<br>[peer-sender] `no body is ever recorded or logged`<br>[peer-receiver] `is stored with the walkthrough frame, delivered through the gate, and recorded without its body` | B, A | Included because it is about relayed messages. Only the Tower half is covered; the cloud half is in Gaps. |
| 1940 (inherited, non-functional): A remote message takes the same per-agent and per-terminal locks, in the same order, as a local one | packages/codev/src/agent-farm/__tests__/peer-receiver.test.ts<br>packages/codev/src/agent-farm/__tests__/peer-receive.e2e.test.ts | [peer-receiver] `takes the per-agent serializer before the terminal lock: a pass queued behind the agent never touches the terminal`<br>[peer-receive.e2e] `with the terminal lock held by an interrupt still writing, answers held busy within 5 s; delivers once it frees` | A, B | Same scenario as 1967 "Locks". |
| 1940 (inherited, non-functional): Native Windows: the recommended grammar passes through Git Bash, PowerShell and cmd unquoted | .github/workflows/windows.yml<br>scripts/windows-probe.mjs | [windows.yml] job `probe`, steps `Probe afx:// addresses typed unquoted (Git Bash)`, `Probe afx:// addresses typed unquoted (PowerShell)`, `Probe afx:// addresses typed unquoted (cmd)` | D | The same probe as the stage 2 Windows row above. It is included because the probed addresses are `afx://` ones. |
| 1967: Mail reaching a recipient's terminal that itself survived a Tower restart | — | — | at verify-approval, in the real-Tower walkthrough | From the plan's map, not from either spec's Test Scenarios. A restarted test Tower ends the terminals of its temp-directory workspaces, so B tests only the database and rows surviving: `restarts one Tower with its state intact: the same port, database and cloud identity, and a new tunnel session` in two-towers-harness.e2e, and the restart test in peer-send.e2e. Neither covers the terminal itself. |

#### Gaps

Every scenario has some covering test. None is entirely untested. The 11 items below are named parts of scenarios that have no test, or are reached only indirectly.

1. **1967 Rate-limited backlog: "a fresh send refused for rate, from either source, exits non-zero."** Closed in phase 13, after the claude review: `peer-send-cli.test.ts`'s `prints a refusal by %s (%s) in its own words, and exits non-zero` now has a `rate-limited` row for each source, the peer and Codev Cloud, worded as the sending Tower words them (layer A, the CLI against the Tower's answer). Before that, no test ran the CLI on a rate refusal by the stand-in or by R.
2. **1967 Builders across Towers: the builder's footer reply command.** Closed in layer A in the review phase, by the architect's ruling (main, 2026-11-27T14:10Z): `peer-sender.test.ts`'s `each footer row for a builder messaged from another Tower prints a command the builder's own send accepts` takes each of Decision 7's footer rows for a builder recipient, builds the frame with the receiver's own framing (`formatRemoteMessage` and `remoteReplyRoute`, as `receiver.ts` calls them at step 16), takes the reply command out of the footer as printed, parses it with the shared parser, and hands it to the real sender as that builder. A builder's address and the front door (for a `main` architect, named or not) pass the builder rule and every other check and are stored for the peer. The named-architect row prints `afx send architect`, which names no Tower: the builder's own spawning architect, a local send the remote sender never sees, which the test asserts. A mutation that makes the builder rule refuse the front door fails the test on that row. The send itself is still against the scripted outbox; the real cloud round trip is on the verify-approval list.
3. **1967 A run of `cloud-error`: "and the record."** No test shows the cloud-error mark in `afx peer log` or the record. The `afx peer log` marks test uses `not-verified` and `clock-skew`. The run is also driven by scripted answers, not the stand-in, and has no B test. Searched for `cloud-error|cloud error` in `peer-commands.test.ts`, `peer-outbox.test.ts` and `peer-surfaces.e2e.test.ts`.
4. **1940 Offline then online: "raises no escalation after the escalation age."** No test waits past the escalation age with mail waiting for a peer. The behaviour holds only because the row is never in the sender's mailbox (asserted in B), and the badge never enters the attention state for such mail. Searched for `escalat` in `peer-*.test.ts`, `inbox-*.test.ts`, `spec-1313*.test.ts` and `overview.test.ts`.
5. **1940 50 waiting: "after one is dismissed, a send is held again."** Not found. Searched for `dismiss` in `peer-sender`, `peer-outbox`, `peer-pipeline`, `peer-send.e2e`, `peer-surfaces.e2e` and `peer-inbox`. The receiver's own undelivered cap has a dismissal case (`with 50 undelivered from one peer, refuses the next with no retryAfterSec until one is delivered or dismissed`), but that is R's limit, not the sender's waiting cap.
6. **1940 Mismatch: "or a different recipient."** Only a different body is tested. Searched for `mismatch` across `__tests__/`.
7. **1940 A payload claiming a different sending Tower.** Closed in the review phase, after the claude review of the PR (`a2f660715`). `peer-receiver.test.ts`'s `refuses ${label}, storing nothing` has the row "a payload whose sender claims another sending Tower": the statement names `mbp`, the payload's sender names `devvm`, and the message is refused as `malformed` with nothing stored. `peer-contract.test.ts`'s `refuses %s as malformed` has "from naming a Tower" and "from naming an owner". The outcome is a refusal, not the message shown under the authenticated Tower: Spec 1967's payload rules let no payload address name a Tower. Before this, the case was reached only by the property test's random draws.
8. **1940 Cloud unreachable at send time, then reconnect.** No test takes the stand-in down at send time and brings it back. A uses a scripted "no answer at all". Searched for `cloud-unreachable` and `relay.stop` in the e2e files and `peer-pipeline`.
9. **1940 Renamed recipient: "mail already held for it still reaches it."** Not found. Searched for `renameTower|rename` in the peer tests. There are no rename cases in `peer-outbox` or `peer-send.e2e`.
10. **1940 Hostile bodies: a leading `!` or `/`, and the bracketed-paste terminator.** No named case. These are covered only through ESC removal and the property test's header-first check. Searched for `u001b`, `x1b`, `201~`, `leading` and `'!` in the peer tests.
11. **1940 (non-functional): "or in anything the cloud stores."** The cloud half cannot be tested here, so it is on the list for the real-cloud run at verify-approval. The stand-in keeps payload bytes in its own records (`records every call: route, caller, headers, payload size and answer, and never 200 from C on the relay route` asserts `forward.payload` equals the payload), so it says nothing about the real cloud.

### Known residuals

- **A cloud-supplied reason can reach the status (phase 5, architect ruling 2026-11-27T03:36Z).**
  A close reason or `auth_error` reason sent by Codev Cloud reaches the tunnel's last failure, the
  Tower log and `afx tower status` after `sanitizeRemoteDetail` (up to 120 characters, so a
  43-character session secret would fit); this predates Spec 1967, only the cloud can put a secret
  there, and so it rests on the cloud's obligation never to send one, and the secret-echo check
  deliberately covers only `auth_ok`'s `towerId`, `slug` and `name`.
- **The frame marker is read as `###` (phase 6).** Decision 7 escapes a body line "that begins
  the frame marker" and neither spec spells the marker out. The header and the footer both
  begin with `###`, so a body line whose first character other than a space or a tab begins
  `###` gets a backslash in front of it. `#` and `##` lines are left as written.
- **A marker line led by a no-break space is not escaped (phase 6, claude review).** Decision 7
  escapes a line whose first character other than a space or a tab begins the marker. U+00A0 is
  not on its removal list, so a body line written as a no-break space and then `###…` keeps its
  marker and can look like a frame line. That is faithful to Decision 7 as written; widening
  the rule is a spec change.

## Deviations from Plan

Per phase. Readings neither spec states, and the force-advanced phases, follow in their own
subsections.

- **Phase 1.** None.
- **Phase 2.** `seeded-generator.test.ts` was added outside the plan's file list, so the
  generator is tested on its own (the architect accepted it). After phase 5, the harness took its
  ports from the OS instead of fixed ones (`cd54ced1c`): two two-Tower files run in one vitest
  call had taken the same two ports and talked to each other's Towers (architect ruling,
  2026-11-27T02:26Z).
- **Phase 3.** None in the end. The first cut stored mail held for release with a reason; the
  codex review sent it back to the plan's representation (`reason = NULL, release_hold = 1`).
- **Phase 4.** Added, not in the plan: `afx peer on` and `afx peer grant` are refused (403
  `NOT_OVER_TUNNEL`) for a request carrying the tunnel marker, as `/api/ide/session` is. Off and
  revoke only narrow, so they are allowed.
- **Phase 5.** One fix outside the plan's files: once `auth` reads the switch from `global.db`,
  `bugfix-1871-cloud-identity`'s suite left that database open, and its teardown failed with
  `EBUSY` on Windows (run 45929432410). The suite now closes it (architect ruling,
  2026-11-27T02:50Z); the one allowed re-dispatch, 45930869011, was green.
- **Phase 6.**
  - The receiver races its gate attempt against the contract's 5-second deadline, and answers with
    the row's state when the deadline comes first. The plan said "Started: the answer is that
    pass's outcome"; the spec's deadline outranks it (codex review, round 1).
  - `mailbox.released_at` was added to migration v21 so a released row is not held again for
    release. A release is permanent (architect ruling, 2026-11-27T04:51Z).
  - A hold grant withdraws held mail it now covers, as switch-off and revoke do: hold wins.
- **Phase 7.** A re-registration to another cloud or Tower id drops the cached peer list (see
  Readings).
- **Phase 8.** The two builder-rule messages moved from `servers/tower-messages.ts` to
  `utils/agent-names.ts`, so the sender does not import the Tower's server; `tower-messages.ts`
  re-exports them.
- **Phase 9.**
  - A remote send's `bodyLength` is the body as stored and sent, once normalised (codex and claude,
    round 2), not the body as typed.
  - A file for another Tower is no longer refused at 48 KiB before the recipient is known. The SDK
    measures the encoded request and refuses one past Tower's 1 MiB ceiling with no call
    (`REQUEST_TOO_LARGE`, round 3).
  - An outbox that cannot take a message makes the sender throw `PeerSendHeldOnFaultError`
    (`503 REMOTE_HELD_ON_FAULT`): stored and held, with words that say not to send it again
    (architect ruling on the round 1 review).
- **Phase 10.** Discovery lists running workspaces only, and R's query limit counts answered
  queries only (see Readings).
- **Phase 11.** None.
- **Phase 12.**
  - One wiring addition outside the plan's file list: the workspace-scoped
    `GET /workspace/<b64>/api/peer/outbox` in `tower-routes.ts`, so the popover lists mail waiting
    for a peer as `afx inbox` does.
  - The plan's "attention state for held-for-release mail only" was read as "of the new kinds",
    since #1313's escalation keeps its own attention state.
  - The Peers section is hidden when the Tower has no cloud registration and remote messaging is
    off (architect ruling at phase 12 close, done as its own commit in phase 13, `7dc60fd54`).
- **Phase 13.**
  - `overview.md` in both trees needed the same edits, though the plan did not list it.
  - The plan asked for each `CLAUDE.md`/`AGENTS.md` template pair to be byte-identical. Each keeps
    the two differences it already has on `main` by design (the title line and the AGENTS.md
    note), and every edit is identical in both. The architect confirmed this reading of the
    criterion (2026-11-27T13:35Z).
  - The full `afx status` cannot run on a harness Tower, because Tower leaves temp-directory
    workspaces out of what it reports. It moved to the verify-approval list.
  - `peer-pipeline.test.ts` has a Windows-only 120 s per-test limit, with the measured cause in its
    comment (`47e830c3a`).
- **Review phase.** Gap 2, the builder footer's reply round trip, was closed in layer A, not with a
  new two-Tower case (architect ruling, 2026-11-27T14:10Z).

### Readings neither spec states

- **A re-registration drops the cached peer list (phase 7; architect ruling, 2026-11-27T06:36Z).**
  - **What drops it.** When this Tower's registration changes its server URL or its Tower id,
    three things are dropped before anything reads them: the cached peer list, its former names
    and the relay evidence.
  - **What keeps it.** A new key for the same Tower on the same cloud, as `afx tower connect
    --reauth` gives, keeps all three.
  - **What stays regardless.** Grants and the switch stay, because a person set them.
  - **The mechanism.** `peer_settings.listing_scope`, `forgetListingUnlessFor`, and
    `PeerList.scoped()`.
  - **The ruling.** Neither spec states this. The ruling is the architect's, not the owner's;
    the owner has been told and may overrule. The wire contract does not change, so nothing goes
    to the cloud side.
- **Discovery lists running workspaces only (phase 10; architect ruling, 2026-11-27T10:27Z).**
  - **What is listed.** `afx peer show` lists what a message could reach now: the agents of
    workspaces that are running on the peer. An agent of a running workspace with no live
    terminal is listed `not live`, because mail for it is accepted and held.
  - **What is not.** A stopped workspace is not listed. Spec 1940's address book resolves a
    name only to a running workspace, so step 13 refuses mail to a stopped one as
    `no-such-agent`. Listing it would offer an address a message cannot reach.
  - **The ruling.** Neither spec states this; Spec 1940 has a full grant show "every active
    workspace". The ruling is the architect's, not the owner's; the owner has been told and may
    overrule.
- **The receiving Tower's query limit counts answered queries only (phase 10; architect ruling,
  2026-11-27T10:27Z).**
  - **The rule.** R counts a query against its 10-a-minute limit only once it has passed the
    grant check, as a message's limit is checked after its grant. So a peer with no grant is
    refused `no-grant` every time and never reaches R's limit.
  - **What bounds such a peer.** Codev Cloud's per-pair query limit, which stands in front of R.
  - **The ruling.** Neither spec states the order. The ruling is the architect's, not the
    owner's; the owner has been told and may overrule.
- **The sending Tower's queue (phase 8; the builder's readings, recorded here as claude's phase 9
  review asked).**
  - **Runs.** Five `not-verified` in a row mark a peer "not verifying", five `cloud-error` "cloud
    error", and one `clock-skew` "clock out of range". Any other answer ends a run. An answer S
    could not read as the contract's neither extends nor ends one.
  - **Held mail leaves only while S would accept the send now**: the switch on, a registration not
    marked deregistered, and a relay not known to be missing. Otherwise nothing is sent and no
    attempt is counted, so turning the switch off pauses held mail rather than refusing it.
  - **The back-off** counts from the row's durable `attempts`: 5, 10, 20, 40 and 80 s, then a 2-minute
    cap. A fresh head goes at once. `retryAfterSec: 0` is waited as 1 s, so a cloud cannot spin the
    queue. A listing brings a retry forward only after `tower-offline` or `cloud-unreachable`.
  - **An answer to a call begun under another registration** (server URL and Tower id) is recorded
    but not used; the row stays held as `registration-changed`. A new key alone is the same
    registration.
  - **A cloud `401` ends the row refused (`unauthenticated`)**, and the sender is told
    `not-registered` with `afx tower connect --reauth`.
  - **Checks 1 to 4 are read again after the name resolves**, and the waiting-mail cap is counted in
    the same synchronous step as the insert, so two sends cannot both take the last place.
- **`afx send` across Towers (phase 9; the builder's readings).**
  - A refused send to another Tower is a `403 REMOTE_REFUSED` carrying the words, `refusedBy`,
    `reason`, `retryAfterSec`, `mailboxId` and `peer`.
  - An interrupt to any `afx://` address, this Tower's own name included, is refused as
    `LOCAL_ADDRESS_ONLY` before the sender is asked.
  - Mailbox ids are printed in full, as local holds print them (the walkthrough shows eight
    characters).
  - The SDK waits 65 s for an answer to a send naming another Tower: the sender's 20 s per call, the
    cloud's 15 s for the receiver, and room for the route.
- **The inbox (phase 11; the builder's readings, for the architect).**
  - A released message's escalation clock starts at its release, not at its arrival.
  - `afx inbox release` is refused through Codev Cloud's tunnel, as a grant is.
  - A message that ended for a peer leaves the list and stays visible through `afx inbox show <id>`.
  - Dismissing the held head of a peer's queue sends the next message at once.

### Phases closed by porch's force-advance

Porch closes a plan phase at its 3-iteration ceiling when the last round still has a
REQUEST_CHANGES. The fix for that round then gets no consult review before the next phase.

- **Phase 5 (the tunnel's peer entry point).** The iteration 3 fix, `c21f5b932`, had no consult
  round. The architect ran the codex review (APPROVE) and the claude review (COMMENT) of it
  themselves (main, 2026-11-27T03:31Z and 03:36Z), and asked for one small follow-up commit
  with no review round: `e05573ba2`.
- **Phase 7 (peer listing and the cloud client).** The iteration 3 fix, `3cd856ef1`, was not
  re-reviewed by consult. The architect read its source diff, ran the three test files it
  touches (86 passed) and found nothing to change (main, 2026-11-27T06:36Z).
- **Phase 9 (afx send across Towers).** Iteration 3's codex point was right: the CLI's 1 MiB
  guard measured each file, not the request Tower reads. The fix, `10e5fe397`, has the SDK
  measure the encoded request and refuse one past Tower's ceiling with no call
  (`REQUEST_TOO_LARGE`). It was not re-reviewed by consult. The architect read its source diff,
  ran the two test files it touches (26 and 19 passed) and found nothing to change; the
  PR-level review covers it (main, 2026-11-27T09:31Z).
- **Phase 12 (the Peers panel and the three-count indicator).** Iteration 3's codex point was
  right: a caller could mark a folder with its own pid and `exec` Playwright, keeping the pid, and
  the teardown would then remove that folder. The fix, `a38f0f2b0`, has the main process own its
  run by an in-memory record, and the teardown refuse a run it holds no record of. It was not
  re-reviewed by consult. The architect read it, checked that `removePeersDirs` removes only a
  direct child of the temp directory with the run prefix, and found nothing to change, with no
  consult round before phase 13 (main, 2026-11-27T12:54Z).

## Consultation Feedback

Two reviewers each round, as `.codev/config.json` configures them: Codex (GPT-5.6 Sol) and Claude.
Gemini was not a configured lane, so it has no entries. No round returned a `CONSULT_ERROR` or an
empty output. COMMENT verdicts: Claude in plan rounds 1 and 2, Codex in phase 1 round 2, and Claude
in phase 12 round 1. Plan round 3 ended with both reviewers at REQUEST_CHANGES; its fixes went to the
plan-approval gate, where the owner approved the thirteen-phase plan (decision main-58). The rebuttal files are committed in
`codev/projects/1967-tower-to-tower-messaging-stage/`; the raw outputs are not.

The last round, "Review (Round 1)", is the PR-level consultation on PR #2007.

### Specify (Round 1)

All changes for this round landed in commit 407d64534 ("Specification with multi-agent review"); the builder disputed nothing.

#### Codex — REQUEST_CHANGES
- **Concern**: Criterion 17 and contract section 8 had both Towers record every attempt with Tower IDs and full addresses, but the receiver cannot record a request that never reaches it, or vouch for a sender whose MAC fails. → **Addressed**: Section 8 now has each party record what it can see: the sender records every outbound attempt, and the receiver records every request that reaches it, with the sender marked `unverified` until the MAC verifies (407d64534).
- **Concern**: The cloud's answers were too loosely specified for two independent implementations; the full JSON bodies and headers for every outcome were needed. → **Addressed**: Section 6 now opens with one answer shape (a field table giving type and presence), `Content-Type`, `x-codev-peer-outcome` on every answer, example cloud bodies and a status table.
- **Concern**: Criterion 8 (one relay call at a time per peer) conflicted with section 4, which allows discovery queries to run alongside messages. → **Addressed**: Criterion 8 and section 4 now limit the serialisation and the in-flight assertion to message relay calls.

#### Claude — REQUEST_CHANGES
- **Concern**: Nothing required TLS for the session secret. `buildTunnelWsUrl` maps a user-settable `http:` URL to `ws:`, so the secret could travel in cleartext, and the loopback stand-in tests would exercise only that insecure path. → **Addressed**: The contract requires `wss:` before a secret is taken and `https:` for peer calls, with an exception only for a loopback cloud. Added as a success criterion, gap G8, a test scenario and a risk.
- **Concern**: The payload and query-answer addresses showed only `kind: "architect"`, but stage 1's address type also has `kind: "id"` for builders. → **Addressed**: Section 4 defines the two-kind union and adds a builder example. R resolves `id` and refuses a shell as `not-addressable`, with a criterion and scenarios to cover it.
- **Concern**: `maxAnswerBytes`/`maxPayloadBytes` were advertised only in the sender-side listing, so the receiver had no way to learn them. → **Addressed**: They are now pinned as protocol-v1 constants in a new table, and the listing's `limits` carries only rate limits.
- **Concern**: `requestId` and the statement fields that end up in the terminal frame were never validated. → **Addressed**: The cloud validates the request ID as a lower-case UUID, R's step 4 validates every statement field, payload addresses must fit the component rule and the 512-character cap, and a new frame-invariant criterion has a property test (gap G11).
- **Concern**: No criterion covered the builder rule for remote addresses or the stage 2 builder footer rows. → **Addressed**: A new criterion and scenarios cover three cases: a builder naming another Tower's architect (not its own) is refused locally, the front door is reachable under a grant, and each footer row's command is accepted.
- **Concern**: The 503 row made retries depend on the listing showing the peer online, while the prose made them unconditional. → **Addressed**: Back-off is unconditional (5 s rising to 2 min). A listing that shows the peer back only brings the next retry forward.
- **Concern**: The spec did not say what R does when lock contention stops it answering within its 5 s deadline. → **Addressed**: R answers `held`/`busy` if the write cannot start within 5 s (gap G9, plus a test scenario).
- **Concern**: A deterministic `not-verified` mismatch would retry for 30 days and nothing would surface it. → **Addressed**: After five in a row, the peer shows as "not verifying" in `afx peer list`, the Peers panel and the record (gap G10).
- **Concern**: Decision 9's other stage 2 surfaces (inbox, status lines, Peers panel, three-count indicator) were in neither scope column. → **Addressed**: Desired State now puts them explicitly in scope, and Playwright verification was added.
- **Concern**: The constraints did not name the migration v18 "no CHECK" precedent as an option. → **Addressed**: Constraints now names it beside a table rebuild and separate tables.
- **Concern**: Open Question 1's alternative (verify only against the stand-in) should be struck. → **Addressed**: The recommendation was strengthened. The alternative stays listed and marked as such, because the choice belongs to the owner.
- **Concern**: (Minor) the spec restates a fair amount of spec 1940. → **N/A**: Not changed. The reviewer judged it not worth a revision.

### Plan (Round 1)

The plan changes landed in commit a1c5ada5c ("Plan with multi-agent review"). The Claude output carries a #1649 "WORKING TREE CHANGED" warning naming the plan file.

#### Codex — REQUEST_CHANGES
- **Concern**: The Playwright plan did not isolate test Towers. The default config falls back to port 4100 with `reuseExistingServer: true`, so a run could reuse the live Tower. → **Addressed**: Phase 12 adds `playwright.peers.config.ts`. It refuses port 4100 and any non-throwaway directory, always starts a fresh Tower, and is the only config that runs the peers suites (the default config ignores them).
- **Concern**: The "one module speaks the contract" grep would catch the independent stand-in relay. → **Addressed**: The invariant and its structural test now cover production files only and explicitly exempt `__tests__/`.
- **Concern**: Comparing raw fresh and upgraded schemas cannot work, because v17/v18 append columns. → **Addressed**: Phase 3 compares normalised schemas: tables, columns via `table_xinfo`, foreign keys, unique constraints, indexes and whitespace-normalised CHECKs.
- **Concern**: Phase 9 left out `OverviewData` in `packages/types/src/api.ts` and did not say what scope the new counts have. → **Addressed**: Phase 11 names `OverviewData`. All three counts are workspace-scoped, and `peer_outbox` now stores the sending workspace.

#### Claude — COMMENT
- **Concern**: Phase 9 pointed at `tower-routes.ts` for the held counts. They are computed in `servers/overview.ts`, and several `apps/web` consumers were not named. → **Addressed**: Phase 11 names `overview.ts`, the fallback in `tower-routes.ts` and `OverviewData`. Phase 12 names every `apps/web` consumer and test.
- **Concern**: The `not-registered` refusal depends on a deregistered marker from #1871 that does not exist on `main`. → **Addressed**: Phase 8 builds the half that needs no marker (a `401` from the cloud) and writes the pre-call check against whatever marker #1871 lands. If #1871 has not merged by phase 13, the gap is flagged to the architect.
- **Concern**: Phase 2's harness cannot pre-write `cloud-config.json` through `startTower()`. → **Addressed**: Phase 2 spawns each Tower directly, following `bugfix-1515-tower-isolation.e2e.test.ts`. The harness owns and cleans up its directories.
- **Concern**: Phase 6 had no criterion for R's cap of 50 accepted-but-undelivered messages. → **Addressed**: Phase 6 now asserts both of R's limits on an injected clock, including the 51st message being refused without `retryAfterSec`.
- **Concern**: Phase 8 (and to a lesser degree phase 6) was oversized. → **Addressed**: It was split into phase 8 (outbox and the sender's checks, layer A) and phase 9 (routing, CLI, layer B), and discovery moved to its own phase 10. The plan now has 13 phases.
- **Concern**: Some paths and types were imprecise: `utils/agent-names.ts`, and the `held-for-release` reason missing from the union and from `hold-verdict.ts`. → **Addressed**: Each was corrected in the named phases.
- **Concern**: The plan credited porch's `--exclude` flag with excluding `*.e2e.test.ts`. The real source is `vitest.config.ts`. → **Addressed**: The plan now attributes the exclusion to `vitest.config.ts`, and phase 2 gains a criterion to run porch's exact command once and confirm the new file is skipped.

### Plan (Round 2)

The plan changes landed in commit 2f8af628d. Separately, contract revision 4 (commit 68cff8fe4, an architect-relayed cloud correction) was folded into the plan this round. The Claude output again carries a #1649 "WORKING TREE CHANGED" warning naming the plan file.

#### Codex — REQUEST_CHANGES
- **Concern**: `peer_accepted` stored only a hash, a row ID and an expiry. Once a shorter `mailbox.retentionDays` pruned the mailbox row, a duplicate could no longer be told its message's state. → **Addressed**: `peer_accepted` now carries the state and reason itself, written in the same transaction as every status change, and is pruned only after its 30-day expiry. Phase 3 tests a 1-day retention, and phase 6 adds the short-retention retry scenario.
- **Concern**: The Playwright guard only checked that the variables were set, and the shown `mktemp` usage lost the paths needed for cleanup. → **Addressed**: The config creates its own directories with `mkdtemp`, resolves each with `realpath` and refuses any that is outside the temp directory or touches the live paths. `globalTeardown` removes exactly what it created, with a unit test and a criterion.
- **Concern**: Phase 5 claimed to test replay after a `no-grant` refusal, but grants do not exist until phase 6. → **Addressed**: Phase 5 now tests that a statement refused by its stub handler cannot be presented again. The real `no-grant` replay moved to phase 6.

#### Claude — COMMENT
- **Concern**: No phase named the `afx peer grant --deliver | --hold` flags or the default mode. → **Addressed**: Phase 4 carries both flags. Deliver is the default for own Towers, giving both is refused, and `afx peer grants` shows the mode. Each has a criterion.
- **Concern**: Phase 12 would pull the existing route-mocked `spec-1313-held-count-indicator` suite out of the default Playwright run. → **Addressed**: The suite is extended in place and stays in the default run. Only `peers-panel.test.ts` goes through the peers config, `testIgnore` becomes an array, and `PEERS_SUITE` is exported.
- **Concern**: Phase 12's seeded throwaway database is probably more machinery than route mocks need. → **Addressed**: The marked states now come from route mocks, one case reads the real route unmocked on a fresh Tower, and the custom seeding was dropped.
- **Concern**: Nothing pruned `peer_records` or resolved `peer_outbox` rows. → **Addressed**: Phase 3 adds a prune that never uses fewer than 30 days and never removes a held outbox row. Phase 4 adds `peer.recordRetentionDays`.
- **Concern**: (Nits) The "every `FROM mailbox` query is in one file" claim ignores `canonicalize-workspace-paths.ts`, and phase 7 lacked a criterion that `afx peer list` works with the switch off. → **Addressed**: The claim was reworded and is now checked by a grep test, and phase 7 gained the criterion.

### Plan (Round 3)

The plan changes landed in commit 47798fe8e. The Claude output carries a #1649 "WORKING TREE CHANGED" warning naming the plan file.

#### Codex — REQUEST_CHANGES
- **Concern**: The first mailbox insert and the `peer_accepted` insert were not one atomic transaction, so a crash between them could let a retry create a second row. → **Addressed**: Phase 6 does both inserts in one SQLite transaction, `peer_accepted` first, and its primary key settles races. Failure injection at each point and a concurrent-arrival test are new criteria.
- **Concern**: Requests that fail in `tunnel-client.ts` (steps 1 to 8) never reach phase 6's records or clock surface. → **Addressed**: Phase 5 adds an injected hook that emits one structured event per request and never carries secrets. Phase 6 wires it to the record and the clock surface, with criteria for a failure at each step.

#### Claude — REQUEST_CHANGES
- **Concern**: The set-based `dismissHeldForAgent` (called by `afx cleanup`) bypassed the `peer_accepted` mirror, so a sender's retry would be told `held` for a dismissed message. → **Addressed**: The mirror now covers every status-writing statement, set-based ones included, through a join to the rows actually changed. A listing test catches any new writer, and an `afx cleanup` criterion was added.
- **Concern**: `superseded` was missing from the mirrored states, and a guarded no-op update must not rewrite the accepted state. → **Addressed**: `superseded` is stated to be unreachable for remote rows (their `supersede_key` is NULL), and a test asserts it. Only real changes are mirrored.
- **Concern**: The criterion that `afx://` survives unquoted in Git Bash, PowerShell and cmd had nowhere to run, because `windows.yml` uses only bash and no probe references `afx://`. → **Addressed**: Phase 5 adds an `--argv` probe to `scripts/windows-probe.mjs` and three per-shell workflow steps (bash, pwsh, cmd). The risk row was corrected.
- **Concern**: Phase 3's mailbox grep would fail on day one because of a one-off script under `packages/codev/scripts/`. → **Addressed**: The grep is now scoped to non-test files under `packages/*/src`.
- **Concern**: Phase 4 named the wrong file for the prune pass. → **Addressed**: The setting is resolved in `mailbox-wiring.ts`, and the prune runs in `mailbox-delivery.ts`.
- **Concern**: (Minor) Several small gaps:
  - whether `release_hold` is cleared after release
  - each Playwright worker re-evaluates the config
  - the layer A precedent cited is itself an excluded test
  - mock code becomes dead once the metadata push is removed

  → **Addressed**: Each was fixed:
  - release and dismissal clear `release_hold`, with a criterion
  - the config reuses paths it inherits, tested by loading it twice
  - the plan now cites `tunnel-integration.test.ts`/`tunnel-client.test.ts`
  - phase 5 removes `lastMetadata` and the metadata POST handler

### Phase 1: Wire contract module and shared test vectors (Round 1)

The first Codex run crashed twice on a literal line-separator character in the builder thread (consult bug #1818). The character was removed in 519d01159 and Codex was rerun; the output below is from the rerun. The Claude output carries a #1649 "REPOSITORY MOVED" warning: HEAD went from 979c4a9e0 to 519d01159 during the review.

#### Codex — REQUEST_CHANGES
- **Concern**: `statementId` is checked only as 22 base64url-alphabet characters, not as the canonical base64url encoding of exactly 16 bytes. → **Rebutted**: R never decodes the ID, only uses it as a replay key, and the ID sits inside the MAC'd statement. Canonical form and randomness are the cloud's obligations, and the cloud agreed the vectors. The architect ruled that the rebuttal stands, and the contract text and five vector names were clarified with no behaviour change (86893013c).
- **Concern**: Receiver `detail` strings over the contract's 500-character limit were accepted. → **Addressed**: `readAnswerBody` now treats a `detail` over 500 code points as `tower-error`, tested at 500 and 501 (4b91e7f3f).

#### Claude — APPROVE
- **Concern**: `readAnswerBody` kept `retryAfterSec` when the reason was stray (it checked the raw body's reason). → **Addressed**: `retryAfterSec` and `supported` are now read only when the outcome accepted that reason, with tests (4b91e7f3f).
- **Concern**: `ReceiverAnswer` let R omit `supported` on an `unsupported-version` refusal. → **Addressed**: That refusal is now its own variant with `supported` required, pinned by a `@ts-expect-error` test.
- **Concern**: (Informational) The reviewer noted four things:
  - the structural grep is a repo-wide tripwire
  - `readRelayRequestHeaders` has no production caller
  - step 3 answers `unsupported-version` for non-JSON statements
  - header names are duplicated in `peer-wire.ts`

  → **N/A**: All four were kept by design. The tripwire names the file it trips on, the header reader serves as a conformance check, the step 3 reading was agreed with the cloud and noted for phase 8, and codev-types cannot import from `packages/codev`.

### Phase 1: Wire contract module and shared test vectors (Round 2)

There is no rebuttals file for this round. The dispositions come from commit e30799d43 and the builder thread.

#### Codex — COMMENT
- **Concern**: `ReceiverAnswer` allows `retryAfterSec` on every refusal, but the contract allows it only with `rate-limited`. → **Addressed**: The rate-limited refusal is now its own variant, and only it may carry `retryAfterSec` (e30799d43).

#### Claude — APPROVE
- **Concern**: (Cosmetic) The statement-header cap is measured in UTF-16 units against a constant named in bytes. → **Addressed**: It is now measured in UTF-8 bytes. No verdict changes (e30799d43).
- **Concern**: (Cosmetic) `encodeDiscoveryAnswer` can report `truncated: true` without dropping an address, in a one-byte boundary case. → **Addressed**: It now budgets against the untruncated envelope and is tested at 65,536 and 65,537 bytes.
- **Concern**: Nothing asserts that every vector's `statementId` is unique, although the cloud relies on it. → **Addressed**: The vectors test now asserts uniqueness, with no vector changes.
- **Concern**: `encodeAnswerJson` throws above 65,536 bytes, and R's answer path should catch that. → **N/A**: Recorded in the thread as a handoff to phases 6 and 10, where R's answer path is built.
- **Concern**: (Informational) The `independently()` helper in the vectors test rewrites the standard base64 alphabet to base64url before decoding. → **N/A**: informational; no change was made and no response was recorded.

### Phase 2: Stand-in relay and two-Tower test harness (Round 1)

Both outputs carry a #1649 "WORKING TREE CHANGED" warning naming the plan file. The rebuttal says the builder made that edit at the architect's direction, recording a limit of the harness. The fixes are in commit 0de21715c.

#### Codex — REQUEST_CHANGES
- **Concern**: `PUT /api/peer/state` accepts a body with extra keys, but the contract requires exactly `{ "remoteMessaging": "on" | "off" }`. → **Rebutted**: Contract section 0 says receivers ignore fields they do not know, everywhere in the contract. The 400 stays for bodies that are not the object. A comment at the check and a renamed test now pin this reading, and Claude agreed with it in round 2.

#### Claude — APPROVE
- **Concern**: `writeRecordUnchecked` changed the account object that both Towers share, which would get in the way of phase 8's test that breaks one peer only. → **Addressed**: Unchecked owner fields now go to a per-Tower `ownerOverride`, `restoreRecord` undoes the change, and a new test breaks one direction while the other stays healthy (0de21715c).
- **Concern**: Nothing tested that `rotateKey` closes the session (the [r5] behaviour). → **Addressed**: A new test shows the session closes, the old key gets 401, the new key authenticates, and the next connection gets a new secret.
- **Concern**: `lastIssued` was keyed by recipient only, so a replay fault could replay another sender's statement. → **Addressed**: It is now keyed by sender and recipient, with a two-sender test.
- **Concern**: `forward.answer` was not kept on the `tower-error` path. → **Addressed**: It now keeps the status, headers and the body read before the cap. The 502 test checks them.
- **Concern**: The layer A wall time was not recorded. → **Addressed**: About 1.4 s for 57 tests, recorded in the fix commit and the thread.

### Phase 2: Stand-in relay and two-Tower test harness (Round 2)

The fixes are in commit 2beedf38f.

#### Codex — REQUEST_CHANGES
- **Concern**: The stand-in read `PUT /api/peer/state` with a 4,096-byte cap the contract does not define, so a valid report carrying a large unknown field got `400`. → **Addressed**: The body is read whole, and a test sends a 20,000-character unknown field and gets 204 (2beedf38f).

#### Claude — APPROVE
- **Concern**: (Claude also agreed with the round 1 rebuttal on unknown fields.) The empty-`x-codev-peer-to` → `400 malformed` reading was not listed among the stand-in's documented readings. → **Addressed**: It was added to the header's list of readings.
- **Concern**: `handleState` counts a call before answering 400, so a flood of malformed reports never gets a 429. → **Rebutted**: This is the documented order (body checks before limits, as the relay does), and the reviewer called it self-consistent.
- **Concern**: The `answer-delay` fault does not count against `relayTimeoutMs`. → **Addressed**: The fault's doc now says so and points later phases to `answer-late` or a short timeout.
- **Concern**: `inFlightMax` is inflated by calls that fail before step 2. → **Addressed**: Documented, not changed: the doc comment says it counts from authentication, including calls the cloud then refuses.
- **Concern**: A one-time `replay-statement`/`wrong-secret` fault could be used up by a call that then answers 503. → **Addressed**: The `tower-offline` re-check now runs before any forward fault is taken.
- **Concern**: (Minor) Two minor points: no `enableConnectProtocol` on the stand-in's HTTP/2 client, and slugs unique per account rather than globally. → **N/A**: Neither was changed. Nothing proxies a WebSocket here, and the stand-in models the target state (codev-cloud #22), as the reviewer agreed.

### Phase 2: Stand-in relay and two-Tower test harness (Round 3)

There is no rebuttals file for this round. The dispositions come from commit 97c0d9106 and the builder thread.

#### Codex — APPROVE
- No concerns raised (APPROVE)

#### Claude — APPROVE
- **Concern**: A fault could be used up on a call it cannot affect: `replay-statement` with no earlier statement on the pair, or `answer-delay` on a call that `reset-stream` kills. → **Addressed**: A fault is now taken only on a call it can change, so a one-time fault is never wasted (97c0d9106).
- **Concern**: `inFlightMax` never resets, which phases 8 and 9 will need. → **Addressed**: `resetInFlight()` was added (97c0d9106).
- **Concern**: (Informational) The seeded generator's surrogate adjustment is subtle, and `handleState` counts before the 400. → **N/A**: The reviewer said no change was needed for either.

### Phase 3: Peer storage and the mailbox migration (Round 1)

The fixes are in commit 6b920569a.

#### Codex — REQUEST_CHANGES
- **Concern**: `holdForRelease()` kept the row's gate `detail`, so a row could read `held-for-release:user-text`. → **Addressed**: A new `reportedDetail()` hides the detail while the row is held for release, and both inbox routes use it. The row reads `busy:user-text` again once released, with route-level tests (6b920569a).
- **Concern**: `resolveOutbox()` used COALESCE on `last_reason`, so a delivered row could keep `tower-offline`. → **Addressed**: An answer that ends a row now replaces the outcome and reason as a pair, null included. A resolution with no answer keeps the last pair and may not carry a reason of its own.
- **Concern**: `RemoteEnqueueInput` required a hold reason, a departure from the plan's `reason = NULL, release_hold = 1` that claimed a gate verdict that never happened. → **Addressed**: The plan's representation is back and `enqueueRemote` refuses a reason together with `releaseHold`. A duplicate is told `busy` from `peer_accepted` only, never from the mailbox row.

#### Claude — APPROVE
- **Concern**: `checkedState` allowed `held` with a null reason, which `duplicateAnswer` throws on. → **Addressed**: It is now refused on every write and every read.
- **Concern**: `writeListing` throws on unrecognised listing values, so raw cloud JSON would fail a whole refresh. → **N/A**: The store stays strict, and normalisation is recorded as a phase 7 handoff to `peer/cloud-client.ts`.
- **Concern**: (Cosmetic) `insertRecord` validated `payloadSize` with the epoch-ms helper, so the error message was misleading. → **Addressed**: A `nonNegativeInt` helper was added, tested for its exact message.
- **Concern**: The dashboard badge and popover can disagree by the held-for-release count until phases 11 and 12 land. → **N/A**: Recorded in the thread for phase 12 to re-check.
- **Concern**: The layer A wall time was missing from the thread. → **Addressed**: It was already in the phase 3 commit (45 tests, 1.36 to 1.50 s) and is now in the thread too.

### Phase 3: Peer storage and the mailbox migration (Round 2)

There is no rebuttals file for this round. The dispositions come from commit a2b90307f and the builder thread.

#### Codex — APPROVE
- No concerns raised (APPROVE)

#### Claude — APPROVE
- **Concern**: `dismissHeldWithKey` and `supersede` write to the mailbox without mirroring, relying on the convention that remote rows have no `supersede_key`. `dismissHeldWithKey` also sets `release_hold`, which no local row carries. → **Addressed**: Both now carry `AND remote_tower_id IS NULL`, `dismissHeldWithKey` no longer sets `release_hold`, and a test breaks the invariant by hand (a2b90307f).
- **Concern**: `release()` lacked the `remote_tower_id IS NOT NULL` guard that `holdForRelease()` has. → **Addressed**: The guard was added.
- **Concern**: A stale thread note ("phase 6 passes `busy` at insert") still read as current. → **Addressed**: It is struck through in the thread.
- **Concern**: The reviewer agreed with two deferrals already recorded: the badge and popover counts disagreeing, and a released row's escalation clock starting at `created_at`. → **N/A**: Both were deferred to phases 11 and 12. The phase 11 thread entry records that the escalation clock now starts at release.

### Phase 4: The remote-messaging switch and grants (Round 1)

#### Codex — APPROVE
- No concerns raised (APPROVE).

#### Claude — APPROVE
No blocking concerns. This round has no rebuttals file; the dispositions of its non-blocking notes come from commit `7edda5e06` and the builder thread.
- **Concern**: Three refusals in `targetOfAddress` quote the raw address text instead of `shown(text)`, so a bidi or zero-width character could reach a message the CLI prints. → **Addressed**: every peer-route refusal now passes through one sanitizer as it leaves Tower, and the address-quoting sites use `shown()` (`7edda5e06`).
- **Concern**: `isOverTunnel` checks `=== '1'` where the shutdown route's deny-check uses `!== undefined`. → **Addressed**: the tunnel marker now refuses `on` and `grant` on any value, as the shutdown route does (`7edda5e06`).
- **Concern**: An oversized request body is reported as "not valid JSON". → **Addressed**: it is no longer reported as invalid JSON (`7edda5e06`).
- **Concern**: `lib/config.ts` imports `PEER_MIN_RETENTION_DAYS` from `agent-farm/peer/store.js`; the constant belongs in `peer-wire.ts`. → **Rebutted**: `lib/config.ts` already imports from `agent-farm/`, and retention is Tower-local policy, not wire protocol.
- **Concern**: Withdrawal on switch-off or revoke is lazy, so an off-then-on before the next drainer pass would deliver mail Decision 4 says stays held (a carry-forward). → **N/A**: carried to phase 6; the architect ruled (2026-11-27T02:01Z) that withdrawal there is eager.

### Phase 5: Tunnel handshake, session secret and the verified entry point (Round 1)

#### Codex — REQUEST_CHANGES
- **Concern**: A peer handler's error message was logged verbatim (`peer entry point failed: ${err.message}`), so an exception quoting the verified statement or the payload would leak it. → **Addressed**: only the error's class is logged, for the handler, the audit hook and `auth_ok` handling; tested with a handler error that quotes the request id, the sender's email and the body (`94b6bd1a2`).
- **Concern**: A malformed auth response was echoed unless it held the exact text `sessionSecret`, so a secret under another label could be logged. → **Addressed**: an unparseable auth response is reported by byte count only, and an unknown type is shown only when it looks like one; tested with four shapes carrying a real secret without the label (`94b6bd1a2`).

#### Claude — APPROVE
- **Concern**: A stale comment in `tower-tunnel.ts` says the metadata refresh pushes to codevos.ai, though #1986 (the dead metadata push) removed the push. → **Addressed**: the comment now says it refreshes the cache `GET /__tower/metadata` serves (`94b6bd1a2`).
- **Concern**: `readCappedBody` has no read deadline, so a forward whose body never ends pins the stream until the cloud resets it. → **N/A**: carried to phase 6, where the body read shares the 5-second answer deadline.
- **Concern**: In `startH2Server`, the http2 `session` in the `'session'` handler shadows the outer `TunnelSession` parameter. → **Addressed**: renamed `h2Session`; the rename showed `setLocalWindowSize` would have used the outer session, and it now uses the http2 one (`94b6bd1a2`).
- **Concern**: `useStatementId` eviction assumes a monotonic clock. → **Addressed**: a comment now says a clock stepping back keeps some ids longer, which only refuses more and ends with the session (`94b6bd1a2`).
- **Concern**: The dispatched Windows run's result was not recorded, and the acceptance criterion needs it green or reported. → **Addressed**: run 45929432410 is recorded (probe legs green; a unit suite's teardown failure was reported to the architect and fixed per their ruling), and the workflow was dispatched again.
- **Concern**: `peer-entry-point.test.ts` spends about 14 s on real reconnect back-off; an injectable back-off would cut it. → **N/A**: not now; it is well inside the plan's budget, and a later phase adds one if it needs more reconnects.

### Phase 5: Tunnel handshake, session secret and the verified entry point (Round 2)

#### Codex — REQUEST_CHANGES
- **Concern**: A valid `auth_ok` could repeat `relay.sessionSecret` in `name` or `slug`, which `tower-tunnel.ts` persists to `cloud-config.json` and logs. → **Addressed**: an `auth_ok` whose `towerId`, `slug` or `name` repeats the secret (as sent, or as base64url, base64 or hex) is not used at all, and the attempt fails with a fixed reason; tested against a clean control (`40c032749`).

#### Claude — APPROVE
- **Concern**: An unreadable remote-messaging switch fails the whole tunnel connect (dashboard, VS Code remote, `/t/`) for no security gain; stating `off` with a WARN would be equally fail-closed. → **Rebutted**: that is a fallback against the fail-fast rule, so it went to the architect, who ruled to keep failing the attempt, with one ERROR line naming the cause and the reason shown as `Last failure` in `afx tower status` (`41e058585`).
- **Concern**: `cleanup()`'s `session.secret = null` is not independently tested. → **Addressed**: a test holds the old session object across a reconnect and a disconnect, and fails if the nulling is removed (`40c032749`).
- **Concern**: The outcome of the Windows re-dispatch (run 45930869011) was not recorded. → **Addressed**: recorded in the thread as green (both probe legs, unit tests, CLI tests and install verification).
- **Concern**: A comment in `bugfix-1871-cloud-identity.test.ts`, and the thread, say the switch is read on `auth_ok`; it is read when sending `auth`. → **Addressed**: both corrected (`40c032749`).
- **Concern**: A statement that MACs correctly but is not JSON is refused `unsupported-version`, not `not-verified` (noted so nobody "fixes" it). → **N/A**: no change, as the review says; this follows contract section 5, step 3.

### Phase 5: Tunnel handshake, session secret and the verified entry point (Round 3)

#### Codex — REQUEST_CHANGES
- **Concern**: `authOkRepeatsSecret()` derived the base64, base64url and hex spellings only for a taken offer, so for an unsupported or malformed relay offer the secret could be written in another encoding into `name`, `slug` or `towerId`, then persisted and logged. → **Addressed**: the spellings now come from `relay.sessionSecret` as sent, whatever becomes of the offer; tests add controls and five repeated cases in other encodings (`c21f5b932`).

#### Claude — APPROVE
- **Concern**: The same gap as Codex's point: the check compares every encoding only when the offer is taken. → **Addressed**: see Codex's entry (`c21f5b932`).
- **Concern**: `lastFailure` is overwritten by states that are not failures (`circuit breaker reset`, the half-open retry), briefly hiding the real cause in `afx tower status`. → **Addressed**: those reasons now leave the last failure in place; tested after an `invalid_api_key` park (`c21f5b932`).
- **Concern**: `readCappedBody` still has no deadline of its own (already agreed). → **N/A**: already carried to phase 6's 5-second answer deadline.

- **After round 3**: Porch force-advanced the phase, so the iteration 3 fix `c21f5b932` had no consult round. The architect ran the codex review (APPROVE) and the claude review (COMMENT) of it themselves (2026-11-27T03:31Z and 03:36Z), and asked for one small follow-up commit with no review round: `e05573ba2`.

### Phase 6: Receiving a message: accepted once, delivery through the mailbox and gate (Round 1)

#### Codex — REQUEST_CHANGES
- **Concern**: The receiver awaits the whole delivery attempt (`runWithin` bounds only the wait to start), so a slow gate or paced write, such as a 48 KiB agy message, can miss R's 5-second answer deadline and the cloud's 15-second relay timeout. → **Addressed**: the receiver races the attempt against the time left and, at the deadline, answers with the message's state (`held`, `busy`) while the attempt runs on; tested with fake timers and with an 800-line agy write between real Towers (`39485e73e`).

#### Claude — REQUEST_CHANGES
- **Concern**: A row a human releases is held again at once: the drain-time recheck (`remoteMailAllowed`) re-holds it under a `--hold` grant, a revoked grant or the switch off, so hold-for-release can never deliver and phase 11's release criterion is unreachable. → **Addressed**: a nullable `mailbox.released_at` (in the unshipped v21 migration) is set by `release()`, and `remoteMailAllowed` answers yes for a released row; the owner dismisses one to stop it (`39485e73e`).
- **Concern**: No test releases a row and then drains it. → **Addressed**: three tests drain after a release (under the hold grant, after a revocation with the switch off, and with withdrawals after the release); each fails without `released_at` (`39485e73e`).
- **Concern**: Flood aggregation is tested at counts of 2 to 4, not the spec's 1,000-in-a-minute scenario. → **Addressed**: a test now gives one row with a count of 1,000 (`39485e73e`).
- **Concern**: A body line led by a no-break space before `###` is not marker-escaped; faithful to Decision 7, but worth a review residual. → **Addressed**: recorded as a residual in the review document; the escaping rule stays as Decision 7 states it.
- **Concern**: Layering nit: `withdrawRemoteMail` and `remoteMailAllowed` live in `peer/receiver.ts` but serve the routes and the wiring. → **Rebutted**: left as documented in the file's header.

### Phase 6: Receiving a message: accepted once, delivery through the mailbox and gate (Round 2)

#### Codex — APPROVE
- No concerns raised (APPROVE).

#### Claude — APPROVE
No blocking concerns. This round has no rebuttals file; dispositions of its non-blocking notes come from the builder thread and commits.
- **Concern**: `released_at` is permanent authority: a released row survives every later withdrawal, and the architect should rule on it explicitly. → **Addressed**: the architect ruled (2026-11-27T04:51Z) that a released row stays the owner's to deliver, as built, with a phase 11 carry-forward for `afx peer off` and `revoke` to report released messages still waiting; recorded in the thread (`422e2f694`).
- **Concern**: R's per-minute limit is a fixed window, not a sliding one; and `limits()` does a synchronous `loadConfig` per inbound request (both marked by the reviewer as notes, not change requests). → **N/A**: not changed, and no response was recorded; R's limits stay as the contract states them (a per-minute window).
- **Concern**: The no-break-space marker-line residual should stay visible at the spec gate. → **N/A**: already recorded as a residual in the review document in round 1.

### Phase 7: Peer listing and the cloud client (Round 1)

#### Codex — REQUEST_CHANGES
- **Concern**: The peer list, its persisted cache, former names, relay evidence and listing budget survive a registration change, so after switching account, Tower id or cloud, `afx peer list` can show another account's Towers and a send can resolve a stale Tower. → **Addressed**: `peer_settings.listing_scope` records the server URL and Tower id a list was fetched under; every `PeerList` read and peer route drops another registration's list first, and the budget is per registration; tested with Codex's account A to B case (`26bb88e2c`).

#### Claude — APPROVE
- **Concern**: `relayStated()` reads and parses every `peer_towers` row when it needs only the settings row, and phase 8 will call it per relay call. → **Addressed**: `relayStated()` and `relay()` now read the settings row only (`26bb88e2c`).
- **Concern**: A malformed `server_url` throws out of `PeerList`, giving a 500 on `GET /api/peer/towers` and on grant/revoke. → **Rebutted**: Tower never writes such a config; the route fails loudly with a log line naming the cause, as the fail-fast rule asks, and "no relay" would hide the real fault.
- **Concern**: Doc nits: `hasPendingSwitchReport()`'s comment and the "changes in order" test name do not match the newest-wins behaviour. → **Addressed**: the comment and the test name now say what the code does (`26bb88e2c`).
- **Concern**: `retryable` on an over-cap listing is never read. → **Rebutted**: it is filled in for every failure so both route classifiers return one shape, and its value is right; phase 8's holding loop may read it.

### Phase 7: Peer listing and the cloud client (Round 2)

#### Codex — REQUEST_CHANGES
- **Concern**: `listTowers()` shares an in-flight call before checking the registration, and `refresh()` checks only `self.towerId`, so if the cloud changes mid-call with the same Tower id, the old cloud's list is cached under the new scope. → **Addressed**: an in-flight call is shared only under the same registration, and `refresh` compares the full scope before reading the answer, reporting a new `registration-changed` problem; tested with the same-Tower-id case (`90801f92e`).

#### Claude — APPROVE
- **Concern**: `refresh`'s post-call check compares only `self.towerId`, not the full listing scope (the same gap as Codex's point). → **Addressed**: the full scope is compared now (`90801f92e`).
- **Concern**: With no registration at all, nothing is dropped, so `afx peer list` still shows the previous registration's Towers. → **Addressed**: kept as a decision, and the note now says the Towers shown are from the last list, and when (`90801f92e`).
- **Concern**: `scoped()` opens a transaction and runs write statements on every read, a hot path for phase 8. → **Addressed**: `forgetListingUnlessFor` reads one row first and writes nothing unless the scope differs (`90801f92e`).
- **Concern**: `problemOf`'s throw for `malformed` is unreachable and would surface as a route 500. → **Rebutted**: it is reachable only if the cloud breaks the contract, and then the fail-fast rule wants it loud.

### Phase 7: Peer listing and the cloud client (Round 3)

#### Codex — REQUEST_CHANGES
- **Concern**: `onTunnelAuthOk` is called without the originating registration, so a delayed `auth_ok` from registration A can be noted as B's relay state and cancel B's pending switch report. → **Addressed**: `tower-tunnel.ts` passes the registration the connection was made under, and `noteAuthOk` notes nothing for another scope, cancels no report and logs INFO once; each new test fails with the fix removed (`3cd856ef1`).

#### Claude — APPROVE
- **Concern**: `CloudClient.relay` returns an answer with no record of the registration it was made under (a phase 8 concern). → **N/A**: recorded for phase 8, since the relay call has no production caller in phase 7; the outbox will keep each call's scope.
- **Concern**: `lastStatedSwitch` is a module global in `tower-tunnel.ts`. → **Addressed**: the stated switch is now kept per tunnel client (`3cd856ef1`).
- **Concern**: `listingSeq` restarts at 0 each process, and earlier disputed points are noted but not re-raised. → **N/A**: nothing to change; the first describes the intended order, and the rest were not raised again.

- **After round 3**: Porch force-advanced the phase, so the iteration 3 fix `3cd856ef1` was not re-reviewed by consult. The architect read its source diff, ran the three test files it touches (86 passed) and found nothing to change (2026-11-27T06:36Z).

### Phase 8: The outbox, the sender's checks and the per-peer queue (Round 1)

#### Codex — APPROVE
- No concerns raised (APPROVE).

#### Claude — APPROVE
- **Concern**: `Decision.heldReason` is computed and asserted but never read. → **Addressed**: `decide()` no longer computes it, and the test assertion is updated (`06eaeaa25`).
- **Concern**: A queue blocked by the switch, registration or relay persists no reason, so phase 11's `afx inbox` would show the stale last-answer reason. → **N/A**: carried to phase 11, which will show why a peer's queue is paused as a line worked out from Tower's state.
- **Concern**: `Outbox.enqueue` throws synchronously when stopped, while every other failure rejects. → **Addressed**: it now returns a rejected promise, documented and tested (`06eaeaa25`).
- **Concern**: The record row is written before the registration-scope check, so a discarded answer still appears in `afx peer log` with its outcome. → **Rebutted**: the record describes the call, and recording `registration-changed` would lose what the cloud said; carried to phase 11 as a note for `afx peer log`.
- **Concern**: `towerOf(row)` can throw inside two log calls. → **N/A**: the reviewer recommended no change; a throw there means a corrupt database, which `failed()` reports loudly.

### Phase 9: afx send across Towers, end to end (Round 1)

#### Codex — REQUEST_CHANGES
- **Concern**: The route trims the message before the sender sees it, changing leading/trailing whitespace and `bodyLength`; the contract asks for normalisation, not trimming. → **Rebutted**: `handleSend` has trimmed every local and remote message since before this spec, once, before anything is stored, and retries resend the stored bytes; changing it for all sends belongs in its own issue, and the architect checked it against `main` and agreed it stays.
- **Concern**: `/api/send` and the CLI enforced the 48 KiB limit before the sender's ordered checks, so an oversized remote send could get `MESSAGE_TOO_LARGE` before `remote-off`, `no-relay` or `option-not-allowed`; needs route/CLI precedence tests. → **Addressed**: the route and CLI leave a remote body's size to the sender's check 6, on the normalised body (own-slug and local sends keep the local limit), with route and CLI precedence tests (fc1d91ddc).
- **Concern**: The headline E2E proved acceptance and framing but never delivery through the gate, nor the printed reply command delivered back. → **Addressed**: the headline case now uses `live` workspaces whose architects run an echo program named `claude`, and asserts delivery both ways, the footer's reply included, once each side grants (fc1d91ddc).
- **Note**: The lane output carries a working-tree-changed warning (`.builder-state.md`). → **N/A**: the builder changed their own untracked state file just after starting the lanes; nothing a reviewer reads changed.

#### Claude — APPROVE
- **Concern**: The receiving Tower's `detail` is carried and normalised by `printableDetail` but never printed, so a later peer's `detail` would be silently dropped. → **Addressed**: the route passes it as `detail` in a refusal and `remote.detail` in an answer, the SDK reads it, and `afx send` prints it after this Tower's words (fc1d91ddc).
- **Concern**: An `Outbox.enqueue` rejection escapes as an HTTP 500 though the message is persisted and held. → **Addressed**: by the architect's ruling, the sender logs an ERROR and throws `PeerSendHeldOnFaultError`, answered as 503 `REMOTE_HELD_ON_FAULT` with words saying the message is stored, held and must not be sent again (e495e3a96).
- **Concern**: Phases 8 and 9's readings are not yet in the review document. → **N/A**: they are in the thread and go into the review document in the review phase, as its header says.
- **Concern**: Cosmetic: `"2 held message(s)"` wording. → **Addressed**: separate singular and plural lines, with tests for both (fc1d91ddc).
- **Note**: The same working-tree-changed warning (`.builder-state.md`). → **N/A**: as for Codex; the builder's own state file.

### Phase 9: afx send across Towers, end to end (Round 2)

#### Codex — REQUEST_CHANGES
- **Concern**: `readFileContent()` rejects a `--message-file` over 48 KiB before the recipient is classified, so an oversized remote file says "too large" before `remote-off`, and a CRLF file that fits once normalised is refused. → **Addressed**: `afx send` decides local vs remote before reading files; a remote file's size is left to the sender, only a file over Tower's 1 MiB request ceiling (`MAX_REQUEST_BODY_BYTES`) is refused first, and local and `--all` sends keep 48 KiB; tests added (861329f9d).
- **Concern**: A remote send's `bodyLength` comes from the pre-normalised message, so "N bytes" can be wrong for CRLF or removed code points. → **Addressed**: the sender returns `bytes` (the normalised UTF-8 length) on delivered and held results and the route reports it as `bodyLength`, tested on the CRLF case (861329f9d).

#### Claude — APPROVE
- **Concern**: Same `bodyLength`-before-normalisation point. → **Addressed**: as for Codex (861329f9d).
- **Concern**: The SDK type-checks a refusal's fields but passes the 200 answer's `remote` through unvalidated, so "detail is text only" holds for refusals only. → **Addressed**: a new `readRemoteAnswer` reads each field by type, with tests (861329f9d).
- **Concern**: Cosmetic: the `REMOTE_HELD_ON_FAULT` CLI line ends in its error code. → **Addressed**: the SDK gives it its message as the error and keeps the code in `errorCode`, so the CLI prints the words alone (861329f9d).
- **Concern**: Tracking: phases 8 and 9's readings still absent from the review document. → **N/A**: deferred to the review phase, as in round 1, now including the held-on-fault ruling and the changed `bodyLength` reading.

### Phase 9: afx send across Towers, end to end (Round 3)

#### Codex — REQUEST_CHANGES
- **Concern**: The new 1 MiB CLI guard compares raw file bytes, but Tower applies the ceiling to the whole JSON request; the envelope, JSON escaping, or `--message-file` plus `--file` can pass the guard and still be dropped by `parseJsonBody` as a transport failure. → **Addressed**: the SDK's `sendMessage` encodes the request once, measures it as `parseJsonBody` counts it and refuses one over the ceiling with `REQUEST_TOO_LARGE` and no call; the ceiling is one literal in codev-types; boundary, escape-expansion and combined-file tests (10e5fe397).

#### Claude — APPROVE
- **Concern**: A superseded reading ("`bodyLength` is the body as typed") still sits in the thread's readings list and could be copied into the review document. → **Addressed**: struck through in the thread, pointing to round 2's reading (10e5fe397).
- **Concern**: Same raw-file-bytes 1 MiB guard point (escape-heavy content can exceed the request ceiling). → **Addressed**: as for Codex (10e5fe397).
- **Concern**: `localAddressOnlyMessage('This')` reads "This takes a local address". → **Addressed**: it now reads "Finding an agent on this Tower takes a local address: ..." (10e5fe397).
- **Concern**: `send.ts` falls back to the local held wording if a 200 held answer lacks `remote`. → **Rebutted**: only a malformed answer reaches that fallback, as the review itself says; nothing to change.

- **After round 3**: Porch force-advanced the phase at the 3-iteration ceiling, so the fix `10e5fe397` (the SDK measures the encoded request and refuses one past Tower's ceiling as `REQUEST_TOO_LARGE`) had no consult round; the architect read its source diff, ran the two test files it touches (26 and 19 passed), found nothing to change, and left it to the PR-level review (main, 2026-11-27T09:31Z).

### Phase 10: Discovery across Towers (Round 1)

#### Codex — REQUEST_CHANGES
- **Concern**: `recordQuery()` always stores `payloadSize: null`, though the contract requires every outbound relay call, discovery queries included, to record its payload size. → **Addressed**: a query's relay call records `payload.bytes.length`, pre-call refusals keep null as a message's do, with layer A checks and a layer B check of the same size at both ends (ad886a0c5).

#### Claude — APPROVE
- **Concern**: R's query limit counts answered queries only, so a peer with no grant is bounded by the cloud's per-pair limit, not R's. → **Rebutted**: this follows the contract's step order (the limit is step 15, the grant check step 14); recorded in the thread for the architect, whose ruling (10:27Z) is now in the review document's readings.
- **Concern**: `QueryLimit.take` reads `deps.now()` while payload freshness reads `request.receivedAt` (two clocks). → **Rebutted**: a message's step 15 in the receiver's `decide` does the same, so the query path matches it.
- **Concern**: `shownLines([])` takes `Math.max()` of an empty list (`-Infinity`). → **Addressed**: the width starts at 0, with a test (ad886a0c5).
- **Concern**: `QUERIES_PER_PEER_PER_MINUTE` lives in `discovery.ts`, not the contract. → **Rebutted**: it is a limit R enforces, not a wire constant, so it stays beside the code that enforces it.
- **Concern**: `/api/peer/show` is reachable through the cloud's `/t/` proxy. → **Rebutted**: intended; the barrier is on `/__tower/peer`, and phase 12's Peers panel needs the `/api/peer/*` routes remotely.

### Phase 10: Discovery across Towers (Round 2)

#### Codex — APPROVE
- No concerns raised (APPROVE).

#### Claude — APPROVE
- **Concern**: Non-blocking: the new `expect(shownLines([])).toEqual([])` test is vacuous (passes with or without the fix), and the same unseeded `Math.max` remains in phase 7's `towerLines`. → **Addressed**: no rebuttals file for this round; per the thread and the phase 11 commit 50eb06359, the vacuous assertion was dropped and `towerLines` seeds its `Math.max` with 0, fixed in place.
- **Concern**: Minor: if `discoverAddresses` ever threw, the limit slot would already be consumed. → **N/A**: the reviewer marked it "no action" (the function is synchronous over in-memory data).

### Phase 11: Inbox, status and record surfaces (Round 1)

#### Codex — APPROVE
- No concerns raised (APPROVE).

#### Claude — APPROVE
- **Concern**: `checkRemoteSender` checks the remote sender's slug and owner email only as non-empty, and the inbox prints them without `printable()`, unlike the record view (defence in depth). → **Addressed**: no rebuttals file; per the thread entry (02c759827), fixed in place in phase 12's commit d0b528084: the slug and owner are checked against the statement rules when stored and when read.
- **Concern**: `/api/inbox` now lists held-for-release rows that `heldCount` excludes, breaking the #1450 "Held group length equals badge count" invariant; phase 12's Playwright run should assert the grouping. → **N/A**: carried into phase 12 per the thread; phase 12's three-count indicator and its Playwright suite assert each popover group as long as its count (d0b528084).
- **Concern**: Nit: `logEntryView` and `outboxMessageView` do bounded per-row (N+1) lookups on CLI paths. → **Addressed**: fixed in place in d0b528084: queue heads read once and the log's sent messages in one query.
- **Concern**: The full `afx status` command is proven only in layer A; worth one manual run at phase 13's walkthrough. → **N/A**: tried in phase 13, but a harness Tower leaves temp-directory workspaces out (`isTempDirectory`), so the architect put the full command on the verify-approval list for a real Tower (thread, review document).

### Phase 12: Dashboard: Peers panel and three-count indicator (Round 1)

#### Codex — REQUEST_CHANGES
- **Concern**: `peersDirs()` trusts pre-existing `CODEV_PEERS_E2E_*` values and `removePeersDirs()` deletes them recursively, so caller-supplied temp directories could be erased; needs verifiable ownership and a test that caller directories are kept. → **Addressed**: the main process makes one `codev-peers-e2e-*` run folder with an exclusive-create `.owner` marker (pid and nonce), reused only by the maker or its child with the marker matching and removed only by the maker; new tests and real runs keep a caller's folder (15324e344).

#### Claude — COMMENT
- **Concern**: No workflow runs `playwright.peers.config.ts`, so the #1313/#1450 held-count suite drops out of nightly CI. → **Addressed**: a step in `dashboard-e2e.yml` on port 14102, after the Decisions step, same guard, `--retries 3` (15324e344).
- **Concern**: `countWaitingForPeer` reads every held payload BLOB just to count, on every `/api/overview`. → **Addressed**: now a payload-free `GROUP BY` count (`countHeldOutboxBySender`), tested to agree with the list (15324e344).
- **Concern**: The one unmocked Playwright case covers "no cloud at all", not the plan's "a cloud with no relay". → **N/A**: a throwaway Tower has no cloud registration and the harness stays off the real cloud, so this needs a fake cloud, beyond this phase's plan; flagged to the architect as reading 4, with `relay: none` covered by the mocked case.
- **Concern**: Nits: `mark.run` interpolated unescaped; "no controls" asserted only in the via-cloud case. → **Addressed**: `escapeHtml(String(mark.run))`, `peerTime` no longer throws on a non-number, and the local case asserts no controls (15324e344).
- **Concern**: Nit: temp directories leak if a run dies before `globalTeardown`. → **Rebutted**: nothing else can prove the folder is that run's, which is the point of Codex's fix; the config's doc says so.

### Phase 12: Dashboard: Peers panel and three-count indicator (Round 2)

#### Codex — REQUEST_CHANGES
- **Concern**: `peersDirs()` reuses a run recorded under `proc.ppid` with a matching marker; a caller can mark a folder under their shell's pid (the Playwright main process's parent) and have it adopted; the test misses a valid parent-pid marker. → **Addressed**: the parent-pid path is open only to a real Playwright worker (IPC channel plus `TEST_WORKER_INDEX`); the main process reuses only a run under its own pid; tests for this exact case (3f0ed1359).

#### Claude — APPROVE
- **Concern**: `refreshPeers()` has no in-flight or generation guard, so a slow older answer can overwrite a newer list. → **Addressed**: requests are numbered and only the latest renders; a new Playwright case fails without the guard (3f0ed1359).
- **Concern**: The Peers section renders on every Tower home page, even one never connected to Codev Cloud. → **N/A**: not changed; the architect's call, raised to them at the phase boundary. The architect later ruled it hidden on an unregistered Tower with the switch off (7dc60fd54, phase 13).
- **Concern**: `peerModeText` labels any unknown grant mode "deliver". → **Addressed**: an unknown mode is shown as itself, escaped, with a hostile-text case (3f0ed1359).

### Phase 12: Dashboard: Peers panel and three-count indicator (Round 3)

#### Codex — REQUEST_CHANGES
- **Concern**: `peersDirs()` trusts a valid marker whose `ownerPid` is the current pid; a caller can mark a folder with their shell's pid and `exec` Playwright, keeping the pid, so the folder is adopted and deleted; needs process-local provenance. → **Addressed**: the main process keeps the run it made in memory (`globalThis` under a registered symbol), reuses and removes only that run, ignores inherited values even with its own pid, and the teardown throws on a run it holds no record of; tests plus a real exec-caller run (a38f0f2b0).

#### Claude — APPROVE
- **Concern**: `escapeHtml(tower.name)` and `escapeHtml(g.recipient)` lack the `String(...)` coercion used elsewhere in the panel. → **Addressed**: the panel's calls now coerce with `String(...)` (a38f0f2b0).
- **Concern**: Observations: `held-group--release`/`--peer` have no CSS rules (reviewer: no action needed); the Peers-section question stays with the architect. → **N/A**: not raised as concerns; the rebuttal treats the escaping nit as the round's only one, and the Peers-section question was later ruled by the architect (7dc60fd54).

- **After round 3**: Porch force-advanced the phase at the 3-iteration ceiling, so the fix `a38f0f2b0` (the main process owns its run by an in-memory record; the teardown refuses a run it holds no record of) had no consult round; the architect read it, checked that `removePeersDirs` removes only a direct child of the temp directory with the run prefix, and found nothing to change, with no consult round before phase 13 (main, 2026-11-27T12:54Z).

### Phase 13: Docs in both trees, the walkthrough end to end, and Windows (Round 1)

#### Codex — APPROVE
- No concerns raised (APPROVE).

#### Claude — APPROVE
- **Concern**: The review document's Gap 11 contradicts its own verify-approval list. → **Addressed**: Gap 11 now says the cloud half is on that list (4fc7b20ef).
- **Concern**: Gap 1, the spec's C4 criterion "a fresh send refused for rate exits non-zero", is one more `it.each` row. → **Addressed**: peer and cloud `rate-limited` rows in `peer-send-cli.test.ts` (21/21), and gap 1 marked closed (4fc7b20ef).
- **Concern**: Gap 2, the builder-footer reply round trip, is covered end to end only for its refusal half. → **Addressed** (review phase): closed in layer A by the architect's ruling, not with a new layer B case: a table-driven test hands each builder footer row's command, as printed, to the real sender as the builder (de2263971); the real-cloud round trip is on the verify-approval list.
- **Concern**: The phase 10 "running workspaces only" ruling for `afx peer show` is in the review but in no doc. → **Addressed**: the `afx peer show` row in `agent-farm.md`, both trees, says only running workspaces are listed and what `not live` means (4fc7b20ef).
- **Concern**: The template-pair "empty diff" criterion was adapted (two by-design hunks kept) and needs the architect's confirmation. → **N/A**: the architect already confirmed that reading (2026-11-27T13:35Z), recorded in the thread.
- **Concern**: Nits: redundant Windows `vi.setConfig({ testTimeout })` beside per-test `TEST_TIMEOUT`; the held line prints the full UUID where the spec shows `7c1e52aa`. → **Rebutted**: the two timeouts cover different tests (those with no timeout, and four that need one on POSIX too); the spec's id is illustrative and the walkthrough asserts the full id printed.

### Review (Round 1)

The PR-level consultation, on PR #2007. Responses are in `1967-review-iter1-rebuttals.md`; the code
changes are in `a2f660715`.

#### Codex — COMMENT
- **Concern**: Phase 13's criterion that each `CLAUDE.md`/`AGENTS.md` template pair be byte-identical was adapted, not met as written. → **Addressed**: Deviations (phase 13) now says so and records the architect's confirmation of the reading (2026-11-27T13:35Z).
- **Concern**: The review's Layer A count predates the review phase's gap 2 test. → **Addressed**: the build and porch's test command were run again on `a2f660715`; the runs section records the result.
- **Concern**: `PeerAcceptedRow` declares `mailboxId` twice in `peer/store.ts`. → **Rebutted**: it declares it once (`store.ts:720`); the other (`store.ts:774`) is in `AcceptedInsert`, a separate interface.

#### Claude — APPROVE
- **Concern**: `outbox.ts`'s `errorKind()` logged `err.message`, where every sibling logs the class for the no-secrets-in-logs rule. → **Addressed**: it returns `err.constructor.name` (`a2f660715`).
- **Concern**: Gap 7 (a payload claiming a different sending Tower) is one table row from closed. → **Addressed**: named cases in `peer-receiver.test.ts` (refused `malformed`, nothing stored) and `peer-contract.test.ts` (`from` naming a Tower or an owner) (`a2f660715`).
- **Concern**: The no-break-space marker residual should be carried into stage 3, which admits other owners' Towers. → **Addressed** (documented): in Follow-up Items, and raised with the architect; the rule stays as Decision 7 states it.
- **Concern**: `readRelayRequestHeaders` has no production caller. → **Addressed**: its doc comment says it is the cloud's step 2, never called by Tower code, kept so the contract's tests pin it (`a2f660715`).
- **Concern**: `held-group--release` and `held-group--peer` have no CSS rules. → **N/A**, checked: `held-count-three-groups.png` shows each group distinct by its heading and count, the for-release group with its own line naming the human action; the existing `held-group--scheduled` has no rule either.

## Lessons Learned

### What Went Well

- **A contract first, then a stand-in that speaks it.** The wire contract, its shared vectors and a
  stand-in relay built from the contract's shapes alone let the Tower half be finished and tested
  before the cloud half existed. The cloud architect reproduced the worked vector on their side,
  and a structural test keeps the stand-in from importing the production peer code it tests.
- **Layers kept porch's check fast without leaving the real paths untested.** Layer A (about 242 s,
  inside porch's tests check) runs the receiver in process on temporary databases with injected
  clocks. Layer B runs two built Towers against the stand-in over loopback, on demand, in about a
  minute. Layer C runs the browser suites in an isolated config, and layer D is the Windows
  workflow.
- **A seeded property test with no new dependency.** The frame invariant holds for 600 generated
  statements and payloads (seed 1967), so a failure reproduces exactly from its printed case.
- **The scenario-to-test table paid for itself.** Written at phase 13, it named 11 partial gaps with
  what was searched. Three are closed: the rate refusal's exit code and the builder footer's reply
  round trip before the PR, and a payload claiming another sending Tower after its review.
- **An additive migration.** v21 adds columns and tables only, so held mail is never copied or
  rebuilt on upgrade.

### Challenges Encountered

- **Four phases reached porch's three-iteration ceiling** (5, 7, 9, 12). Each last-round point was
  right, and its fix got no consult review. The architect read the diff and ran the tests for
  each, and the force-advance section below records that.
- **Windows, twice.** In phase 5, another spec's suite left `global.db` open once `auth` read the
  switch, which failed teardown with `EBUSY`. In phase 13, two of this spec's files failed on their
  first Windows run: a fixture written with a POSIX-literal workspace path (the #1940 fixture
  lesson again), and a pipeline test past its time limit. The second was measured before the limit
  was raised: SQLite commits waiting on a disk sync, on test databases with a rollback journal.
- **Harness isolation.** Two two-Tower files in one vitest call took the same fixed ports and
  talked to each other's Towers; ports now come from the OS and a Tower must prove it is its own
  process. Tower leaves temp-directory workspaces out of what it reports, so the full `afx status`
  cannot run on a harness Tower and waits for a real one.
- **Mocks with an explicit list of real functions.** Five test files mock `tower-messages.js` that
  way, so a new import from it broke them; the receiver's reverse lookup lives elsewhere instead.
- **A merge of `origin/main` with four conflicts** (#1977 and #1992), each kept from both sides,
  plus the send CLI test's fake Tower learning `/health/live`.

### What Would Be Done Differently

- **Check CI on the head before announcing a gate.** The `pr` gate was announced while CI was red and unseen: the Unit
  Tests job had failed at its `/tmp` residue check on every push since the PR opened, so the unit tests had never run
  on Linux. The check is `gh pr checks` on the head before the announcement.
- **Run the earlier stage's e2e file once a phase changes what it pins.** Porch skips `e2e_tests` in this repository,
  and the on-demand layer B runs covered only this project's seven two-Tower files, so the whole e2e suite first ran
  against this branch in CI. There, stage 1's `cross-workspace-addressing.e2e.test.ts` still expected stage 1's
  "not available in this version" refusal. It should have been in the on-demand runs once phase 9 changed what an
  `afx://` address does.
- **Write the scenario-to-test table with the plan, and keep it per phase.** The builder footer's
  two halves were built and tested in phases 6 and 8, and the missing round trip between them was
  found only at the end.
- **Split the phases that carried the most.** Phase 9 (the CLI, the SDK, the route, the wiring and
  the end-to-end file) and phase 12 (the panel, the indicator and a new isolated browser config)
  each reached the ceiling with real findings in the last round.
- **Run the Windows workflow on each new test file early,** not first at the end: both phase 13
  failures were new files on their first Windows run.

### Methodology Improvements

- **Porch: review a force-advanced fix.** When porch force-advances at the ceiling, the next phase
  could open with a single-model consult of the last fix, or require a recorded architect read of
  it, instead of relying on the review document to say who looked.
- **Plan template: a scenario-to-test column.** Each Test Scenario named against the phase and file
  that will cover it, checked at each phase's review, so a gap is found in the phase that leaves it.
- **Porch: record on-demand layers.** A named, non-blocking check for each on-demand layer (here B
  and C) would record its last run against the commit in `status.yaml`, rather than in the thread
  and the review only.

## Architecture Updates

- Routed: cold — `codev/resources/arch.md` gains section 10, "Cross-Tower Messaging Through Codev
  Cloud (Spec 1967)": the module map under `agent-farm/peer/`, the one module that speaks the wire,
  provenance, the receiver's steps, the sender and outbox, the peer list, the switch and grants,
  storage (migration v21), records, surfaces and the test layers (phase 13, `f9d21e1d5`).
- Routed: cold — `arch.md`'s glossary gains **Peer** and **Grant**, and its stage 1 note no longer
  says every Tower address is refused (`CROSS_TOWER_UNAVAILABLE` no longer exists in production
  code).
- Hot: no change. `arch-critical.md` is at its cap of ten facts, and its mailbox-first fact (every
  message writer routes through the mailbox and gate) already covers remote mail, which is stored
  and delivered that way.

## Lessons Learned Updates

- Routed: cold — Testing — a command printed for an agent to run is tested as a round trip, taken
  from the real producer's output as printed and handed to the real consumer as that agent
  (companion to #1940's resolver lesson).
- Routed: cold — Testing — on the Windows runner, measure SQLite commit cost before raising a time
  limit, and raise it for Windows only with the cause in the comment.
- Routed: cold — Architecture — build one half of a two-repository feature against a written wire
  contract, shared test vectors and a stand-in that imports no production code.
- Not added: the force-advance lesson and the Windows fixture-path lesson are already in
  `lessons-learned.md` (from 1951 and #1940); this project repeated them.
- Hot: no change. `lessons-critical.md` is at its cap, and none of these outranks a hot lesson.

## Flaky Tests

No flaky tests encountered. Both red Windows runs had a cause found and fixed in the branch (see
Challenges); neither was intermittent.

## Follow-up Items

- **The real-cloud run at verify-approval**, the list under Spec Compliance, once codev-cloud #22
  ships.
- **The gaps still open** (Gaps 3 to 6 and 8 to 11 under Spec Compliance): each is a named part of a scenario
  with no direct test, though every scenario has some covering test.
- **Issue #2006** (apps/web on Node 26 needs `NODE_OPTIONS=--no-experimental-webstorage`): seen
  here, not changed in this PR.
- **Issue #1870** (the status route's symlink observation): already filed, not changed here.
- **Stage 3** (another owner's Towers) is the design's next stage, not this issue.
- **The no-break-space marker line, for stage 3.** Decision 7 leaves a body line led by U+00A0
  and then `###` unescaped (Known residuals). In stage 2 only the owner's own Towers can send, but
  stage 3 admits other owners'. The stage 3 design should decide whether to widen the rule (the
  claude review of the PR; raised with the architect).
