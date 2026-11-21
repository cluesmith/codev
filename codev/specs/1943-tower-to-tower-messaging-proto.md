# Specification: Tower-to-Tower Messaging Protocol

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
Keep implementation phases, file paths, code, and "first we will… then we will…"
out of the spec — those belong in codev/plans/<id>-*.md.
-->

> Issue #1943 — an independent second draft from the same brief as #1940, written only from the brief and the codebase.
> Protocol: SPIR. Deliverable: this design. Code follows only after spec and plan approval.

## Problem Statement

`afx send` is how every Codev agent talks to every other one. It stops at two edges:

1. **The edge of a workspace, for named architects.** A named architect (Spec 755) can be reached only from inside its own workspace. From outside, `<workspace>:architect` reaches that workspace's `main` (else its first registered architect) and nothing else. `<workspace>:architect:<name>` does not parse as anything meaningful. So every cross-workspace message to a named architect is relayed by hand through `main`. That cost is recorded. Between 2026-09-29 and 2026-10-02 the codev workspace's `local` architect coordinated a disk-cleanup sweep. Fifteen reports from eight workspaces all landed on codev `main`, which relayed each one by hand (owner's comment on #1605).
2. **The edge of a machine.** One owner often runs several Towers (a laptop, a dev VM, …), and collaborators run their own. No agent on one Tower can message an agent on another. Codev Cloud already holds an authenticated tunnel to each connected Tower (Spec 97), but nothing uses it to carry messages between Towers.

The capability asked for is **sending messages**: `afx send`, extended across workspaces, then across Towers, then across owners. The design has to settle three things up front so later stages need no second migration:

- an address grammar that names a Tower as well as a workspace and an agent;
- a security model that treats a remote message as what it really is;
- a transport.

On the security model: a message is text typed into the prompt of a coding agent that usually runs with permissions skipped. **Accepting a message from another Tower is accepting remote instructions for an agent with shell access.**

Who is affected:

- **Owners running several workspaces with named architects** (stage 1). Today they relay by hand.
- **Owners with several machines** (stage 2). Today they copy text between machines.
- **Collaborators on different Towers** (stage 3). Today they have no channel at all except a human pasting text.
- **Every existing `afx send` user and agent.** The current colon forms are in agent prompts, docs, cron task files and muscle memory. A migration must not break them silently.

## Current State

### Address grammar

`parseAddress` (`packages/codev/src/agent-farm/utils/agent-names.ts`) splits on the **first** colon into `{ project, agent }`. Everything is lowercased. Accepted forms today:

| Form | Meaning | Resolved by |
|---|---|---|
| `spir-42`, `42`, `builder-spir-42` | a builder in the sender's workspace (exact, then tail match with leading-zero strip) | `resolveAgentInWorkspace` |
| `architect`, `arch` | from a builder: its spawning architect (Spec 755 affinity); from anyone else: `main`, else first registered | `resolveAgentInWorkspace` |
| `architect:<name>` | a named architect in the sender's workspace. A builder may name only its own spawning architect (the Spec 755 spoofing rule) | special-case intercept in `resolveTarget` |
| `<workspace>:architect` | `main` (else first registered) of the workspace whose **path basename** matches | `findWorkspaceByBasename` |
| `<workspace>:<builder>` | a builder in that workspace | same |

What breaks:

- `architect:<name>` and `<workspace>:architect` have the same shape. `resolveTarget` (`servers/tower-messages.ts`) tells them apart only by intercepting the literal word `architect` on the left of the colon. `<workspace>:architect:<name>` parses as workspace `<workspace>` plus agent `architect:<name>`. That agent then falls through to builder lookup and fails with a bare `NOT_FOUND`. Issue #1605 records the failure.
- A workspace is named only by its path basename. That is not unique on one machine: two workspaces named `codev` yield `AMBIGUOUS`, and #1391 reports the same collision in display surfaces. A basename also means nothing on another machine.
- The same grammar is consumed in more than one place:
  - `afx send`;
  - cron task targets (`resolveTarget(task.target, …)` in the cron delivery path);
  - the registry fallback (`resolveAgentInRegistry`), which holds mail for known-but-offline agents;
  - the SDK `sendMessage` used by the VS Code extension;
  - `afx interrupt`.

### Provenance and replies

`formatMessageForTarget` (`servers/tower-routes.ts`) and `utils/message-format.ts` frame each message. Example: `### [ARCHITECT:main MESSAGE → ob-refine | <ts>] ###`. **The frame never names the sender's workspace.** The mailbox row stores `from_workspace`, but the recipient never sees it.

The result: a message from `marketmaker`'s `main` to `shannon`'s architect reads `ARCHITECT:main`, which looks like the recipient's own `main`. The obvious reply, `afx send architect:main`, goes to the wrong architect. The builder-bound reply hint is hard-coded to `afx send architect "…"`. Cross-workspace provenance is therefore already wrong on one Tower, before any second Tower exists.

### Delivery

Delivery is mailbox-first (Spec 1313 and its follow-ups):

- `POST /api/send` persists a `mailbox` row in `~/.agent-farm/global.db`.
- It then attempts delivery through the render gate under the per-terminal `submitToSession` lock.
- It returns `delivered`, or `held` with a reason (`busy`, `no-profile`, `no-live-pty`) and a detail.
- A known agent with no live PTY has its mail held rather than refused.
- `--interrupt` and the ESC path are explicit human gate bypasses.
- Bodies are capped at 48 KB (`MAX_MESSAGE_BYTES`) at both the CLI and the route.
- `from` is validated only syntactically (`isSafeSenderId`). A builder's identity is verified against `global.db` by the CLI (#1094, #1783). An architect's identity comes from `CODEV_ARCHITECT_NAME`.

### Codev Cloud and the tunnel

Facts below are from the Tower code and from the codev-cloud repository at `origin/main`, 2026-11-17.

- **The tunnel.** A Tower opens `wss://<cloud>/tunnel` and authenticates with `{type:"auth", apiKey:"ctk_…"}`. The cloud answers `auth_ok {towerId, slug, name}`.
  - The cloud then acts as the **HTTP/2 client** over that WebSocket, and the Tower acts as the **server** (role reversal). Every request on the tunnel is therefore cloud-initiated. The Tower cannot originate a request over it.
  - The Tower's tunnel client stamps each proxied request with the Tower's local key, a localhost `Host` header, and an `x-codev-tunnel-proxy` marker. It blocks a short list of management paths (`api/tunnel/`, `api/ide`, `api/shutdown`, `api/agent-lifecycle`).
  - Everything else, `POST /api/send` included, reaches Tower as a fully trusted local caller. **The cloud is already in the trusted computing base of every connected Tower.**
- **Cloud authorization.** It is owner-only: a tower row is looked up by `id OR slug AND userId = <session user>`. There are no organisations, teams, shared towers or collaborators. The cloud stamps no user identity onto proxied requests.
- **Identity.**
  - A user is a better-auth account: email (unique, verification required) and password, or Google OAuth.
  - A tower row carries `id` (ULID), `userId`, `name`, `slug` (**globally unique across all users**), `machineId`, and a bcrypt hash of its single `ctk_` key.
  - Re-registration rotates the key in place. `PATCH /api/towers/:id {name}` re-slugs the Tower, and the old slug stops resolving immediately with no redirect. Delete leaves a one-hour 410 tombstone.
- **Tower-key reach.** A `ctk_` key is accepted by **no cloud API except `DELETE /api/towers/:id`** for its own Tower.
  - The Tower's best-effort `POST /api/tower/metadata` push targets an endpoint that does not exist.
  - The cloud pulls workspace and terminal metadata on demand through the tunnel (`GET /api/projects`). It shows that data only to the owner and stores none of it.
- **No messaging.** The cloud has no relay, inbox or notification feature, and it never calls a Tower's `/api/send` on its own.
- **Deployment.**
  - It runs as a single Railway instance. The tunnel registry is an in-process map with no pub/sub.
  - Each production deploy restarts the relay and drops every tunnel.
  - Rate limits are in memory. The only audit record is a `connection_log` of connects, disconnects and auth failures.
- **Tower naming.** Tower-side naming is being reconciled with the cloud's canonical slug in #1871 (the Tower persisted the typed name, not the slug). #1914 already landed part of that, for the IDE public prefix.

### Existing ground

| Item | Relation to this spec |
|---|---|
| #655 (cloud messaging via Codev Cloud) | An earlier, narrower framing: a cloud-hosted `afx send` plus Claude Channels as a receive path. This spec **subsumes its Tower-originated half** (see Open Questions, Q11). Its web/mobile sender and Claude Channels ideas are not designed here. |
| #1605 (front-door-only cross-workspace routing) | Records a decision that the `<workspace>:architect:<name>` gap "is the design, not a bug", on **encapsulation** and **single trust ingress** grounds. Goal 1 of this brief reverses that decision. This spec answers both arguments (Approach A1 → "Answering #1605") and asks the owner to confirm (Q5). |
| #1391 (workspace display names collide) | Same root cause as basename addressing. Stage 1's unique workspace names remove that cause. |
| #1871 / codev-cloud#17 (canonical slug, rename, deregistration) | Stage 2 needs the Tower to know its canonical cloud slug, since that slug is the Tower part of an address. |
| #1165 / codev-cloud#7 (device authorization for `afx tower connect`) | Orthogonal. A smoother `connect` helps adoption but changes no contract here. |
| Spec 755, Spec 823 | Named architects, affinity routing, the builder spoofing rule, sibling messaging. |
| Spec 1313 + held-mail follow-ups (#1365, #1473, #1482, #1573, #1584, #1664) | The delivery invariants every new writer must honour. |
| Spec 62, Spec 97 | Prior remote-access and tunnel design. Spec 97 established `ctk_` key auth and the WSS transport. |

## Desired State

### Stage 1: Named architects across workspaces, one Tower, no cloud

- Any architect or human shell on a Tower can address a named architect in **another workspace on the same Tower**. Builders keep today's reach: their own spawning architect, plus other workspaces' front doors (Q7).

  ```bash
  afx send shannon/architect:ob-refine "…"
  ```
- Workspaces have **Tower-unique names**. Today's basename stays the default where it is unambiguous and valid.
- The recipient sees the sender's address **as the recipient would type it to reply**, e.g. `codev/architect:local`. The frame's reply hint carries that exact address.
- No Tower needs a Codev Cloud connection, and nothing in this stage depends on one.
- Every existing address form keeps working. `<workspace>:<agent>` is accepted with a deprecation notice. `architect:<name>` stays first-class.

**Headline path.** From codev's `local` architect:

1. Run `afx send shannon/architect:ob-refine "disk sweep: report your largest dirs"`.
2. It arrives in shannon's `ob-refine` terminal, framed as from `codev/architect:local`, with the reply hint `afx send codev/architect:local "…"`.
3. `ob-refine`'s reply lands back in `local`.
4. No message passes through either workspace's `main`.

### Stage 2: My Tower talks to my other Towers, via Codev Cloud

- An agent on one of my Towers addresses an agent on another of my Towers by prefixing the Tower name, which is the cloud slug:

  ```bash
  afx send devvm/codev/architect:local "…"
  ```
- The message travels through Codev Cloud. It is persisted in the receiving Tower's mailbox and delivered through its render gate, exactly as a local message is.
- The sender learns the real first outcome:
  - `delivered`;
  - `held` with a reason, at the remote mailbox;
  - `queued` with a reason, kept in the sender's own outbox because the remote Tower or the cloud is unreachable;
  - `rejected` with a reason.
- The recipient sees a frame visibly marked **remote**, naming `laptop/codev/architect:main`, with that address as the reply hint.
- I can list my Towers and, for each online one, its workspaces and live agents.

**Headline path.**

1. From my laptop's `main` architect in `codev`, run `afx send devvm/codev/architect:local "rebuild finished, take over"`.
2. It arrives in the dev VM's `local` architect, framed as remote from `laptop/codev/architect:main`.
3. `local` replies with the address in the frame, and the reply arrives back on the laptop.
4. With the dev VM's Tower stopped, the same send reports `queued: tower-offline`. It delivers by itself when the dev VM's Tower comes back.

### Stage 3: My Tower talks to someone else's Tower

- Other owners' Towers are **default-deny**.
  - A human on the receiving side grants another owner, identified by their verified Codev Cloud email, the right to message a specific scope: one workspace's architect front door, or one named architect.
  - Builders are never reachable by other owners in this design (Q6).
- By default, a message from another owner is **held for the human to release** (`held: awaiting-release`). It is not delivered straight to the agent. A grant can opt into direct delivery (Q1).
- The frame shows the **owner identity** the cloud verified, alongside the sending Tower's claimed agent identity. It is visibly distinct from a local or same-owner message.
- Replies to a message I sent are accepted from exactly the agent I sent it to, for a bounded window, without a separate grant.
- Grants are revocable. Revocation takes effect at the receiving Tower immediately, whatever the cloud's state.

**Headline path.**

1. Bob grants `alice@example.com` access to `ansari/architect`.
2. Alice's `main` architect runs `afx send bob-mbp/ansari/architect "PR #12 in our shared lib is ready for your side"`, and gets back `held: awaiting-release`.
3. Bob sees the held message on his dashboard and releases it.
4. Bob's `main` architect receives it, framed as remote from another owner (`alice@example.com`, Tower `alice-mbp`).
5. Bob's architect replies to the address in the frame, and the reply arrives in Alice's `main` (held or delivered according to Alice's setting for Bob).

## Success Criteria

### Address grammar (all stages)

- [ ] One grammar is accepted everywhere an address is typed or configured: `afx send`, `afx interrupt`, cron targets, and the SDK/VS Code send path. It is parsed by one shared parser.
- [ ] A 1-, 2- and 3-segment address resolves as defined in the recommended grammar below.
  - A 4-or-more-segment address fails with a "reserved form" error.
  - No address ever resolves to a recipient other than the one it names. Unresolvable means a loud error that states the reason.
- [ ] Bare `architect` sent from a builder still routes to its spawning architect.
- [ ] The builder rule is enforced in every position. A builder may **name** an architect only if it is its own spawning architect, whether the address is written unqualified (`architect:x`), qualified with its own workspace (`codev/architect:x`), qualified with another workspace, or Tower-qualified. A builder reaches any other workspace's architects only through the front door, `ws/architect` (recommended, Q7).
- [ ] The legacy form `<workspace>:<agent>` keeps resolving exactly as today. Every use prints a deprecation notice naming the replacement (`<workspace>/<agent>`). `architect:<name>` is not deprecated.
- [ ] A colon in a multi-segment address is valid only as the `architect:<name>` agent segment. Anything else (`devvm/codev:architect`, `shannon/ws:architect`) fails as a malformed address, never as a quiet `NOT_FOUND`.
- [ ] No address depends on a filesystem path or its spelling. Workspaces are resolved through the registry keyed by `workspaceKey()`. A Windows test proves that two spellings of the same directory yield the same workspace name.

### Stage 1

- [ ] Every registered workspace has either a Tower-unique name or an explicit "unnamed" status with the reason (collision, or a basename that is not a valid name). Naming follows the deterministic contract under "Workspace and Tower names":
  - an assigned name is never taken away by another workspace registering;
  - a human-set name never steals one;
  - registry rows that resolve to the same directory are one workspace for naming purposes.
- [ ] A command lists this Tower's workspace names and their architects as full addresses.
- [ ] A human can set a name.
- [ ] A name pinned in the workspace's committed config survives moving or re-cloning the directory.
- [ ] `afx send <ws>/architect:<name>` from any architect or human shell on the Tower delivers to that named architect through the mailbox and gate (closing the #1605 gap).
- [ ] Every message whose sender is in a different workspace from its recipient carries the sender's workspace-qualified address in its frame.
- [ ] The reply hint is the shortest address the **recipient is permitted to use** that reaches the sender. When no permitted address reaches the sender (for example, a builder messaged by a named architect it may not name), the hint says to reply through the recipient's own architect.
- [ ] Short frames keep their single-write path: a builder-bound frame stays within the #1567 bounds (3 lines, 256 bytes), so the added provenance does not move short messages onto bracketed paste.
- [ ] The stage 1 headline path works with no `cloud-config.json` present.

### Stage 2

- [ ] The headline path works between two real Towers registered to the same Codev Cloud account. The recipient's frame is marked remote and names `tower/workspace/agent`.
- [ ] A message to a remote Tower is persisted locally **before** the first relay attempt. The sender sees one of `delivered` / `held:<reason>` / `queued:<reason>` / `rejected:<reason>`.
- [ ] A `queued` message delivers automatically once the target Tower is reachable again, within the retry window. Past the window it becomes `expired`. Queued and expired outbound messages are listable and dismissable by a human on the sending Tower.
- [ ] A retried message is never delivered twice. The receiving Tower deduplicates on (origin Tower, message id), and keeps dedupe records strictly longer than the longest sender retry window.
- [ ] Queued messages to the same remote agent are relayed in the order they were sent (FIFO per target agent). There is no ordering guarantee across different targets.
- [ ] A relay delivery whose attestation does not verify is refused by the receiving Tower. This covers forged attestation headers arriving through the owner proxy, a replayed delivery, and a local caller posting to the relay route.
- [ ] A remote message is persisted to the receiving Tower's mailbox before any delivery attempt, and delivered only through the render gate. `raw`, `interrupt`, ESC, `no-enter`, `--all` and `--delay` are refused for remote targets, each with a clear error.
- [ ] A Tower-qualified address naming this Tower's own name resolves locally without contacting the cloud.
- [ ] An unknown Tower name fails fast with `rejected: unknown-tower`. For the sender's own account, the error lists the account's Tower names.
- [ ] Stopping the Codev Cloud connection never affects local or cross-workspace messaging.

### Stage 3

- [ ] Tower existence does not leak. An address naming a Tower that is neither the sender's own nor one that has granted the sender anything yields `rejected: unknown-tower`, identical whether the slug exists or not. On a Tower that has granted the sender something, any target outside the grant yields a uniform `not-authorized` that does not reveal whether the target exists.
- [ ] An email grant binds to exactly one account. A pending grant binds to the account that first presents that verified email; from then on the grant follows that account's user id, not the email.
  - The account changing its email keeps the grant (the frame shows the current email).
  - Deleting the account voids the grant.
  - A different account that later verifies the same email does not inherit it.
- [ ] The stage 3 human surfaces exist and are usable without editing files or the database:
  - **grants:** create, list and revoke, on the receiving side;
  - **reachable peers:** a list of what I can reach, on the sending side;
  - **held messages:** see a message held for release, read its body, release it or dismiss it.
- [ ] A grant scoped to `ws/architect` (front door) or `ws/architect:<name>` admits exactly that scope. Builder targets are never admitted for another owner.
- [ ] A message from another owner under a `hold` grant becomes `held: awaiting-release`, and the target agent receives nothing until a human releases it. A release through a non-interactive agent shell is refused.
- [ ] A frame from another owner shows the cloud-verified owner email and the sending Tower's name, and is visibly distinct from same-owner frames. A body line that imitates a frame delimiter is neutralized.
- [ ] Revoking a grant on the receiving Tower rejects the next message from that owner even if the cloud still forwards it.
- [ ] A reply from the exact remote agent I messaged is admitted inside the reply window without a grant. A message from any other agent on that Tower is not.
- [ ] A reply-path message is delivered in my delivery mode for that owner: the mode of my grant to them if one exists, otherwise `hold`.
- [ ] Per-peer rate limits and a per-peer cap on messages held for release are enforced on the receiving Tower. Exceeding them yields `rejected: rate-limited` or `rejected: queue-full`.

## Constraints

- **Transport is directed by the owner:** the Codev Cloud tunnel. Direct Tower-to-Tower connections are set aside unless a concrete requirement the tunnel cannot meet appears (see Approach T4).
- **Stage 1 must not depend on Codev Cloud.** It must not wait behind stages 2 or 3, and each stage must ship on its own with a working headline path. A primitive with the usable path deferred is not acceptable.
- **Mailbox-first (Spec 1313).** A remote message is persisted to the receiving Tower's mailbox and delivered through the render gate under the per-terminal lock, honouring the lock order (per-agent, then per-terminal). Nothing remote writes a PTY directly. Nothing remote bypasses the gate.
- **Fail fast, no fallbacks.** An address that does not resolve fails loudly with its reason. It never falls back to another recipient. There is no alternate transport when the cloud is down: mail waits in the sender's outbox, visibly.
- **Server/client isolation (#1189).** Wire contracts (the relay envelope, outcomes, discovery payloads) live in `codev-types`. `codev-core` and `codev-sdk` do not import each other. The address parser must be usable by both the Tower and the SDK, so it must be environment-agnostic.
- **Windows.** Workspaces are keyed by `workspaceKey()`'s canonical spelling, and an address must not depend on how a path is spelled.
- **Message ceiling.** 48 KB per body, enforced by the sender, the cloud and the receiver.
- **Existing frame contracts the provenance work must honour.** These are named so the plan cannot trip on them:
  - `isSafeSenderId` (`^[A-Za-z0-9._:-]{1,128}$`) is enforced on `POST /api/send` and **excludes `/`**. A qualified sender identity therefore cannot travel as today's `from` string unchanged. The wire must carry origin as structured fields, or the validator must change deliberately.
  - `architectHeaderLabel` recognizes only senders that begin with `architect:`. A qualified sender would degrade to a bare `ARCHITECT` and lose exactly the provenance stage 1 adds.
  - #1567: a builder-bound frame is typed as one short write only while it is under 4 lines and at most 256 bytes. The added provenance and reply hint must not move short messages onto the bracketed-paste path.
- **Path spelling on POSIX.** `workspaceKey()` canonicalizes only on Windows. On POSIX it is the path as given (#1870, open), so one macOS directory can hold two registry rows. Naming must treat rows that resolve to the same directory as one workspace.
- **Proportionality.** Design the address and trust model for all three stages, and nothing a hypothetical fourth stage alone would need. The grammar reserves one extra leading segment for a future owner/organisation component, as room rather than machinery.
- **Cross-repository work.** The relay, the directory and the grant registry are Codev Cloud work in the codev-cloud repository. This repository owns the Tower, the CLI and the shared contracts.
- **Gates.** Decisions that are the owner's (above all the posture toward other owners) are surfaced in Open Questions, not settled silently.

## Assumptions

- Codev Cloud remains the single relay. Tower slugs stay globally unique across users, which is true today. If slugs ever became per-user, the reserved leading segment absorbs an owner component without changing the rest of the grammar.
- #1871 lands enough for a Tower to know and display its canonical slug, at least its steps 1, 2 and 5, before stage 2 ships. Stage 2 depends on that.
- A cloud account's verified email is an acceptable identifier for another owner. Google OAuth accounts carry a verified email.
- The cloud stays single-instance through stage 3, or it gains cross-instance routing (pub/sub or sticky routing by tower) before a relay must reach a tunnel held by another instance. Either way that is cloud work.
- An agent running under the owner's shell can, in the limit, do anything the owner can do locally (edit files, run any `afx` verb). The design cannot make a local surface agent-proof. It can keep trust changes off every path an agent uses in normal operation, and audit them. This limit is stated, not hidden (see Risks).
- Remote Towers may run older Codev versions. The relay contract is versioned, and a Tower without support answers `rejected: peer-unsupported`.

## Solution Approaches

The space splits into four decisions: the address grammar, discovery, the trust model, and transport and delivery. Each gets its alternatives and a recommendation. The combined recommended design follows at the end of this section.

### Part A: The address grammar

#### The same addresses in every candidate

| # | Meaning | Today |
|---|---|---|
| 1 | builder `spir-42`, my workspace | `spir-42` |
| 2 | my spawning architect (from a builder) | `architect` |
| 3 | sibling architect `ob-refine`, my workspace | `architect:ob-refine` |
| 4 | the `main` architect of `marketmaker`, this Tower | `marketmaker:architect` |
| 5 | architect `ob-refine` in `shannon`, this Tower (goal 1) | *impossible* |
| 6 | architect `local` in `codev` on my Tower `devvm` (goal 2) | *impossible* |
| 7 | builder `spir-42` in `codev` on `devvm` | *impossible* |
| 8 | `main` in `ansari` on Alice's Tower `alice-mbp` (goal 3) | *impossible* |
| 9 | `main` of a workspace whose name has a dot: `iaser.ai` | `iaser.ai:architect` |

Forms 1–3 are identical in every candidate below: in-workspace short forms are not changed by any of them. The table shows 4–9.

| # | A1 Path-like | A2 URI scheme | A3 Email-like | A4 Dotted DNS | A5 Handles | A6 Colons, extended |
|---|---|---|---|---|---|---|
| 4 | `marketmaker/architect` | `afx:///marketmaker/architect` | `architect@marketmaker` | `main.architect.marketmaker` | `@marketmaker` *(once defined)* | `marketmaker:architect` |
| 5 | `shannon/architect:ob-refine` | `afx:///shannon/architect/ob-refine` | `architect:ob-refine@shannon` | `ob-refine.architect.shannon` | `@shannon-ob` | `shannon:architect:ob-refine` |
| 6 | `devvm/codev/architect:local` | `afx://devvm/codev/architect/local` | `architect:local@codev.devvm` | `local.architect.codev.devvm` | `@vm` | `devvm:codev:architect:local` |
| 7 | `devvm/codev/spir-42` | `afx://devvm/codev/builder/spir-42` | `spir-42@codev.devvm` | `spir-42.builder.codev.devvm` | `@vm-42` | `devvm:codev:spir-42` |
| 8 | `alice-mbp/ansari/architect:main` | `afx://alice-mbp/ansari/architect/main` | `architect:main@ansari.alice-mbp` | `main.architect.ansari.alice-mbp` | `@alice` | `alice-mbp:ansari:architect:main` |
| 9 | `iaser.ai/architect` | `afx:///iaser.ai/architect` | `architect@iaser.ai` → **ambiguous** (`iaser` on Tower `ai`?) | **ambiguous** | `@iaser` | `iaser.ai:architect` |

In A2, an empty authority (`afx:///`) means "this Tower". The alternative is to write this Tower's own name.

#### A1: Path-like, right-anchored (`[[tower/]workspace/]agent`)

The address is one to three `/`-separated segments, read **from the right**:

- the last segment is always the agent;
- one segment to its left is a workspace on this Tower;
- two segments to its left add a Tower.

The agent segment keeps today's forms whole, including `architect:<name>`.

- **Shell:** `/`, `:`, `.` and `-` need no quoting in bash, zsh or PowerShell. It is the shortest form for every remote case.
- **Tab completion:** it reads broad-to-narrow, left to right, exactly as shells complete paths, so a completion script could later complete Tower, then workspace, then agent.
- **Agents:** it is easy to copy verbatim from a frame, and it cannot be mistaken for a sentence.
- **Short and relative forms:** these fall out of the segment count with no special tokens. A qualified address that lands back on the sender's own workspace and Tower is identical to the unqualified form.
- **Rename:** names are labels over stable ids (see Part C), so a rename breaks only addresses typed with the old name, and those fail loudly.
- **Future component:** a fourth leading segment (owner or organisation) is reserved.
- **Migration:** the smallest of any candidate.
  - `architect:<name>` is unchanged.
  - `<ws>:<agent>` becomes `<ws>/<agent>`, a one-character change, and the legacy form stays parseable without ambiguity during deprecation.
  - Dots in workspace names (`iaser.ai`, `cluesmith.com`) need no rename.
- **Risks:**
  - It looks like a filesystem path. It is never one, because `afx send` takes no path argument in that position.
  - `.` and `..` must be banned as names, along with a leading `-`, which a shell would read as a flag.
- **Recommended.**

#### A2: URI scheme (`afx://tower/workspace/kind/name`)

This is the owner's floated idea. The absolute form is self-describing and could become clickable in a dashboard or terminal. The kind is a path segment (`architect/local`, `builder/spir-42`), and a query or fragment could carry future options.

- **Shell:** `afx://` must be typed on every remote send. `afx:///` for "this Tower" is easy to get wrong.
- **Short forms:** a URI has no natural relative form for "this Tower, other workspace", so in practice the in-workspace short forms remain a second grammar beside it.
- **Agents:** reliable. Agents write URIs well.
- **Rename and future component:** the same as A1. The authority could later carry `owner@tower`.
- **Migration:** every cross-workspace form changes shape.
- **Verdict:** not recommended as the grammar. But A2 is **A1 with a prefix**: `afx://devvm/codev/architect:local` can be added later as a pure alternative *spelling* of the same address, for linkable contexts, with no grammar change. Choosing A1 keeps that door open at no cost.

#### A3: Email-like (`agent@workspace.tower`)

Familiar, and `@` reads clearly as "somewhere else".

- **Hierarchy:** it runs narrow-to-broad, so tab completion must complete the agent before the workspace is known, which is backwards for a shell.
- **Dots:** using `.` between workspace and Tower forbids dots in workspace names. Real workspaces have them (`iaser.ai`, `cluesmith.com`, `codevos.ai`), so this forces renames, and example 9 becomes ambiguous.
- **Agents:** they may "correct" it into a real email address.
- **Future component:** good: append a right-hand label.
- **Verdict:** not recommended.

#### A4: Dotted DNS-style (`name.kind.workspace.tower`)

Fully right-anchored like DNS, with the kind as a label.

- It inherits A3's dot problem in full, every form changes, and `ob-refine.architect` versus `architect.marketmaker` needs positional rules to tell name-kind from kind-workspace.
- Agents may read it as a hostname.
- **Verdict:** not recommended.

#### A5: Short handles resolved through a directory (`@alice`, `@vm`)

The shortest form, and it survives renames when a handle maps to a stable id.

- A handle works only after someone defines it. That needs a per-owner directory, local or in the cloud.
- Provenance and replies still need a canonical, handle-free form, because my handle `@alice` means nothing on Alice's Tower.
- **Verdict:** a convenience *layer* over a canonical grammar, not a grammar. Not recommended now. It is compatible with A1 later, as a handle that expands to an A1 address.

#### A6: Colon-separated, extended (`[tower:]workspace:agent`)

The status quo, extended.

- `a:b:c` is either Tower-workspace-agent or workspace-plus-`architect:<name>`, and only the literal word `architect` tells them apart. That is exactly the overload #1605 and this brief describe, made worse.
- **Verdict:** rejected. It is the baseline the others are measured against.

#### Comparison

| Criterion | A1 Path | A2 URI | A3 Email | A4 DNS | A5 Handles | A6 Colons |
|---|---|---|---|---|---|---|
| Typing at a shell (quoting, length) | no quoting; shortest | no quoting; `afx://` on every remote send | no quoting; short | no quoting; long | shortest, once defined | no quoting; short |
| Tab completion | natural (broad → narrow) | after the prefix | backwards | backwards | over defined handles | ambiguous |
| An agent writing it reliably in a reply | high | high | medium (looks like email) | medium (looks like a host) | low (handles are per-owner) | low (ambiguous) |
| Short and relative forms | from the segment count | none for "this Tower"; needs a second grammar | natural | natural | n/a | ambiguous |
| Surviving a rename | the same for all: names over stable ids, old names fail loudly | same | same | same | best (handle → id) | same |
| Room for a future component | reserved leading segment | authority userinfo | trailing label | trailing label | n/a | none |
| Migration from today | minimal: `:` → `/` for the cross-workspace form only | every cross-workspace form | reorder, plus renames for dotted names | everything | additive | n/a (it is today) |

**Recommendation: A1, the path-like right-anchored grammar.** A2 can be adopted later as a spelling of A1 if a linkable form is wanted (Q3).

#### The recommended grammar in full

```
address   := [ [ tower "/" ] workspace "/" ] agent        ; 1–3 segments, read right to left
                                                          ; 4+ segments: reserved (owner/org), refused for now
agent     := "architect" | "arch"                         ; contextual, see the resolution rules
           | "architect:" arch-name                       ; a named architect
           | builder-ref                                  ; canonical builder-<protocol>-<id>, or its tail (spir-42, 42)
           | shell-id
tower     := the Tower's Codev Cloud slug                 ; globally unique, [a-z0-9-]
workspace := ws-name                                      ; unique per Tower
ws-name   := [a-z0-9] [a-z0-9._-]{0,63}, not "." or ".."  ; lowercase; dots allowed
arch-name := [a-z] [a-z0-9-]{0,63}                        ; unchanged (Spec 755)
```

Matching is case-insensitive and stored lowercase, as today.

The **canonical** form of an agent is what provenance shows and what is stored on mailbox rows. It is always kind-explicit:

- `architect:<name>`;
- the canonical builder id `builder-<protocol>-<id>`;
- the shell id.

Short forms (`architect`, `arch`, `spir-42`, `42`) are resolution inputs only. They are never shown as provenance.

#### Resolution rules

| Segments | Resolves | Rules |
|---|---|---|
| 1 (`agent`) | in the sender's workspace | Exactly today's rules: Spec 755 affinity for bare `architect` from a builder; the spoofing rule for `architect:<name>` from a builder; builder exact match, then tail match (an ambiguous tail is `AMBIGUOUS`); shells. |
| 2 (`ws/agent`) | in workspace `ws` on this Tower | If `ws` is the sender's own workspace, identical to the 1-segment form (affinity and spoofing apply). Otherwise: bare `architect` means that workspace's `main`, else its first registered architect (unchanged); `architect:<name>` means that named architect (**new**, goal 1), for architect and human-shell senders; builders and shells as in the 1-segment form. **The builder rule generalizes Spec 755:** a builder may name an architect only if it is its own spawning architect, in any workspace or on any Tower. Elsewhere it uses the front door, `ws/architect`. This keeps builders' reach exactly where it is today (Q7). |
| 3 (`tower/ws/agent`) | on Tower `tower` | If `tower` is this Tower's own name: identical to the 2-segment form, with no cloud contact. Otherwise the sender's Tower relays it (Part D), and the receiving Tower resolves `ws/agent` under its own rules **for a remote sender**: no affinity, so bare `architect` means `main`, and then its authorization (Part C). |
| 4 or more | — | `rejected: reserved-form`. |

- **Legacy `<ws>:<agent>`.** This is a single segment containing `:` whose left side is not `architect`. It is accepted as `<ws>/<agent>`. Each use returns a deprecation notice in the response, which the CLI prints to stderr, naming the replacement. The workspace is matched as today, by registered name.
  - The edge case of a workspace literally named `architect` keeps today's reading of `architect:<x>` (a named architect). Such a workspace is reachable as `architect/<agent>`.
  - How long the legacy form survives is Q10.
- **Colons in multi-segment addresses.** The legacy colon form is honoured **only in a 1-segment address**. In a multi-segment address a colon is valid only as the `architect:<name>` agent segment. Anything else is a malformed address, with a purposeful error:
  - `devvm/codev:architect`;
  - `shannon/marketmaker:architect`;
  - a colon in a Tower or workspace segment.
- **Errors** are loud and specific, and never a fallback:
  - `NOT_FOUND` lists, for a local workspace, the registered workspace names or that workspace's architects;
  - `AMBIGUOUS` lists the candidates;
  - `NO_CONTEXT`;
  - `WORKSPACE_UNNAMED` says how to name the workspace;
  - `RESERVED_FORM`;
  - remote rejections as defined in Part D.

#### Workspace and Tower names

- **Workspace name.** This is the Tower's registry entry for the workspace. The registry already has a `name` column, keyed by the `workspaceKey()` path. It is unique per Tower. Precedence:
  1. a name a human set on this Tower;
  2. a name pinned in the workspace's committed Codev config, which travels with the repository and so survives moves and re-clones;
  3. the lowercased path basename, if it fits `ws-name` and is unique.

  Otherwise the workspace is **unnamed**: it works normally, but it cannot be addressed from outside itself until a human names it. There is no silent `-2` suffix.

  The contract is deterministic, and it never takes a valid address away as a side effect:
  1. **Assignment is persistent.** A name, once assigned to a workspace, is stored in the registry and kept until a human changes it, a changed pin re-applies (rule 4), or the workspace is removed.
  2. **First holder keeps it.** An automatic name (pinned or basename) is assigned only if no other workspace holds it. A workspace registering later whose automatic name is taken is left unnamed, and the error names the holder. Registering a new clone never invalidates an existing workspace's address.
  3. **Humans never steal.** Setting a name another workspace holds fails loudly. The human must rename or remove the holder first.
  4. **Pins re-apply only if free.** A pin added or changed in config is applied on the next registration if the name is free. If it is taken, the workspace keeps its current name and the conflict is reported.
  5. **One directory is one workspace.** Registry rows that resolve to the same real directory (symlinks, trailing slashes, `/tmp` against `/private/tmp`) are one workspace for naming, so a workspace never collides with itself. Full path-independence on POSIX depends on #1870.
  6. **Upgrade.** Workspaces that already collide on basename at upgrade are all left unnamed. They are `AMBIGUOUS` today, so nothing that worked before stops working.

  Renaming a workspace changes only its label. Grants and mailbox rows key on the registry identity, not the label. The old name simply stops resolving, and the resulting `NOT_FOUND` lists the current names.
- **Tower name.** This is the Tower's Codev Cloud slug. It is globally unique and canonical per #1871. A Tower with no cloud registration has no Tower name: 3-segment addresses are unavailable on it (a loud error pointing at `afx tower connect`), while 1- and 2-segment addressing is unaffected.
  - A rename in the cloud re-slugs the Tower. The old slug fails as `unknown-tower`, and for the owner's own account the error lists the account's current Tower names.
  - Trust records and grants key on the stable `towerId` and owner user id, so a rename never breaks trust. It only breaks addresses typed with the old name, and loudly.

#### Provenance: how the recipient sees the sender

- The frame names the sender by **the shortest address that, typed by the recipient, reaches the sender**:
  - the bare canonical agent, within one workspace;
  - `ws/agent`, across workspaces;
  - `tower/ws/agent`, across Towers.

  So the provenance *is* the reply address.
- The reply hint is the shortest address **the recipient is permitted to use** that reaches the sender. For a builder recipient that is never a named architect other than its own spawning architect. When nothing permitted reaches the sender, the hint says to reply through the recipient's own architect. The hint never suggests an address the recipient's send would refuse.
- Remote frames carry a distinct **REMOTE** marker. Frames from another owner also carry that owner's **cloud-verified email**. The receiving Tower attests to that email; the agent name is only the sending Tower's claim (see Part C, "Provenance and spoofing").
- A remote body cannot contain a line the recipient would read as a frame delimiter. The receiving Tower neutralizes delimiter-shaped lines in remote bodies, so a body cannot forge a local header after the real one.
- `afx inbox`, the message-bus frames the dashboard reads, and Tower logs show sender and recipient in the same grammar. Mailbox rows store origin as structured fields (Tower, workspace, agent, owner, remote message id), not as a concatenated string.

The exact frame wording is plan-level. The invariants above are spec-level.

#### Answering #1605 (front door only)

#1605 argued that per-name cross-workspace addressing breaks **encapsulation** (seats come and go) and bypasses a **single trust ingress** (claims Tower cannot attest). This design reverses its out-of-scope clause for the owner's own workspaces, as goal 1 asks. Each argument is answered:

- **Encapsulation.** `ws/architect` stays the stable public front door, and nothing about it changes. Naming a seat directly is the sender's explicit choice, and a seat that has gone fails loudly with the current architect list. That is the same contract `architect:<name>` already has inside a workspace.
- **Trust ingress.** On one Tower every workspace belongs to the same owner, and every cross-workspace frame now *states* its origin (`codev/architect:local`), so the receiving seat can apply its own scrutiny.
  - Named seats are opened to **architects and human shells** only. Builders keep the front door, so a prompt-injected builder gains no new direct line to any seat (Q7).
  - For other owners (stage 3) the front door *is* the default: a grant names exactly the scope it admits, and `ws/architect` is the natural one.
- **Opt-out.** A workspace that wants front-door-only behaviour can declare it in its config. Its named seats then refuse senders from other workspaces with a purposeful error that names the front door. That error is #1605's requested change 1.

#1605's requested error message and documentation are subsumed by stage 1 (Q5).

### Part B: Discovery

**Question:** which Towers can I reach, which workspaces and agents are live on them, and how much does each side reveal?

| Approach | Description | Verdict |
|---|---|---|
| B1: Cloud directory plus on-demand pull **(recommended)** | The cloud lists the Towers I may reach: my own, plus other owners' Towers that granted me. For **my own** online Towers it fetches workspace names and live agents from the Tower through its tunnel on request, extending today's owner-only `GET /api/projects` pull, and stores nothing. For **other owners' Towers** it returns only what the grant names, plus online/offline. | Reuses what exists. Disclosure follows ownership. |
| B2: Towers publish metadata to the cloud | Each Tower pushes its workspaces and agents. The cloud stores and serves them. | The cloud would store a live map of what every owner is working on. The push endpoint the Tower calls today does not even exist. |
| B3: Ask the remote Tower directly | The sender's Tower sends a "list" request through the relay to the remote Tower, which answers according to its own policy. | Accurate, and the remote Tower controls disclosure, but every listing costs a relay round-trip. Useful later. Not needed now. |

**What is revealed, and to whom:**

| Viewer | Sees about a Tower | Never sees |
|---|---|---|
| Its owner | name, online/offline, workspace names, architects by name, live builder ids | — |
| Another owner holding a grant | Tower name, owner email, the granted scopes (`ansari/architect`), online/offline | other workspaces, builder ids, unlisted architects, whether an ungranted name exists |
| Anyone else | nothing; addressing that Tower yields `not-authorized` | — |

Online/offline status is unavoidably revealed to grantees, because `queued: tower-offline` reveals it. This is stated, not hidden.

**Local discovery for stage 1.** This Tower's addressable workspace names and their architects, listed as full addresses, are part of stage 1 (a success criterion). They come from Tower, not the cloud. A Tower listing command for stage 2 shows my Towers and their agents through B1. Shell tab completion is a natural later addition and is not required.

### Part C: The security model

#### Identity

- **Tower.** The cloud's `towerId` (ULID), proven to the cloud by the Tower's `ctk_` key on every relay call, over TLS. The name (slug) is a label over it.
- **Owner.** The cloud `userId`. Between owners it is presented as the account's **verified email**. Grants are *entered* by email but *bound* to a `userId`:
  - A pending email grant binds to the first account that presents that verified email in an attested delivery. The receiving Tower records the `userId` at that moment.
  - From then on the grant follows that `userId`. A later email change keeps the grant, and the frame shows the current verified email.
  - Account deletion voids the grant. The cloud reports a `userId` that no longer exists, and the Tower treats it as revoked.
  - A different account that later verifies a released email never inherits a grant already bound to a `userId`.
- **Agent.** The sending Tower asserts it, exactly as `from` is asserted locally today. Builders are verified against `global.db`, and architects come from `CODEV_ARCHITECT_NAME`. The receiving Tower can verify the owner and the Tower, through the cloud's attestation. It can never verify the agent name, so provenance labels the agent as the sending Tower's claim.

#### Trust model alternatives

| Approach | Description | Trade-offs |
|---|---|---|
| R1: Cloud-attested identity, signed per tunnel session, policy enforced at both ends **(recommended)** | The cloud authenticates the sending Tower and enforces coarse policy: same owner, or an active grant between the two. It attaches an **attestation** to the relayed delivery: the origin `towerId`, `userId` and verified email, the message id, a timestamp and a hash of the body. It **MACs** the attestation with a secret it issued to the receiving Tower in that tunnel's authenticated handshake. The secret lives in memory on both ends, is never written to disk, and is replaced on every reconnect. The receiving Tower verifies the MAC, rejects stale or replayed attestations, then re-checks its own policy (below). | Little key management: no pairing and no per-peer keys, one secret per tunnel session. It relies on the cloud for identity, but **the cloud is already in every connected Tower's trusted computing base**: the tunnel can drive any local route with the local key stamped. R1 adds no new trust in the cloud. The MAC makes the Tower's check **real** rather than nominal: owner-proxied browser traffic and local callers do not hold the session secret, so neither can fabricate a relay delivery. A cloud *bug* in proxy separation therefore yields a refused delivery, not a message. The Tower's own grants bound what any relay mistake can deliver. |
| R2: Pinned Tower keypairs with end-to-end signatures (optionally encryption) | Each Tower holds a signing key. Peers pin each other's public keys at pairing, with out-of-band fingerprint checks between owners. Messages are signed and verified end to end, and the cloud only routes. | Protects against a *malicious* cloud forging messages. But while the tunnel lets the cloud drive terminals, a malicious cloud does not need to forge messages. Adds key generation, storage, rotation, reinstall re-pairing and fingerprint UX. Worth revisiting only if a "messaging-only" connection mode, without the owner proxy, is ever offered (Q4). |
| R3: Cloud-only policy (the Tower trusts the relay) | The cloud decides everything, and the Tower delivers whatever arrives on the relay route. | Rejected. The brief requires that the Tower not trust the relay blindly, and one cloud authorization bug would expose every Tower's agents. |

#### Trust establishment

- **My own Towers.** Towers registered to the same cloud account trust each other **by default**: every agent can reach every agent, with direct delivery. This is parity with local messaging. Each Tower can switch off same-owner inbound, or narrow it.
  - The argument for default-on: the owner's cloud session already grants full terminal access to all their Towers.
  - The argument against, which Q2 surfaces honestly: today a stolen `ctk_` key reaches nothing beyond impersonating that one Tower's tunnel. With default same-owner trust, it can inject messages into agents on all of the owner's Towers.
- **Other owners' Towers: alternatives.**

| Approach | Description | Trade-offs |
|---|---|---|
| E1: Allow-list by verified email **(recommended)** | A human on the receiving side grants `alice@example.com` a scope on this Tower. The cloud records a coarse pairing, pending until an account with that verified email exists. Alice's Tower listing then shows what she may reach. | One action, on one side. Doubles as discovery. Binds to a verified identity. A typo grants a stranger nothing until that exact email verifies an account, and the cloud never confirms whether an email has an account. |
| E2: Email-bound one-time invitation | The receiving side creates an invite for a scope and an email. The invitee redeems the code on their side. | Two-party consent, and the invitee knows explicitly. Adds a code hand-off step, and a stolen code is useless only if it is email-bound. |
| E3: Cloud-mediated contact request | The sender requests access in the cloud UI, and the receiver approves. | Lets strangers ask for access, which is a spam and social-engineering surface. Needs cloud UI work. |

- **Grant shape.** A grant is a **capability record**, not a boolean:
  - **subject:** another owner, optionally narrowed to one of their Towers;
  - **scope:** one workspace's front door `ws/architect`, one named architect `ws/architect:<name>`, or all of a workspace's architects (written `ws/architects` in a grant; this is a scope notation, not an address);
  - **delivery mode:** `hold` (the default) or `direct`;
  - **issued-by** and **issued-at**.

  Builders are not a grantable scope (Q6). Grants live on the **receiving Tower**, which is the source of truth for fine-grained authorization and is keyed by workspace registry identity, so a workspace rename keeps its grants. They are mirrored to the cloud only as a coarse pairing ("owner X may send to Tower Y").
- **Who may change trust.** Granting, narrowing and revoking are **human actions**, offered through interactive surfaces: the dashboard, and an interactive CLI confirmation that refuses a non-interactive shell. They are never reachable from `afx send`, a message body or any automatic path. Every change is audited.
- **Reply path.** Sending a message from my agent X to a remote agent Y opens, on my Tower, a reply path admitting messages **from exactly Y to exactly X** for a window (7 days suggested; Q12). It needs no grant.
  - It applies only to other owners. Same-owner traffic needs no reply path.
  - A reply-path message is delivered in my delivery mode for that owner: the mode of my grant to them if I have one, otherwise **`hold`**. A reply from a stranger I messaged first still waits for my release unless I chose `direct` for them.

#### Authorization: who may message whom

| Sender ↓ / Target → | Architect, same Tower | Builder, same Tower | Architect, own other Tower | Builder, own other Tower | Another owner's architect | Another owner's builder |
|---|---|---|---|---|---|---|
| Architect or human shell | ✓ | ✓ | ✓ (default trust) | ✓ (default trust) | only with a grant covering it, or on a reply path | ✗ |
| Builder | by name only its own spawning architect; otherwise front doors (`architect`, `ws/architect`) | ✓ | front doors (`tower/ws/architect`) | ✓ (default trust) | ✗, refused at the sending Tower | ✗ |

- **Builders name no architect but their own** (Q7). In every position a builder can name only its own spawning architect. Elsewhere it reaches front doors, which is today's reach, unchanged by stage 1.
- **Builders never originate cross-owner messages** (Q7). A builder takes direction from its architect, and the architect can relay. This also keeps a prompt-injected builder from exfiltrating to a trusted peer.
- **A remote sender never gets affinity routing.** Bare `architect` from a remote sender always means `main`.

#### Provenance and spoofing: the cross-Tower equivalent of Spec 755's rule

1. **A remote message is never local.** It arrives only on the relay route, is persisted with remote origin fields, and is framed REMOTE. It can never satisfy a local identity check or be attributed to a local agent.
2. **Each party vouches only for what it can check.**
   - The cloud attests the Tower and the owner.
   - The sending Tower asserts the agent.
   - The frame shows the attested owner and Tower and the claimed agent, labelled as such.
3. **The relay route accepts only verified relay traffic.** It accepts a request only if its attestation MAC verifies against the current tunnel session's secret, and its timestamp and message id are fresh. The proxy marker alone is not trusted: a local caller can set any header, and the owner proxy forwards arbitrary browser headers.
   - **This defends against:** owner-proxied browser traffic, local callers, and replays.
   - **It does not defend against:** a malicious cloud, which is in the trusted computing base, as Q4 states.
   - **The cloud must still:**
     - strip attestation headers from owner-proxied browser traffic;
     - refuse to forward the relay route through the owner proxy;
     - never deliver peer traffic through the owner-proxied path (`/api/send`).

   These are explicit cloud obligations (Part D), and the MAC is the Tower's independent check on them.
4. **No forged frames.** Delimiter-shaped lines in remote bodies are neutralized, and `raw` is refused for remote messages, because a raw body carries no provenance.
5. **The Spec 755 rule is unchanged inside the sender's own workspace,** and stays enforced by the sender's Tower.

#### Revocation, rate limiting and audit

- **Revocation.**
  - Revoking a grant takes effect at the receiving Tower **immediately**, independent of the cloud.
  - Revocation is mirrored to the cloud, which stops forwarding.
  - Blocking a peer Tower or owner is a local deny that overrides any grant.
  - Deregistering or deleting a Tower in the cloud ends all its trust.
  - Reply paths expire by time and are cleared when that peer is revoked.
  - Messages from a revoked owner that are still held for release are marked dismissed, not delivered.
- **Rate limiting** happens at two points:
  - **in the cloud:** per sending Tower, and per Tower pair;
  - **on the receiving Tower:** a per-peer-owner token bucket, plus a cap on messages held for release per peer (indicative defaults: 30 a minute and 50 held, configurable).

  Exceeding a limit yields `rejected: rate-limited` or `rejected: queue-full`. The 48 KB body cap applies at all three points.
- **Audit.** There are three records:

| Where | Record | Contents |
|---|---|---|
| Receiving Tower | the mailbox row | Every **accepted** remote message (delivered or held), with origin Tower id and name, owner id and email, claimed agent, remote message id and outcome. This is the record that already exists for every local send. |
| Receiving Tower | the inbound relay log | Every relay attempt **including rejected ones**, as metadata only: time, origin Tower, owner, claimed agent, message id, size, the target as written, the outcome and its reason. **No body.** A rejected attempt is not a mailbox row: nothing deliverable is kept. The target as written stays on the receiving owner's own machine and is never echoed to the sender. |
| Sending Tower | an outbox record | Every outbound remote message and its outcomes. |
| Cloud | a relay log | **Metadata only:** time, sending and receiving Tower, owner ids, message id, size, outcome. Never bodies. Each owner can see the entries for their own traffic. Retention is Q13. |

  Grant and trust changes are audited on the receiving Tower.

#### The human in the loop

| Approach | Description | Verdict |
|---|---|---|
| H1: Hold for release by default for other owners, per grant **(recommended)** | Messages from other owners become `held: awaiting-release`. A human releases or dismisses each one, and released messages go through the normal gate. A grant may opt into `direct`. Same-owner messages deliver directly. | Puts the human between a stranger's text and an agent with shell, without blocking trusted collaborators who choose `direct`. Reuses the mailbox, `afx inbox` and the dashboard's held-mail indicator. |
| H2: Always deliver directly; grants are the only control | Simplest. | One compromised collaborator machine becomes shell on mine. |
| H3: Always hold, with no `direct` option | Safest. | Makes real-time collaboration tedious, and owners would route around it. |

The release action must be human-only, exactly like trust changes: it is offered through the dashboard and an interactive confirmation, and refused from a non-interactive shell.

### Part D: Transport and delivery semantics

#### Transport alternatives

| Approach | Description | Verdict |
|---|---|---|
| T1: Cloud relay with a sender-side outbox **(recommended)** | **Outbound:** the sending Tower calls a new cloud relay API over HTTPS, authenticated with its `ctk_` key. This is needed because the role-reversed HTTP/2 tunnel cannot carry Tower-initiated requests. **Inbound:** the cloud forwards to the receiving Tower over that Tower's existing tunnel session, on a dedicated relay route. Both legs pass through the cloud: one choke point. Mail for an unreachable Tower waits in the **sender's** outbox and is retried. | Bodies never rest on the cloud's disk. Survives cloud deploys (which drop every tunnel) and laptops that sleep. Matches the mailbox-first philosophy: a known recipient's mail is kept, not dropped. |
| T2: Cloud relay with cloud store-and-forward | The cloud persists undeliverable envelopes and delivers them when the target reconnects. | The cloud would store bodies (instructions for shell-capable agents) at rest, and it is single-instance and restarts on every deploy. |
| T3: Cloud relay, fail fast when offline | `rejected: tower-offline` and nothing is kept, so the sending agent must remember to retry. | Simplest. But agents do not reliably retry, and laptops sleep. It would also contradict how the local mailbox treats a known-but-offline agent. |
| T4: Direct Tower-to-Tower (LAN, VPN, tailnet) | Towers connect to each other directly. | **Considered and set aside.** It would duplicate identity, authorization, NAT traversal and audit outside the single choke point. No requirement found here is unmet by the tunnel: messages are small, latency-tolerant and infrequent. Tower-to-Tower messaging is unavailable without Codev Cloud, which is accepted. |

#### Who is responsible for what

| Responsibility | Codev Cloud (the choke point) | Receiving Tower (trusts the relay only for what it cannot check) |
|---|---|---|
| Identity | authenticates the sending Tower by its `ctk_` key; attests `towerId`, `userId`, verified email; MACs the attestation with the receiving tunnel's session secret | verifies the MAC and freshness; rejects anything else on the relay route; binds pending email grants to the attested `userId` |
| Authorization | coarse: same owner, or an active pairing; **non-enumerating** (an unknown slug and an ungranted Tower answer alike) | fine-grained: its own grants, scopes, reply paths, blocks, same-owner switch; builder targets never admitted for other owners |
| Rate limiting | per sending Tower and per Tower pair | per peer owner, plus the held-for-release cap |
| Audit | relay log, metadata only | mailbox row with origin fields; trust-change log |
| Revocation | stops forwarding on revocation, deregistration or delete | effective immediately, regardless of the cloud |
| Size | 48 KB cap | 48 KB cap |
| Delivery | forwards, and returns the receiver's outcome synchronously | mailbox-first; render gate; per-terminal lock; framing and neutralization; refused options |

**What the cloud can read.** Message bodies are visible to the cloud in transit, because TLS terminates there. In this design the cloud does not store bodies (T1), never logs them, and keeps only relay metadata. That is no more than what the cloud already sees of the owner's terminal traffic through the tunnel. End-to-end body encryption is Q4.

**Work that lands in the codev-cloud repository:**

1. **A relay API** accepting Tower-key-authenticated envelopes. It:
   - resolves the target Tower by slug;
   - applies coarse authorization and rate limits;
   - forwards over the target's tunnel to the dedicated relay route, with attestation;
   - returns the receiver's outcome within a bounded timeout;
   - records the relay log.

   This is the first cloud API other than delete that a `ctk_` key may call.
2. **A per-session attestation secret.** The cloud issues it in the tunnel handshake (alongside `auth_ok`), holds it in memory only, and replaces it on every reconnect. It MACs every relay delivery's attestation with it.
3. **Separation of relay and owner-proxy traffic:**
   - strip attestation headers from proxied browser requests;
   - refuse the relay route on the owner proxy;
   - never route peer traffic to `/api/send`.
4. **The directory (B1):**
   - list the account's Towers with online state;
   - list other owners' Towers that granted me, with their scopes;
   - pull workspace and agent listings on demand from the owner's online Towers.
5. **The pairing registry:** coarse grants keyed by owner `userId` and `towerId`; email-pending entries that bind once to the first verified account; mirroring of revocations; reporting deleted accounts.
6. **Cross-instance routing** if the relay ever runs on more than one instance (pub/sub or sticky routing by tower). Not needed while it is single-instance.
7. **Optional:** answering a recently renamed slug for the owner's own account, so the error can name the new slug. Nice to have.

#### Delivery semantics

- **Envelope.** It carries:
  - a contract version;
  - a sender-assigned message id, which is the idempotency key;
  - the structured `from` (Tower, workspace, canonical agent);
  - the `to` address as written;
  - the body, after `--file` content is appended at the sender;
  - the send time.

  It carries no other options: everything except a plain gated send is refused for remote targets.
- **Callers other than `afx send`.** Cron targets and `afx interrupt` accept 1- and 2-segment addresses, and a 3-segment address naming this Tower. A remote Tower is refused for both in this design: cron at task load, and interrupt because it is an operator action on a local PTY.
- **Outcomes** returned to the sender (and printed by `afx send`):

| Outcome | Where the message is | Meaning |
|---|---|---|
| `delivered` | remote PTY, via the gate | the same as local, including the #1584/#1473 verification flags when present |
| `held: <reason>` | the remote mailbox | a local reason (`busy`, `no-live-pty`, `no-profile`), or `awaiting-release` (H1). The remote Tower delivers or releases it later. |
| `queued: <reason>` | the **sender's** outbox | `tower-offline`, `cloud-unreachable`, or `outcome-unknown` (the relay timed out after possibly persisting). It is retried with backoff for the retry window (24 hours suggested; Q12), then becomes `expired`. |
| `rejected: <reason>` | nowhere deliverable; recorded only as metadata in the relay logs | `unknown-tower`, `not-authorized`, `not-found` / `ambiguous` (own Towers only; other owners always see `not-authorized`), `rate-limited`, `queue-full`, `too-large`, `option-not-allowed`, `peer-unsupported`, `reserved-form`, `not-connected` (this Tower has no cloud registration) |

- **A non-enumerating decision rule.** Slugs are global, so the reason the sender sees depends on its relationship to the target Tower, never on whether something exists:

| Target Tower is… | Sender sees, for a bad Tower | Sender sees, for a bad target inside it |
|---|---|---|
| one of the sender's own Towers | `unknown-tower`, plus the list of own Towers | full detail: `not-found` / `ambiguous` |
| another owner's Tower that granted the sender something | — | `not-authorized`, identical for nonexistent and ungranted targets |
| any other slug, existing or not | `unknown-tower`, identical either way, with no list | — |

- **Idempotency.** The receiving Tower deduplicates on (origin `towerId`, message id). A retry of a message already persisted returns that row's current state and never delivers twice. This is what makes `outcome-unknown` retries safe.
  - Dedupe records are kept **strictly longer than the longest sender retry window**, and the retry window is bounded by that retention. Pruning can never make a late retry look new.
- **Ordering.** The sender's outbox relays queued messages to the same target agent in send order (FIFO per target agent), and a later message is not relayed while an earlier one to the same target is still queued. There is no ordering guarantee across targets.
- **What the sender learns, and when.** The sender gets the first outcome synchronously, which is parity with local `afx send`. A later delivery of a message held remotely is not pushed back to the sender in this design (Q14). Queued messages update locally as retries resolve, and a human can list and dismiss them.
- **Cloud or tunnel down.**
  - Stage 1 is unaffected, and so is every local or cross-workspace send.
  - Outbound remote sends go to `queued: cloud-unreachable` and retry.
  - Inbound remote messages wait in their senders' outboxes.
  - Nothing uses any other path.
- **Replies.** Every remote frame carries the sender's full `tower/ws/agent` reply address. A reply is an ordinary remote send, authorized by same-owner trust, a grant, or the reply path.

### Recommended design, in summary

| Decision | Recommendation |
|---|---|
| Address grammar | A1, path-like right-anchored `[[tower/]workspace/]agent`; legacy `<ws>:<agent>` deprecated; `architect:<name>` kept; a 4th leading segment reserved; `afx://` available later as a spelling |
| Names | Tower = cloud slug. Workspace = Tower-unique registry name (human-set, then config-pinned, then basename); unnamed rather than auto-suffixed |
| Provenance | The shortest reply address from the recipient's position; REMOTE marker; owner email for other owners; neutralized remote bodies |
| Discovery | B1: cloud directory plus on-demand pull; disclosure follows ownership and grants |
| Identity and trust | R1: cloud-attested Tower and owner, MAC-signed per tunnel session; sender-asserted agent; same owner trusted by default; other owners default-deny, E1 email allow-list; capability-shaped grants on the receiving Tower |
| Authorization | Builders name only their own spawning architect, anywhere, and otherwise use front doors; other owners reach architects only; builders never originate cross-owner messages; a remote sender never gets affinity routing |
| Human in the loop | H1: hold for release by default for other owners, `direct` per grant; release and trust changes are human-only actions |
| Transport | T1: cloud relay (HTTPS out, tunnel in) with a sender-side outbox, idempotent delivery, synchronous first outcome |

### Stages and what each depends on

| Stage | Headline | Depends on | Lands in |
|---|---|---|---|
| 1 | Named architects across workspaces on one Tower | nothing external | codev only: grammar, parser, workspace names, resolution, provenance, docs (CLAUDE.md/AGENTS.md and skeleton twins) |
| 2 | My Towers talk to my other Towers | stage 1's grammar; #1871 (canonical slug); cloud relay, session attestation secret, separation and directory (cloud items 1–4) | codev and codev-cloud |
| 3 | Another owner's Tower | stage 2; cloud pairing registry (item 5); owner decisions Q1, Q2, Q6, Q7, Q8 | codev and codev-cloud |

Stage 1 ships first, and nothing in it waits for stage 2 or 3. Stage 2 is usable among the owner's own Towers before stage 3 exists.

## Open Questions

### Critical (blocks progress)

1. **Posture toward messages from other owners (H1).** Hold for release by default, with `direct` opt-in per grant (recommended)? Or direct delivery by default, or always hold? This is the owner's central security decision.
2. **Default trust between my own Towers.** On by default, with a per-Tower opt-out (recommended, because the owner's cloud session already reaches all their Towers)? Or explicit opt-in on each Tower, which closes the escalation where one stolen `ctk_` key reaches agents on every Tower of that owner?
3. **The address grammar.** A1, path-like (recommended), or A2 `afx://`, or another candidate? If A1, should `afx://` also be accepted as an alternative spelling from the start, or only when a linkable surface needs it?
4. **Codev Cloud as the identity root between owners (R1).** Is it acceptable that the cloud attests owner identity, and can read bodies in transit (stored never, logged never)? Or does stage 3 require R2 pinned Tower keys, or end-to-end encryption?

### Important (shapes the design)

5. **Reversing #1605.** Confirm that named architects in my own workspaces are directly addressable from other workspaces, with a per-workspace front-door-only opt-out, and that #1605 is closed as superseded by stage 1.
6. **Builders and other owners.** Confirm that builders are never reachable by other owners in this design, rather than reachable as a grantable scope.
7. **Builder reach.** Confirm the builder rule, which keeps builders' reach exactly where it is today: in every position a builder may *name* only its own spawning architect, reaching any other workspace's or Tower's architects only through the front door (`ws/architect`, `tower/ws/architect`). Builders may send to the owner's other Towers, and never to other owners. Without this rule, stage 1 would let a builder name every architect seat on the Tower, since today only a parse failure stops it. The alternative is to let builders name any seat on the owner's own Towers, which is simpler to explain but widens what a prompt-injected builder can reach directly. The front-door opt-out in workspace config is no substitute, because it is per recipient workspace, not per sender kind.
8. **How trust is established with other owners.** E1, an email allow-list (recommended); E2, an email-bound invitation; or E3, a contact request in the cloud.
9. **Mail for an unreachable Tower.** A sender-side outbox with a retry window (recommended), or fail fast?
10. **Deprecating the legacy colon form.** How many releases does `<ws>:<agent>` keep working with a notice before it becomes an error? This spec says only "deprecated, then removed".
11. **#655.** Confirm that this spec subsumes #655's Tower-originated messaging, so #655 can close as superseded, with its web/mobile sender and Claude Channels ideas left to a new issue if still wanted.

### Nice to know (optimization)

12. The default windows: reply path (7 days suggested) and outbox retry (24 hours suggested).
13. Retention of the cloud's relay log.
14. Pushing delivery receipts back to the sender when a remotely held message is later delivered, released or dismissed.
15. Shell tab completion for addresses, and A5 handles as a later convenience layer.

## Test Scenarios

### Grammar and resolution (unit tests; Windows included)

1. **Every row of the address table.**
   - Forms 1–9 under A1 parse to the expected (Tower, workspace, agent).
   - `a/b/c/d` gives `reserved-form`.
   - Empty segments (`a//b`), `.`, `..`, a leading `-`, and uppercase input (normalized) each behave as specified.
   - Mixed grammar: `devvm/codev:architect`, `shannon/marketmaker:architect` and `dev:vm/codev/architect` each fail as malformed, with a purposeful error, never a quiet `NOT_FOUND`.
2. **Legacy forms.**
   - `marketmaker:architect` and `codev-public:spir-42` resolve as today, with a deprecation notice.
   - `architect:ob-refine` resolves with no notice.
   - A workspace literally named `architect` is reachable as `architect/<agent>`.
3. **Spec 755 regression matrix.**
   - Single architect; multiple architects with affinity; legacy builder; architect gone.
   - The builder rule rejects `architect:x`, `<own-ws>/architect:x`, `<other-ws>/architect:x` and `<tower>/<ws>/architect:x` from a builder not spawned by `x`.
   - A builder sending `<other-ws>/architect` (the front door) is allowed.
   - An architect or human shell sending `<other-ws>/architect:x` is allowed.
4. **Workspace names.**
   - Collision on registration. `/a/codev` is registered and named `codev`; `/b/codev` registers later. `/a/codev` keeps `codev`; `/b/codev` is unnamed, and the error names the holder and how to set a name.
   - Collision at upgrade. Two pre-existing `codev` workspaces are both unnamed after upgrade, and both were `AMBIGUOUS` before.
   - Humans never steal. Setting `/b/codev`'s name to `codev` fails while `/a/codev` holds it. Setting it to `codev-b` succeeds.
   - Precedence. A human-set name wins over a pinned config name, which wins over the basename. A newly added pin applies on the next registration only if it is free.
   - Same directory, two spellings. On macOS, `/tmp/ws` and `/private/tmp/ws` (or a symlinked path) registered as two rows are one workspace for naming and never collide with each other.
   - A rename makes the old name `NOT_FOUND`, listing the current names.
   - Windows: `C:\repo` and `c:\repo` give the same name.
5. **Fail fast.** No 2- or 3-segment address that fails to resolve ever falls back to `main` or to the sender's workspace.

### Stage 1 (integration, one Tower)

6. **The headline path.** `codev/architect:local` → `shannon/architect:ob-refine`:
   - delivered through the mailbox and gate;
   - the frame names `codev/architect:local`;
   - the reply via the frame's address lands in `local`;
   - no `cloud-config.json` exists.
7. **Builder-bound cross-workspace frame.** From `marketmaker/architect:main` (the front door's architect) to a builder in `codev`: the frame names `marketmaker/architect:main` and the reply hint is `marketmaker/architect`, the address the builder may use. From a named seat `shannon/architect:ob-refine`, which the builder may not name: the hint says to reply through its own architect. The hint never names an address the builder's send would refuse. The frame stays within 3 lines and 256 bytes (#1567).
8. **Front-door opt-out.** A workspace configured front-door-only rejects `ws/architect:<name>` from another workspace, with the purposeful error. `ws/architect` still works.
9. **Cron.** A cron target written in the new grammar and one in the legacy grammar both deliver. A 3-segment cron target is refused at load with a clear error.

### Stage 2 (integration with a mock relay; then a real two-Tower manual pass)

10. **Real two-Tower headline.** Laptop → dev VM `local` and back, with REMOTE framing and `tower/ws/agent` provenance on both sides.
11. **Target Tower stopped.** `queued: tower-offline`. Restart it and the message delivers once. Past the retry window it is `expired`, and it is listable and dismissable.
12. **Relay timeout after the receiver persisted.** `queued: outcome-unknown`. The retry returns the existing row's state, with exactly one delivery.
13. **Cloud unreachable.**
    - Remote sends: `queued: cloud-unreachable`.
    - Local and cross-workspace sends: unaffected.
14. **Refused options to a remote target.** `--raw`, `--interrupt`, ESC, `--no-enter`, `--delay` and `--all` each give `rejected: option-not-allowed`.
15. **Addressing my own Tower by name.** A 3-segment address naming this Tower resolves locally, with zero relay calls.
16. **Not connected.** A Tower with no cloud registration sending a 3-segment address: `rejected: not-connected`, pointing at `afx tower connect`.
17. **Unknown Tower.** A typo of one of my own Towers' names gives `rejected: unknown-tower`, listing the account's Towers. For slugs that are not mine, see test 21: no list.
18. **Origin checks on the relay route.**
    - A local caller posting to the relay route, even with the proxy marker and well-formed attestation headers, is refused: no valid session MAC.
    - Owner-proxied traffic carrying forged attestation headers is refused **by the Tower**, because it has no valid MAC. This is tested with the cloud's header stripping disabled, to prove the Tower's check stands alone.
    - A replayed relay delivery (same MAC, stale timestamp or a seen message id) is refused or deduplicated.
    - An attestation MAC'd under a previous tunnel session's secret is refused after a reconnect.
19. **Version skew.** A peer on an older Codev without the relay route: `rejected: peer-unsupported`.
20. **Mailbox-first on the receiver.** The row exists before the delivery attempt, a busy recipient gives `held: busy`, and the render gate and per-terminal lock are honoured (no direct PTY write). This reuses the Spec 1313 test harness.
20a. **Dedupe retention.** A retry arriving just inside the maximum retry window, after ordinary mailbox pruning has run, is still recognized as a duplicate.
20b. **Ordering.** Three messages to one remote agent, queued while its Tower is offline, are delivered in send order when it returns. A fourth message, to a different agent, is not held back by them.

### Stage 3 (integration with a mock relay attesting two owners; then a real two-account manual pass)

21. **No grant, and no enumeration.**
    - Alice addresses `bob-mbp`, which exists but has granted her nothing, and `no-such-tower`, which does not exist. Both give `rejected: unknown-tower`, byte-identical apart from the timestamp, and neither lists any Towers.
    - On a Tower that granted Alice `ansari/architect`, an ungranted existing workspace and a non-existent one both give an identical `not-authorized`.
    - The receiving Tower's inbound relay log records each rejected attempt as metadata, with no body.
21a. **Email grant binding.**
    - A grant to `alice@example.com` binds on Alice's first attested delivery.
    - After Alice changes her email, her messages are still admitted, and the frame shows the new email.
    - After Alice's account is deleted and a new account verifies `alice@example.com`, the new account is `not-authorized`.
22. **Grant scoped to `ansari/architect`.**
    - `ansari/architect` is admitted and held for release.
    - `ansari/architect:other` is `not-authorized`.
    - `ansari/spir-42` is `not-authorized`.
23. **Release, through the human surfaces.** Bob sees the held message on the dashboard and in the interactive CLI, and reads its body.
    - A release delivers through the gate.
    - A dismiss never delivers.
    - A release attempted from a non-interactive shell is refused.
    - Grants can be created, listed and revoked through the same surfaces, with no file or database editing.
24. **Direct grant.** A `direct` grant delivers without a hold.
25. **Revocation.** Revoke on the receiving Tower while the cloud (mocked) still forwards: the next message is `not-authorized`, and messages still held for release become dismissed.
26. **Reply path.**
    - A reply from exactly the agent I messaged is admitted within the window.
    - A message from another agent on that Tower is not.
    - After the window, neither is.
    - With no grant to that owner, the admitted reply is `held: awaiting-release`. With a `direct` grant to them, it delivers directly.
27. **Forged frames.** A remote body containing `### [ARCHITECT:main MESSAGE → main | …] ###` is neutralized in the delivered frame.
28. **Builder origination.** A builder addressing another owner's Tower is refused at the sending Tower, and nothing reaches the relay.
29. **Flood.** Exceeding the per-peer rate gives `rate-limited`. Exceeding the held cap gives `queue-full`. Other peers and local senders are unaffected.
30. **Frame for another owner.** It shows the verified email and Tower, and is distinct from a same-owner REMOTE frame.

### Non-functional

31. **Latency.** Local and cross-workspace sends show no regression; a single-architect workspace keeps its fast path.
32. **Bodies are never stored or logged by the cloud.** Asserted in the cloud's relay tests.
33. **Size.** A 48 KB + 1 byte body is refused by the sender's CLI, the cloud and the receiving Tower, each independently.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| A remote message prompt-injects an agent with shell access | Medium | High | Other owners are default-deny and held for release by default (H1); scopes are architects only; frames are visibly REMOTE with the attested owner; frame forgery is neutralized; `raw` and the bypass options are refused; rate and held-queue caps apply |
| A cloud authorization bug delivers beyond what the owner granted | Low | High | The receiving Tower re-checks its own grants, scopes, blocks and reply paths (R1), so a relay mistake can deliver nothing the Tower would not admit |
| The cloud routes peer traffic through the owner proxy (local key stamped) | Low | Critical | An explicit cloud obligation (separation, item 3), independently checked by the Tower: a relay delivery must carry an attestation MAC under the tunnel session's secret, which owner-proxied browser traffic cannot produce; tested on both sides |
| A stolen `ctk_` key reaches agents on all of the owner's Towers | Low | High | Surfaced as Q2; per-Tower opt-out of same-owner inbound; revoking the key in the cloud ends it; the relay log records sends by origin Tower |
| An agent changes trust or releases held mail on its owner's behalf | Medium | High | Trust changes and releases are human-only interactive actions, never reachable through `afx send` or message content, and audited. The residual limit is stated: an agent running as the owner can in principle do what the owner can |
| Duplicate delivery after a relay timeout | Medium | Medium | Idempotent delivery keyed by (origin Tower, message id); dedupe records kept longer than the longest retry window |
| An email address is reused by a different account and inherits a grant | Low | High | A grant binds once to the first verified `userId` and follows that id, never the email; a deleted account voids it |
| Stage 1 silently widens what a prompt-injected builder can reach | Medium | Medium | The builder rule keeps builders on front doors outside their own spawning architect; surfaced as Q7 rather than decided in a table row |
| One macOS directory registered under two spellings collides with itself and becomes unaddressable | Medium | Medium | Rows that resolve to the same real directory are one workspace for naming; full POSIX canonicalization is #1870 |
| Remote messages to one agent arrive out of order after retries | Medium | Low | FIFO per target agent in the sender's outbox |
| A cloud deploy drops every tunnel mid-conversation | High | Low | Sender-side outbox with retry; `queued` is visible, not silent |
| The cloud scales to several instances and the relay cannot reach a tunnel on another instance | Low (single-instance today) | High | Cloud item 6 must land before any scale-out; named as a cloud dependency |
| Legacy colon forms in prompts, docs and cron files break | Medium | Medium | The legacy form keeps working with a deprecation notice; docs and both template trees are updated in stage 1; removal timing is the owner's call (Q10) |
| Workspace-name collisions make addresses unpredictable | Medium | Medium | No auto-suffix: an unnamed workspace with a loud, actionable error; pinned names in config; this also removes #1391's root cause |
| An address quoted inside a message body is read relative to a different position | Low | Low | Frames carry each party's full address when crossing Towers; documentation states that an address is interpreted by whoever types it |
| A Tower renamed in the cloud strands addresses agents have memorised | Medium | Low | Identity keys on `towerId`, so trust survives; the old name fails loudly with the current list for the owner's own Towers |
| Stage 2 slips behind #1871 | Medium | Medium | Stage 1 has no dependency on it; stage 2 states it as a prerequisite |
| Over-design for stage 3 | Medium | Medium | No end-to-end crypto, cloud store-and-forward, handles, receipts or cross-instance routing unless an owner decision asks for them; each is listed as an alternative or a nice-to-know |

## References

- Issue #1943 (this brief); issue #655 (cloud messaging); #1605 (front-door-only routing); #1391 (workspace name collisions); #1871 and codev-cloud#17 (canonical slug, rename, deregistration); #1165 and codev-cloud#7 (device authorization); #1914 (public prefix follows the relayed slug); #1094 and #1783 (builder identity verification); #1478 and #1574 (sender attribution, recipient in frames).
- Spec 755 (`codev/specs/755-multi-architect-support-per-ar.md`), Spec 823 (`codev/specs/823-multi-architect-coordination-b.md`): named architects, affinity, the spoofing rule, sibling messaging.
- Spec 1313 (`codev/specs/1313-afx-send-mailbox-first-delivery.md`) and the held-mail follow-ups (#1365, #1473, #1482, #1573, #1584, #1664).
- Spec 62 (`codev/specs/0062-secure-remote-access.md`), Spec 97 (`codev/specs/0097-cloud-tower-client.md`).
- Current code: `packages/codev/src/agent-farm/utils/agent-names.ts` (`parseAddress`); `servers/tower-messages.ts` (`resolveTarget`, `resolveAgentInRegistry`); `servers/tower-routes.ts` (`handleSend`, `formatMessageForTarget`); `utils/message-format.ts` (frames, `REPLY_HINT`, `MAX_MESSAGE_BYTES`); `lib/tunnel-client.ts` (role-reversed tunnel, local-key stamping, blocked paths); `lib/cloud-config.ts`; `db/schema.ts` (`known_workspaces`, `mailbox`).
- codev-cloud at `origin/main`, 2026-11-17: tunnel server and registry, owner-only proxy, tower schema (globally unique slug, one `ctk_` key), `connection_log`, and the absence of any relay, sharing or messaging feature.
- `codev/resources/commands/agent-farm.md` (the current `afx send` address documentation).
