# Specification: Tower-to-Tower messaging, stage 2 — the Tower half

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
Keep implementation phases, file paths, code, and "first we will… then we will…"
out of the spec — those belong in codev/plans/<id>-*.md.
-->

Issue: #1967. **The design is already approved**: `codev/specs/1940-tower-to-tower-messaging-proto.md`
(issue #1940) designs all three stages, and this project builds stage 2 of it. This spec does not
re-decide that design. It does four things:

1. states the boundary of this project (the Tower half; the cloud half is in another repository);
2. sorts every stage 2 acceptance criterion into what can be verified here, with a stand-in relay,
   and what waits for the real Codev Cloud;
3. proposes the **concrete wire contract** between Tower and Codev Cloud, in a section written to be
   read on its own by the cloud's architect;
4. lists, under its own heading, every place where this spec changes, corrects or fills a gap in
   the approved spec, so the owner sees each difference at the gate.

Where this spec is silent, the approved spec governs. References to "Decision N" are to the
approved spec.

## Problem Statement

An agent on one of my Towers cannot message an agent on another of my Towers (the approved spec's
problem 2). Stage 1 made the address `afx://<tower>/<workspace>:<agent>` parse and refuses it with
"cross-Tower messaging is not available". Stage 2 makes it work between two Towers on one Codev
Cloud account, both behind NAT, through Codev Cloud as the relay, with the security model of
Decisions 3 to 5: default deny, grants held by the receiving Tower, an attested statement of the
sending Tower verified by MAC, hold at the sender when the route is down, accepted exactly once.

The work spans two repositories with two architects. Both halves are built at once (owner ruling,
decision main-53), so they must be built and tested against one written contract before either
can be run against the other.

## Current State

What exists on `main` and in Codev Cloud today, read in the source for this spec.

- **Stage 1 is merged.** One structured address (`AgentAddress` in `codev-types`, with `owner` and
  `tower` fields already present), one parser and formatter in the SDK, the builder rule, workspace
  address names, `afx workspace list`, `afx whoami`, and the qualified cross-workspace header and
  reply footer. Every `afx://` address is refused with `CROSS_TOWER_UNAVAILABLE`, by the CLI and by
  Tower, including from cron targets, `afx interrupt` and `afx refresh`.
- **The tunnel.** Tower opens a WebSocket to the cloud's `/tunnel`, sends
  `{type:'auth', apiKey}`, and receives `{type:'auth_ok', towerId, slug, name}` (the cloud has
  sent `slug` and `name` since its PR #18; Tower reads only `towerId`). Tower then runs an HTTP/2
  server over the socket; only the cloud opens requests on it. Tower's tunnel client runs inside
  the Tower process, answers `GET /__tower/metadata` itself, refuses a short blocklist, and proxies
  every other request to Tower's own local listener stamped with the real local key and the marker
  header `x-codev-tunnel-proxy`. Requests from the cloud's `/t/<slug>/` browser proxy arrive on the
  same session, with the browser's own headers, for any path.
- **Tower to cloud over HTTPS.** The only cloud route that accepts a Tower key (`ctk_`) is
  `DELETE /api/towers/:id`. Tower's periodic `POST /api/tower/metadata` gets a 404: the route does
  not exist (issue #1986). The cloud pulls metadata over the tunnel when its dashboard asks.
- **Codev Cloud.** Tower slugs are unique across the whole cloud (`tower_slug_unique`). There is no
  relay, no peer listing, no session secret and no rate limit beyond the `/t/` proxy's. "Online"
  means a live session in the one cloud process's memory; a peer that vanishes without closing
  looks online for up to about 135 seconds. Every cloud deploy drops every tunnel. Renaming a
  Tower in the cloud does not reconnect it. Key rotation does not close the old key's tunnel.
- **Issue #1871** (Tower persists the cloud's canonical slug as its name) is being built now, by
  builder `bugfix-1871`. Until it lands, Tower's stored `tower_name` is the name the user typed,
  which can differ from the slug.
- **The mailbox** (`global.db`) holds every local send. Its `status` and `reason` columns carry
  `CHECK` constraints listing today's values (`held`/`delivered`/`superseded`/`dismissed`;
  `busy`/`no-profile`/`no-live-pty`). SQLite cannot alter a `CHECK` in place, so any new status or
  hold reason on that table needs a table rebuild on upgraded installs.

## Desired State

The stage 2 walkthrough in the approved spec (after Decision 9) works as written: four human
commands set up a pair of Towers, `afx send afx://devvm/codev:architect:local "…"` is delivered
under a `REMOTE, your Tower` header with a reply command that works, and a message to a Tower that
is asleep waits on the sending Tower and arrives once when it wakes. Everything listed for stage 2
in the approved spec's **Staging** table is built on the Tower side: the `afx://tower/` form,
peers, grants, hold for release and `afx inbox release`, the receiving entry point, remote
headers, sender-side hold, accepted-once, discovery, rate limits, records, the switch, and the
`afx peer` commands of Decision 9 marked stage 2. So is the rest of Decision 9's stage 2 surface:
`afx inbox` in three groups, `afx inbox show` with the remote sender's full address, `afx inbox
dismiss` for the new kinds of held mail, the remote-messaging line in `afx status`, the Tower's name
and switch in `afx tower status`, the read-only Peers panel on the dashboard's Tower home page, and
the held-mail indicator's three counts. The Peers panel is a human's only read-only view of the
feature, so it is in scope, not deferred. (Its stage 3 parts, the invitation link and other owners'
Towers, are not.)

**The boundary of this project.**

| | In this project (codev, issue #1967) | Not in this project |
|---|---|---|
| Tower | Everything above, both as sender and as receiver; the stand-in relay used by its tests; docs, skills and role files in both trees | — |
| Codev Cloud | Nothing. The cloud half is codev-cloud issue #22, built by that repository's architect | The relay, the session secret and statement, the peer listing, the switch-state route, cloud rate limits and record, keeping `/t/` apart from the relay, per-account slugs |
| Canonical name | Consumes it | Issue #1871 (builder `bugfix-1871`) persists it |
| Stage 3 | Nothing beyond refusing `afx://owner@tower/…` as not yet available, as stage 1 does | Issue #1968 |

Until the cloud ships its half, a Tower running this code is inert for cross-Tower traffic: the
switch is off by default, a fresh or upgraded Tower holds no grants, and a cloud with no relay is
reported as such ("this Codev Cloud has no relay") on any `afx://` send and in `afx peer list`.

## Success Criteria

Each stage 2 criterion from the approved spec, inherited as written, is sorted by where it can be
verified:

- **Here**: fully verified in this repository, with two test Towers (each on its own port and
  database) and a stand-in relay that speaks the wire contract below.
- **Cloud**: needs the real Codev Cloud. Verified once codev-cloud issue #22 ships, by a human-run
  check through the real cloud (Open Question 1 asks when that happens).
- **Split**: the Tower's share is verified here; the cloud's share waits.

| # | Criterion (the approved spec's wording, abridged only where noted) | Where | What is verified here |
|---|---|---|---|
| 1 | The headline path works between two Towers on one account, both behind NAT; the stage 2 walkthrough can be followed as written | Split | Every step and every row of the skipped-step table, with the stand-in relay. Behind NAT, through the real cloud: Cloud |
| 2 | With remote messaging off, a Tower refuses an `afx://` send to another Tower before anything leaves the machine, and says how a human turns it on | Here | The stand-in records that no call was made |
| 3 | A Tower's name is unique within its owner's account only; the name I give a Tower is not affected by other accounts; an address for one of my own Towers never contains an owner | Split | No address, header, listing or reply command for one of my own Towers contains an owner; `afx://owner@…` is refused as not yet available. Per-account uniqueness is codev-cloud #22 item 8: Cloud |
| 4 | A Tower accepts no remote message until its owner has granted a peer; a fresh install, and an upgraded one, refuse everything | Here | |
| 5 | The sender is told `delivered`, `held` with where and why, or `refused` with the reason; a refusal exits non-zero and leaves nothing on the receiving Tower | Here | "Nothing" means no mailbox row and no accepted-once record; the audit record is kept (Departures, G6) |
| 6 | A message for a Tower that is offline, or sent while the cloud is unreachable, is held on the sending Tower, visible in `afx inbox`, accepted exactly once when the route returns within the 30-day lifetime, then shown as expired | Here | Offline, no answer, cloud unreachable, a lost answer, a simulated cloud deploy, and lifetime by an injected clock |
| 7 | Mail held on the sending Tower is a distinct kind of held mail: the local drainer never types it, it never raises the starved-agent escalation, and `afx inbox` and the held-mail indicator show it apart | Here | |
| 8 | Messages from one Tower to one recipient arrive in the order sent, including when several agents send at once: one relay call at a time per peer | Here | The stand-in records the number of **message** relay calls in flight per peer, which never exceeds one. Discovery queries are not serialised with messages (contract, section 4) |
| 9 | The recipient's header marks the message as remote and names the sending Tower and the sender's full address; the reply command works | Split | With the stand-in. Through the real cloud: Cloud |
| 10 | The sending Tower's identity shown to the recipient comes from Codev Cloud's authentication of that Tower, carried in the attested statement; no field of the message can change it | Split | The receiving Tower takes it only from a verified statement; a payload claiming another Tower changes nothing. That the cloud builds the statement only from its own records: Cloud |
| 11 | A relayed request is accepted only with a statement whose MAC verifies under the current tunnel session's secret; a request from this machine holding the local key, one through the `/t/` proxy with any headers, a replayed statement, and one from an earlier tunnel session are each refused, and nothing is stored | Split | All four, at the Tower: the local caller; a request down the tunnel with arbitrary headers and no valid MAC, as the `/t/` proxy could send; a replay; an earlier session's secret. That the cloud strips the headers and refuses the path on `/t/`: Cloud |
| 12 | A send to a peer that does not speak the protocol, or through a cloud without the relay, is refused with that reason and not held | Split | The Tower's reaction to the contract's `peer-unsupported` answer and to a cloud with no relay (old handshake, 404 on the routes). That the real cloud reports an old Tower: Cloud |
| 13 | `--raw`, `--interrupt` and `--no-enter` are refused for a remote recipient, and control characters in a remote body never reach a terminal | Here | Also `--delay` (Decision 5) |
| 14 | From one Tower I can list my other Towers, and for one I have been granted, its workspaces and agents | Split | With the stand-in's listing and discovery. Against the real listing: Cloud |
| 15 | Removing a grant refuses further mail from that peer immediately, and stops automatic delivery of mail from it that was accepted but not yet delivered | Here | |
| 16 | Flooding is bounded at the cloud and again at the receiving Tower | Split | The receiving Tower's limits, and the sending Tower's cap on mail waiting for a peer. The cloud's limits: Cloud |
| 17 | Both Towers keep a record of every cross-Tower attempt and its outcome, without bodies in logs | Here | Each Tower records what it can see: the sender every outbound attempt; the receiver every request that reaches it, with the sender recorded as unverified until the MAC has verified (contract, section 8). With the aggregation rule for floods (Departures, C5) |

**Criteria this project adds for its own half.**

- [ ] The stand-in relay implements the wire contract below exactly, and the Tower is tested only
      against it. No test sends through the real cloud or touches the live Tower on port 4100.
- [ ] The contract's MAC and hash are pinned by test vectors committed in this repository in a
      form the cloud can run unchanged (secret, statement bytes, expected MAC, payload bytes,
      expected hash, expected verdict).
- [ ] Remote messaging is off on a fresh install and on an upgraded one, and no grant exists on
      either.
- [ ] A Tower takes a session secret only from a tunnel over TLS (`wss:`), and makes its relay,
      listing and switch-state calls only over HTTPS. The one exception is a cloud on a loopback
      address, which is what tests use. Against any other plain-HTTP cloud it reports no relay and
      refuses every `afx://` send to another Tower with that reason.
- [ ] The builder rule holds for remote addresses. A builder's send to
      `afx://<tower>/<workspace>:architect:<name>` is refused by its own Tower unless that is its
      own spawning architect; it reaches `afx://<tower>/<workspace>:architect` (the front door)
      under a grant; and each of Decision 7's footer rows for a builder messaged from another of my
      Towers prints a command the builder's own send accepts.
- [ ] Builders are addressable across my own Towers under a grant that covers them: a message to
      `afx://<tower>/<workspace>:<builder-id>` is delivered, and discovery under such a grant lists
      builders by id.
- [ ] Nothing in a statement or payload can forge a frame. For arbitrary values of every statement
      and payload field, either the request is refused before anything is stored, or the frame the
      receiving Tower writes consists of a header and footer built only from values that passed
      their validation rules (contract, section 5), and a body satisfying Decision 7's invariant.
- [ ] Every remote message is persisted to the receiving Tower's mailbox first and delivered only
      through the render gate, under the per-agent then per-terminal locks, in that order. No
      remote body reaches a terminal without the normalisation of Decision 7.
- [ ] The session secret is held in memory only: never written to `global.db`, `cloud-config.json`
      or any file, and never logged. Statements, MACs and bodies are never logged.
- [ ] Two items left by stage 1 for stage 2 are built and tested: the hint "write
      `afx://devvm/codev:architect`" when the first of two components before `architect` is one of
      my Towers; and an `afx://` address naming a workspace by its new explicit name resolves once a
      workspace whose basename is `arch`, `builder` or contains a space has been given one.
- [ ] An `afx://` address typed unquoted in Git Bash, PowerShell and cmd arrives unchanged (the
      on-demand Windows workflow, run on the branch and linked from the PR).
- [ ] The docs, skills and role files that teach addressing, peers and the inbox are updated in
      both `codev/` and `codev-skeleton/`, including the role guidance of Decision 7 that only the
      Tower part of a remote address is verified.

## Constraints

- **The approved spec is the design.** The issue has no Baked Decisions section; the approved spec
  plays that role. Its stage 2 decisions are not re-decided here. Where this spec departs from it,
  the departure is listed under its own heading below, for the owner to accept or reject.
- **Safety, fixed by the architect.**
  - Remote messaging is off by default. A fresh or upgraded Tower refuses every remote message.
  - Tests never send through the real Codev Cloud and never touch the live Tower on port 4100. They
    use test Towers on their own ports and databases, as
    `packages/codev/src/agent-farm/__tests__/cross-workspace-addressing.e2e.test.ts` does, and a
    stand-in relay written for this project.
  - Every new message writer goes through the mailbox and the render gate and takes the
    per-terminal lock; lock order is per-agent, then per-terminal. Remote bodies never reach a PTY
    raw.
  - Secrets stay in memory and out of logs.
- **Mailbox-first and fail-fast** (approved spec, Constraints) apply unchanged.
- **Tests and load.** At most 3 test workers; porch's tests check has 15 minutes; full local runs
  only at a one-minute load average of 20 or less. A failure is reported to the architect, never
  rerun or skipped silently.
- **Platform code** (the tunnel client, CLI argument handling) gets the on-demand Windows workflow.
- **Server/client isolation** (issue #1189): wire types live in `codev-types`.
- **Both trees** for every framework file that teaches addressing.
- **No `Co-Authored-By` trailers.**
- **The mailbox's `CHECK` constraints** (Current State) bound how new held states can be stored. The
  plan chooses among a table rebuild, separate tables, and the precedent migration v18 set for
  `detail`: a column with no `CHECK`, its values enforced in TypeScript, so a fresh install and an
  upgraded one cannot diverge.
- **UI changes** (the Peers panel, the held-mail indicator) are verified in a browser with
  Playwright before they are called done (`codev/resources/testing-guide.md`).

## Assumptions

- Issue #1871 lands before this project's end-to-end phase, so a Tower knows its own canonical name.
  The contract below also gives the sending Tower its current name in every peer listing, so a
  rename made in the cloud reaches it without waiting for a reconnect.
- The cloud's architect agrees the wire contract below, or corrects it, before the Tower code that
  speaks it is finished. Until then that code is kept to one module and the test vectors, so a
  correction is a local change.
- Codev Cloud ships codev-cloud issue #22. Stage 2 messaging works before per-account slugs (item 8)
  ship, because slugs are globally unique today; criterion 3's cloud share waits for item 8.
- Shells pass an argument containing `://` through unchanged (confirmed by the Windows run).
- Local trust is unchanged: any process holding the local Tower key acts as the owner (Decision 4).

## Solution Approaches

The design is fixed. Two choices remain open for this half, and both shape the contract.

### Approach 1: where the receiving entry point lives

**A. In the tunnel client, on one exact path that exists only on the tunnel** (recommended).
Tower's tunnel client already answers `/__tower/metadata` itself without proxying it. It answers
`POST /__tower/peer` the same way: it verifies the statement with the secret of the session the
request arrived on, then hands the verified message to Tower's delivery code inside the process.
The path never reaches Tower's local HTTP listener, so a local caller holding the key has no route
to call at all, and the session secret never leaves the object that owns the session.

- For: two barriers instead of one (the approved spec's table in Decision 3 lists "keep the entry
  point off the local listener" and the MAC separately); the secret is naturally bound to its
  session; a request from an earlier session cannot be checked against the wrong secret.
- Against: the tunnel client gains an in-process dependency on delivery code it does not have
  today.

**B. A route on Tower's local listener, guarded by the MAC alone.** Simpler wiring, but the route
is reachable by every local caller and the secret has to be shared out of the tunnel client.

### Approach 2: how the Tower half is proven before the cloud exists

**A. A stand-in relay that speaks the contract, plus shared test vectors** (recommended; required
by the architect). The stand-in plays the cloud for two test Towers: the `/tunnel` handshake with a
session secret, the relay, the listing, the switch-state route, and failure modes on demand
(offline, no answer, deploy, old cloud, rate limits, a forged or replayed request). The vectors let
the cloud test its MAC and hash against the same bytes.

**B. Run Codev Cloud locally.** Needs its database and code from another repository with its own
architect, and does not exist yet. Rejected.

**C. Wait for the cloud's staging deployment.** Blocks this project on the other, and tests must not
send through a real cloud. Rejected for tests; it is where the human-run real-cloud check happens
(Open Question 1).

Where sender-held mail and grants are stored, and how the per-peer queue is built, are the plan's.

## Wire Contract (proposed to Codev Cloud)

*This section is written to be read on its own by the Codev Cloud architect, and is the Tower
half's proposal for codev-cloud issue #22. It incorporates the cloud architect's answers on that
issue (comment 7174155361); each is marked with its letter (a) to (h). Where it and the approved
spec differ, the difference is also listed under "Departures from the Approved Spec".*

### Parties and principles

- **S**, the sending Tower; **C**, Codev Cloud; **R**, the receiving Tower. S and R are Towers of
  one account in stage 2.
- S → C is an HTTPS call authenticated with S's Tower key. C → R travels down R's existing tunnel.
  No Tower opens a listening port.
- **C forwards the payload bytes untouched and never parses them** (a). Everything C needs to
  route, state and record a request travels outside the payload.
- **The statement is exact bytes, and the MAC is over those bytes** (b). Neither side ever builds a
  canonical JSON form. R verifies the MAC over the bytes it received, then parses them.
- All JSON is UTF-8. Every base64url value is RFC 4648 §5 with no padding. Times are integer epoch
  milliseconds. Hashes are lowercase hex.
- **Every header this protocol adds starts with `x-codev-peer-`** (g), so C strips them from `/t/`
  requests by prefix.
- Receivers ignore fields they do not know, everywhere in this contract. A change of meaning raises
  the protocol version.
- **TLS on both legs.** A Tower accepts a session secret only on a `wss:` tunnel and makes the
  calls in sections 2 to 4 only over `https:`. The single exception is a cloud whose host is a
  loopback address (tests). A Tower configured with any other `http:` cloud treats it as having no
  relay. (Today a Tower turns an `http:` server URL into a `ws:` tunnel; without this rule the
  secret, and with it the power to mint statements, would cross the network in cleartext.)

### Protocol constants

Fixed by protocol version 1, known to every party without asking, and not settings anywhere. A
later version may change them.

| Constant | Value | Meaning |
|---|---|---|
| Message text | 49 152 bytes (48 KiB) as UTF-8 | The longest `body`, checked by S and R |
| Forwarded payload | 102 400 bytes | The longest payload S sends, C accepts and R reads (d) |
| Statement header | 4 096 bytes | The longest encoded `x-codev-peer-statement` |
| Answer | 65 536 bytes | The longest answer R gives and C passes back (d) |
| Relay timeout | 15 000 ms | How long C waits for R's complete answer (e) |
| Receiver's answer time | 5 000 ms | How soon R answers once it has the body |
| Sender's call timeout | 20 000 ms | How long S waits for C's answer |
| Freshness | ±5 minutes | How far `issuedAt` may be from R's clock |
| Statement-id memory | 10 minutes | How long R remembers a used statement id |
| Lifetime | 30 days from `sentAt` | After this a message is expired at S and refused by R |

### Protocol version

This contract is protocol version **1**. The version appears in: the `auth` message
(`peer.protocols`), `auth_ok` (`relay.protocols`), the peer listing (`relay.protocols`, and each
Tower's `protocols`), the relay call (`x-codev-peer-version`), the statement (`v`) and every answer
(`v`).

- C forwards a request in version v only to a Tower whose live session stated v. Otherwise it
  answers `peer-unsupported` (below), and S refuses the send without holding it.
- R refuses a verified statement whose `v` it does not speak, with `unsupported-version` and the
  list it does speak.
- Mixed versions: a Tower that predates this contract sends no `peer` field, so C never forwards
  to it. A cloud that predates it sends no `relay` field and has no `/api/peer/…` routes, so a Tower
  reports "this Codev Cloud has no relay" and refuses every send to another Tower.

### 1. Tunnel handshake (c)

Tower → C, the first WebSocket message, gains one optional field:

```json
{ "type": "auth", "apiKey": "ctk_…",
  "peer": { "protocols": [1], "remoteMessaging": "off" } }
```

- `peer` absent means the Tower does not speak the protocol. C records the stated protocols and
  switch state against the session, and may also keep the last stated values on the Tower's row so
  they are known while it is offline.
- `remoteMessaging` is `"on"` or `"off"`. C uses it only to show in the peer listing; R's own check
  is the one that counts.

C → Tower, `auth_ok`, gains one field:

```json
{ "type": "auth_ok", "towerId": "01J…", "slug": "devvm", "name": "devvm",
  "relay": { "protocols": [1], "sessionSecret": "<base64url of 32 random bytes>" } }
```

- `relay` is an object when this cloud has a relay, and `null` when it explicitly has none. Absent
  (today's cloud) also means no relay. A Tower does not infer relay support from anything else.
- `sessionSecret` is 32 bytes from a CSPRNG, new for every tunnel connection. Both sides hold it in
  memory only; neither writes it anywhere or logs it. It dies with the session. A Tower ignores it,
  and treats the cloud as having no relay, on a tunnel that is not `wss:` (loopback excepted; see
  the principles).
- C computes every MAC for a request with the secret of the same session whose HTTP/2 connection
  carries that request. (So a genuine request can never be MACed with one session's secret and
  arrive on another.)
- C closes a Tower's session, and so its secret, when the Tower is deregistered **and when its key
  is rotated**. (Today rotation leaves the old key's tunnel up; that has to close.)

### 2. Switch-state report (c)

A change of the switch while the tunnel is up:

```
PUT /api/peer/state
Authorization: Bearer ctk_…
Content-Type: application/json

{ "remoteMessaging": "on" }
```

Answer `204`. On failure the Tower does not retry in a loop: the next `auth` carries the truth.
This is the only Tower-to-cloud report stage 2 adds. Stage 2 does not route anything through
`POST /api/tower/metadata` and does not ask the cloud to build it; it removes that dead push from
Tower (issue #1986; Departures, C14).

### 3. Peer listing

```
GET /api/peer/towers
Authorization: Bearer ctk_…
```

```json
{
  "v": 1,
  "relay": { "protocols": [1] },
  "self": { "towerId": "01J…", "name": "mbp" },
  "limits": {
    "messagesPerTowerPerMinute": 60,
    "messagesPerPairPerMinute": 30,
    "queriesPerPairPerMinute": 10
  },
  "towers": [
    { "towerId": "01J…", "name": "devvm", "online": true,
      "protocols": [1], "remoteMessaging": "on" }
  ]
}
```

- `relay` is `null` when this cloud has no relay. A `404` without this body means the same.
- `self` is the caller's own Tower as C has it now; a Tower takes its current name from here as
  well as from `auth_ok`, so a rename reaches it without a reconnect.
- `towers` lists every other Tower on the caller's account, never Towers of other accounts (stage 3
  adds those as optional fields). `name` is the current slug. `online` means a live session in
  C's memory now; it is soft (e) and the Tower treats it as a hint. It must not come from the
  database's `status` column. `protocols` is what that Tower's live or last session stated (`[]` if
  none or unknown). `remoteMessaging` is `"on"`, `"off"` or `"unknown"`.
- `limits` are C's own rate limits, which C may change; `afx peer limits` shows them. The protocol
  constants above are not repeated here.
- **Call budget.** A Tower calls this on demand (`afx peer list`, `afx peer show`, a send to a name
  it does not know) at most once every 10 seconds, and, while it holds mail for a peer, at most
  once every 30 seconds to learn when the peer is back.

### 4. The relay call: S → C

One route for messages and discovery queries:

```
POST /api/peer/relay
Authorization: Bearer ctk_…
Content-Type: application/json
x-codev-peer-version: 1
x-codev-peer-kind: message            (or: query)
x-codev-peer-to: <R's Tower id>
x-codev-peer-request-id: <message id or query id: a UUID chosen by S>

<payload bytes>
```

- The recipient Tower, the request id, the kind and the version travel in headers, outside the
  payload (a). C needs nothing from the body.
- **C validates the headers** before anything else: `x-codev-peer-request-id` must be a UUID in
  canonical lower-case form (36 characters, `8-4-4-4-12` hex digits), `x-codev-peer-kind` one of
  the two kinds, `x-codev-peer-version` a version C relays. Anything else is refused as
  `malformed` (or `unsupported-version`) without forwarding. R validates them again from the
  statement.
- **The payload is opaque to C** and at most 102 400 bytes (d). C refuses a larger one with
  `too-large` without forwarding it.
- C authenticates S by its key on every call (how it makes that cheap is C's choice), checks that
  `x-codev-peer-to` is another Tower of S's account, applies its limits, builds the statement from
  its own records, forwards once, and returns R's answer. **C never retries a forward and never
  queues one.** One relay call is one forward attempt at most.
- **C waits at most 15 000 ms for R's complete answer** (e). Past that it resets the stream and
  answers `no-answer`.
- S waits at most 20 000 ms for C's answer. S makes **one message relay call at a time per peer**,
  in the order it accepted the sends. A discovery query is not queued behind messages.

**The payload, kind `message`.** Written by S; the envelope that the message id belongs to:

```json
{ "sentAt": 1764100000000,
  "to":   { "workspace": "codev", "kind": "architect", "name": "local" },
  "from": { "workspace": "codev", "kind": "architect", "name": "main" },
  "body": "CI is green on the tunnel branch" }
```

- `sentAt` is S's send time, fixed across retries; the 30-day lifetime runs from it.
- **An address** in `to` and `from` is stage 1's structured address without `tower` or `owner`,
  one of two kinds:
  - `{ "workspace": "codev", "kind": "architect" }`, the workspace's front door, or with
    `"name": "local"`, a named architect;
  - `{ "workspace": "codev", "kind": "id", "name": "builder-spir-1940" }`, a builder by its id
    (`name` required). On R a `kind: "id"` resolves as a local id does today; if it resolves to a
    shell, the answer is `refused`, `not-addressable`, because shells are never reached from
    another Tower.
  - Every component fits stage 1's component rule (lower-case letters, digits, `.`, `_`, `-`,
    starting with a letter or digit), and the address written as text is at most 512 characters
    (stage 1's `MAX_ADDRESS_LENGTH`). Two such addresses and `sentAt` fit in the 4 096-byte
    envelope allowance.
- `to` is the recipient as R would write it locally; `workspace` is required.
- `from` is S's statement of the sending workspace and agent. `workspace` is absent when the
  sending workspace has no address name; `from` is `null` when the sender has no agent identity.
  R frames those cases with no reply address, as stage 1 does.
- `body` is the message text: at most 48 KiB as UTF-8, checked by S and again by R. Before
  serialising, S applies Decision 7's line-ending rule and removes its listed code points (R applies
  the full normalisation again). So every character JSON escapes costs at most two bytes, and any
  48 KiB body fits: 2 × 49 152 + 4 096 for the envelope = 102 400.
- The message id is **not** in the payload. R takes it from the statement (a).
- There is no field for `--raw`, `--interrupt`, `--no-enter` or `--delay`. S refuses them before
  anything is sent.
- **S stores these exact bytes with the message and resends the same bytes on every retry.** R's
  accepted-once check compares the payload hash.

**The payload, kind `query`** (discovery, Decision 6):

```json
{ "sentAt": 1764100000000, "what": "addresses" }
```

### 5. The forwarded request: C → R

Down R's tunnel, on the HTTP/2 connection whose session secret is used for the MAC:

```
:method POST
:path   /__tower/peer                  (exactly; no query, no other path) (g)
content-type: application/json
x-codev-peer-statement: <base64url of the statement bytes>
x-codev-peer-mac: <base64url of HMAC-SHA-256(key = decoded sessionSecret, message = statement bytes)>

<the payload bytes exactly as C received them>
```

**The statement** is a JSON object that C serialises however it likes; R uses the exact bytes:

```json
{ "v": 1,
  "kind": "message",
  "toTowerId": "01J…R",
  "fromTowerId": "01J…S",
  "fromTowerName": "mbp",
  "fromOwnerId": "usr_…",
  "fromOwnerHandle": null,
  "fromOwnerEmail": "ana@example.com",
  "sameOwner": true,
  "requestId": "6f1c…",
  "issuedAt": 1764100000123,
  "statementId": "<base64url of 16 random bytes>",
  "payloadSha256": "<SHA-256 of the forwarded body bytes>" }
```

- Every field comes from C's own records or from C itself; none from anything S supplied, except
  `requestId` and `kind`, copied from S's headers, and `payloadSha256`, computed by C over exactly
  the bytes it forwards.
- `fromTowerName` is S's slug at the moment of issue. `fromOwnerHandle` is `null` until accounts have
  handles (stage 3). `sameOwner` is always `true` in stage 2. `statementId` is new for every
  statement, including two for one message.
- The encoded statement header is at most 4 096 bytes.
- The email is inside the base64url bytes, so a non-ASCII address is never a raw header value (b).

**What R checks, in this order, before storing anything.** Any failure in steps 1, 2 and 4 to 6
and 8 is `not-verified`; it stores nothing and is recorded under the aggregation rule (section 8).

1. The request arrived on the tunnel, at exactly `POST /__tower/peer`, with both headers, a statement
   header of at most 4 096 bytes, and a body of at most 102 400 bytes (R stops reading past it).
2. The MAC verifies, in constant time, under the secret of the session the request arrived on. A
   session whose `auth_ok` carried no `relay` has no secret, and everything fails here.
3. The statement bytes parse as a JSON object whose `v` is a version R speaks. Otherwise the answer
   is `refused`, reason `unsupported-version`, with the versions R speaks, and nothing is stored.
   (The MAC has verified, so this answer goes only to a genuine relay.)
4. Every field of that version is present, of the right type, and within its rule: `kind` is
   `message` or `query`; `requestId` is a canonical lower-case UUID; `toTowerId`, `fromTowerId`
   and `fromOwnerId` are 1 to 64 letters, digits, `_` or `-`; `fromTowerName` fits the Tower-name
   rule (lower-case letters, digits and hyphens, starting with a letter or digit, at most 63
   characters); `fromOwnerEmail` is at most 254 characters with no control characters;
   `fromOwnerHandle` is `null` or fits the same rule as a Tower name. Only values that pass reach
   a frame, the mailbox or the record.
5. `toTowerId` is R's own id.
6. The SHA-256 of the body equals `payloadSha256`.
7. `issuedAt` is within 5 minutes of R's clock, either way. Otherwise the answer is `refused`,
   reason `clock-skew`, and nothing is stored.
8. `statementId` has not been seen in the last **10 minutes** (the ±5-minute window means a
   statement can be fresh for 10). R keeps the ids in memory; a restart ends the tunnel session and
   its secret, so the memory need not survive one.

From here **the statement is used up**, whatever the outcome. Then: the switch is on
(`remote-off`); the payload parses as the kind's schema
(`malformed`); `sentAt` is not more than 5 minutes ahead of R's clock (`clock-skew`) and not more
than 30 days old (`expired`); the body is at most 48 KiB (`too-large`); accepted-once, recipient,
grant and limits as in Decisions 3 to 5. The payload's addresses must fit the address rules in
section 4, or the answer is `malformed`.

R answers within **5 seconds** of receiving the body: it persists, makes one gate attempt as a
local send does, and answers `delivered` or `held`. If the write cannot start within that time
(the per-agent or per-terminal lock is held by other deliveries), R answers `held` with reason
`busy` and the row is drained later like any held local mail. R never makes C wait past its own
deadline, so C's `no-answer` means R is unreachable, not slow.

### 6. Answers

**One answer shape, from either source.** Every answer, from R or from C, is a JSON object with
`Content-Type: application/json` and the header `x-codev-peer-outcome` set to the value of its
`outcome` field, so C can record the outcome class without parsing a body and S can read it
before parsing one.

| Field | Type | Present | Meaning |
|---|---|---|---|
| `v` | integer | always | The protocol version of the answer |
| `source` | `"tower"` or `"cloud"` | always | Who decided: R, or C without reaching R |
| `outcome` | string | always | From R: `delivered`, `held`, `refused`, `not-verified`, or `answered` (queries). From C: `refused` or `unavailable` |
| `reason` | string | with `held`, `refused`, `unavailable` | One of the reasons listed below for that source and outcome |
| `detail` | string, at most 500 characters | optional, from R | For a person, between Towers of one owner. S strips control characters and caps its length before printing it |
| `retryAfterSec` | integer | optional, with `rate-limited` | When the sender may try again |
| `supported` | array of integers | with `unsupported-version` | The versions the answering party speaks |
| `duplicate` | boolean | optional, from R | `true` when this answers a second arrival of an accepted message (below) |
| `addresses` | array | with `answered` | Discovery results (below) |
| `truncated` | boolean | with `answered` | `true` when R trimmed `addresses` to fit the 65 536-byte answer |

**R answers every decided outcome with HTTP 200.** C returns R's status, the two headers and the
body unchanged, provided the body is at most 65 536 bytes (d). A larger answer, a non-200, or a
body that is not this shape becomes C's `tower-error`.

**From R, kind `message`:**

```json
{ "v": 1, "source": "tower", "outcome": "delivered" }
{ "v": 1, "source": "tower", "outcome": "held", "reason": "busy" }
{ "v": 1, "source": "tower", "outcome": "refused", "reason": "no-grant",
  "detail": "mbp has no grant here for codev:architect:local. On devvm: afx peer grant mbp codev:architect:local" }
{ "v": 1, "source": "tower", "outcome": "not-verified" }
```

- `held` reasons: `busy`, `no-profile`, `no-live-pty`, `held-for-release`.
- `refused` reasons: `remote-off`, `no-grant`, `no-such-agent`, `not-addressable` (a shell, or a
  terminal kind that is never a recipient), `rate-limited`, `too-large`, `expired`, `clock-skew`,
  `unsupported-version`, `mismatch` (the id was already accepted with a different payload hash),
  `dismissed`, `malformed`.
- `not-verified` carries no reason: R says nothing about which check failed.
- A second arrival of an accepted message id from the same Tower with the same payload hash is
  answered with the first message's current state and `"duplicate": true`.

**From R, kind `query`:**

```json
{ "v": 1, "source": "tower", "outcome": "answered", "truncated": false,
  "addresses": [
    { "address": { "workspace": "codev", "kind": "architect", "name": "local" }, "live": true },
    { "address": { "workspace": "codev", "kind": "id", "name": "builder-spir-1940" }, "live": false } ] }
```

Only what the asker's grant covers: under a grant of one architect, that architect; of a
workspace's architects, each of them; of everything (`--all`), every workspace's architects and
builders. Never a shell. Each `address` follows the address rules in section 4, and `live` says
whether the agent has a live terminal. Refusals as for a message.

**From C, when R was not reached or not asked:**

```json
{ "v": 1, "source": "cloud", "outcome": "unavailable", "reason": "tower-offline" }
{ "v": 1, "source": "cloud", "outcome": "refused", "reason": "rate-limited", "retryAfterSec": 20 }
```

| HTTP | `outcome` | `reason` | S does with a message |
|---|---|---|---|
| 400 | `refused` | `malformed`, or `unsupported-version` with `supported` | Refuses the send |
| 401 | `refused` | `unauthenticated` | Refuses; tells the human to run `afx tower connect --reauth` |
| 404 | `refused` | `unknown-tower` (not a Tower of this account; the same answer whether or not it exists elsewhere) | Refuses |
| 409 | `refused` | `peer-unsupported` | Refuses, not held |
| 413 | `refused` | `too-large` | Refuses |
| 429 | `refused` | `rate-limited`, with `retryAfterSec` | A fresh send: refuses. Mail already held at S: stays held, and the peer's queue waits `retryAfterSec` (Departures, C4) |
| 502 | `unavailable` | `tower-error` | Holds, retries |
| 503 | `unavailable` | `tower-offline` (no live session) | Holds, retries |
| 504 | `unavailable` | `no-answer` (R did not answer within the relay timeout) | Holds, retries (e) |

- **A discovery query is never held**: every answer but `answered` refuses it, with the reason
  (Decision 6).
- No answer at all, a connection error, or a 5xx without this body: S holds, as **cloud
  unreachable**.
- `404` without this body, or a listing whose `relay` is `null`: S refuses, as **no relay**.
- An answer from R of `not-verified`: S holds and retries.
- **Retrying.** A held message is retried on a back-off that starts at 5 seconds and is capped at 2
  minutes, **whatever the listing says**: "online" is soft in both directions (e). A listing that
  shows the peer has come back only brings the next retry forward.
- **A cloud deploy is ordinary** (f). It drops every tunnel and replaces every secret, so requests in
  flight come back as no answer, cloud unreachable or not verified. Each holds at S, and the retry
  is a new relay call with a new statement and the same message id and payload bytes.
- **A run of `not-verified`.** A genuine relay is not-verified only by accident (a deploy, a
  reconnect). Five in a row for one peer means the two sides disagree about the contract. S keeps
  retrying at the capped interval, and shows the peer as "not verifying" in `afx peer list`, the
  Peers panel and its record, until a message to that peer gets any other answer.

### 7. Limits (h)

| Limit | Proposed | Enforced by | Notes |
|---|---|---|---|
| Messages relayed from one Tower | 60 a minute | C | From the approved spec |
| Messages relayed from one Tower to one Tower | **30 a minute** | C | New: the approved spec gives no per-pair number. Equal to R's default per-peer limit, so C's refusal normally comes first |
| Discovery queries from one Tower to one Tower | 10 a minute | C and R | From the approved spec |
| Calls whose key does not authenticate | C's choice; proposed 10 a minute per source address | C | New |

The sizes and times are protocol constants (above), not limits C sets.

- **Retries count.** A retry is a relay call like any other, and counts against every limit above.
  So does a call whose answer is `not-verified`. S's one-call-per-peer rule and its back-off keep
  retries few.
- The Tower-enforced limits of the approved spec are unchanged: 30 messages a minute accepted from
  one peer, 50 accepted but undelivered per peer, 50 waiting at the sender per peer.

### 8. Records (h)

Each party records what it can see, and nothing it cannot vouch for.

- **The sending Tower** records every outbound attempt: every relay call it makes (including each
  retry) and every send it refuses before calling, with the time, the recipient Tower's id and
  name, the full addresses, the message id, the payload size and the outcome.
- **The receiving Tower** records every request that reaches its entry point. Until the MAC has
  verified (steps 1 and 2 of section 5), it knows nothing about who sent it, so such a request is
  recorded against the tunnel session, with the sender `unverified`. Once the MAC has verified, the
  record names the sending Tower from the statement, and once the payload has parsed, the full
  addresses.
- **C** records every relay call: time, sending and receiving Tower ids, kind, request id, payload
  size, outcome class, duration.
- Never a body, a statement, a MAC or a secret, anywhere.
- **One row per attempt**, except floods. Attempts refused as rate limited, requests that are not
  verified (at R) and calls whose key does not authenticate (at C) are **aggregated**: one row per
  sender (the Tower id; at R before verification, the tunnel session; at C without a key, the
  source address), reason and minute, with a count and the first and last time. A flood therefore
  adds at most one row per sender per minute.
- C's record must not be deleted with a Tower's row, or deregistering a Tower would erase its
  history. Retention is C's choice for C's record; a Tower keeps its own for at least 30 days.

### 9. Keeping `/t/` apart from the relay (g)

- Both of C's `/t/` proxies (HTTP and WebSocket) refuse, with `404`, any request whose final
  `:path`, after percent-decoding, dot-segment removal and collapsing of doubled slashes, starts with
  `/__tower/`, compared without regard to case.
- Both strip every request header whose name starts with `x-codev-peer-`.
- C delivers peer traffic only to `POST /__tower/peer`, never through `/api/send` or any other path.
- With the MAC these are second barriers. If either fails, the result at R is `not-verified` and
  nothing stored, not a message.

### 10. What the Tower side builds against this contract

So that both halves can check each other's understanding:

- The Tower's tunnel client answers `POST /__tower/peer` itself and never proxies any path under
  `/__tower/peer` to Tower's local listener. A request to that path on the local listener reaches no
  handler.
- The session secret lives in the tunnel client's per-session state and nowhere else.
- The test vectors (Success Criteria) hold, for several cases: a secret, statement bytes, the
  expected MAC, payload bytes, the expected `payloadSha256`, and the expected verdict, including a
  statement with a non-ASCII email and one whose MAC was made with another secret.

## Departures from the Approved Spec

Each line says what the approved spec says, what this spec does instead, and why. Approving this
spec at the gate adopts them, except where the owner rules otherwise.

### Changes

| | The approved spec | This spec | Why |
|---|---|---|---|
| C1 | The statement covers "the message id" and a hash of "the payload exactly as forwarded" (Decision 3); each message "carries an id and a send time" (Decision 5) | The message id, recipient Tower id, kind and version travel outside the payload, in headers of the relay call; R takes the message id from the statement. The payload holds the envelope of Decision 5 (send time, recipient, sender, body) and nothing else | (a) The cloud routes, states and records without parsing the bytes it forwards, so no two parsers read one document |
| C2 | Message size: 48 KB, enforced by the sending Tower, the cloud and the receiving Tower (Decision 3, Limits) | The cloud enforces a cap on forwarded payload bytes, 102 400 (48 KiB of text at worst two bytes a character, plus 4 KiB of envelope). The 48 KiB text limit stays with both Towers. New: a 65 536-byte cap on the answer the cloud passes back | (d) The cloud does not inspect content. A discovery answer is the case the answer cap is for |
| C3 | Held at the sender: offline, cloud unreachable, or not verified; "if no answer comes back" the row stays held (Decision 5) | A named outcome `no-answer`, distinct from `tower-offline`, from a cloud relay timeout of 15 seconds; both held at the sender. R answers within 5 seconds | (e) "Online" is soft: a vanished peer looks online for about 135 seconds, and a relay to it would otherwise hang |
| C4 | "A refusal for rate is never retried automatically by the sending Tower; the sender is told, and decides" (Decision 3) | Kept for a fresh send whose sender is still waiting. For mail already held at the sender, a rate-limited answer leaves the row held and pauses that peer's queue for `retryAfterSec`, keeping the order | After an outage a backlog of up to 50 held messages is drained in one go. At 30 a minute per pair, messages 31 to 50 would otherwise end refused, against "accepted exactly once when the route returns" |
| C5 | "Every relay attempt" is recorded at the cloud; "every inbound decision" and "every outbound attempt" at the Towers (Decision 3) | Rate-limited attempts, not-verified requests and unauthenticated calls are recorded as one counted row per sender, reason and minute | (h) Otherwise the record is what a flood fills |
| C6 | Cloud limits "per sending Tower and per pair", with a number only per Tower (Decision 3) | Per pair: 30 messages a minute. Retries and not-verified attempts count. Unauthenticated calls: proposed 10 a minute per source address | (h) The numbers were missing |
| C7 | `--raw`, `--interrupt`, `--no-enter`, `--delay`: refused by the sending Tower; "the receiving Tower refuses them again" (Decision 5) | The sending Tower refuses them. The payload has no field that can ask for them, and R acts on no field it does not know, so R has nothing to refuse | The intent, that R never honours them, holds by construction; a field R would only ever refuse adds nothing |
| C8 | "A peer with no grant gets the same answer as a Tower that does not exist" (Decision 6); full reasons between my own Towers (Decision 5 and the walkthrough) | Between my own Towers, a discovery query without a grant is refused with `no-grant` and the command to add one. The identical answer stays for other owners, in stage 3 | The two decisions disagree for own Towers; this follows Decision 5 and the walkthrough |
| C9 | Front door only: a refusal reason, and rules for grants in such a workspace (Decisions 4, 5, 10) | Not built, and no such refusal exists | The owner cut the front-door-only setting at stage 1's plan approval (decision main-31); nothing exists for stage 2 to interact with |
| C10 | The lifetime runs 30 days from the sender's send time (Decision 5) | R also refuses a send time more than 5 minutes ahead of its clock, as `clock-skew` | A send time in the future would lengthen the lifetime past what the accepted-once record covers |
| C11 | R "remembers statement ids for the five minutes in which a statement could still be fresh" (Decision 3) | Ten minutes | Freshness is ±5 minutes, so a statement issued just under 5 minutes ahead of R's clock stays fresh for almost 10. Five minutes of memory would let it be replayed |
| C12 | Not stated | A send from a Tower that has never connected to Codev Cloud is refused before anything leaves (`not-connected`, naming `afx tower connect`). One whose key the cloud rejects, or that #1871 has marked deregistered, is refused (`not-registered`, naming `afx tower connect --reauth`), not held | Waiting does not fix either; a human has to act |
| C13 | The sending Tower "refuses a Tower name that is not in its peer list, before anything leaves" (Decision 3) | The sending Tower keeps its last listing on disk (ids, names, and names each Tower has had). When the cloud is unreachable, a name in it resolves and the message is held; a name not in it is refused as unknown, saying when the list was last refreshed and that the cloud is unreachable. A Tower's former name fails naming its current one | The peer list belongs to the cloud, which may be unreachable at send time; the approved spec's own test "the old name fails naming the new one" needs the names a Tower has had |
| C14 | Current State: "Tower already pushes workspace paths, workspace names and terminal ids to the cloud every 30 seconds" | That push has never reached the cloud (404, issue #1986). Stage 2 does not replace it: the switch state goes in the `auth` message and one new `PUT /api/peer/state`. Stage 2 removes the dead push from Tower and closes #1986 | (c) Fix in place: the push is dead code in the file stage 2 changes, and nothing uses it |

### Gaps the approved spec leaves, filled here without changing it

| | Gap | Rule in this spec |
|---|---|---|
| G1 | How the cloud learns that a Tower speaks the protocol, and its switch state | Optional fields of the `auth` message; absence means not supported (c). A switch change while connected uses `PUT /api/peer/state` |
| G2 | How the statement and payload are encoded, and over what the MAC is made | Section 5 of the contract: exact bytes, base64url, MAC over the bytes (b) |
| G3 | The receiving entry point | One exact path, `POST /__tower/peer`, answered inside the tunnel client and absent from the local listener (Approach 1A); headers under `x-codev-peer-` (g) |
| G4 | How a Tower learns its current name after a rename made in the cloud, which does not reconnect it | From `self` in every peer listing, as well as from `auth_ok` |
| G5 | What a cloud deploy does to messages in flight | Ordinary: they hold at the sender and are retried (f) |
| G6 | "Leaves nothing on the receiving Tower" against "both Towers keep a record" | Nothing means no mailbox row and no accepted-once record. The record of the attempt is kept, without a body |
| G7 | A remote send from a workspace with no address name, or from a sender with no agent identity | Sent, and framed by R with no reply address; stage 1's footer for a cross-workspace sender whose workspace has no address name is the model |
| G8 | The approved spec assumes TLS on each leg ("inside TLS on each leg", Decision 3), but a Tower today accepts an `http:` cloud and opens a `ws:` tunnel | A Tower takes a session secret only over `wss:` and makes peer calls only over `https:`, loopback excepted; any other plain-HTTP cloud has no relay |
| G9 | A receiving Tower whose delivery cannot start within the relay's time | R answers `held`, `busy` within 5 seconds rather than making the cloud wait; the row drains as held local mail does |
| G10 | Two halves that disagree about the contract would make every message `not-verified` and retry silently for 30 days | After five in a row for one peer, the peer is shown as "not verifying" in `afx peer list`, the Peers panel and the record |
| G11 | Which values from a statement or payload may reach a frame typed at a terminal | Only values that pass their rules in contract sections 4 and 5; `requestId` is validated as a UUID by the cloud and again by R |

### Facts that differ from the approved spec's description of today, with no design change

- The `/t/` route's lookup needs no change for per-account slugs, but its tombstones and three other
  slug lookups do (codev-cloud's work, noted on issue #22).
- Connection events are deleted with the Tower's row; the relay record must not be (contract,
  section 8).
- Accounts created before 2026-02-17 were marked verified without verification, so "verified email"
  is weaker for them. This matters for stage 3, where the email is shown to another owner. Stage 2
  carries the email in the statement and shows it to no one; noted for issue #1968.

## Open Questions

**Critical (blocks progress)**

1. **When are the real-cloud criteria checked, and does that hold the project open?** Recommended:
   the PR merges when every criterion verifiable here passes; the feature is inert until the cloud
   ships (switch off, no grants, no relay). The verify phase stays open until a human has run the
   stage 2 walkthrough through the real cloud (staging first), on two Towers both behind NAT, with
   the architect's permission; `verify-approval` waits for it. This is the only answer consistent
   with the approved spec's constraint that each stage ships its headline path, not a primitive.
   The alternative, verifying with the stand-in and filing a follow-up for the real-cloud run,
   would close the project before its headline path had run once; it is listed only because the
   choice is the owner's.
2. **Does the cloud's architect agree the wire contract?** It is sent as written. A correction
   changes the contract section and the module that speaks it, not the rest of this spec.

**Important (shapes the design)**

3. **The departures C1 to C14.** Each is the owner's to accept or reject at the gate. C4 (retrying
   rate-limited held mail) and C5 (aggregated records) change stated rules; the others make precise
   or correct.
4. **Issue #1871's timing.** If it has not merged when the end-to-end phase starts, that phase waits
   for it rather than reading the typed name.

**Nice-to-know**

5. Whether the cloud should close a Tower's session on rename so `auth_ok` carries the new slug at
   once. Not needed by this contract (G4); it would make `/t/` URLs right sooner.
6. Whether the default limits are the right size (the approved spec's Open Question 16).

## Test Scenarios

The approved spec's stage 2 scenarios (its Test Scenarios, "Between my own Towers") are inherited
as written and run against the stand-in relay with two test Towers, except these, which need the
real cloud: "another account holds a Tower with the same name as mine"; "on the cloud side: a
request through the `/t/` proxy… is refused"; the cloud's half of "exceeding the per-peer limit";
and the headline path behind NAT.

Added by this spec, all against the stand-in:

- **Contract vectors.** The MAC and hash vectors pass; a statement with a non-ASCII email verifies;
  one MACed with another secret does not.
- **R's checks, one at a time.** Each of steps 1 to 8 in contract section 5 fails alone, and each
  stores nothing; a statement presented again 9 minutes after it was first used is refused; one
  whose first presentation was refused for want of a grant cannot be presented again.
- **The local listener.** `POST /__tower/peer` to Tower's local port, with the local key and the
  tunnel marker header, reaches no handler and stores nothing.
- **Handshake.** `auth` carries `peer` with the switch state; `auth_ok` without `relay` makes every
  `afx://` send to another Tower refuse as no relay; a switch change while connected makes one
  `PUT /api/peer/state`, and its failure is not retried in a loop.
- **Mixed versions.** The stand-in answers `peer-unsupported`: refused, not held. An old cloud (no
  `relay`, `404` on `/api/peer/…`): refused as no relay.
- **No answer.** The stand-in holds a forward past the relay timeout: held at the sender as
  `no-answer`, then delivered once on retry; the receiving Tower has one mailbox row.
- **A deploy.** The stand-in drops both tunnels mid-send and issues new secrets: the message holds,
  then arrives once, under the new secret, with a new statement and the same message id.
- **Caps.** A payload of 102 400 bytes is relayed and one byte more is refused as too large; a 48
  KiB body made entirely of characters JSON escapes fits; a discovery answer over 65 536 bytes is
  trimmed and marked truncated.
- **Rate-limited backlog (C4).** 50 messages held for an offline peer drain in order, across the
  per-pair limit, with none refused; a fresh send refused for rate exits non-zero.
- **Record aggregation (C5).** 1 000 not-verified requests in one minute add one record row at the
  receiving Tower, with a count of 1 000.
- **Clock (C10, C11).** A send time 6 minutes ahead is refused as `clock-skew`.
- **Unregistered sender (C12).** A Tower never connected, and one marked deregistered, each refuse
  an `afx://` send to another Tower with the stated remedy, and make no call.
- **Cached peer list (C13).** With the cloud unreachable, a known name holds and an unknown one
  refuses naming the time of the last listing; a Tower's former name fails naming its current one.
- **Own name.** `afx://<own name>/…` resolves locally without the cloud; after a rename in the
  stand-in, the next listing's `self` makes the new name resolve locally and the old one fail.
- **Stage 1 carry-overs.** The `devvm` hint; an `afx://` address using a workspace's new explicit
  name resolves where the basename could not.
- **TLS.** A Tower whose cloud is `http:` on a non-loopback host ignores a `relay` in `auth_ok`,
  makes no peer call, and refuses an `afx://` send to another Tower as no relay. On loopback (the
  stand-in) it works.
- **Builders across Towers.** A builder's send to a named architect on another of my Towers that is
  not its own is refused by its own Tower, and no call is made; its send to that workspace's front
  door is delivered under a grant. A message to a builder on another Tower under an `--all` grant is
  delivered, and its footer's reply command is accepted when the builder sends it. Discovery under
  `--all` lists builders by id; under a grant of one architect it does not.
- **Shells.** `afx://<tower>/<workspace>:<shell-id>` is refused by the receiving Tower as
  `not-addressable`, with nothing stored, even under `--all`.
- **Field validation.** A request id that is not a canonical UUID is refused by the stand-in (as the
  cloud would) and, injected past it, by R. A property test over arbitrary values of every
  statement and payload field: each request is either refused with nothing stored, or produces a
  frame whose header and footer contain only validated values.
- **R's deadline.** With the recipient's terminal lock held by another delivery, a remote message is
  answered `held`, `busy` within 5 seconds and delivered once the lock is free.
- **A run of `not-verified`.** The stand-in MACs with a wrong secret: after five attempts the peer
  shows as "not verifying"; once the stand-in is fixed, the next retry delivers and the mark clears.
- **The Peers panel and held-mail indicator**, rendered in a browser with Playwright: the peer list,
  the switch state, a peer that is not verifying, and the three counts.
- **Secrets and bodies.** After a full walkthrough, neither Tower's logs, `global.db` nor
  `cloud-config.json` contain the session secret, any statement, any MAC or any body text.
- **Locks.** A remote message takes the per-agent then per-terminal locks, in that order.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| The two halves read the contract differently | Medium | High | One written contract, agreed before either side finishes; shared test vectors; the stand-in is built from the contract, not from the Tower code |
| The cloud corrects the contract after Tower code exists | Medium | Medium | The code that speaks it is one module; the contract section is the only part of this spec that would change |
| A security check is written but not wired on the real path | Medium | High | Every refusal in contract section 5 is tested through the real tunnel client on a test Tower, not only as a function; the architect reads the verification code (architect's instruction) |
| The secret or a body leaks into a log or a file | Low | High | Tested by scanning logs, the database and the config after a full run |
| The secret crosses the network in cleartext because a Tower points at a plain-HTTP cloud | Low | High | A secret is taken only over `wss:` and peer calls go only over `https:`, loopback excepted (G8); tested |
| Tests touch the live Tower or the real cloud | Low | High | Test Towers on their own ports and databases; the stand-in is the only relay any test reaches |
| The cloud ships late and the feature stays inert | Medium | Medium | Open Question 1; the Tower half is complete and tested on its own |
| Retrying rate-limited held mail (C4) hides a misbehaving sender | Low | Medium | Fresh sends are still refused; held rows stay visible in `afx inbox`, and the 50-message cap at the sender and the 30-day lifetime bound them |
| Aggregated records (C5) hide the detail of a flood | Low | Low | The count, the sender and the first and last times are kept; attempts that reached a decision keep one row each |
| A mailbox table rebuild on upgrade loses rows | Low | High | The plan specifies the migration and tests it on a database copied from the current schema with held rows in it |

## References

- `codev/specs/1940-tower-to-tower-messaging-proto.md` — the approved design (Decisions 1 to 7 and 9,
  the stage 2 walkthrough, Staging, the stage 2 criteria and scenarios)
- `codev/reviews/1940-tower-to-tower-messaging-proto.md` — stage 1's review and the items it left for
  stage 2
- Issue #1967 (this work); issue #1940 (the design); issue #1968 (stage 3); issue #1871 (canonical
  Tower name); issue #1986 (the dead metadata push); issue #655 (cloud messaging)
- codev-cloud issue #22 (the cloud half) and its comment 7174155361 (the cloud architect's answers)
- Spec 97 (the cloud tunnel client), Spec 1313 (mailbox-first delivery), Spec 755 (the builder rule)
