# Specification: Messaging between workspaces and between Towers — addressing, discovery, security

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
Keep implementation phases, file paths, code, and "first we will… then we will…"
out of the spec — those belong in codev/plans/<id>-*.md.
-->

Issue: #1940. The address grammar, once the owner has chosen it, is fixed by this spec. Command
names and header layouts are the proposed ones; the plan may change a spelling only where it
collides with something that exists. The decisions that are the owner's are collected under
**Open Questions**, each with a recommendation.

**At a glance.** What the spec recommends, and where the owner's decision on it is asked.

| Matter | Recommendation | Open Question |
|---|---|---|
| Stages | 1: named architects across workspaces on one Tower. 2: my own Towers. 3: another owner's Tower | — |
| What this project builds | Stage 1 only; stages 2 and 3 become their own issues | 4 |
| Address | Today's colon grammar on one Tower; `afx://[owner@]tower/` in front of it to leave the Tower | 1 |
| Names | Tower names unique per owner (ruled); an account handle names the owner; a workspace may be given an explicit name | 11 |
| Front door (#1605) | Named architects addressable from other workspaces by default; a workspace may choose front door only; #1605 closes as superseded | 12 |
| Transport | Codev Cloud relays (directed); it holds no mail; an offline Tower's mail waits at the sender for up to 30 days | 7 |
| Identity | The cloud says who is sending, in a statement the receiving Tower can verify came from the relay | 3 |
| Authorization | Default deny; grants live on the receiving Tower and name a peer Tower and its recipients; one switch per Tower, off to start | 2, 5 |
| Builders | Name only their own architect; otherwise front doors; never cross owners | 6 |
| Another owner | One emailed invitation connects two owners; grants stay per Tower; mail is held for the owner to release | 2, 10, 13 |
| Commands | One new noun, `afx peer`, plus `afx workspace list` and `name`, and `afx inbox release` | — |

## Problem Statement

`afx send` reaches an agent only if the sender can name it, and only if it lives on the same Tower.
Three things the owner wants are impossible today. They are listed in the owner's order, as the
issue was updated on 2026-11-21; the issue as first filed, and the builder's spawn prompt, had
named architects last:

1. **Named architects cannot be reached from outside their own workspace.** From workspace `codev`
   there is no way to write "the architect named `tunnel` in workspace `codev-cloud`". Only that
   workspace's `main` architect is reachable. This is a gap on a single Tower, with no network
   involved.
2. **My Towers cannot message each other.** An architect on my laptop cannot message an architect on
   my dev VM.
3. **My Tower cannot exchange messages with someone else's.** There is no way for a collaborator's
   architect and mine to talk.

Behind all three sits one missing piece: an address that can name an owner, a Tower, a workspace, a
kind of agent and the agent itself. Behind the second and third sits a security problem that has to be
treated as what it is. A message delivered to an agent is text typed into the prompt of a coding
agent that usually runs with permission checks skipped. **Accepting a message from another Tower is
accepting remote instructions for an agent with shell access.**

Who is affected: every owner who runs more than one named architect (stage 1), more than one machine
(stage 2), or works with a collaborator who also runs Codev (stage 3).

## Current State

**Addressing.** An address is split on its first colon into two slots, `{project, agent}`.

| Written today | Means |
|---|---|
| `architect` | From a builder: its spawning architect. From anyone else: `main`, else the first registered |
| `architect:review` | The architect named `review` in the sender's workspace |
| `builder-spir-1940`, `1940` | A builder in the sender's workspace (exact id, then tail match) |
| `codev-cloud:architect` | The `main` architect (else the first registered) of the workspace whose directory basename is `codev-cloud` |
| `codev-cloud:builder-bugfix-12` | A builder in that workspace |
| `<shell-id>`, `codev-cloud:<shell-id>` | A utility shell terminal, by exact id |

- `architect:review` and `codev-cloud:architect` have the same two-slot shape. The resolver tells
  them apart by intercepting the literal word `architect` in the first slot. With only two slots
  there is nowhere to put a third thing, so "architect `tunnel` in workspace `codev-cloud`" cannot be
  written. Spec 786 and Spec 823 both recorded cross-workspace architect coordination as deferred.
- A workspace is identified by its absolute path. Its address name is the directory basename,
  matched case-insensitively against workspaces currently active in Tower. Two workspaces with the
  same basename produce an `AMBIGUOUS` error that the user has no way to resolve. The basename is
  stored once in `known_workspaces.name`; nothing lets the user change it, and
  `.codev/config.json` has no name field.
- Architect names match `^[a-z][a-z0-9-]*$` (64 characters at most). Builder ids look like
  `builder-<protocol>-<id>`. Neither can contain a colon, a slash, a dot or `@`.

**Provenance.** The recipient sees a header such as
`### [ARCHITECT:review MESSAGE → main | <time>] ###`. It names the sender's agent id only. The
sender's workspace is stored on the mailbox row but is not in the header, so an architect that
receives a message from another workspace is not shown an address it can reply to. Only messages to
builders carry a reply hint, and it is always `afx send architect "…"`.

**Sender identity is self-asserted.** The CLI works out who is sending (builder worktree, else the
`CODEV_ARCHITECT_NAME` environment variable) and puts it in the request. Tower checks only that the
string is well formed. The one spoofing rule (Spec 755) is that a sender that is a registered
builder may address, by name, only its own spawning architect. Anyone holding the local Tower key
can claim any sender.

**Delivery.** Spec 1313 made sends mailbox-first: the message is persisted, then typed only onto a
prompt the render gate has verified empty. The response is `delivered`, or `held` with a reason
(`busy`, `no-profile`, `no-live-pty`). Held rows never expire; a human lists, reads and dismisses
them with `afx inbox`. Message text is capped at 48 KB, by the CLI and again by Tower. There is no
rate limit on sends.

**Tower and Codev Cloud.**

- A Tower that has run `afx tower connect` holds an outbound WebSocket to Codev Cloud and serves
  HTTP/2 over it. Only the cloud opens requests on that tunnel; Tower has no way to send a request
  to the cloud over it. Separately, Tower makes a few plain HTTPS calls to the cloud, authenticated
  with its `ctk_` key.
- The cloud knows each Tower by an immutable id, a name, a slug, and the account that owns it. The
  slug is unique across the whole cloud: a name someone else already holds is silently bumped to
  `<name>-2`. Locally, Tower stores the id, the key and the name the user typed, which can differ
  from the slug (issue #1871, not yet implemented). Tower stores nothing about who its owner is.
- A cloud account has a verified email and a display name. It has no short, unique name that could
  stand for an owner in an address.
- The cloud exposes each Tower at `/t/<slug>/…` to that Tower's owner only (browser session or
  personal access token). There are no teams, no sharing between accounts and no Tower-to-Tower
  path.
- A request arriving through the tunnel is stamped with Tower's own local key and a marker header.
  It carries no identity for whoever made it. Tower refuses a short list of paths on the tunnel;
  `/api/send` is not on that list. So the owner's own cloud session can already cause a message to
  be typed into any agent on a connected Tower, with any claimed sender. That is the trust Spec 97
  placed in the cloud, and this spec does not change it. It matters here for two reasons: the cloud
  is already fully trusted by a connected Tower, and that path is no basis for Tower-to-Tower
  messaging because it has no notion of who is calling.
- Tower already pushes workspace paths, workspace names and terminal ids to the cloud every 30
  seconds.
- `BRIDGE_MODE` lets a CLI on one host drive a Tower on another using the shared local key over
  plain HTTP. It hands over the whole Tower, in cleartext, and is not a basis for this work either.

## Desired State

One address grammar names an owner, a Tower, a workspace, a kind of agent and an agent. Every address valid
today keeps its meaning. The three goals ship as three stages, each usable on its own.

**Stage 1 — architects on one Tower.** No second Tower, no transport, no Codev Cloud.

> From the `review` architect in `codev`, run `afx send codev-cloud:architect:tunnel "…"`. The
> message appears at the `tunnel` architect's prompt in `codev-cloud`, under a header that names
> `codev:architect:review` and shows the command to reply. The reply arrives the same way.

**Stage 2 — my own Towers.** Through Codev Cloud.

> On my dev VM I allow my laptop once. From the laptop's `main` architect I run
> `afx send afx://devvm/codev:architect:local "…"`. It appears at the `local` architect's prompt on the VM,
> marked as coming from my Tower `mbp`. If the VM is switched off, the message is held on the laptop
> and arrives when the VM comes back.

**Stage 3 — someone else's Tower.**

> I invite a collaborator by email from Codev Cloud, and they accept. I allow one of their
> Towers, `sam@studio`, to message one architect of mine. Their message arrives held; I
> read it and release it; my architect sees it marked as from another owner, with their email and
> the address `afx://sam@studio/codev-cloud:architect:data` to reply to. Anything they send to any
> other agent of mine is refused.

Across all stages: an address that does not resolve fails with the reason and never reaches a
different recipient; a remote message is persisted to the receiving Tower's mailbox and delivered
only through the render gate; the recipient can always tell a remote message from a local one and
always sees an address it can reply to.

The design that delivers this is argued under **Solution Approaches**: the address grammar
(Decision 1), names and renames (Decision 2), the transport and what each party enforces
(Decision 3), the trust model (Decision 4), delivery semantics (Decision 5), discovery
(Decision 6), provenance (Decision 7), how two owners connect (Decision 8), the commands
(Decision 9) and the front door (Decision 10). Two walkthroughs show setup step by step: my own
Towers after Decision 9, another owner in Decision 8.

## Success Criteria

**Which criteria belong to this project.** This spec designs all three stages, as the issue asks.
What project 1940 goes on to build is the owner's call (Open Question 4). Under the recommended
answer, the stage 1 criteria are this project's acceptance criteria and are sufficient to plan
from. The stage 2 and stage 3 criteria are written here so that the follow-up issues inherit them;
they are not acceptance criteria for this project.

Approving this spec with Open Question 4 answered as recommended makes the stage 1 checklist the
acceptance criteria for project 1940. The architect then files one issue for stage 2 and one for
stage 3, each citing this spec and inheriting its checklist as written.

**Stage 1 (architects on one Tower)**

- [ ] A named architect in another workspace on the same Tower is addressable, and the message is
      delivered or held exactly as a same-workspace message would be, including `no-live-pty` when
      the architect is registered but has no live terminal.
- [ ] Every address form valid before this change resolves to the same recipient as before.
- [ ] A message from another workspace shows the sender's qualified address in its header. Its
      footer tells the recipient how to reply: a command that works when pasted unchanged, or, for
      a builder messaged by an architect it may not name, to reply through its own architect.
      Same-workspace frames are unchanged.
- [ ] A builder can name an architect only if it is its own spawning architect, however the
      address is qualified. It reaches every other architect through a front door, as today.
- [ ] No reply command in a footer is one the recipient's own send would refuse.
- [ ] A workspace set to front door only refuses mail from outside to its named architects, with
      an error that names its front door; nothing is rerouted.
- [ ] An ambiguous workspace name fails with an error naming every match and the remedy; giving one
      workspace an explicit address name removes the ambiguity.
- [ ] One command lists every workspace on this Tower with its architects, each as an address ready
      to paste. `afx whoami` prints the caller's own address, and an explicit workspace name can
      be cleared as well as set.
- [ ] All of the above works on a Tower that has never connected to Codev Cloud. Until stage 2
      ships, an `afx://` address is refused with a reason that says cross-Tower messaging is not
      available, whether or not the Tower is connected.
- [ ] The address is a structured wire contract in `codev-types`, with one parser and one formatter
      shared by the CLI, Tower and the VS Code extension.
- [ ] Docs, skills and role files that teach addressing are updated in both `codev/` and
      `codev-skeleton/`.

**Stage 2 (my own Towers)**

- [ ] The headline path works between two Towers on one account, both behind NAT. The stage 2
      walkthrough can be followed as written: the same commands, in that order, with those results.
- [ ] With remote messaging off, a Tower refuses an `afx://` send to another Tower before anything
      leaves the machine, and says how a human turns it on.
- [ ] A Tower's name is unique within its owner's account only. The name I give a Tower is not
      affected by what any other account has registered, and an address for one of my own Towers
      never contains an owner.
- [ ] A Tower accepts no remote message until its owner has granted a peer. A fresh install, and an
      upgraded one, refuse everything.
- [ ] The sender is told `delivered`, `held` with where and why, or `refused` with the reason. A
      refusal exits non-zero and leaves nothing on the receiving Tower.
- [ ] A message for a Tower that is offline, or sent while the cloud is unreachable, is held on the
      sending Tower, visible in `afx inbox`, and is accepted exactly once when the route returns,
      provided that is within the message's 30-day lifetime. After that it is shown as expired.
- [ ] Mail held on the sending Tower is a distinct kind of held mail: the local delivery drainer
      never tries to type it into a terminal, it never raises the starved-agent escalation, and
      `afx inbox` and the held-mail indicator show it apart from mail waiting for a local agent.
- [ ] Messages from one Tower to one recipient are delivered in the order they were sent,
      including when the peer is online and several agents send at once: the sending Tower makes
      one relay call at a time for each peer.
- [ ] The recipient's header marks the message as remote and names the sending Tower and the
      sender's full address; the reply command in it works.
- [ ] The sending Tower's identity shown to the recipient comes from Codev Cloud's authentication
      of that Tower, carried in the attested statement. No field of the message can change it.
- [ ] A relayed request is accepted only with a statement whose MAC verifies under the current
      tunnel session's secret. A request from this machine that holds the local key, a request
      through Codev Cloud's `/t/` browser proxy with any headers, a replayed statement, and one
      from an earlier tunnel session are each refused, and nothing is stored.
- [ ] A send to a peer that does not speak the protocol, or through a cloud without the relay, is
      refused with that reason and not held.
- [ ] `--raw`, `--interrupt` and `--no-enter` are refused for a remote recipient, and control
      characters in a remote body never reach a terminal.
- [ ] From one Tower I can list my other Towers, and for one I have been granted, its workspaces and
      agents.
- [ ] Removing a grant refuses further mail from that peer immediately, and stops automatic
      delivery of mail from it that was accepted but not yet delivered.
- [ ] Flooding is bounded at the cloud and again at the receiving Tower.
- [ ] Both Towers keep a record of every cross-Tower attempt and its outcome, without bodies in
      logs.

**Stage 3 (another owner's Tower)**

- [ ] Two owners can be connected only through an invitation that both act on in a signed-in
      Codev Cloud session. A Tower credential alone cannot create or accept one. One invitation
      connects the two owners, whatever number of Towers each has. The walkthrough in Decision 8
      can be followed by two people as written.
- [ ] A Tower is shown to a connected owner only while its remote messaging is on.
- [ ] An invitation can be accepted only by the account it was addressed to, and before it is
      accepted nothing about it appears on any Tower of the invitee.
- [ ] Another owner's Tower is always written with its owner, `afx://sam@mbp/…`. When Sam and I
      each have a Tower called `mbp`, each address reaches the right one from either side, and
      every header, listing and reply command prints the owner when the Tower is not the reader's
      own.
- [ ] After connecting, nothing is deliverable until the receiving owner grants a specific
      recipient on a specific Tower. Builders cannot be granted to another owner's Tower, and a
      builder's send to another owner's Tower is refused by its own Tower.
- [ ] A message from another owner is held for release unless the grant says otherwise. Nothing in
      Tower releases or dismisses it automatically.
- [ ] The header states that the message is from another owner and shows their verified email.
- [ ] An ungranted sender cannot distinguish "no such agent" from "not allowed", and learns nothing
      about why a message is held.
- [ ] Discovery shows another owner exactly the recipients they have been granted and nothing else.
- [ ] Either owner can end the connection from any of their Towers or from Codev Cloud. Relaying
      stops at once in both directions between all their Towers, and the grants to the other
      owner's Towers are removed.

## Constraints

- **Transport is directed by the owner:** every cross-Tower message travels through Codev Cloud,
  which is the single security choke point. It reaches the receiving Tower down that Tower's
  existing tunnel. No Tower accepts an inbound connection.
- **Every frame stays three lines.** Tower types a frame in one short write only while it has
  fewer than four lines and is at most 256 bytes; anything else goes by chunked paste. Today's
  frame is three lines, with the reply hint on the footer line, precisely so that short messages
  stay on the short path. Every new frame in this spec keeps to three lines, with its reply
  command on the footer line. The byte limit is not changed, so a longer address leaves less room
  for a body on the short path: 87 bytes for the cross-workspace example frame, 68 for one from my
  own Tower and 26 for one from another owner's Tower, against 103 today. Longer messages take the paste path, as every message of
  ordinary length already does; on agy that path is slower, line by line.
- **Mailbox-first (Spec 1313).** A remote message is persisted to the receiving Tower's mailbox and
  delivered through the render gate, under the same per-agent and per-terminal locks as any other
  message. Nothing remote writes a terminal directly, and there is no force path.
- **Fail fast, no fallbacks.** An address that does not resolve fails loudly with the reason. It
  never falls back to a different recipient, a different Tower or a different route.
- **Server/client isolation (issue #1189).** Wire contracts live in `codev-types`; `codev-core` and
  `codev-sdk` do not import each other.
- **End-to-end usable at each stage.** Each stage ships its headline path, not a primitive.
- **Proportionate.** The address and the trust model are designed for all three stages. Nothing is
  designed that only a fourth stage would need.
- **Both trees.** Framework files that teach addressing change in `codev/` and `codev-skeleton/`.
- **Windows.** A workspace is keyed by `workspaceKey()`'s canonical spelling; an address never
  depends on how a path is spelled, and must survive Git Bash, PowerShell and cmd unquoted.
- **A connected Tower keeps working when the cloud is down**, for everything on that Tower.

## Assumptions

- Codev Cloud can take the work listed under Decision 3. It lives in the `codev-cloud` repository
  and has its own architect; stages 2 and 3 cannot ship before it does.
- Issue #1871 (Tower persists and displays the cloud's canonical slug) lands before stage 2. The
  Tower part of an address is that slug.
- Codev Cloud makes Tower slugs unique per account before stage 2, and gives accounts a handle
  before stage 3 (Decision 2). Both are changes to what it does today.
- Shells pass an argument containing `://` through unchanged, including Git Bash on Windows. Stage
  2's Windows test confirms this before the form is relied on.
- The cloud stays as trusted as Spec 97 made it: it can already reach every route of a connected
  Tower on the owner's behalf.
- Local trust is unchanged. Any process holding the local Tower key acts as the owner.
- Remote terminals, remote spawn, remote gate approval and messaging from a web or mobile client
  are out of scope.

## Solution Approaches

### Decision 1: the address grammar

An address may have to say up to five things: whose Tower, which Tower, which workspace, what kind
of agent, and which one. Tower names are unique per owner, not across the cloud (owner ruling;
Decision 2), so two owners may each have a Tower called `mbp`, and another owner's Tower can only be
named together with its owner.

**Does the owner belong in the address? Yes**, for three reasons.

1. It is needed. With per-owner Tower names, `mbp` alone does not say whose.
2. Whose Tower it is matters more for trust than anything else in the address. It should be visible
   wherever an address is written or read: by an agent composing a reply, in a discovery listing,
   in a grant a human is about to approve.
3. Addresses for my own Towers leave it out, so its presence is itself the signal that a message is
   leaving my own machines.

The alternative is to keep the owner out and resolve a bare Tower name through the sender's peer
list, as the first draft of this spec did. It needs either global Tower names or private nicknames,
and it hides the one fact a reader most needs.

**Seven candidates**, each in its best form, each with a place for the owner. The same eleven
addresses are written in each. The setting: my account's handle is `ana` and I have two Towers,
`mbp` and `devvm`. A collaborator, `sam`, also has two, `mbp` and `studio`, so one Tower name is
used by both of us. Workspaces are `codev`, `codev-cloud` and `codevos.ai` (a real directory name
with a dot in it). Rows 1 to 10 are written by an architect in `codev` on my `mbp`. Row 11 is the
reverse direction, written on Sam's side.

- **A. URI scheme.** `afx://<owner>@<tower>/<workspace>/<kind>/<name>`. The owner sits in the user
  part of the authority, as in `ssh user@host`. Short forms are URI relative references.
- **B. Email-like.** `<agent>@<workspace>.<tower>.<owner>`. Short forms drop from the right.
- **C. Slash path, no scheme.** `<owner>/<tower>/<workspace>/<kind>/<name>`. Short forms drop
  leading segments.
- **D. Dotted, DNS-style.** `<agent>.<workspace>.<tower>.<owner>`, most specific first.
- **E. Handles through a directory.** `@<owner>/<handle>`. Each addressable agent registers a
  handle with its owner's directory; within my own account the owner is dropped.
- **F. Colon path.** `<owner>:<tower>:<workspace>:<agent>`, most general first, where the agent
  part is `architect`, `architect:<name>` or a builder or shell id. Short forms drop leading
  components.
- **G. Colon address within a Tower, URI to leave it.** On one Tower, today's colon grammar with one
  new form. To reach another Tower, `afx://<owner>@<tower>/` goes in front of the address as that
  Tower would write it.

**Shortest correct form** — what the sender types:

| # | Recipient | A. URI | C. Slash path | F. Colon path | G. Colon within, URI across |
|---|---|---|---|---|---|
| 1 | My spawning architect | `architect` | `architect` | `architect` | `architect` |
| 2 | Architect `review`, my workspace | `architect/review` | `architect/review` | `architect:review` | `architect:review` |
| 3 | Builder 1940, my workspace | `builder/spir-1940` | `builder/spir-1940` | `builder-spir-1940` | `builder-spir-1940` |
| 4 | Main architect of `codev-cloud`, this Tower | `/codev-cloud/architect` | `codev-cloud/architect` | `codev-cloud:architect` | `codev-cloud:architect` |
| 5 | Architect `tunnel` in `codev-cloud`, this Tower | `/codev-cloud/architect/tunnel` | `codev-cloud/architect/tunnel` | `codev-cloud:architect:tunnel` | `codev-cloud:architect:tunnel` |
| 6 | Main architect of `codevos.ai`, this Tower | `/codevos.ai/architect` | `codevos.ai/architect` | `codevos.ai:architect` | `codevos.ai:architect` |
| 7 | Architect `local` in `codev` on my `devvm` | `afx://devvm/codev/architect/local` | `devvm/codev/architect/local` | `devvm:codev:architect:local` | `afx://devvm/codev:architect:local` |
| 8 | Builder 1940 in `codev` on my `devvm` | `afx://devvm/codev/builder/spir-1940` | `devvm/codev/builder/spir-1940` | `devvm:codev:builder-spir-1940` | `afx://devvm/codev:builder-spir-1940` |
| 9 | Main architect of `codev-cloud` on Sam's `mbp` | `afx://sam@mbp/codev-cloud/architect` | `sam/mbp/codev-cloud/architect` | `sam:mbp:codev-cloud:architect` | `afx://sam@mbp/codev-cloud:architect` |
| 10 | Architect `data` in `codev-cloud` on Sam's `studio` | `afx://sam@studio/codev-cloud/architect/data` | `sam/studio/codev-cloud/architect/data` | `sam:studio:codev-cloud:architect:data` | `afx://sam@studio/codev-cloud:architect:data` |
| 11 | Sam's side writing my `main` architect in `codev` on my `mbp` | `afx://ana@mbp/codev/architect` | `ana/mbp/codev/architect` | `ana:mbp:codev:architect` | `afx://ana@mbp/codev:architect` |

| # | B. Email-like | D. Dotted | E. Handles |
|---|---|---|---|
| 1 | `architect` | `architect` | `architect` |
| 2 | `review` | `review` | `@review` |
| 3 | `spir-1940` | `spir-1940` | `1940` (builders get no handle) |
| 4 | `architect@codev-cloud` | `architect.codev-cloud` | `@codev-cloud` |
| 5 | `tunnel@codev-cloud` | `tunnel.codev-cloud` | `@tunnel` |
| 6 | `architect@codevos.ai` | `architect.codevos.ai` | `@codevos` |
| 7 | `local@codev.devvm` | `local.codev.devvm` | `@devvm-local` |
| 8 | `builder-spir-1940@codev.devvm` | `builder-spir-1940.codev.devvm` | none; needs a structural form |
| 9 | `architect@codev-cloud.mbp.sam` | `architect.codev-cloud.mbp.sam` | `@sam/mbp-codev-cloud` |
| 10 | `data@codev-cloud.studio.sam` | `data.codev-cloud.studio.sam` | `@sam/data` |
| 11 | `architect@codev.mbp.ana` | `architect.codev.mbp.ana` | `@ana/codev` |

**Full form** — every component written out. Rows 1 and 11 name the same agent, so their full forms
are identical, and row 1 assumes the sender's spawning architect is `main`.

| # | A. URI | C. Slash path | F. Colon path | G. Colon within, URI across |
|---|---|---|---|---|
| 1, 11 | `afx://ana@mbp/codev/architect/main` | `ana/mbp/codev/architect/main` | `ana:mbp:codev:architect:main` | `afx://ana@mbp/codev:architect:main` |
| 2 | `afx://ana@mbp/codev/architect/review` | `ana/mbp/codev/architect/review` | `ana:mbp:codev:architect:review` | `afx://ana@mbp/codev:architect:review` |
| 3 | `afx://ana@mbp/codev/builder/spir-1940` | `ana/mbp/codev/builder/spir-1940` | `ana:mbp:codev:builder-spir-1940` | `afx://ana@mbp/codev:builder-spir-1940` |
| 4 | `afx://ana@mbp/codev-cloud/architect/main` | `ana/mbp/codev-cloud/architect/main` | `ana:mbp:codev-cloud:architect:main` | `afx://ana@mbp/codev-cloud:architect:main` |
| 5 | `afx://ana@mbp/codev-cloud/architect/tunnel` | `ana/mbp/codev-cloud/architect/tunnel` | `ana:mbp:codev-cloud:architect:tunnel` | `afx://ana@mbp/codev-cloud:architect:tunnel` |
| 6 | `afx://ana@mbp/codevos.ai/architect/main` | `ana/mbp/codevos.ai/architect/main` | `ana:mbp:codevos.ai:architect:main` | `afx://ana@mbp/codevos.ai:architect:main` |
| 7 | `afx://ana@devvm/codev/architect/local` | `ana/devvm/codev/architect/local` | `ana:devvm:codev:architect:local` | `afx://ana@devvm/codev:architect:local` |
| 8 | `afx://ana@devvm/codev/builder/spir-1940` | `ana/devvm/codev/builder/spir-1940` | `ana:devvm:codev:builder-spir-1940` | `afx://ana@devvm/codev:builder-spir-1940` |
| 9 | `afx://sam@mbp/codev-cloud/architect/main` | `sam/mbp/codev-cloud/architect/main` | `sam:mbp:codev-cloud:architect:main` | `afx://sam@mbp/codev-cloud:architect:main` |
| 10 | `afx://sam@studio/codev-cloud/architect/data` | `sam/studio/codev-cloud/architect/data` | `sam:studio:codev-cloud:architect:data` | `afx://sam@studio/codev-cloud:architect:data` |

| # | B. Email-like | D. Dotted | E. Handles |
|---|---|---|---|
| 1, 11 | `main@codev.mbp.ana` | `main.codev.mbp.ana` | `@ana/codev` |
| 2 | `review@codev.mbp.ana` | `review.codev.mbp.ana` | `@ana/review` |
| 3 | `builder-spir-1940@codev.mbp.ana` | `builder-spir-1940.codev.mbp.ana` | none |
| 4 | `main@codev-cloud.mbp.ana` | `main.codev-cloud.mbp.ana` | `@ana/codev-cloud` |
| 5 | `tunnel@codev-cloud.mbp.ana` | `tunnel.codev-cloud.mbp.ana` | `@ana/tunnel` |
| 6 | `main@codevos.ai.mbp.ana` | `main.codevos.ai.mbp.ana` | `@ana/codevos` |
| 7 | `local@codev.devvm.ana` | `local.codev.devvm.ana` | `@ana/devvm-local` |
| 8 | `builder-spir-1940@codev.devvm.ana` | `builder-spir-1940.codev.devvm.ana` | none |
| 9 | `main@codev-cloud.mbp.sam` | `main.codev-cloud.mbp.sam` | `@sam/mbp-codev-cloud` |
| 10 | `data@codev-cloud.studio.sam` | `data.codev-cloud.studio.sam` | `@sam/data` |

Rows 1 to 6 of F and G are identical, and rows 2, 3 and 4 are exactly what is typed today.

| Criterion | A. URI | B. Email-like | C. Slash path | D. Dotted | E. Handles | F. Colon path | G. Colon within, URI across |
|---|---|---|---|---|---|---|---|
| Typed at a shell | No quoting; longest. Rows 4 to 6 start with `/`, which Git Bash on Windows rewrites into a file path | No quoting; short | No quoting; the shell offers file names as completions | No quoting; compact | A leading `@` is PowerShell's splat operator, so handles need quotes there | No quoting in bash, zsh, PowerShell or cmd | No quoting; one-Tower forms as F, remote forms nearly as long as A |
| Written by an agent | Familiar. Two syntaxes to keep apart (full, relative); risk of percent-encoding or a trailing slash | Order is the reverse of today's; rows 9 to 11 look like real email addresses | Looks like a file path | Looks like a hostname | Shortest, but has to be looked up | Today's shape, but what each word means depends on counting | Today's shape on one Tower; a remote address is copied whole from a header or a listing |
| Short forms | Relative references; two of three need a leading `/` or `//` | A bare name cannot say architect or builder | Drop leading segments; depth is found by counting | Ambiguous by label count | None needed | Drop leading components; depth is found by counting | Two tiers and no counting: a local address, or `afx://` and a Tower in front of one |
| Whose Tower is visible | Yes: `sam@` | Last label, unmarked | First segment, unmarked | Last label, unmarked | Yes: `@sam/` | First component, unmarked | Yes: `sam@`; and `afx://` marks every address that leaves this Tower |
| Same Tower name under two owners (rows 9, 11) | `afx://mbp/` is mine, `afx://sam@mbp/` is Sam's | `.mbp` and `.mbp.sam` | `mbp/` and `sam/mbp/` | As B | The handle hides which Tower | `mbp:` and `sam:mbp:` | As A |
| Dots in workspace names (row 6) | Fine | `codevos.ai.mbp.ana` cannot be split reliably | Fine | Cannot be parsed | Fine | Fine | Fine |
| Survives a rename | Names, with stable ids underneath (Decision 2) | Same | Same | Same | Best: a handle is bound to ids | Same | Same |
| Room for a future component | Best: query, fragment | Poor | A sixth positional segment | Poor | Directory fields | A sixth positional component | As A for remote forms |
| Migration from today's colon forms | Every qualified form changes; colon forms need a deprecation period; docs, skills and prompt strings change in both trees | Everything changes | As A | Everything changes | Everything changes, plus a directory to build and keep correct | None | None: the `afx://` forms are new and nothing existing changes |

**What decides it.**

- **B and D** fail on real data. Workspace directories contain dots (`codevos.ai`,
  `cluesmith.com`), and with an owner label added there are now three places a dot can mean a
  boundary. Both also put the agent first with no room to say what kind of agent it is, and B's
  cross-owner rows read as real email addresses.
- **E** is the only candidate where a rename costs nothing, and the shortest to type. It pays with a
  directory: handles must be unique per owner across all that owner's Towers (Sam has a
  `codev-cloud` on each of two Towers, so one of them needs a longer handle), kept in step with
  agents that come and go, and published to other owners, which turns discovery into a standing
  disclosure. A handle can be re-bound, so the same text can reach a different agent later.
  Builders are too short-lived to register, so a structural form is needed as well.
- **A, C, F and G are one idea** — a path from the most general component to the most specific,
  with a kind word marking the agent. They differ in how the levels are marked.
  - **C and F** mark every level the same way, so the owner, the Tower and the workspace are told
    apart only by how many components precede the kind word.
  - **A** marks the owner and the Tower distinctly and is the most extensible. It costs a second
    syntax for short forms, a Windows hazard on exactly the stage-1 forms, and a migration away
    from every colon form in use.
  - **G** takes A's marking for the part that names a machine and leaves everything on a machine
    as it is today.

**What the five-part positional form costs, if F is kept.**

- `sam:mbp:codev-cloud:architect` and `devvm:codev:architect:local` both have four components. The
  first begins with a person and the second with a machine, and only the position of the word
  `architect` says which. The most trust-relevant part of the address is the one found by counting.
- A builder or shell address has no kind word at all, so its depth is known only from the count:
  `a:b:c:d` is owner, Tower, workspace, id.
- A miscount does not produce a malformed address; it produces a well-formed one at the wrong
  level. Most of those fail loudly because the name does not exist at that level. Some do not: a
  Tower and a workspace can share a name.
- `architect`, `arch` and `builder` must be reserved at three levels, including as account handles
  in Codev Cloud.
- A variant, **F with a marked owner** (`sam@mbp:codev-cloud:architect`, the shape of an `scp`
  target), removes the first cost and keeps the rest. It is the runner-up below.

**Recommendation: G. Keep today's colon grammar for everything on one Tower, and put
`afx://[owner@]tower/` in front of it to leave the Tower.** This changes the first draft's
recommendation (F). With the owner in the address, F becomes five positional parts, three of them
optional, and the count is what tells a person from a machine.

1. **Three boundaries, three marks.** `@` follows an owner, `//…/` encloses the machine, `:`
   separates what is on it. Nothing is found by counting.
2. **Leaving this Tower is visible.** `afx://` appears exactly when a message goes through Codev
   Cloud, is subject to another Tower's grants, and follows the cross-Tower delivery rules. An
   address with an `@` is someone else's Tower; one without is mine.
3. **No migration.** Nothing written today changes, and nothing is deprecated.
4. **One grammar for the part after the Tower.** The path of an `afx://` address is, character for
   character, the address as that Tower would write it. A reply address is made by putting a prefix
   on, never by translating.
5. **It is the owner's `afx://` idea, used where a URI earns its keep.** `sam@mbp` reads the way
   `ssh sam@mbp` does.

Its costs: two tiers of syntax; remote addresses are the longest of the colon-based candidates;
`afx://devvm/codev:architect:local` mixes `/` and `:`, which is legal in a URI path but unusual; and
it relies on shells leaving an argument containing `://` alone, which stage 2's Windows test must
confirm.

**The stage-1 form is the same under F, F with a marked owner, and G:
`codev-cloud:architect:tunnel`.** Those three differ only in how a Tower and an owner are written,
which stage 1 does not use. Runner-up: F with a marked owner, which is shorter and has no scheme but
still tells a Tower from a workspace by counting. Then A, for an owner who would rather have one
syntax everywhere and accept the migration.

The rest of this spec is written in G. It needs only that an address parses into
`{owner?, tower?, workspace?, kind, name?}`.

**The recommended grammar in full.**

```
address    = local | remote
local      = [ workspace ":" ] agent
remote     = "afx://" [ owner "@" ] tower "/" workspace ":" agent
agent      = "architect" [ ":" architect-name ]     ; bare "arch" stays an alias for bare "architect"
           | local-id                               ; a builder id (or a tail such as 1940), or a
                                                    ; shell id, resolved as today
tower-ref  = [ owner "@" ] tower                    ; how commands, grants and listings name a Tower
```

- **Parsing a local address.** If it contains the word `architect` as a component, at most one
  component may precede it, the workspace, and at most one may follow, the architect's name.
  Otherwise it is a local id, optionally preceded by a workspace, resolved as it is today (builders
  by exact id then tail, then shells by exact id). Any other shape is malformed and fails naming the
  shape that was expected.
- **A remote address always names the workspace.** There is no "sender's workspace" on another
  Tower.
- **Leaving parts out.** No owner means my own account. No `afx://` means this Tower. No workspace
  means the sender's workspace. Bare `architect` keeps today's meaning exactly: from a builder, its
  spawning architect; from anyone else, `main`.
- **Naming myself is allowed, from stage 2.** `afx://mbp/…` written on my own `mbp` means the
  same as the local address, and resolves without the cloud. The form with my own owner in it,
  `afx://ana@mbp/…`, means the same from stage 3, when handles exist; in stage 2 any address with
  an owner is refused as not yet available. In stage 1 every `afx://` address is refused: a Tower
  does not yet know its own canonical name.
- **Components** are lower-cased and must match `[a-z0-9][a-z0-9._-]*`; owner handles and Tower
  names are further limited to letters, digits and hyphens. No escaping or encoding exists; a name
  outside that set is not addressable until it is given one that fits (Decision 2). `architect`,
  `arch` and `builder` cannot be given as an explicit workspace name. A port, a query, a fragment or a percent-encoded
  character makes the address malformed; they are free for later use. This rule bounds what an
  address can carry. It does not loosen the existing rules for naming an architect or a builder.
- **No local address stops working.** The component rule governs explicit names and everything in
  an `afx://` address. A local address still matches a workspace by its directory basename exactly
  as it does today, whatever characters the basename has; such a workspace needs an explicit name
  only to be reached from another Tower.
- **Reserved words do not change what resolves today.** `arch` is an alias only where it is the
  whole agent part: `arch`, or `codev:arch`. It is never read as `architect` before a colon, so
  `arch:review` keeps today's meaning, the agent `review` in a workspace whose basename is `arch`.
  A workspace whose basename is `arch` or `builder` keeps resolving by that basename in a local
  address, as today. One whose basename is `architect` is not addressable by name today, because
  `architect:<x>` already means a named architect, and that does not change. Each needs an
  explicit name only to be reached by name from another Tower.
- **Other terminal kinds.** Dev-server terminals are not message recipients today and do not
  become so.
- **Shells stay local.** A shell id is addressable within a Tower exactly as today, and never from
  another Tower, including my own: text sent to a shell prompt is a command, with no agent between
  the sender and the machine.
- **Helpful failures.** When an address is malformed or a name does not resolve, and the text
  matches something at another level, the error says so. `devvm:codev:architect` fails with "a
  local address has at most a workspace before `architect`; `devvm` is one of your Towers, so
  write `afx://devvm/codev:architect`". `afx://sam@laptop/…` fails with "no Tower named `laptop`
  owned by `sam` is connected to this Tower; connected: `sam@studio`".
- **One hazard no candidate avoids.** Leaving the owner off an address for someone else's Tower
  gives a valid address for my own Tower of the same name, if I have one. It errs toward my own
  agents and never toward a stranger's. Headers, listings and reply commands always print the
  owner when the Tower is not the reader's own, so a copied address is right; a retyped one is the
  risk.
- **Wire form.** On the wire an address is the structured object, never the string. The string is
  for people and agents.
- **Canonical display.** An address is shown in the shortest form that is correct for the reader,
  in four tiers: `architect:review` within a workspace, `codev:architect:review` within a Tower,
  `afx://mbp/codev:architect:review` to another Tower of the same owner, and
  `afx://ana@mbp/codev:architect:review` to anyone else.

### Decision 2: names, identity and renames

An address is made of names. Names change. Everything durable is therefore bound to an identity
that does not change, and names are resolved to identities at the moment of sending.

**What Codev Cloud does today** (read from its current source, not assumed).

- A Tower's slug is derived from the name its owner typed and is **unique across the whole cloud**.
  If any account already holds the slug, the newcomer is silently given `<name>-2`, then `-3`. A
  rename onto a taken slug is refused.
- An account has a verified email and a display name. It has **no handle**: nothing short, unique
  and typeable names an owner.
- The `/t/<slug>/` route already looks a Tower up by slug **and** owner.

A flat global namespace means my own stage-2 addresses depend on strangers. Whoever registered
`mbp` first has it; I become `mbp-2`, and the name I type on every send is one I did not choose. It
gets worse with every new account.

**Owner ruling: Tower names are per owner.** Each name is unique only inside the level above it.

| Level | Name used in an address | Unique within | Identity underneath | On rename |
|---|---|---|---|---|
| Owner | The account's handle | Codev Cloud | The cloud's account id | Connected owners learn the new handle from the cloud. The old one stops resolving, and the error names the new one |
| Tower | Its name (the cloud's slug, canonical per #1871) | Its owner's account | The cloud's immutable Tower id | The same, for peers |
| Workspace | An explicit address name if one is set, else the directory basename | Its Tower | The workspace key Tower already uses (`workspaceKey()` of its path) | The old name stops resolving on that Tower |
| Architect | Its name (Spec 755) | Its workspace | Name within workspace | Not renameable today |
| Builder, shell | Its id | Its workspace | Id within workspace | Not renameable |

**What identifies an owner in an address.** It has to be stable, typeable and not a secret.

| Option | Stable | Typeable | Verdict |
|---|---|---|---|
| Verified email | Mostly | Has an `@` and dots, which collide with every candidate grammar; long | Rejected as the address part. It stays the thing a human checks |
| The account id | Yes | No: an opaque string | Rejected. It is the identity underneath |
| A private nickname each side picks for the other | Yes | Yes | Rejected. The two sides would write the same Tower differently, and an address quoted inside a message would not resolve for its reader |
| **An account handle** (recommended) | Yes | Yes: lower-case letters, digits and hyphens, starting with a letter | Recommended |

- A **handle** is chosen by the account holder and is unique across Codev Cloud. This is the one
  global namespace in the design. A collision there happens once per person, not once per machine,
  and is resolved by the person choosing another; a handle is never bumped silently, because other
  people type it.
- It is asked for the first time an account creates or accepts an invitation (Decision 8). Stages 1
  and 2 need no handle, because my own addresses never contain one.
- It is not what establishes who someone is. The verified email does that: it is shown when
  connecting, in the peer list and in every header from another owner. A look-alike handle gets
  nowhere by itself, because a name resolves only among Towers already connected to mine.

**Collisions and renames.**

- Two owners with a Tower of the same name: no conflict. `afx://mbp/…` is mine and
  `afx://sam@mbp/…` is Sam's; from Sam's side the reverse.
- A second Tower on my own account registered under a name I already use: it is bumped to `-2`
  within my account, as today, and Tower shows the name it actually got (#1871). I can rename it or
  take the name over from a Tower that is no longer connected, both of which exist today.
- A Tower already bumped by the global rule (`mbp-2` because a stranger held `mbp`) can be renamed
  to `mbp` once uniqueness is per owner.
- **Grants, mailbox rows, held outbound mail and audit records store identities** wherever one
  exists: the Tower id, the owner's account id, the workspace key. So a rename never silently
  changes who is allowed or where held mail is going. Two things in a grant are not identities and
  are resolved when mail arrives: the front door, and an architect's name (Decision 4).
- **A name is resolved only through the sender's own peer list** (Decision 6), never by a global
  lookup: a Tower name with no owner among my account's Towers, and `owner@tower` among that
  owner's Towers that are connected to mine. If a peer renames its Tower or its handle and a
  stranger later takes the old one, the old text does not start reaching the stranger.

**The Codev Cloud changes this needs** (also listed under Decision 3).

- Tower slugs become unique per account instead of across the cloud: at registration, on rename and
  on takeover. The `/t/` route needs no change. Stage 2 depends on this.
- Accounts gain a handle. Stage 3 depends on this.

**Workspace names.**

- **A workspace gets an explicit address name** through one command, stored by Tower against the
  workspace key. This is the remedy for two workspaces sharing a basename and for a basename that
  is not address-safe, both of which have no remedy today. The rules:
  - A workspace's address name is its explicit name if it has one, otherwise its directory
    basename. Names are compared lower-cased.
  - **Setting a name.** An explicit name must fit the component rule in Decision 1, must not be a
    reserved word, and must not equal the address name, explicit or basename, of any other
    workspace Tower has registered, whether or not it is running at that moment. Setting one that
    breaks a rule is refused with the reason. So a name can never be taken from a workspace that
    is already using it, including one that is stopped.
  - **A workspace that arrives later.** If a workspace is registered afterwards and its basename
    equals an existing explicit name, the explicit name keeps resolving to the workspace that
    holds it. The newcomer is not addressable by name until it is given one of its own, and
    `afx workspace list` and the error for its bare basename both say so.
  - Two workspaces with the same basename and no explicit names are both unaddressable by that
    name: the address fails as ambiguous, listing both paths and the naming command.
  - Changing or clearing an explicit name takes effect at once; the old name stops resolving.
    Removing a workspace from Tower frees its name.
  - Moving a directory still makes a new workspace as far as Tower is concerned. That is existing
    behaviour and is not changed here.
- **A Tower not connected to Codev Cloud has no Tower name and no owner** and needs neither:
  nothing outside it can address it.

Also considered: workspace ids in addresses — rejected as unreadable; the id belongs underneath.

### Decision 3: transport, and who enforces what

**Directed: Codev Cloud as the relay.** The two legs are different, because only the cloud can open
a request on a tunnel.

- **Sending leg:** the sending Tower makes an outbound HTTPS call to the cloud, authenticated with
  its Tower key, as it already does for its other calls to the cloud.
- **Receiving leg:** the cloud forwards the message down the receiving Tower's existing tunnel and
  returns that Tower's answer to the caller.

Both legs are connections a Tower opened outwards. It works behind NAT with no network setup, opens
no new listening port on any machine, and puts identity, coarse authorization, rate limiting, audit
and revocation in one place.

**Set aside: direct Tower-to-Tower links** (LAN, VPN, tailnet). They would need a second listener
on a daemon that controls shells, certificates or keys to manage per pair, and a second place where
every security rule has to be enforced. No requirement in the three stages needs them. The address
and the grant model do not preclude adding a direct route later.

**Rejected: reusing the owner's `/t/<slug>/api/send` proxy** with a personal access token stored on
each Tower. The token grants the whole Tower API, terminals included, to whichever machine holds
it; and the request carries no caller identity, so the receiving Tower could not tell one sender
from another.

The relay is trusted for one thing only: saying which Tower a message came from. Everything else is
checked again by the receiving Tower, so a relay that is wrong or abused cannot cause delivery the
receiving owner did not grant.

| Concern | Codev Cloud (the choke point) | Receiving Tower | Sending Tower |
|---|---|---|---|
| Who is sending | Authenticates the sending Tower by its key on every relayed message and states, under a MAC the receiving Tower can verify, the Tower id and current name, the owner's account id, handle and verified email, and whether sender and recipient share an owner. No field of the message can set these | Takes the sender's Tower and owner only from the cloud's attested statement, after verifying its MAC (below) | Stamps the sending workspace and agent, as well as it can identify them (see Decision 7) |
| Who may talk to whom | Relays only between two Towers of one account, or two Towers whose owners are connected, and lists a Tower to another owner only while its remote messaging is on | Delivers only what a local grant allows: this peer, this recipient, this mode. No grant means refusal. This is the authoritative check | Refuses a Tower name that is not in its peer list, before anything leaves |
| Human hold | None | Holds for release where the grant says so | None |
| Flooding | Limits per sending Tower and per pair; caps message size | Its own limit per peer, a cap on undelivered mail per peer, the same size cap | None |
| Record | Every relay attempt as metadata (when, which Towers, message id, size, outcome class) and every connection event | Every inbound decision, release and dismissal | Every outbound attempt and outcome |
| Withdrawal | Ending a connection, or deregistering a Tower, stops relaying immediately, both ways | Removing a grant, or switching remote messaging off, stops delivery immediately | Not applicable |
| Content | Does not inspect it | Strips control characters, frames the message itself, persists first, delivers through the gate | Not applicable |

**Limits.** The outcome when one is exceeded is fixed. Who can change the number depends on who
enforces it.

- A limit enforced by a Tower is a default its owner can change, in the Codev config file on that
  Tower.
- A limit enforced by the cloud is a service limit, set by whoever runs Codev Cloud. An owner
  cannot change it from a Tower.
- Message size and message lifetime are fixed by the protocol and are not settings anywhere.

| Limit | Default | Enforced by | When exceeded |
|---|---|---|---|
| Message size | 48 KB, the same as a local send | Sending Tower, cloud, receiving Tower | Refused as too large |
| Messages relayed from one Tower | 60 a minute | Cloud | Refused as rate limited |
| Messages accepted from one peer | 30 a minute | Receiving Tower | Refused as rate limited |
| Mail from one peer accepted but not yet delivered | 50 messages | Receiving Tower | Refused as rate limited until some is delivered, released or dismissed |
| Mail waiting at the sender for one peer | 50 messages | Sending Tower | A further send to that peer is refused locally as rate limited, until some is sent, dismissed or expired |
| Discovery queries from one peer | 10 a minute | Cloud and receiving Tower | Refused as rate limited |
| Invitation lifetime (stage 3) | 24 hours, single use | Cloud | The invitation no longer works |
| Lifetime of a message | 30 days from its send time; fixed by the protocol, not configurable | Sending Tower and receiving Tower | Marked expired by the sender; refused as expired by the receiver (Decision 5) |

A refusal for rate is never retried automatically by the sending Tower; the sender is told, and
decides.

**What the cloud can read.** Bodies pass through the cloud readable, inside TLS on each leg. The
cloud must not store or log them: it holds no mail, and its record is metadata only. This is the
same exposure as the terminal traffic the cloud already carries for a connected Tower. Encrypting
bodies end to end would need Tower keys (Decision 4, alternative B) and is not proposed.

**When the cloud or the tunnel is down.** Stage 1 is unaffected. A cross-Tower message that cannot
leave is held on the sending Tower (Decision 5). Nothing arrives at a Tower whose tunnel is down.
There is no alternate route.

**How the receiving Tower knows a relayed message is genuine.** Neither where a request arrives
nor any header on it can prove it came from the relay.

- Tower's tunnel client runs inside the Tower process. It forwards every request that comes down
  the tunnel to Tower's own local listener, with the real local key and a marker header.
- A process on the machine that holds the local key can send the same marker, or any other header.
- The cloud's `/t/` browser proxy passes a browser's own headers down the same tunnel.

So the proof has to be something only the relay and this Tower hold.

1. **A secret per tunnel session.** When a Tower's tunnel is authenticated, the cloud issues it a
   fresh random 256-bit secret in the handshake reply. Both sides keep it in memory only: it is
   never written to disk and never logged. Every new tunnel connection gets a new secret, and the
   old one stops working.
2. **An attestation on every relayed request.** With each relayed message and each discovery
   query the cloud sends a statement and a MAC over it (HMAC-SHA-256, keyed with the receiving
   Tower's session secret). The statement covers:
   - the protocol version and the kind of request;
   - the receiving Tower's id;
   - the sending Tower's id and current name;
   - the sending owner's account id, handle and verified email, and whether the two Towers share
     an owner;
   - the message id (or query id) and the time the cloud issued the statement;
   - a statement id: 128 random bits the cloud generates for this one statement, so that no two
     statements are ever the same, including two for one message in the same millisecond;
   - a SHA-256 hash of the payload exactly as forwarded: the body, the recipient, and the sending
     Tower's statement of workspace and agent.
3. **The check, made before anything is stored.** The receiving Tower accepts the request only if
   all of these hold:
   - the MAC verifies under the current session's secret;
   - the receiving Tower id is its own;
   - the payload hashes to the stated value;
   - the statement was issued within five minutes of the Tower's clock;
   - its statement id has not been presented before. Tower remembers statement ids for the five
     minutes in which a statement could still be fresh.

   A statement is used up the moment it passes these checks, before the address is resolved, the
   grant is looked up or any limit is applied, and whatever the request's outcome turns out to
   be. So a statement whose message was refused for want of a grant cannot be presented again.

   A request that fails stores nothing and is recorded as a rejected attempt. What its sender is
   told depends on which check failed. A statement outside the five-minute window is refused, with
   the reason that the clock is out of range. Any other failure is reported as *not verified*,
   which is not a refusal: the sending Tower keeps the message held and tries again, as it does
   when no answer comes back. The ordinary cause is a tunnel that reconnected while the request
   was on its way, so the MAC was made with the secret before last.

   A retry is a new call to the relay and carries a new statement with a new id; its message id
   then finds the existing mailbox row, if there is one (Decision 5).

| | Stops a local caller holding the key | Stops the `/t/` browser proxy | Stops a replay | Stops a malicious cloud |
|---|---|---|---|---|
| Trust the tunnel's marker header | No | Only if the cloud strips it | No | No |
| Keep the entry point off the local listener | Yes | Only if the cloud keeps the two apart | No | No |
| **Session secret and attestation** (recommended) | Yes | Yes | Yes | No |
| A signing key per Tower (Decision 4, alternative B) | Yes | Yes | Yes | Yes |

**What this does not defend against.** A malicious or compromised cloud, which holds the secret.
The cloud is already inside every connected Tower's trust: the tunnel can drive any route the
tunnel does not block, with the local key stamped. Nor a process that can read Tower's memory,
which already owns the machine as that user.

**What the cloud must still do.**

- Authenticate the sending Tower by its key on every relay call, and build the statement only from
  its own records, never from anything the sender supplied.
- Keep each session secret in memory, one per tunnel session, and never log it.
- Drop any attestation header from requests coming through the `/t/` browser proxy, and refuse the
  relay's path there. With the MAC this is a second barrier, not the only one: if it fails, the
  result is a refused request, not a message.
- Never deliver peer traffic through `/api/send` or any other route.
- Hash exactly the bytes it forwards.

**A wrong clock.** A Tower whose clock is more than five minutes out refuses every relayed
request. It says so in `afx peer list` and in its record, and the sender of one of my own Towers
is told the reason.

Every other tunnel route keeps its current behaviour.

**Mixed versions.** Towers and the cloud are upgraded at different times.

- Every relayed message and discovery query carries a protocol version. A receiving Tower refuses
  a version it does not speak, naming the versions it does; the refusal is final, not held.
- A peer Tower too old to have the entry point at all is reported by the cloud as not supporting
  cross-Tower messaging. The send is refused with that reason. It is not held, because waiting
  will not fix it.
- The cloud states whether it has a relay, explicitly, in its answer to the peer-listing call and
  in the tunnel handshake. A Tower told that it has none says so on any `afx://` send and in
  `afx peer list`, and refuses the send. A Tower does not infer this from anything else, and in
  particular not from having no session secret.
- A Tower whose own tunnel is down can still send, because the sending leg is an ordinary HTTPS
  call. It cannot receive: mail for it, replies included, waits at its senders. `afx peer list`
  says so.
- The CLI and Tower ship in one package and are upgraded together. Tower goes on accepting the
  address as a string from a CLI, the extension or a script, and parses it itself; only
  Tower-to-Tower traffic requires the structured form. An older Tower given an `afx://` address
  fails it as an unknown recipient, which is loud and correct.
- Additions to the wire form are optional fields. Anything that changes meaning raises the
  version.

**Work that lands in the `codev-cloud` repository.**

1. A relay: accept a message from an authenticated Tower, apply the cloud's checks in the table,
   forward it to the recipient Tower's tunnel with the attested statement, and return the recipient
   Tower's answer. No body is stored or logged.
2. A peer listing for a Tower credential: the other Towers on the same account; the Towers of
   connected owners that have remote messaging on; and invitations this Tower's owner has sent.
   Each Tower comes with its id, current name, owner handle and verified email, and whether it is
   online. A Tower reports its switch state to the cloud for this.
3. Connections between owners (stage 3), as walked through in Decision 8: the invitation page, the
   invitation email, the acceptance page, the notice to the inviter, the Connections page where an
   owner sees and ends connections, and the daily limit on invitations. A connection is a record
   of two account ids. Creating, accepting, declining and cancelling require a signed-in user
   session. Ending a connection is also accepted from any Tower of either owner.
4. Carrying discovery queries the same way as messages (Decision 6).
5. The session secret in the tunnel handshake and the attested statement on every relayed request;
   and keeping the browser proxy apart from the relay, as listed under "What the cloud must still
   do".
6. Rate limits and the metadata record.
7. Dropping a deregistered Tower from every peer list at once, and ending an account's
   connections when the account is deleted.
8. Tower slugs unique per account instead of across the cloud: at registration, on rename and on
   takeover (stage 2).
9. Account handles: chosen by the account holder, unique across the cloud, changeable, asked for
   when an account first creates or accepts an invitation (stage 3).

Stage 1 needs none of this.

### Decision 4: the trust model

**Identity.**

- A **Tower** is identified by its Codev Cloud registration: the immutable Tower id, proved to the
  cloud by the Tower's key each time it authenticates. Its name is a label for that id, unique
  within its owner's account.
- An **owner** is a Codev Cloud account with a verified email. The cloud binds each Tower to one
  owner. The account's handle is a label for it; the verified email is what a person checks.
- A receiving Tower learns both from the cloud's attested statement (Decision 3). It does not
  learn them from the message.

Alternatives for how identity is proved:

| | How | For | Against |
|---|---|---|---|
| **A. Cloud-vouched identity, grants held by the Tower** (recommended) | The cloud says who is sending, in a statement the receiving Tower can verify came from the relay (Decision 3); the receiving Tower decides what that sender may do | One place proves identity, as the owner directed. No keys to create, exchange, rotate or lose. The Tower still makes its own authorization decision | A compromised cloud could forge a sender |
| **B. End-to-end Tower keys** | Each Tower holds a signing key; peers pin it when they connect; every message is signed | The relay could not forge a sender | A pairing ceremony and key lifecycle on every Tower. It buys little today: the cloud can already reach every route of a connected Tower, and someone who takes over an owner's cloud account can drive that owner's real Tower, signatures and all |
| **C. Everything decided by the cloud** | The cloud holds the grants; the Tower delivers whatever the relay hands it | Simplest Tower | The Tower trusts the relay blindly, and workspace and architect names move into the cloud's database |
| **D. A shared secret per pair** | A token copied between two Towers | No cloud involvement | A secret to move by hand; no owner identity; nothing for the choke point to enforce |

Recommended: **A**. B is the alternative to choose if the owner does not want the cloud to be able
to name a sender; it would become worthwhile if the tunnel's general exposure were narrowed first.

**Peers, connections and grants.** Three terms carry the whole model.

- A **peer** is a Tower the cloud is willing to relay to or from: every other Tower on my account,
  and every Tower of an owner I am connected with that has remote messaging on.
- A **connection** joins two owners (Decision 8). It is created by invitation and held by the
  cloud. It makes each owner's Towers peers of the other's; it permits no delivery.
- A **grant** lives on the receiving Tower and says: this peer may message these recipients, in
  this mode. The modes are *deliver* and *hold for release*. With no grant, the answer is refusal.

**How trust is established.**

- **Between my own Towers (stage 2):** my other Towers are peers automatically, because the cloud
  knows they are mine. Nothing is deliverable until remote messaging is on for both Towers and I
  have added a grant on the receiving Tower, one command per direction. A grant to one of my own
  Towers may cover every agent and defaults to *deliver*. The stage 2 walkthrough after Decision 9
  shows every command, from nothing to a reply.
- **Between two owners (stage 3):** one owner invites the other by email, and the other accepts.
  Decision 8 walks through it step by step. Both acts happen
  in a signed-in Codev Cloud session, so no agent on either machine can connect a Tower to a
  stranger using credentials it can read from disk. An invitation is single-use, expires, and can
  be used only by the account it was addressed to. Nothing unsolicited is ever shown on a Tower.
  Once connected, each owner adds grants, Tower by Tower. A grant to another owner's Tower must
  name its recipients and defaults to *hold for release*.

**Authorization.**

- Default deny, on every Tower, for every peer including my own.
- A grant names the peer Tower (`devvm`, or `sam@studio` for another owner's) and a set of
  recipients written as local addresses: one architect in one workspace
  (`codev:architect:main`), every architect in a workspace, or (own Towers only) everything.
- The unit of trust on the sending side is the **Tower**, not an agent on it. A receiving Tower
  cannot verify which agent on the other Tower wrote a message, so a grant to a Tower is a grant to
  everything running on it.
- A grant is checked against the recipient an address resolves to. `codev:architect` in a grant
  means the workspace's front door, whichever architect that is at the time.
- **What a grant stores.** The peer Tower's id; the workspace's key; and one of four scopes: the
  front door, one architect by name, every architect, or everything. Tower and workspace are
  stored as identities, so renaming either changes nothing. The front door is stored as a rule and
  is resolved when mail arrives. An architect has no identity other than its name, so a grant for
  one follows the name.
- **When the recipient is not there.** A grant can be made only for a workspace Tower has
  registered and, if it names an architect, one that exists. If the workspace or the architect is
  later removed, the grant is kept, `afx peer grants` shows it as matching nothing, and mail under
  it is refused as no such agent. It applies again if the same workspace or name returns.
- **Front door only, turned on later.** A grant that names an architect in that workspace is kept
  but stops matching: mail under it is refused as front door only, and `afx peer grants` says why.
  It applies again if the setting is turned off. Turning the setting on or off never creates or
  widens a grant.

**Builders.** One rule, the same at every distance: **a builder may name an architect only if it
is its own spawning architect.** Everywhere else it reaches architects through a front door:
`architect` (its own), `<workspace>:architect`, and from stage 2 `afx://tower/workspace:architect`.

- This is exactly the reach a builder has today, when the only thing that stops it writing
  `<workspace>:architect:<name>` is that the form does not parse. Stage 1 makes the form parse, so
  the rule has to be stated, or every builder would gain a line to every architect on the Tower.
- Builder to builder is unchanged on one Tower. Between my own Towers it follows the grant.
- A builder neither sends to another owner's Tower nor is reachable from one. Its own Tower
  refuses the send, and a grant naming a builder for another owner's Tower is refused when it is
  made. A builder is driven by its architect and by porch, and a message from outside would bypass
  both.
- Architects and humans have the new reach in full.

*The alternative: reply reach.* A builder could also be allowed to use the new reach to reply to
an agent that has messaged it, judged by finding that message in the mailbox. That needs a lookup
keyed by identity, a lifetime tied to mailbox pruning, and tests for restart and rename, all in
stage 1. The
rule above needs one comparison that Tower already makes for Spec 755. The case the reply rule
served is a named architect in another workspace messaging a builder, and the builder answering it
directly. Under the plain rule that answer takes one hop more, through the builder's own architect
or the other workspace's front door. That is what happens today, it is uncommon, and the footer of
the message says which to use (Decision 7). No case was found that the plain rule fails outright.

**The human in the loop.** A message under a *hold for release* grant is persisted and held with
its own reason. It appears in the held-mail indicator and in `afx inbox`. The owner reads it and
either releases it, after which it is delivered through the gate like any other message, or
dismisses it. The delivery machinery never releases it by itself.

Mail held for release has no lifetime. Tower neither expires it nor dismisses it, however long it
waits. The 30-day lifetime in Decision 5 governs whether a message is accepted, not what happens
to one already in the mailbox. What bounds the pile is the cap on undelivered mail per peer
(Decision 3): once 50 messages from one peer are waiting, further mail from it is refused as rate
limited until the owner releases or dismisses some. That is the intended backpressure. The
held-mail indicator is in its attention state the whole time, and the sender is told.

What this protects, stated exactly: it keeps a remote sender's text out of an agent's prompt until
something acting with the owner's local authority lets it in. It is a safeguard against the remote
sender. It is not a barrier against a process on the same machine that already holds the local
Tower key, which can release mail as it can do anything else the owner can; this spec does not add
a human-only credential to Tower. The one step that does require something an agent on the machine
does not hold is creating a cross-owner connection, which needs a signed-in cloud session.

**Withdrawal.** Removing a grant has three effects.

- New mail from that peer is refused at once.
- Mail from that peer already accepted but not yet delivered stays in the mailbox and becomes
  *held for release*, whatever mode it arrived under, so nothing slips through afterwards. The
  owner may still release or dismiss it: a grant governs what a peer may put into my mailbox, and
  what I do with a message already there is my own decision.
- Mail the peer's Tower is still holding for mine is refused when it next tries, and its row ends
  as refused on that side.

Either owner can end a connection, from any of their Towers or from the cloud. Relaying stops in
both directions between every Tower of the two owners, and each Tower removes its grants to the
other owner's Towers.

**The switch.** A Tower has one switch for remote messaging, covering sending and receiving. It
starts off. While it is off the Tower makes no relay call and accepts none, mail already waiting
for a peer stays held, and the Tower is not shown to other owners. Mail from a peer that was
already accepted but not yet delivered becomes *held for release*, exactly as when a grant is
removed, and stays so when the switch is turned on again. The Tower tells the cloud the
state of its switch when it connects and when it changes; the Tower's own check remains the one
that counts.

**The cross-Tower equivalent of the Spec 755 rule.**

1. A Tower speaks only for itself. Its identity comes from the cloud's authentication; a Tower
   cannot relay on behalf of another.
2. A builder may name only its own spawning architect, however the address is written. Qualifying
   an address with the sender's own workspace or Tower does not escape the check.
3. A sender outside the workspace never gets a builder's affinity. The front door,
   `<workspace>:architect`, means `main`, else the first registered, for every sender outside the
   workspace, on this Tower or another.

Like Spec 755's rule, the builder rule rests on a sender id the CLI asserts. It limits what an
agent does by mistake or under bad instructions. The boundary that holds against a hostile peer is
the grant on the receiving Tower.

### Decision 5: delivery semantics

A cross-Tower send is one request that travels to the receiving Tower and back, so the sender gets
the receiving Tower's real answer.

| Outcome | Meaning | Where the message is |
|---|---|---|
| `delivered` | The receiving Tower's gate passed and the write completed | Receiving Tower, delivered |
| `held`, at the recipient | Persisted on the receiving Tower and waiting: `busy`, `no-profile`, `no-live-pty` as today, or awaiting release by its owner | Receiving Tower, held |
| `held`, at the sender | It has not arrived: the recipient Tower is offline, the cloud is unreachable, or the receiving Tower could not verify the relay's statement (Decision 3) and the send will be tried again | Sending Tower, held |
| `refused` | Not accepted, with the reason: unknown Tower, no grant, no such agent, front door only, rate limited, too large, expired, remote messaging off, option not allowed, protocol not supported, clock out of range | Nowhere. The command exits non-zero |

- **To another owner**, the receiving Tower reports only `delivered`, `held` or `refused`, with no
  reason and no difference between "no such agent" and "not allowed". Reasons would reveal who
  exists and whether a human is at the keyboard.
- **A Tower that is offline: hold at the sender.** The sending Tower keeps the row, shows it in
  `afx inbox` where it can be dismissed, and sends it when the peer returns. This is the same
  promise Spec 1313 makes for an agent with no live terminal, and it is the case stage 2 exists
  for: a dev VM reporting to a laptop whose lid is closed.
  - Such a row is waiting for a route, not for a prompt, and may wait for days. It is therefore
    its own kind of held mail: only the cross-Tower sender acts on it; Spec 1313's local drainer
    and its escalation of long-held mail do not apply to it; and the inbox and the held-mail
    indicator list it separately, so a closed laptop does not look like a starved agent.
  - It is capped. While a peer is offline neither the cloud's limit nor the receiving Tower's
    applies, so the sending Tower holds at most 50 messages for one peer (Decision 3) and refuses
    the next one locally. An agent sending in a loop is stopped and told, and cannot fill the
    mailbox unnoticed.
  - Alternative, fail fast: simpler, but the report is lost unless the agent remembers to retry.
  - Alternative, hold in the cloud: rejected, because the cloud would then store message bodies.
- **Accepted once.** Each message carries an id and a send time chosen by the sending Tower, and
  both stay the same across retries. A message has a fixed lifetime of 30 days from its send time.
  The lifetime is part of the protocol, not a setting, so both Towers know it.
  - The receiving Tower records the id on the mailbox row it creates. A second arrival of the same
    id from the same peer creates no second row and is answered with the current state of the
    first: `delivered`, `held`, or `refused` if the owner dismissed it. A restart or a rename does
    not affect this, because the record is keyed by peer Tower id and message id.
  - An id belongs to one envelope: the body, the recipient, the send time and the sending Tower's
    statement of workspace and agent. The receiving Tower keeps a hash of that envelope with the
    id. A second arrival with the same id and a different envelope is refused as a mismatch and
    recorded. It is not answered with the first message's state, and it changes nothing.
  - The receiving Tower keeps that record for at least the message's lifetime, whatever its mailbox
    retention is set to, and refuses as expired any message past its lifetime. A retry can
    therefore never outlive the record that would have recognised it.
  - If no answer comes back, the sending Tower keeps its row held and retries with the same id. A
    sender-held row ends in one of four ways: accepted by the peer, refused by the peer, dismissed
    by its owner, or marked expired by the sending Tower itself when its lifetime runs out. It is
    never dropped silently, and an expired row stays visible like any other resolved row.
  - What this guarantees is one mailbox row per message. Typing that row into the terminal has the
    guarantee every local message has under Spec 1313, no more: the gate before the write, and a
    row that is never typed again once the write was accepted.
- **Order.** Messages from one sending Tower to one recipient are delivered in the order they were
  sent. The sending Tower makes one relay call at a time for each peer, in the order it accepted
  the sends, whether or not anything is held. So it sends its held mail for a peer oldest first, a
  new message for a peer that still has held mail queues behind it, and two agents sending to the
  same peer at the same moment are sent one after the other. At the recipient, Spec 1313 already drains held mail
  for an agent in arrival order. No order is promised between different senders. Two consequences:
  the queue is per peer, which costs nothing because everything that holds mail at the sender is a
  condition of the whole peer; and a refused message leaves the order, so if one is refused for
  rate the next may arrive without it.
- **Later changes are not pushed back.** A message held at the recipient and delivered an hour
  later does not notify the sender, exactly as with local held mail today.
- **Not available across Towers:** `--raw`, `--interrupt`, `--no-enter` and `--delay`. Each is
  refused by the sending Tower with a reason; the receiving Tower refuses them again. `--all`
  takes no address and stays what it is: every builder in the sender's own workspace.
- **Replies.** Every header carries the sender's address in the form the recipient would type, and
  the footer says how to reply, by the rule in Decision 7. Whether a reply to another Tower is
  accepted depends on the grants of the Tower it goes back to; if they do not allow it, the
  refusal says so.

### Decision 6: discovery

| Question | Answer |
|---|---|
| Which Towers can I reach? | My peer list (`afx peer list`): every Tower on my account by name, and every Tower of a connected owner as `owner@tower` with the owner's verified email; whether each is online, and what I have granted it |
| How did I come to know them? | My own: they are registered to my account. Someone else's: their owner and I are connected, and the Tower has remote messaging on. There is no directory of other people's Towers and no search |
| What is running on a peer? | `afx peer show` asks the peer through the relay. The peer's Tower answers; the cloud passes the answer through and keeps no directory of workspaces or agents. Every line of the answer is an address the asker can paste: `afx://devvm/codev:architect:local` for my own Tower, `afx://sam@studio/codev-cloud:architect:data` for another owner's |
| How much does a peer reveal? | Exactly what the asker could message. One of my own Towers with a full grant sees every active workspace, architects by name, builders by id, and which are live. Another owner sees the recipients they have been granted, as addresses, and nothing else: no other workspace names, no builders, no liveness |
| And on one Tower (stage 1)? | `afx workspace list` shows every workspace on this Tower with its architects, as local addresses |

Discovery queries are rate limited and recorded like messages. A peer with no grant gets the same
answer as a Tower that does not exist. A query to a peer that is offline, or made while the cloud
is unreachable, is refused with that reason. It is never held: an answer that arrives later is no
use to the command that asked.

### Decision 7: provenance

- **The receiving Tower writes the header.** It uses the cloud's attested statement for the Tower
  and owner, and
  the sending Tower's statement for the workspace and agent. Nothing in the body can alter it.
- **Two parts of a remote address carry different weight.** The owner and the Tower
  (`sam@studio`, and the verified email) are authenticated by Codev Cloud. The workspace and agent
  after the slash are what the sending Tower says, and are worth exactly as much as that Tower:
  if it is compromised, they can be anything. Grants are per Tower for this reason, and the role
  guidance says so.
- **Four cases, visibly different:**
  1. Same workspace: the header is exactly today's. Unchanged.
  2. Another workspace on this Tower (stage 1): today's header with the sender's
     workspace-qualified address in place of its bare id.
  3. One of my own Towers (stage 2): marked remote, naming the Tower.
  4. Another owner's Tower (stage 3): marked as another owner's, with the owner's verified email.

  For example, cases 2 to 4:

  ```
  ### [ARCHITECT codev:architect:review MESSAGE → tunnel | <time>] ###
  ### [REMOTE, your Tower · afx://mbp/codev:architect:main → local | <time>] ###
  ### [REMOTE, OTHER OWNER sam@example.com · afx://sam@studio/codev-cloud:architect:data → main | <time>] ###
  ```

  The address in a header is always in the shortest form correct for the recipient, so a Tower of
  another owner is always printed with its owner, even when the recipient has a Tower of the same
  name.
- **The footer never offers an address the recipient may not use.** Cases 2 to 4 carry a reply
  command on the footer line, where builder-bound frames carry theirs today, so the frame stays
  three lines. The command is the shortest address that reaches the sender *and that the recipient
  is allowed to send to*. When there is none, the footer says how to reply instead. Case 1 keeps
  today's footer unchanged.

  | Recipient | Sender | Footer |
  |---|---|---|
  | An architect | Any agent it may address | `(reply: afx send codev:architect:review "…")`, or the `afx://` form for another Tower |
  | An architect | A named architect in a front-door-only workspace | `(reply via its front door: afx send codev-cloud:architect "…")` |
  | A builder | Another builder | `(reply: afx send codev:builder-spir-12 "…")` |
  | A builder | The `main` architect of another workspace | `(reply: afx send codev:architect "…")`, the front door, which reaches it |
  | A builder | A named architect that is not its own | `(reply through your architect: afx send architect "…")` |
  | A builder | An agent on another of my Towers (stage 2) | The same three rows, with the `afx://` form: a builder's address, the front door `afx://mbp/codev:architect` when the sender is that workspace's `main`, and otherwise `(reply through your architect: afx send architect "…")` |
  | An architect | An architect on another owner's Tower | The reply command as usual, `(reply: afx send afx://sam@studio/codev-cloud:architect:data "…")`. Whether the reply is accepted is decided by the other Tower's grants, and the architect is told when it sends |
- **A body cannot counterfeit a header.** A remote body is normalised by the receiving Tower before
  it is stored, and the stored form is what is delivered.
  - It must be valid UTF-8; if it is not, the message is refused.
  - Line endings first: CR LF, a lone CR, U+2028 and U+2029 each become one line feed.
  - Then these code points are removed, and no others. The list is fixed by this spec and does
    not follow a Unicode version:
    - U+0000 to U+001F except U+0009 (tab) and U+000A (line feed);
    - U+007F to U+009F (DEL and the C1 controls);
    - U+00AD (soft hyphen), U+061C, U+180E;
    - U+200B to U+200F (zero-width space, non-joiner, joiner, and the two direction marks);
    - U+202A to U+202E and U+2066 to U+2069 (the embedding, override and isolate controls);
    - U+2060 to U+2064, and U+FEFF (word joiner, invisible operators, byte-order mark).
  - The cost is known: without the joiner and non-joiner some Persian words and some emoji
    sequences display differently. The text stays readable, and this applies to remote bodies
    only.
  - Any line whose first character other than a space or a tab begins the frame's marker is
    altered so that it no longer does.
  - The invariant, which is what the tests assert for arbitrary input: what reaches the terminal is
    a header written by Tower, then body text containing none of the listed code points and no line
    whose first character other than a space or a tab begins the frame marker, then a footer
    written by Tower.
  - Because the header comes first, a body that starts with `/` or `!` is never read by the agent's
    harness as a command.
  - All of this applies to remote bodies only. A body from this Tower is left exactly as it is
    today, including a line that begins with the frame's marker: every local sender is behind the
    same key and the same owner, and altering local bodies would change messages that work now. So
    the invariant above is asserted for remote messages, and same-Tower frames are asserted
    unchanged.
  - Printable text can still claim, in words, to be something it is not. The header and the role
    guidance below are what an agent relies on, not the body.
- **Agents are told what the markings mean.** The architect and builder role files say that a
  message marked as from another owner is a request from a third party, to be weighed, and is not
  an instruction from the agent's own human; and that in a remote address only the owner and Tower
  are verified.

### Decision 8: how two owners connect

A connection joins two **owners**. It is the only way a Tower of another owner becomes a peer.
Two things have to be decided: what a connection joins, and what carries the invitation.

**What a connection joins: two owners, or one pair of Towers.** An invitation could connect one
Tower of each owner, in which case two owners with two Towers each need four invitations. A
connection permits no delivery by itself, so the question is only what it should cost to say "we
know each other".

| | One pair of Towers | Two owners (recommended) |
|---|---|---|
| Invitations for two owners with two Towers each | Four, each emailed and accepted | One |
| A Tower either owner adds later | Another invitation | Already a peer; still needs a grant |
| What permits delivery | A grant on the receiving Tower, naming the peer Tower | The same. Grants stay per Tower |
| What each owner sees of the other | The one Tower named in the invitation: its name, and whether it is online | Every Tower of the other owner that has remote messaging on, including ones added later: its name, and whether it is online |
| What an ungranted Tower of the other owner can do | Attempt a send, which is refused, counted and recorded | The same, from any of their Towers |
| Must the invitee have a Tower before accepting? | Yes; they pick one | No |
| If the wrong person accepts | They learn one Tower name | They learn the names of my Towers that have remote messaging on |
| Ending | Pair by pair | Once, for every Tower on both sides. To cut off one Tower, remove its grants |

Recommended: **two owners**. The address already says so: `sam@studio` is Sam's Tower, and the
connection is what gives `sam@` a meaning on my Towers. Knowing each other is a fact about two
people; permission is a fact about two Towers, and it stays exactly where it was, in a grant.

The cost is the row in the table: each owner sees the names and online state of the other's
Towers. It is bounded by a switch that already exists. A Tower is shown to other owners only while
its remote messaging is on, and that is off until its owner turns it on. If the owner prefers the
least disclosure, a connection per pair of Towers is the alternative; grants, addresses and every
command but `afx peer end` are the same under it.

**What carries the invitation.**

| | What carries it | Who can use it | Does Codev Cloud send email? | What a stranger can do |
|---|---|---|---|---|
| **A. Emailed to a named address** (recommended) | An email from Codev Cloud to the address the inviter typed, containing a link | Only the account whose verified email is that address | Yes | Nothing. The link does nothing for any other account |
| B. A link the inviter passes on | A link shown to the inviter, who sends it by chat or their own email | Whoever holds it. The inviter must therefore confirm who accepted before the connection exists | No | Whoever obtains the link can ask to connect; the inviter's confirmation is the only check |
| C. A request by handle | Nothing is sent. The request appears on the other owner's Connections page in Codev Cloud | The named account | Optional, as a notice | Anyone who knows a handle can put a request in front of its owner |
| D. Mutual naming | Nothing is sent. Each owner enters the other's handle; the connection forms when both have | The two named accounts | No | Nothing is shown to anyone until both sides have named each other |

Recommended: **A**. The invitation is bound to the invitee's account, so a forwarded or leaked link
is harmless; the invitee is prompted and has something to click; and Codev Cloud already sends
account-verification email, so it is no new capability. B is the one to choose if the owner does not
want Codev Cloud emailing people who may not have an account: it needs no email but adds a
confirmation step and a link that works for whoever holds it. D needs no email and shows nothing
unsolicited to anyone, but gives the invitee nothing to act on and lets a mistyped handle wait in
silence.

**Walkthrough.** Ana (handle `ana`, Towers `mbp` and `devvm`) invites Sam (Towers `studio` and
`mbp`). All four Towers have remote messaging on.

| Step | Who | Does | Sees |
|---|---|---|---|
| 1 | Ana | Runs `afx peer invite` on either Tower, or clicks "Invite another owner" in the dashboard's Peers panel, or opens Connections on Codev Cloud. All three open the same Codev Cloud page in her browser, where she is signed in | A form with one field, the invitee's email. If her account has no handle yet, she is asked to choose one first |
| 2 | Ana | Types `sam@example.com` and submits | Exactly what Sam will be shown. The invitation, listed as pending with its expiry (24 hours) and a Cancel button. On her Towers, `afx peer list` and the Peers panel show one pending line. Nothing else changes |
| 3 | Codev Cloud | Emails `sam@example.com` | Sam's email: Ana's name, verified email and handle; what connecting means; a link; when it expires. **Nothing appears on any of Sam's Towers**: not in a dashboard, the inbox or the peer list. An invitation is text from a stranger and is kept away from anywhere an agent reads |
| 4 | Sam | Opens the link and signs in, creating and verifying an account for that address if he has none | Ana's name, verified email and handle; when the invitation was made and when it expires; the sentence "Connecting lets your Towers and Ana's exchange messages once each of you allows it, Tower by Tower. It allows nothing by itself."; what each will see of the other (the names of the other's Towers that have remote messaging on, and whether they are online); Connect and Decline. If he has no handle he chooses one. He needs no Tower registered to accept |
| 5 | Sam | Clicks Connect | "Connected with `ana` (ana@example.com). Nothing can be delivered to any of your Towers until you add a grant on it", with the command to add one |
| 6 | Every Tower of both owners | Learns of the connection from Codev Cloud | Ana's pending line is replaced by `sam@studio` and `sam@mbp`, each `connected  may message this Tower: nothing`. Sam's Towers gain `ana@mbp` and `ana@devvm` the same way. Each dashboard shows a notice of the new connection. Codev Cloud emails Ana that Sam accepted. Both owners' Connections pages list it with an End button |
| 7 | Each owner, on each Tower that should receive | Adds a first grant, for example `afx peer grant sam@studio codev:architect` on `mbp` | The grant, echoed with Sam's verified email and the mode (held for release by default). The peer list prints this command under any peer that has no grant. Until Sam adds a grant on `studio`, Ana's messages to it are refused |

**When it does not go to plan.**

- **It expires.** The link says so. Ana's pending line shows expired and then goes. Nothing was
  created; she can invite again.
- **Ana cancels it.** The link says it was withdrawn.
- **Sam declines.** Ana's pending line shows declined. Nothing was created.
- **The link reaches someone else.** It is useless to them: opened under any other account it says
  only that the invitation was sent to a different address.
- **Ana typed the wrong address.** Whoever owns that address can accept. Step 6 shows Ana exactly
  who did, by verified email and handle. They learn the names of her Towers that have remote
  messaging on. Nothing is deliverable without a grant she adds herself, and she ends the
  connection from any Tower or from Codev Cloud.
- **The two owners are already connected.** Refused when the invitation is created.
- **Someone uses invitations to send unwanted email.** An account may send a limited number a day
  (10 by default), and each email carries a link that refuses further invitations from that
  account.

**Ending a connection.** `afx peer end sam` on any of Ana's Towers, or End on the Connections
page. Relaying stops at once between every Tower of the two owners, in both directions, and each
Tower removes its grants to the other owner's Towers, so reconnecting later starts from nothing.

### Decision 9: the command surface

Everything cross-Tower sits under one new noun, `afx peer`. These are the proposed names; the plan
may change one only where it collides with an existing command. "Human only" means a trust-widening act: role files tell agents not to run it
unprompted, and it takes the same explicit flag `porch approve` does. That is a convention, not a
barrier (Decision 4).

| Command | What it does | Stage | Who may run it | Acts on |
|---|---|---|---|---|
| **Sending** | | | | |
| `afx send <address> "…"` | Changed: accepts `workspace:architect:name`; then `afx://tower/…`; then `afx://owner@tower/…`. Prints the new outcomes (held on this Tower, refused) | 1, 2, 3 | Agent or human | Tower |
| **This Tower** | | | | |
| `afx workspace list` | New: every workspace on this Tower, its address name, whether it is front door only, and its architects, builders and shells as addresses ready to paste | 1 | Agent or human | Tower |
| `afx workspace name <name>` | New: sets the current workspace's explicit address name; `--clear` removes it | 1 | Agent or human | Tower |
| `afx whoami` | Changed: also prints the caller's own address | 1 | Agent or human | Tower |
| **Peers** | | | | |
| `afx peer list` | My other Towers, connected Towers of other owners with their verified email, and invitations I have sent; whether each is online and what it may message here | 2 (other owners: 3) | Agent or human | Tower, which asks Codev Cloud |
| `afx peer show <tower-ref>` | What runs on a peer that I may message, as addresses | 2 | Agent or human | Tower, through the relay |
| `afx peer grants [<tower-ref>]` | Lists this Tower's grants | 2 | Agent or human | Tower |
| `afx peer grant <tower-ref> (<address>… \| --workspace <name> \| --all) [--deliver \| --hold]` | Adds a grant on this Tower. An address names one recipient; `codev:architect` is the workspace's front door, whichever architect that is. `--workspace` covers every architect in one workspace. `--all` covers everything and is for my own Towers only | 2 | Human only | Tower |
| `afx peer revoke <tower-ref> [<recipients>]` | Removes a grant, or all grants for a peer | 2 | Agent or human; it only narrows access | Tower |
| `afx peer on`, `afx peer off` | The remote-messaging switch, for sending and receiving. Off is where a Tower starts: it sends nothing, accepts nothing and is not shown to other owners | 2 | On: human only. Off: agent or human | Tower, which tells Codev Cloud |
| `afx peer log [--peer <tower-ref>]` | The record of cross-Tower attempts, in and out, with outcomes; no bodies | 2 | Agent or human | Tower |
| `afx peer limits` | Shows the limits in force: this Tower's own, which are changed in the user's Codev config file next to the mailbox retention setting, and the cloud's, as the cloud reports them, which cannot be changed from a Tower | 2 | Show: anyone. Change this Tower's: human only | Tower |
| `afx peer invite` | Opens Codev Cloud's invitation page in the browser. It creates nothing itself | 3 | Human, in the browser | Codev Cloud |
| `afx peer end <owner>` | Ends the connection with another owner, for every Tower on both sides | 3 | Agent or human; it only narrows access | Tower, which tells Codev Cloud |
| **Inbox** | | | | |
| `afx inbox` | Changed: three groups — waiting for a local agent (as today), held for release, waiting for a peer | 2 | Agent or human | Tower |
| `afx inbox show <id>` | Changed: for remote mail, shows the sender's full address and the owner's verified email | 2 | Agent or human | Tower |
| `afx inbox release <id>` | New: releases a message held for release; it is then delivered through the gate | 2 | Human only | Tower |
| `afx inbox dismiss <id>` | Changed: also dismisses mail held for release and mail waiting for a peer | 2 | As today | Tower |
| **Status** | | | | |
| `afx status` | Changed: one line for remote messaging — on or off, peers online, mail held for release, mail waiting for a peer | 2 | Agent or human | Tower |
| `afx tower status` | Changed: this Tower's name, the owner's handle once there is one, and the switch state | 2 | Agent or human | Tower |

**Deliberately not `afx` commands.** These happen on Codev Cloud pages under a signed-in session,
because they are the acts that must not be possible with credentials an agent can read from disk:
creating an invitation (step 2 of Decision 8), accepting or declining one, cancelling one, and choosing an
account handle. `afx peer invite` only opens the page. Codev Cloud's Connections page also lists and
ends connections, for an owner who is away from their Tower.

**The dashboard** gains a Peers panel on the Tower home page: the peer list, read-only, with the
"Invite another owner" link that opens Codev Cloud. The held-mail indicator shows three counts
instead of one, and mail held for release puts it in its attention state. Release and dismissal
stay in the CLI, as dismissal is today.

**The commands a person will use most.**

```
$ afx workspace list
codev          /Users/ana/dev/codev
  codev:architect:main            live
  codev:architect:review          live
  codev:builder-spir-1940         live
codev-cloud    /Users/ana/dev/codev-cloud
  codev-cloud:architect:main      live
  codev-cloud:architect:tunnel    no live terminal
```

```
$ afx send afx://devvm/codev:architect:local "CI is green on the tunnel branch"
[ok] Message delivered to afx://devvm/codev:architect:local (32 bytes)

$ afx send afx://devvm/codev:architect:local "CI is green on the tunnel branch"   # VM switched off
[info] Message held on this Tower (tower-offline) — mailbox id 7c1e52aa. It is sent when devvm returns.

$ afx send afx://sam@studio/codev-cloud:architect:main "Is the relay endpoint on staging?"
[error] Refused by sam@studio.
```

```
$ afx peer list
Remote messaging: on
TOWER        OWNER              STATE     MAY MESSAGE THIS TOWER
devvm        you                online    everything (deliver)
sam@studio   sam@example.com    online    codev:architect:main (hold for release)
sam@mbp      sam@example.com    offline   nothing — afx peer grant sam@mbp <recipients>
(invited)    pat@example.com    pending   expires in 19h
```

```
$ afx peer grant sam@studio codev:architect:main --a-human-explicitly-approved-this
[ok] sam@studio (sam@example.com) may message codev:architect:main on this Tower. Mail is held for release.
```

```
$ afx inbox
WAITING FOR A LOCAL AGENT
  3fa2b1c0  to architect:review   busy:composer-redraw   from builder-spir-1940                2m
HELD FOR RELEASE
  91bc04de  to architect:main     from afx://sam@studio/codev-cloud:architect:data (sam@example.com)   6m
            afx inbox show 91bc04de · afx inbox release 91bc04de · afx inbox dismiss 91bc04de
WAITING FOR A PEER
  7c1e52aa  to afx://devvm/codev:architect:local   tower-offline   from architect:main        41m
```

### Walkthrough: two of my own Towers, from nothing to a reply (stage 2)

Ana has a laptop, `mbp`, and a dev VM, `devvm`. Both are registered to her Codev Cloud account
with `afx tower connect` and their tunnels are up. Neither has ever sent a cross-Tower message.
Each has a workspace `codev`; `main` runs on the laptop and `local` on the VM.

| Step | Machine | Command | Prints |
|---|---|---|---|
| 1 | `mbp` | `afx peer list` | `Remote messaging: off — a human turns it on with: afx peer on`, then one line: `devvm  you  online  may message this Tower: nothing`. The listing works while the switch is off, so she can see what turning it on will involve |
| 2 | `mbp` | `afx peer on --a-human-explicitly-approved-this` | `[ok] Remote messaging is on for mbp. No Tower may message it yet. Allow one with: afx peer grant <tower> …` |
| 3 | `devvm` | `afx peer on --a-human-explicitly-approved-this` | The same, for `devvm` |
| 4 | `devvm` | `afx peer grant mbp codev:architect:local --a-human-explicitly-approved-this` | `[ok] mbp (your Tower) may message codev:architect:local on this Tower. Mail is delivered directly.` |
| 5 | `mbp` | `afx peer grant devvm codev:architect:main --a-human-explicitly-approved-this` | The same, for `devvm` and `codev:architect:main`. This is what lets the reply in step 9 arrive |
| 6 | `mbp` | `afx peer show devvm` | `afx://devvm/codev:architect:local  live`: one address a line, ready to paste, and only what `mbp` has been granted |
| 7 | `mbp`, architect `main` | `afx send afx://devvm/codev:architect:local "CI is green on the tunnel branch"` | `[ok] Message delivered to afx://devvm/codev:architect:local (32 bytes)` |
| 8 | `devvm`, architect `local` | Nothing; the message arrives | The frame below |
| 9 | `devvm`, architect `local` | `afx send afx://mbp/codev:architect:main "Thanks, taking over"`, pasted from the frame's footer | `[ok] Message delivered to afx://mbp/codev:architect:main (19 bytes)`, and `main` on the laptop sees the matching frame |

```
### [REMOTE, your Tower · afx://mbp/codev:architect:main → local | 2026-11-21T03:34:47.452Z] ###
CI is green on the tunnel branch
###############################  (reply: afx send afx://mbp/codev:architect:main "…")
```

**Does the sending Tower need `afx peer on` too? Yes.** The switch covers both directions. While
it is off a Tower makes no relay call and accepts none, so an agent on it cannot send off the
machine until a human has turned remote messaging on. One switch with one meaning is also easier
to hold in the head than one for each direction. So a round trip costs four human commands: the
switch on each Tower, and a grant on each Tower. Steps 2 to 5 are done once per pair of Towers.
Under the alternative in Open Question 5, where my own Towers trust each other automatically,
steps 4 and 5 disappear.

**The grants here are narrow on purpose.** Each names the one architect that should hear from the
other machine, because accepting a remote message is accepting remote instructions for an agent
with a shell. The shortcut for an owner who wants two of their own machines fully open to each
other is `afx peer grant mbp --all`, which covers every architect and builder on the Tower. It is
offered for own Towers only and is not what the documentation teaches first.

**What a skipped step looks like**, at step 7:

| Skipped | The sender sees |
|---|---|
| Step 2 (the switch on `mbp`) | `[error] Remote messaging is off on this Tower (mbp). A human turns it on with: afx peer on`. Nothing leaves the machine |
| Step 3 (the switch on `devvm`) | `[error] Refused by devvm: remote messaging is off there.` |
| Step 4 (the grant on `devvm`) | `[error] Refused by devvm: mbp has no grant there for codev:architect:local. On devvm: afx peer grant mbp codev:architect:local` |
| Step 5 (the grant on `mbp`) | Step 7 succeeds. The reply in step 9 is refused the same way, naming the command to run on `mbp` |
| `devvm` is switched off or asleep | `[info] Message held on this Tower (tower-offline) — mailbox id 7c1e52aa. It is sent when devvm returns.` |

Full reasons are shown because both Towers are Ana's. Another owner's Tower answers only
`refused` (Decision 5).

### Decision 10: the front door, and issue #1605

Issue #1605 is open and records a decision that stage 1 reverses. It says a message from another
workspace should reach only that workspace's default architect, which forwards it. It put
`<workspace>:architect:<name>` out of scope, and said that anyone who wanted it later should argue
against its reasons, not add it as a grammar completion. This section does that.

| #1605's argument | Answer |
|---|---|
| **Encapsulation.** A workspace's architects are a private detail, and seats come and go. `<workspace>:architect` survives a reorganisation; an address per name breaks senders on every rename or removal | The front door does not change. `<workspace>:architect` still means `main`, else the first registered, and is still the right address when the sender does not mind which seat answers. Naming a seat is the sender's explicit choice. When that seat has gone, the send fails at once, naming the workspace's current architects and its front door. That is the contract `architect:<name>` already has inside a workspace, where seats come and go just the same |
| **Single trust ingress.** A cross-workspace message can carry claims Tower cannot attest. One front door lets the default architect apply the workspace's conventions before anything reaches a specialised seat | Three things have changed. First, every cross-workspace frame now states the sender's workspace and agent (Decision 7); when #1605 was written the header named no sender workspace, so only a front door could give a seat that context. Second, builders gain no new reach: a builder still cannot name any architect but its own (Decision 4). Only architects and humans get the new form. Third, on one Tower every workspace has one owner and sits behind one local key. The front door was a convention there, not a boundary, and a claim is no better attested after `main` has forwarded it by hand. Where there is a real boundary, another owner, the ingress is the grant, and a grant names its recipients one by one |
| **Adequate in practice.** Forwarding once handled the real case with no friction | The owner's own later comment on the issue withdraws this. Over four days one named architect coordinated a sweep across the machine, and fifteen reports from eight workspaces landed on its `main`, which relayed each by hand, two of them as files because they would not fit in a message. That cost is why issue #1940 has the goal it has |

**A workspace can still choose front door only.** It is one setting in the workspace's own
`.codev/config.json`, so it travels with the repository and is reviewed like any other change.
With it on:

- A message from outside the workspace to one of its named architects is refused. The sender sees:
  "`codev-cloud` takes mail from other workspaces only at `codev-cloud:architect`. Send it there,
  and name the seat you want in the first line." This is the error message #1605 asked for.
- Nothing is rerouted. Tower does not deliver to `main` instead; the sender sends again.
- It applies to every sender outside the workspace, on this Tower or another. A grant that names
  one of the workspace's architects by name is refused when it is made; a grant for its front door
  is not.
- Mail inside the workspace, the front door itself, and `<workspace>:<builder>` are unchanged.
  The last works today and #1605 did not ask to close it.
- A message *from* a named architect in such a workspace still names its true sender in the
  header. Its reply command is the workspace's front door, because that is the address the
  recipient is allowed to use (Decision 7).
- `afx workspace list` marks the workspace "front door only" and shows other workspaces only its
  front door.

**The default is open.** A named architect is addressable from outside unless its workspace has
chosen front door only. Issue #1940 says a named architect "must be addressable from outside its
own workspace"; a default that needed every workspace to opt in would leave the owner's fan-out
case where it is. The other default is Open Question 12.

**What happens to #1605.** Recommended: close it as superseded when stage 1 merges.

- Its requested change 1, a purposeful error for `<workspace>:architect:<name>`, ships as the
  refusal above for a front-door-only workspace, and as a clear error naming the current
  architects for a name that does not exist.
- Its requested change 2, the addressing table in `CLAUDE.md`, `AGENTS.md` and the skeleton, is
  rewritten by stage 1 for the new rule, front door and opt-in included.
- Its out-of-scope clause is what this section argues against, in the way it asked.

### Compatibility: existing code the design must not break

This section is not design. It records how today's code behaves at the points this design
touches, so that the constraints it implies are requirements and not discoveries. Each was read
in the source for this spec. How the changes are made is the plan's business.

| Code | What it does today | What changes |
|---|---|---|
| `parseAddress` (`utils/agent-names.ts`) | Splits on the first colon and lower-cases. `codev-cloud:architect:tunnel` becomes workspace `codev-cloud`, agent `architect:tunnel`, which is then looked up as a builder id and fails `NOT_FOUND`. `afx://devvm/…` becomes workspace `afx`, agent `//devvm/…` | Replaced by the one shared parser, which returns the structured form. `resolveTarget` and `resolveAgentInRegistry` both take it. The second is the path that holds mail for a recipient with no live terminal; if only the first changes, mail to a named architect in another workspace that is between sessions is refused when it should be held |
| `isSafeSenderId` (`utils/message-format.ts`, enforced on `POST /api/send`) | Accepts a sender id of 1 to 128 characters from letters, digits, `.`, `_`, `:` and `-`. An `afx://` address has `/` and `@` and fails it | **The pattern does not change.** `from` on `/api/send` stays what it is, the sender's local id (`architect:local`, `builder-spir-1940`), with the sender's workspace path beside it. Tower composes the address shown to the recipient from those and the workspace's address name. A remote sender never comes through `/api/send`: it arrives on the relay's entry point as separate fields (owner, Tower, workspace, kind, name), each checked by its own rule. The constraint is that a remote sender is never joined into `from_agent`, which holds a local id. Nor does a remote workspace name go into `from_workspace`, which holds a local path that other code reads as one (the delivery event takes its basename; `afx inbox` prints it) |
| `architectHeaderLabel` and `senderHeaderLabel` (`utils/message-format.ts`) | Decide the header's role word from the sender string: one that begins `architect:` is `ARCHITECT:<name>`, anything else is `BUILDER <id>`, and one that fails the safe-id pattern is `BUILDER <unknown>` | Given an address they would mislabel it: `codev:architect:local` as `BUILDER codev:architect:local`, and any `afx://` address as `BUILDER <unknown>`. They keep their meaning and keep taking a local id. The new frames (cases 2 to 4 in Decision 7) take the role from the structured kind and build the address from parts already validated. A same-workspace send does not pass through the new code, which is what keeps its header byte-identical |
| `formatMessageForTarget` (`servers/tower-routes.ts`) | Chooses the frame from the recipient's kind and the sender id. It is not told the sender's workspace. It has six call sites, among them the delayed send, the hold for a recipient with no live terminal, and the Decisions tab notice | The constraint is that every one of those paths knows the sender's workspace. A path that does not gives a cross-workspace message a same-workspace header on that path only |
| `REPLY_HINT` (`utils/message-format.ts`) | One constant, `(reply: afx send architect "…")`, added to the footer line of builder-bound frames only | Computed per frame for cases 2 to 4, by the rule in Decision 7. The same-workspace builder-bound footer stays the constant |
| The short-frame limits from #1567 (`BRACKET_MIN_LINES` 4, `BRACKET_MIN_BYTES` 256, `isLongFrame` in `servers/message-write.ts`) | A frame of four lines or more, or over 256 bytes, is typed by chunked paste and not by one short write. Today's frame is three lines with the reply hint on the footer line for exactly this reason | Neither number changes and every new frame is three lines. Measured with a full timestamp, the example frames in this spec leave this much body on the short path: 103 bytes today (architect to builder), 87 cross-workspace, 68 from one of my own Towers, 26 from another owner's Tower. Past that a message takes the paste path, which is where any message of ordinary length already goes; on agy that path is typed line by line and is slower |
| `MAX_MESSAGE_BYTES` (48 KB, checked in the CLI and on `/api/send`) | Refuses a larger message loudly | The relay's entry point applies the same constant |

**Other callers that take an address.** There is one resolver, and they all go through it.

| Caller | What it accepts | Why |
|---|---|---|
| Cron task `target` (default `architect`; resolved when the task fires, through `resolveTarget` and then `resolveAgentInRegistry`) | Every local form, including `<workspace>:architect:<name>`, and an `afx://` address that names this Tower. An address for another Tower is refused when the task file is loaded, with the task named | Cron is unattended, and its sender, `af-cron`, is not an agent any peer could have granted |
| `afx interrupt`, `afx refresh` and `afx self-refresh` (they send through the same route, some with its escape option) | Local forms only. An address for another Tower is refused by the CLI and again by Tower | They act on a terminal of this machine. Their options are among those refused across Towers (Decision 5) |
| `afx send --all` | No address | Every builder in the sender's own workspace, as today |
| The SDK's `TowerClient.sendMessage(to, …)` | Any address, as a string | It passes `to` through and Tower parses it, so its signature does not change. Its result type gains the new outcomes: held on this Tower with a reason, and the refusal reasons. The structured address type lives in `codev-types`; the parser and formatter sit in the SDK beside `resolveAgentName`, where Tower and the extension already share address code |
| The VS Code extension (three sends: a builder picked from the current workspace, `architect:main` for "add architect", and `architect:<name>` for a gate approval) | Same-workspace local forms, each sent with its workspace | None changes. The extension gains no cross-workspace or remote send in this spec |
| The dashboard | Sends nothing through this route | The Decisions tab's notice is built inside Tower |

### Staging

| Stage | Delivers | Needs |
|---|---|---|
| 1. Architects on one Tower | The grammar and its structured wire form; `<workspace>:architect:<name>`; qualified provenance and reply commands; the builder rule; the front-door-only setting; explicit workspace names; the one-Tower listing; docs in both trees; issue #1605 closed as superseded | Nothing outside this repository |
| 2. My own Towers | The `afx://tower/` form; peers, grants, hold for release and its release command, the relay path, remote headers, sender-side hold, accepted-once, discovery, rate limits, records, the off switch; the `afx peer` commands | #1871; `codev-cloud` items 1, 2, 4, 5, 6, 8 |
| 3. Another owner's Tower | The `afx://owner@tower/` form; invitations and connections between owners; other-owner headers and role guidance; collapsed outcomes; filtered discovery | `codev-cloud` items 3, 7 and 9 |

**Issue #655** (cloud messaging) asked for two things. Agents on different machines messaging each
other through the cloud, and the question of how such a sender is authenticated, are subsumed by
stages 2 and 3. A human sending and reading messages from the web or a phone is not covered here.
Recommendation: narrow #655 to that remainder and point it at this spec for addressing and grants.

## Open Questions

These are the owner's decisions. The spec is written under the recommended answer to each, so it
can be planned from as it stands; approving it at the gate adopts those answers except where the
owner rules otherwise.

**Critical (blocks progress)**

1. **Which address grammar?** Recommended, and the owner's lean (not yet a ruling): G — today's
   colon grammar on one Tower, and `afx://[owner@]tower/` in front of it to leave the Tower. The
   spec is written in G. Runner-up: F with a marked owner
   (`sam@mbp:codev-cloud:architect`). The stage-1 form is the same under both, so stage 1 does not
   wait on this choice unless the owner prefers a full URI (A).
2. **Posture toward another owner's Tower.** Recommended: default deny; a grant names specific
   architects; mail is held for the owner to release unless a grant is explicitly set to deliver;
   builders are never reachable. The alternatives are stricter (always hold, with no way to opt a
   grant into direct delivery) or looser (deliver once granted).
3. **Is the cloud trusted to say who is sending?** Recommended: yes, with grants held and enforced
   by the receiving Tower (Decision 4, alternative A). The alternative is end-to-end Tower keys
   (alternative B).
4. **What does this project build after the spec is approved?** The issue says the design is the
   deliverable for now. Recommended: this project goes on to plan and implement stage 1 only, and
   stages 2 and 3 become their own issues citing this spec, since they wait on `codev-cloud` and
   #1871. The alternative is to stop at the approved spec, which ships nothing usable and leaves
   the stage 1 gap open.

**Important (shapes the design)**

5. **My own Towers: opt in per Tower, or trusted automatically?** Recommended: one switch per
   Tower, covering sending and receiving, and one grant per receiving Tower. That is four human
   commands for a round trip between two Towers (the stage 2 walkthrough). Automatic trust would
   remove the two grants, and would let a less careful machine instruct agents on a more careful
   one the moment it registers.
6. **Builders.** Recommended: a builder may name only its own spawning architect and otherwise
   uses front doors, exactly as today; it is reachable from my own Towers under a grant and never
   sends to or receives from another owner's. Alternative: let a builder also reply directly to
   any agent that has messaged it, which saves a hop in an uncommon case and adds a mailbox lookup
   to stage 1.
7. **A Tower that is offline.** Recommended: hold at the sender until the message is accepted,
   dismissed, or 30 days old. Alternative: fail fast.
8. **What another owner's sender learns.** Recommended: outcome only, with no reasons.
9. **How much the cloud records.** Recommended: Tower-level metadata only; full addresses stay in
   each Tower's own record. Recording addresses centrally would make the choke point's log more
   useful and put workspace and architect names in it.
10. **How an invitation travels.** Recommended: Codev Cloud emails it to an address the inviter
    names, and only that account can accept (Decision 8, alternative A). The alternative that
    needs no email from Codev Cloud is a link the inviter passes on, confirmed by the inviter
    after someone accepts (alternative B). Either way it is acted on only in a signed-in Codev
    Cloud session, never by a command an agent could run.
11. **What names an owner in an address.** Tower names per owner is ruled. Recommended for the
    owner part: an account handle chosen by the account holder, unique across Codev Cloud. This
    is new in Codev Cloud and needs its architect's agreement, as does per-account slug
    uniqueness.

12. **Reversing #1605.** Recommended: named architects are addressable from other workspaces by
    default, a workspace can choose front door only, and #1605 closes as superseded when stage 1
    merges (Decision 10). Alternative: front door only by default, with workspaces opting in to
    being addressed by name.
13. **What a connection joins.** Recommended: two owners, once, with grants still per Tower. The
    cost is that each owner sees the names and online state of the other's Towers that have remote
    messaging on. Alternative: one pair of Towers per invitation, which discloses one Tower and
    takes four invitations for two owners with two Towers each (Decision 8).

**Nice-to-know**

14. Disposition of #655: narrow it, as recommended above, or close it.
15. Whether a sender should be told when a held message is finally delivered.
16. Whether the default limits in Decision 3 are the right size.
17. If grammar A is chosen: how long the colon forms keep working.

## Test Scenarios

**Addressing (stage 1)**

- Every existing address form resolves as before, including bare `architect` from a builder, from a
  legacy builder and from a non-builder.
- `codev-cloud:architect:tunnel` reaches `tunnel`; an unknown architect name fails naming the
  workspace; an architect registered but with no live terminal is held `no-live-pty`.
- Malformed shapes fail with the expected shape: two components after `architect`, two before it
  (`devvm:codev:architect`, with the hint to write `afx://devvm/codev:architect` when `devvm` is
  one of my Towers), an `afx://` address with no workspace, an empty component, a character
  outside the allowed set, a port, query, fragment or percent-encoding, a reserved word used as a
  workspace.
- Two workspaces share a basename: the address fails listing both; after one is given an explicit
  name, both resolve.
- An explicit workspace name is refused when it is a reserved word, has a character outside the
  allowed set, or equals another workspace's address name (explicit or basename) in any letter
  case. A workspace registered later whose basename equals an existing explicit name does not take
  the name; it is reported as needing one of its own.
- `afx whoami` prints the caller's own address in the form another workspace on this Tower would
  type, for an architect, a named architect and a builder.
- `afx workspace name --clear` removes the explicit name: the workspace resolves by its basename
  again, the old explicit name stops resolving at once, and the name is free for another
  workspace.
- `arch:review` reaches the agent `review` in a workspace whose basename is `arch`, and
  `builder:architect` reaches the front door of a workspace whose basename is `builder`, both as
  today. Neither workspace can be named in an `afx://` address until it has an explicit name.
- Setting an explicit name equal to the basename of a workspace that is registered but not running
  is refused.
- A workspace whose basename contains a space is still reached by its local address as today, and
  is refused in an `afx://` address until it has an explicit name.
- A builder addressing `<own workspace>:architect:<other>` is refused under the Spec 755 rule. A
  builder addressing a named architect in another workspace is refused, whether or not that
  architect has messaged it, and the error names the front door. The same builder reaches
  `<other workspace>:architect`, and its own architect by name with or without its workspace.
- `<workspace>:architect` sent by a builder in another workspace reaches `main`, not the builder's
  spawning architect.
- A cross-workspace message between architects shows the qualified sender and a reply command;
  pasting the reply command delivers to the original sender.
- The footer, for each row of the table in Decision 7: the command shown is accepted when the
  recipient runs it, and a builder messaged by a named architect that is not its own is told to
  reply through its architect.
- A workspace set to front door only: mail from another workspace to its named architect is
  refused with the error in Decision 10 and nothing is delivered to `main`; mail to its front
  door, mail inside it, and mail to one of its builders are delivered; a message from its named
  architect carries the front door as its reply command; `afx workspace list` marks it.
- Mail to a named architect in another workspace that is registered but has no live terminal is
  held, on the immediate path and on the delayed path.
- A cron task whose target is an `afx://` address for another Tower is refused when the task file
  is loaded. `afx interrupt` with such an address is refused.
- The same parser result is produced by the CLI, Tower and the extension for a shared table of
  addresses.
- A shell id resolves within the workspace and as `<workspace>:<shell-id>`, as today.
- With Tower never connected to the cloud, all of the above pass and `afx://devvm/codev:architect`
  is refused with the stated reason; it is refused the same way on a connected Tower.
- A same-workspace message has a byte-identical header to today's. Every new frame has exactly
  three lines, and a cross-workspace message with a 40-byte body is typed by the short write path.

**Between my own Towers (stage 2)**

- Headline path, both directions, each direction needing its own grant.
- Another account holds a Tower with the same name as mine: my registration is not bumped, and
  `afx://<that name>/…` reaches mine.
- `afx://mbp/…` written on my own `mbp` resolves as the local address, without the cloud.
  `afx://ana@mbp/…` is refused in stage 2 as not yet available, and resolves the same way in
  stage 3.
- An `afx://` address typed unquoted in Git Bash, PowerShell and cmd arrives unchanged.
- No grant: refused, nothing persisted on the receiving Tower.
- Recipient Tower offline, then online: held at the sender, then delivered once. While held, the
  row is not attempted by the local drainer, raises no escalation after the escalation age, and is
  listed apart from local held mail.
- Three messages sent to an offline peer arrive in the order sent; a fourth sent as the peer
  returns arrives after them.
- Twenty sends issued concurrently by two agents to one recipient on an online peer arrive in the
  order the sending Tower accepted them, and at no moment are two relay calls to that peer in
  flight.
- With 50 messages already waiting for an offline peer, the next send to it is refused locally as
  rate limited and nothing is stored; after one is dismissed, a send is held again.
- A shell on another Tower cannot be addressed, including on one of my own.
- Cloud unreachable at send time: held at the sender; delivered once after reconnect.
- The relay's answer is lost after the receiving Tower accepted: the retry does not deliver twice,
  and is answered with the first message's current state, including after the owner dismissed it
  and after a Tower restart.
- A second message from the same peer that reuses an accepted message id with a different body,
  or a different recipient, is refused as a mismatch and recorded; the first message's row is
  unchanged.
- A message past its 30-day lifetime is refused as expired by the receiver, including on a
  receiver whose mailbox retention is set shorter; a sender-held row reaching that age is marked
  expired by the sender and is not sent.
- A sender-held message is refused by the peer on retry (its grant was removed meanwhile): the
  sender's row ends as refused and is not retried again.
- A message whose payload claims a different sending Tower is shown with the Tower the cloud
  authenticated.
- A relayed request is refused, and nothing is stored, when: it comes from localhost with the
  local key and the tunnel's marker header; its MAC was made with another secret; its payload was
  altered after the MAC was made; it names another receiving Tower; its statement is more than
  five minutes old; the same statement is presented twice, including one whose first presentation was refused for
  want of a grant; or its secret belongs to a tunnel
  session that has since reconnected.
- On the cloud side: a request through the `/t/` proxy to the relay's path is refused, and an
  attestation header sent by a browser does not reach the Tower.
- A message whose statement was made with the secret of a tunnel session that has just
  reconnected is reported to its sender as held, not refused; the retry is accepted under the new
  secret. A retry of a message already accepted finds the existing mailbox row.
- A Tower whose tunnel is down sends successfully to an online peer, and is not reported as
  talking to a cloud without a relay.
- A message in an unknown protocol version is refused naming the supported versions; a send to a
  peer Tower that predates the protocol is refused, not held; an address sent as a string by an
  older client is parsed by Tower and resolves.
- A body containing escape sequences, a bracketed-paste terminator, C1 controls, bidirectional
  overrides, zero-width characters, a forged header line (also one indented with spaces or tabs),
  or a leading `!` or `/` arrives as inert
  text under a genuine header, and satisfies the invariant in Decision 7. A body that is not valid
  UTF-8 is refused.
- `--raw`, `--interrupt`, `--no-enter` and `--delay` with a remote recipient are refused.
- A recipient Tower renamed in the cloud: the old name fails naming the new one; mail already held
  for it still reaches it.
- Exceeding the per-peer limit is refused as rate limited, at the cloud and, with the cloud's limit
  raised, at the Tower.
- Removing a grant while mail from that peer is held `busy`: it does not deliver; it waits for
  release.
- Remote messaging switched off on the receiving Tower: everything is refused. Switched off on the
  sending Tower: the send is refused locally and no relay call is made; mail already waiting for a
  peer stays held and is sent after the switch is turned on.
- Remote messaging switched off while mail from a peer is held `busy`: it does not deliver; it
  waits for release, and still does after the switch is turned on again.
- The stage 2 walkthrough, step by step, and each row of its skipped-step table.
- Discovery lists what the grant covers and nothing more. `afx peer show` for an offline peer is
  refused, not held.

**Between owners (stage 3)**

- The Decision 8 walkthrough, step by step, with two accounts: each step shows what the table says
  it shows, and before acceptance nothing appears on any Tower of the invitee.
- An invitation cannot be created or accepted with a Tower key; it can with a signed-in session;
  it cannot be used twice, after it expires, or after it is cancelled; opened under an account
  other than the one it was addressed to, it reveals nothing and cannot be accepted.
- Sam and I each have a Tower called `mbp`. From my side `afx://mbp/…` reaches mine and
  `afx://sam@mbp/…` reaches Sam's; from Sam's side the reverse. A message from Sam's `mbp` arrives
  on my `mbp` with a header and reply command that both say `sam@mbp`.
- Sam changes his handle: the old one stops resolving and the error names the new one; my grant to
  his Tower still applies; a stranger who then takes the old handle is not reachable by it.
- An unknown owner, and a Tower of a known owner that is not connected to mine, each fail naming
  what is connected.
- Connected but ungranted: every send is refused, and the refusal is identical for an agent that
  exists and one that does not.
- Granted one architect: mail to it is held for release; released, it is delivered through the
  gate; mail to a second architect and to a builder is refused.
- A grant naming a builder for another owner's Tower is rejected when it is made.
- A grant for a workspace that is not registered, or an architect that does not exist, is refused
  when it is made. A grant whose architect is later removed is kept and listed as matching
  nothing, mail under it is refused, and it applies again when an architect of that name
  returns. A front-door grant follows the front door when `main` is removed.
- A grant naming an architect, in a workspace then set to front door only: mail is refused as
  front door only; with the setting turned off again, it is accepted.
- The header shows the other owner's email as the cloud reports it.
- Either owner ends the connection, from a Tower and from the cloud: the next send in each
  direction is refused, for every pair of their Towers, and the grants to the other owner's Towers
  are gone.
- Two owners with two Towers each connect with one invitation; all four Towers list the other
  owner's two. A Tower with remote messaging off is not listed to the other owner and appears when
  it is switched on. A Tower registered after the connection appears without a new invitation and
  can deliver nothing until it is granted.
- Discovery by another owner returns only granted recipients.

**Non-functional**

- Stage 1 does not slow a same-workspace send. Measured as the median of 100 sends to a recipient
  whose mail is held, so that no terminal write is timed, on the commit before stage 1 and on
  stage 1: the second is within 5%, or 1 ms, of the first, whichever is larger. A same-workspace
  send also makes no network call and no database query it did not make before.
- No message body appears in a Tower log or in anything the cloud stores.
- A remote message takes the same per-agent and per-terminal locks, in the same order, as a local
  one.
- Native Windows: the recommended grammar passes through Git Bash, PowerShell and cmd unquoted.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| A remote message steers an agent with shell access into harm | Medium | High | Default deny; grants per recipient; hold for release for other owners; builders unreachable by other owners; distinct headers; role guidance |
| A peer's Tower is compromised or its agents are prompt-injected | Medium | High | A grant covers a whole Tower by design, so grants stay narrow and held; rate limits; one-command revocation |
| Codev Cloud or an owner's cloud account is compromised | Low | High | No worse than today, when the cloud can already reach every route of a connected Tower; the receiving Tower still applies its own grants and holds; stated plainly as residual |
| An agent on my own machine widens my grants or releases held mail | Low | High | Cross-owner connections need a signed-in cloud session; trust changes are recorded and shown; the same agent can already do anything on that machine |
| Stages 2 and 3 stall on `codev-cloud` | Medium | Medium | Stage 1 has no dependency on it; the cloud work is listed item by item |
| The owner is left off a retyped address for someone else's Tower, and I have a Tower of that name | Low | Medium | It reaches my own agent, never a stranger's; headers, listings and reply commands always print the owner; copying is the normal path |
| Codev Cloud does not take per-account slugs or handles | Low | High | Raised as Open Question 11 and listed item by item under Decision 3; stage 1 is unaffected; stages 2 and 3 wait on it |
| An invitation is accepted by the wrong person after a mistyped address | Low | Medium | The inviter is shown who accepted by verified email; they learn only the names of Towers that have remote messaging on; a connection permits nothing without a grant; one command ends it |
| Stale mail arrives long after it was sent | Medium | Medium | Held rows are visible and dismissable on the sending side; the header carries the send time |
| Discovery or outcome reasons leak what someone is working on | Medium | Medium | Discovery limited to granted recipients; outcomes collapsed for other owners; cloud record is Tower-level |
| A Tower name or a handle is taken by a stranger after a rename, or a look-alike handle is registered | Low | High | Names resolve only among Towers already connected to mine, by id; the verified email is shown wherever another owner appears |
| A Tower's clock is wrong and every relayed request is refused as stale | Low | Medium | The refusal says so, on the Tower and to the sender of one of my own Towers; `afx peer list` shows it |
| Flooding through the relay | Low | Medium | Limits at the cloud and at the Tower; cap on undelivered mail per peer |

## References

- Issue #1940 (this work); issue #1605 (front-door-only cross-workspace routing, answered in
  Decision 10); issue #655 (cloud messaging); issue #1871 (canonical Tower slug);
  issue #1165 (device authorization for `afx tower connect`); issue #1189 (server/client isolation)
- Spec 62 (secure remote access); Spec 97 (cloud Tower client); Spec 107 (cloud registration UI)
- Spec 110 (messaging infrastructure, the original `project:agent` grammar)
- Spec 755 (multi-architect support); Spec 786 and Spec 823 (multi-architect coordination)
- Spec 1313 (mailbox-first delivery); issue #1567 (short-frame write limits); issue #1478 and
  PR #1486 (sender attribution and the safe sender id)
- `codev-cloud` repository: Tower registry, `/t/` proxy and tunnel server
