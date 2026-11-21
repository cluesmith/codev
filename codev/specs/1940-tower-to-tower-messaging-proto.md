# Specification: Messaging between workspaces and between Towers — addressing, discovery, security

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
Keep implementation phases, file paths, code, and "first we will… then we will…"
out of the spec — those belong in codev/plans/<id>-*.md.
-->

Issue: #1940. Command names, header layouts and limits shown here are illustrative; the plan settles
exact spellings. The decisions that are the owner's are collected under **Open Questions**, each with
a recommendation.

## Problem Statement

`afx send` reaches an agent only if the sender can name it, and only if it lives on the same Tower.
Three things the owner wants are impossible today, in this order of priority:

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
them with `afx inbox`. Messages are capped at 48 KB. There is no rate limit on sends.

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

> I invite a collaborator by email from Codev Cloud; they accept and pick one of their Towers. I
> allow that Tower, `sam@studio`, to message one architect of mine. Their message arrives held; I
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
(Decision 6), provenance (Decision 7), how two owners connect (Decision 8) and the commands
(Decision 9).

## Success Criteria

**Which criteria belong to this project.** This spec designs all three stages, as the issue asks.
What project 1940 goes on to build is the owner's call (Open Question 4). Under the recommended
answer, the stage 1 criteria are this project's acceptance criteria and are sufficient to plan
from. The stage 2 and stage 3 criteria are written here so that the follow-up issues inherit them;
they are not acceptance criteria for this project.

**Stage 1 (architects on one Tower)**

- [ ] A named architect in another workspace on the same Tower is addressable, and the message is
      delivered or held exactly as a same-workspace message would be, including `no-live-pty` when
      the architect is registered but has no live terminal.
- [ ] Every address form valid before this change resolves to the same recipient as before.
- [ ] A message from another workspace shows the sender's qualified address in its header, plus a
      reply command that works when pasted unchanged. Same-workspace headers are unchanged.
- [ ] The Spec 755 rule still holds when a builder qualifies an address with its own workspace
      name, and a builder cannot open a conversation with a named architect in another workspace
      (it can reply to one that messaged it).
- [ ] An ambiguous workspace name fails with an error naming every match and the remedy; giving one
      workspace an explicit address name removes the ambiguity.
- [ ] One command lists every workspace on this Tower with its architects, each as an address ready
      to paste.
- [ ] All of the above works on a Tower that has never connected to Codev Cloud. Until stage 2
      ships, an `afx://` address is refused with a reason that says cross-Tower messaging is not
      available, whether or not the Tower is connected.
- [ ] The address is a structured wire contract in `codev-types`, with one parser and one formatter
      shared by the CLI, Tower and the VS Code extension.
- [ ] Docs, skills and role files that teach addressing are updated in both `codev/` and
      `codev-skeleton/`.

**Stage 2 (my own Towers)**

- [ ] The headline path works between two Towers on one account, both behind NAT.
- [ ] A Tower's name is unique within its owner's account only. The name I give a Tower is not
      affected by what any other account has registered, and an address for one of my own Towers
      never contains an owner.
- [ ] A Tower accepts no remote message until its owner has granted a peer. A fresh install, and an
      upgraded one, refuse everything.
- [ ] The sender is told `delivered`, `held` with where and why, or `refused` with the reason. A
      refusal exits non-zero and leaves nothing on the receiving Tower.
- [ ] A message for a Tower that is offline, or sent while the cloud is unreachable, is held on the
      sending Tower, visible in `afx inbox`, and arrives exactly once when the route returns.
- [ ] Mail held on the sending Tower is a distinct kind of held mail: the local delivery drainer
      never tries to type it into a terminal, it never raises the starved-agent escalation, and
      `afx inbox` and the held-mail indicator show it apart from mail waiting for a local agent.
- [ ] Messages from one Tower to one recipient are delivered in the order they were sent.
- [ ] The recipient's header marks the message as remote and names the sending Tower and the
      sender's full address; the reply command in it works.
- [ ] The sending Tower's identity shown to the recipient comes from Codev Cloud's authentication
      of that Tower. No field of the message can change it.
- [ ] The cross-Tower entry point cannot be reached from Tower's local listener or through the
      cloud's `/t/` browser proxy.
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

- [ ] Two Towers of different owners can be connected only through an invitation that both owners
      act on in a signed-in Codev Cloud session. A Tower credential alone cannot create or accept
      one. The walkthrough in Decision 8 can be followed by two people as written.
- [ ] An invitation can be accepted only by the account it was addressed to, and before it is
      accepted nothing about it appears on any Tower of the invitee.
- [ ] Another owner's Tower is always written with its owner, `afx://sam@mbp/…`. When Sam and I
      each have a Tower called `mbp`, each address reaches the right one from either side, and
      every header, listing and reply command prints the owner when the Tower is not the reader's
      own.
- [ ] After connecting, nothing is deliverable until the receiving owner grants a specific
      recipient. Builders cannot be granted to another owner's Tower.
- [ ] A message from another owner is held for release unless the grant says otherwise. Nothing in
      Tower releases or dismisses it automatically.
- [ ] The header states that the message is from another owner and shows their verified email.
- [ ] An ungranted sender cannot distinguish "no such agent" from "not allowed", and learns nothing
      about why a message is held.
- [ ] Discovery shows another owner exactly the recipients they have been granted and nothing else.
- [ ] Either owner can end the connection from their Tower or from Codev Cloud, and relaying stops
      at once in both directions.

## Constraints

- **Transport is directed by the owner:** every cross-Tower message travels through Codev Cloud,
  which is the single security choke point. It reaches the receiving Tower down that Tower's
  existing tunnel. No Tower accepts an inbound connection.
- **A new header must not change how a message is typed.** Tower writes a short frame in one piece
  and a longer one as a chunked paste, and the current frame is sized to stay on the first path.
  Any header or reply line this work adds is sized deliberately against that threshold.
- **Stage 1 involves no transport** and must not depend on a Tower being connected to Codev Cloud.
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
agent      = "architect" [ ":" architect-name ]     ; "arch" stays an alias for "architect"
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
- **Naming myself is allowed.** `afx://ana@mbp/…` written on my own `mbp` means the same as the
  local address, and resolves without the cloud.
- **Components** are lower-cased and must match `[a-z0-9][a-z0-9._-]*`; owner handles and Tower
  names are further limited to letters, digits and hyphens. No escaping or encoding exists; a name
  outside that set is not addressable until it is given one that fits (Decision 2). `architect`,
  `arch` and `builder` cannot name a workspace. A port, a query, a fragment or a percent-encoded
  character makes the address malformed; they are free for later use. This rule bounds what an
  address can carry. It does not loosen the existing rules for naming an architect or a builder.
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
- **Grants, mailbox rows, held outbound mail and audit records store identities**, so a rename
  never silently changes who is allowed or where held mail is going.
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
  - An explicit name must fit the component rule in Decision 1, must not be a reserved word, and
    must not equal the address name of any other workspace Tower knows. Setting one that breaks a
    rule is refused with the reason.
  - An explicit name outranks a basename. If a workspace's basename equals another workspace's
    explicit name, the explicit name resolves and the other workspace is not addressable by name
    until it is given one; the error says so.
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
| Who is sending | Authenticates the sending Tower by its key on every relayed message and stamps the Tower id and current name, the owner's account id, handle and verified email, and whether sender and recipient share an owner. No field of the message can set these | Takes the sender's Tower and owner only from that stamp, and only on the tunnel | Stamps the sending workspace and agent, as well as it can identify them (see Decision 7) |
| Who may talk to whom | Relays only between two Towers of one account, or two Towers joined by an accepted connection that has not been ended | Delivers only what a local grant allows: this peer, this recipient, this mode. No grant means refusal. This is the authoritative check | Refuses a Tower name that is not in its peer list, before anything leaves |
| Human hold | None | Holds for release where the grant says so | None |
| Flooding | Limits per sending Tower and per pair; caps message size | Its own limit per peer, a cap on undelivered mail per peer, the same size cap | None |
| Record | Every relay attempt as metadata (when, which Towers, message id, size, outcome class) and every connection event | Every inbound decision, release and dismissal | Every outbound attempt and outcome |
| Withdrawal | Ending a connection or deregistering a Tower stops relaying immediately, both ways | Removing a grant, or switching remote messaging off, stops delivery immediately | Not applicable |
| Content | Does not inspect it | Strips control characters, frames the message itself, persists first, delivers through the gate | Not applicable |

**Limits.** Each is a default that the owner of the enforcing side can change; the outcome when one
is exceeded is fixed.

| Limit | Default | Enforced by | When exceeded |
|---|---|---|---|
| Message size | 48 KB, the same as a local send | Sending Tower, cloud, receiving Tower | Refused as too large |
| Messages relayed from one Tower | 60 a minute | Cloud | Refused as rate limited |
| Messages accepted from one peer | 30 a minute | Receiving Tower | Refused as rate limited |
| Mail from one peer accepted but not yet delivered | 50 messages | Receiving Tower | Refused as rate limited until some is delivered, released or dismissed |
| Discovery queries from one peer | 10 a minute | Cloud and receiving Tower | Refused as rate limited |
| Invitation lifetime (stage 3) | 24 hours, single use | Cloud | The invitation no longer works |
| Age of a message on arrival | 30 days, the mailbox retention window | Receiving Tower | Refused as expired (Decision 5) |

A refusal for rate is never retried automatically by the sending Tower; the sender is told, and
decides.

**What the cloud can read.** Bodies pass through the cloud readable, inside TLS on each leg. The
cloud must not store or log them: it holds no mail, and its record is metadata only. This is the
same exposure as the terminal traffic the cloud already carries for a connected Tower. Encrypting
bodies end to end would need Tower keys (Decision 4, alternative B) and is not proposed.

**When the cloud or the tunnel is down.** Stage 1 is unaffected. A cross-Tower message that cannot
leave is held on the sending Tower (Decision 5). Nothing arrives at a Tower whose tunnel is down.
There is no alternate route.

**The entry point is narrow.** The receiving Tower accepts cross-Tower messages at one entry point
that exists only for the cloud's relay. It is not served on Tower's local listener, and the cloud's
`/t/` browser proxy cannot address it. Every other tunnel route keeps its current behaviour.

**Work that lands in the `codev-cloud` repository.**

1. A relay: accept a message from an authenticated Tower, apply the cloud's checks in the table,
   forward it to the recipient Tower's tunnel with the identity stamp, and return the recipient
   Tower's answer. No body is stored or logged.
2. A peer listing for a Tower credential: the other Towers on the same account, the Towers
   connected by invitation, and invitations this Tower's owner has sent; each Tower with its id,
   current name, owner handle and verified email, and whether it is online.
3. Cross-owner connections (stage 3), as walked through in Decision 8: the invitation page, the
   invitation email, the acceptance page with its Tower picker, the notice to the inviter, the
   Connections page where an owner sees and ends connections, and the daily limit on invitations.
   Creating, accepting, declining and cancelling require a signed-in user session. Ending a
   connection is also accepted from either Tower.
4. Carrying discovery queries the same way as messages (Decision 6).
5. Guaranteeing that the browser proxy cannot reach the relay entry point or forge its stamp.
6. Rate limits and the metadata record.
7. Ending a Tower's cross-owner connections when the Tower is deregistered.
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
- A receiving Tower learns both from the cloud's stamp. It does not learn them from the message.

Alternatives for how identity is proved:

| | How | For | Against |
|---|---|---|---|
| **A. Cloud-vouched identity, grants held by the Tower** (recommended) | The cloud says who is sending; the receiving Tower decides what that sender may do | One place proves identity, as the owner directed. No keys to create, exchange, rotate or lose. The Tower still makes its own authorization decision | A compromised cloud could forge a sender |
| **B. End-to-end Tower keys** | Each Tower holds a signing key; peers pin it when they connect; every message is signed | The relay could not forge a sender | A pairing ceremony and key lifecycle on every Tower. It buys little today: the cloud can already reach every route of a connected Tower, and someone who takes over an owner's cloud account can drive that owner's real Tower, signatures and all |
| **C. Everything decided by the cloud** | The cloud holds the grants; the Tower delivers whatever the relay hands it | Simplest Tower | The Tower trusts the relay blindly, and workspace and architect names move into the cloud's database |
| **D. A shared secret per pair** | A token copied between two Towers | No cloud involvement | A secret to move by hand; no owner identity; nothing for the choke point to enforce |

Recommended: **A**. B is the alternative to choose if the owner does not want the cloud to be able
to name a sender; it would become worthwhile if the tunnel's general exposure were narrowed first.

**Peers, connections and grants.** Three terms carry the whole model.

- A **peer** is a Tower the cloud is willing to relay to or from: every other Tower on my account,
  and every Tower joined to mine by a connection.
- A **connection** joins two Towers of different owners. It is created by invitation and held by
  the cloud. It says the two may be relayed between; it permits no delivery.
- A **grant** lives on the receiving Tower and says: this peer may message these recipients, in
  this mode. The modes are *deliver* and *hold for release*. With no grant, the answer is refusal.

**How trust is established.**

- **Between my own Towers (stage 2):** my other Towers are peers automatically, because the cloud
  knows they are mine. Nothing is deliverable until I add a grant on the receiving Tower, one
  command per direction. A grant to one of my own Towers may cover every agent and defaults to
  *deliver*.
- **Between two owners (stage 3):** one owner invites the other by email for one of their Towers;
  the other accepts for one of theirs. Decision 8 walks through it step by step. Both acts happen
  in a signed-in Codev Cloud session, so no agent on either machine can connect a Tower to a
  stranger using credentials it can read from disk. An invitation is single-use, expires, and can
  be used only by the account it was addressed to. Nothing unsolicited is ever shown on a Tower.
  Once connected, each owner adds grants on their own Tower. A grant to another owner's Tower must
  name its recipients and defaults to *hold for release*.

**Authorization.**

- Default deny, on every Tower, for every peer including my own.
- A grant names the peer Tower (`devvm`, or `sam@studio` for another owner's) and a set of
  recipients written as local addresses: one architect in one workspace
  (`codev:architect:main`), every architect in a workspace, or (own Towers only) everything.
- The unit of trust on the sending side is the **Tower**, not an agent on it. A receiving Tower
  cannot verify which agent on the other Tower wrote a message, so a grant to a Tower is a grant to
  everything running on it.
- **Builders** are reachable from my own Towers, as they are across workspaces today. They are never
  reachable from another owner's Tower: a builder is driven by its architect and by porch, and a
  message from outside would bypass both.

**The human in the loop.** A message under a *hold for release* grant is persisted and held with
its own reason. It appears in the held-mail indicator and in `afx inbox`. The owner reads it and
either releases it, after which it is delivered through the gate like any other message, or
dismisses it. The delivery machinery never releases it by itself.

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

Either owner can end a connection, from their Tower or from the cloud; relaying stops in both
directions and each side treats the other as a peer with no grant. A Tower has one switch that
turns all remote messaging off; it starts off.

**The cross-Tower equivalent of the Spec 755 rule.**

1. A Tower speaks only for itself. Its identity comes from the cloud's authentication; a Tower
   cannot relay on behalf of another.
2. A builder keeps exactly the reach it has today. The new reach — a named architect in another
   workspace, any agent on another Tower — is open to a builder only as a reply to an agent that
   has messaged it. Architects and humans have the new reach in full.
3. Qualifying an address with the sender's own workspace or Tower does not escape the Spec 755
   check.

**What counts as a reply.** A builder may send to an address outside its existing reach when its
own Tower's mailbox holds a message from that sender to that builder. The check compares
identities (Tower id, workspace key, agent), not names, so it survives a rename. It is not used up
by replying, it survives a Tower restart because it is read from the mailbox, and it lapses when
the mailbox prunes the message (30 days after it was delivered or dismissed, by default). It
permits sending; whether the other side accepts is still decided by that side's grants.

Like Spec 755's rule, this rests on a sender id the CLI asserts. It limits what an agent does by
mistake or under bad instructions. The boundary that holds against a hostile peer is the grant on
the receiving Tower.

### Decision 5: delivery semantics

A cross-Tower send is one request that travels to the receiving Tower and back, so the sender gets
the receiving Tower's real answer.

| Outcome | Meaning | Where the message is |
|---|---|---|
| `delivered` | The receiving Tower's gate passed and the write completed | Receiving Tower, delivered |
| `held`, at the recipient | Persisted on the receiving Tower and waiting: `busy`, `no-profile`, `no-live-pty` as today, or awaiting release by its owner | Receiving Tower, held |
| `held`, at the sender | It has not left: the recipient Tower is offline, or the cloud is unreachable | Sending Tower, held |
| `refused` | Not accepted, with the reason: unknown Tower, no grant, no such agent, rate limited, too large, expired, remote messaging off, option not allowed | Nowhere. The command exits non-zero |

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
  - Alternative, fail fast: simpler, but the report is lost unless the agent remembers to retry.
  - Alternative, hold in the cloud: rejected, because the cloud would then store message bodies.
- **Exactly once.** Each message carries an id and a send time chosen by the sending Tower, and
  both stay the same across retries.
  - The receiving Tower records the id on the mailbox row it creates. A second arrival of the same
    id from the same peer creates nothing and is answered with the current state of the first:
    `delivered`, `held`, or `refused` if the owner dismissed it. That record lives exactly as long
    as the row: for ever while held, and for the retention window (30 days by default) after it is
    delivered or dismissed. A restart or a rename does not affect it, because it is keyed by peer
    Tower id and message id.
  - The receiving Tower refuses, as expired, any message whose send time is older than that
    retention window. A retry can therefore never outlive the record that would have recognised it,
    and a message cannot be resurrected after its row is gone.
  - If no answer comes back, the sending Tower keeps its row held and retries with the same id. A
    sender-held row ends in one of three ways: accepted by the peer, refused by the peer (including
    as expired), or dismissed by its owner. It is never dropped without one of these.
- **Order.** Messages from one sending Tower to one recipient are delivered in the order they were
  sent. The sending Tower sends its held mail for a peer oldest first, and a new message for a peer
  that still has held mail queues behind it. At the recipient, Spec 1313 already drains held mail
  for an agent in arrival order. No order is promised between different senders.
- **Later changes are not pushed back.** A message held at the recipient and delivered an hour
  later does not notify the sender, exactly as with local held mail today.
- **Not available across Towers:** `--raw`, `--interrupt`, `--no-enter`, `--all` and `--delay`. Each
  is refused by the sending Tower with a reason; the receiving Tower refuses them again.
- **Replies.** Every header carries the sender's address in the form the recipient must type, and a
  reply command. Whether the reply is accepted depends on the grants of the Tower it goes back to;
  if they do not allow it, the refusal says so.

### Decision 6: discovery

| Question | Answer |
|---|---|
| Which Towers can I reach? | My peer list (`afx peer list`): every Tower on my account by name, and every Tower connected by invitation as `owner@tower` with the owner's verified email; whether each is online, and what I have granted it |
| How did I come to know them? | My own: they are registered to my account. Someone else's: I accepted, or issued, an invitation. There is no directory of other people's Towers and no search |
| What is running on a peer? | `afx peer show` asks the peer through the relay. The peer's Tower answers; the cloud passes the answer through and keeps no directory of workspaces or agents. Every line of the answer is an address the asker can paste: `afx://devvm/codev:architect:local` for my own Tower, `afx://sam@studio/codev-cloud:architect:data` for another owner's |
| How much does a peer reveal? | Exactly what the asker could message. One of my own Towers with a full grant sees every active workspace, architects by name, builders by id, and which are live. Another owner sees the recipients they have been granted, as addresses, and nothing else: no other workspace names, no builders, no liveness |
| And on one Tower (stage 1)? | `afx workspace list` shows every workspace on this Tower with its architects, as local addresses |

Discovery queries are rate limited and recorded like messages. A peer with no grant gets the same
answer as a Tower that does not exist.

### Decision 7: provenance

- **The receiving Tower writes the header.** It uses the cloud's stamp for the Tower and owner, and
  the sending Tower's statement for the workspace and agent. Nothing in the body can alter it.
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

  Cases 2 to 4 end with a reply command carrying that address, for example
  `(reply: afx send afx://sam@studio/codev-cloud:architect:data "…")`. The address is always in
  the shortest form correct for the recipient, so a Tower of another owner is always printed with
  its owner, even when the recipient has a Tower of the same name.
- **A body cannot counterfeit a header.** A remote body is normalised by the receiving Tower before
  it is stored, and the stored form is what is delivered.
  - It must be valid UTF-8; if it is not, the message is refused.
  - Line endings become a single line feed.
  - Removed: every C0 control character except line feed and tab, DEL, every C1 control character
    (U+0080 to U+009F), and the Unicode characters that reorder or hide text (the bidirectional
    embedding, override and isolate controls, zero-width characters, and the byte-order mark).
  - Any line of the body that begins with the frame's marker is altered so that it no longer does.
  - The invariant, which is what the tests assert for arbitrary input: what reaches the terminal is
    a header written by Tower, then body text containing none of the removed characters and no line
    that begins with the frame marker, then a footer written by Tower.
  - Because the header comes first, a body that starts with `/` or `!` is never read by the agent's
    harness as a command.
  - Printable text can still claim, in words, to be something it is not. The header and the role
    guidance below are what an agent relies on, not the body.
- **Agents are told what the markings mean.** The architect and builder role files say that a
  message marked as from another owner is a request from a third party, to be weighed, and is not
  an instruction from the agent's own human.

### Decision 8: how two owners connect

A connection joins one Tower of one owner to one Tower of another. It is the only way a Tower of
another owner becomes a peer. What has to be decided is what carries the invitation from one person
to the other, and who is able to use it.

| | What carries it | Who can use it | Does Codev Cloud send email? | What a stranger can do |
|---|---|---|---|---|
| **A. Emailed to a named address** (recommended) | An email from Codev Cloud to the address the inviter typed, containing a link | Only the account whose verified email is that address | Yes | Nothing. The link does nothing for any other account |
| B. A link the inviter passes on | A link shown to the inviter, who sends it by chat or their own email | Whoever holds it. The inviter must therefore confirm who accepted before the connection exists | No | Whoever obtains the link can ask to connect; the inviter's confirmation is the only check |
| C. A request by handle | Nothing is sent. The request appears on the other owner's Connections page in Codev Cloud | The named account | Optional, as a notice | Anyone who knows a handle can put a request in front of its owner |
| D. Mutual naming | Nothing is sent. Each owner enters the other's handle and picks a Tower; the connection forms when both have | The two named accounts | No | Nothing is shown to anyone until both sides have named each other |

Recommended: **A**. The invitation is bound to the invitee's account, so a forwarded or leaked link
is harmless; the invitee is prompted and has something to click; and Codev Cloud already sends
account-verification email, so it is no new capability. B is the one to choose if the owner does not
want Codev Cloud emailing people who may not have an account: it needs no email but adds a
confirmation step and a link that works for whoever holds it. D needs no email and shows nothing
unsolicited to anyone, but gives the invitee nothing to act on and lets a mistyped handle wait in
silence.

**Walkthrough of A.** Ana (handle `ana`, Tower `mbp`) invites Sam, who will connect his Tower
`studio`.

| Step | Who | Does | Sees |
|---|---|---|---|
| 1 | Ana | Runs `afx peer invite` on `mbp`, or clicks "Invite another owner" in the dashboard's Peers panel, or opens Tower `mbp` on Codev Cloud. All three open the same Codev Cloud page in her browser, where she is signed in | A form with Tower `mbp` selected and a field for the invitee's email. If her account has no handle yet, she is asked to choose one first |
| 2 | Ana | Types `sam@example.com` and submits | Exactly what Sam will be shown. The invitation, listed as pending with its expiry (24 hours) and a Cancel button. On her Tower, `afx peer list` and the Peers panel show one pending line. Nothing else changes |
| 3 | Codev Cloud | Emails `sam@example.com` | Sam's email: Ana's name, verified email and handle; the Tower `mbp`; what connecting means; a link; when it expires. **Nothing appears on any of Sam's Towers**: not in a dashboard, the inbox or the peer list. An invitation is text from a stranger and is kept away from anywhere an agent reads |
| 4 | Sam | Opens the link and signs in, creating and verifying an account for that address if he has none | Ana's name, verified email and handle; the Tower `mbp`; when the invitation was made and when it expires; the sentence "Connecting lets these two Towers exchange messages once each of you allows it. It allows nothing by itself."; a list of his own Towers to choose from; Connect and Decline. If he has no handle he chooses one. If he has no Tower registered he is told to run `afx tower connect` first, and the invitation waits |
| 5 | Sam | Chooses `studio` and clicks Connect | "Connected: `sam@studio` and `ana@mbp`. Nothing can be delivered to `studio` until you add a grant there", with the command to add one |
| 6 | Both Towers | Learn of the connection from Codev Cloud | Ana's pending line becomes `sam@studio  sam@example.com  connected  may message this Tower: nothing`. Sam's peer list gains `ana@mbp  ana@example.com  connected  may message this Tower: nothing`. Each dashboard shows a notice of the new connection. Codev Cloud emails Ana that Sam accepted, naming his Tower. Both owners' Connections pages list it with an End button |
| 7 | Each owner, on their own Tower | Adds a first grant, for example `afx peer grant sam@studio codev:architect:main` on `mbp` | The grant, echoed with Sam's verified email and the mode (held for release by default). The peer list prints this command under any peer that has no grant. Until Sam adds a grant on `studio`, Ana's messages to it are refused |

**When it does not go to plan.**

- **It expires.** The link says so. Ana's pending line shows expired and then goes. Nothing was
  created; she can invite again.
- **Ana cancels it.** The link says it was withdrawn.
- **Sam declines.** Ana's pending line shows declined. Nothing was created.
- **The link reaches someone else.** It is useless to them: opened under any other account it says
  only that the invitation was sent to a different address.
- **Ana typed the wrong address.** Whoever owns that address can accept. Step 6 shows Ana exactly
  who did, by verified email and handle. Nothing is deliverable without a grant she adds herself,
  and she ends the connection from her Tower or from Codev Cloud.
- **The two Towers are already connected.** Refused when the invitation is created.
- **Someone uses invitations to send unwanted email.** An account may send a limited number a day
  (10 by default), and each email carries a link that refuses further invitations from that
  account.

One invitation connects one pair of Towers. Connecting a second Tower takes a second invitation,
because the unit of trust is the Tower.

### Decision 9: the command surface

Everything cross-Tower sits under one new noun, `afx peer`. Spellings are illustrative; the plan
settles exact names. "Human only" means a trust-widening act: role files tell agents not to run it
unprompted, and it takes the same explicit flag `porch approve` does. That is a convention, not a
barrier (Decision 4).

| Command | What it does | Stage | Who may run it | Acts on |
|---|---|---|---|---|
| **Sending** | | | | |
| `afx send <address> "…"` | Changed: accepts `workspace:architect:name`; then `afx://tower/…`; then `afx://owner@tower/…`. Prints the new outcomes (held on this Tower, refused) | 1, 2, 3 | Agent or human | Tower |
| **This Tower** | | | | |
| `afx workspace list` | New: every workspace on this Tower, its address name, and its architects, builders and shells as addresses ready to paste | 1 | Agent or human | Tower |
| `afx workspace name <name>` | New: sets the current workspace's explicit address name; `--clear` removes it | 1 | Agent or human | Tower |
| `afx whoami` | Changed: also prints the caller's own address | 1 | Agent or human | Tower |
| **Peers** | | | | |
| `afx peer list` | My other Towers, connected Towers of other owners with their verified email, and invitations I have sent; whether each is online and what it may message here | 2 (other owners: 3) | Agent or human | Tower, which asks Codev Cloud |
| `afx peer show <tower-ref>` | What runs on a peer that I may message, as addresses | 2 | Agent or human | Tower, through the relay |
| `afx peer grants [<tower-ref>]` | Lists this Tower's grants | 2 | Agent or human | Tower |
| `afx peer grant <tower-ref> <recipients> [--deliver \| --hold]` | Adds a grant on this Tower | 2 | Human only | Tower |
| `afx peer revoke <tower-ref> [<recipients>]` | Removes a grant, or all grants for a peer | 2 | Agent or human; it only narrows access | Tower |
| `afx peer on`, `afx peer off` | The remote-messaging switch. Off refuses everything and is where a Tower starts | 2 | On: human only. Off: agent or human | Tower |
| `afx peer log [--peer <tower-ref>]` | The record of cross-Tower attempts, in and out, with outcomes; no bodies | 2 | Agent or human | Tower |
| `afx peer limits` | Shows the limits in force. They are changed in the user's Codev config file, next to the mailbox retention setting | 2 | Show: anyone. Change: human only | Tower |
| `afx peer invite` | Opens Codev Cloud's invitation page for this Tower in the browser. It creates nothing itself | 3 | Human, in the browser | Codev Cloud |
| `afx peer end <owner@tower>` | Ends a connection with another owner's Tower | 3 | Agent or human; it only narrows access | Tower, which tells Codev Cloud |
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
creating an invitation (step 2 above), accepting or declining one, cancelling one, and choosing an
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

### Staging

| Stage | Delivers | Needs |
|---|---|---|
| 1. Architects on one Tower | The grammar and its structured wire form; `<workspace>:architect:<name>`; qualified provenance and replies; the builder rule; explicit workspace names; the one-Tower listing; docs in both trees | Nothing outside this repository |
| 2. My own Towers | The `afx://tower/` form; peers, grants, hold for release and its release command, the relay path, remote headers, sender-side hold, exactly-once, discovery, rate limits, records, the off switch; the `afx peer` commands | #1871; `codev-cloud` items 1, 2, 4, 5, 6, 8 |
| 3. Another owner's Tower | The `afx://owner@tower/` form; invitations and connections; other-owner headers and role guidance; collapsed outcomes; filtered discovery | `codev-cloud` items 3, 7 and 9 |

**Issue #655** (cloud messaging) asked for two things. Agents on different machines messaging each
other through the cloud, and the question of how such a sender is authenticated, are subsumed by
stages 2 and 3. A human sending and reading messages from the web or a phone is not covered here.
Recommendation: narrow #655 to that remainder and point it at this spec for addressing and grants.

## Open Questions

**Critical (blocks progress)**

1. **Which address grammar?** Recommended: G — today's colon grammar on one Tower, and
   `afx://[owner@]tower/` in front of it to leave the Tower. Runner-up: F with a marked owner
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

5. **My own Towers: opt in per Tower, or trusted automatically?** Recommended: one grant per
   receiving Tower. Automatic trust would let a less careful machine instruct agents on a more
   careful one the moment it registers.
6. **Builders.** Recommended: reachable from my own Towers, never from another owner's; and a
   builder may use the new reach only to reply. Alternatives: architects only everywhere; or
   builders unrestricted between my own Towers.
7. **A Tower that is offline.** Recommended: hold at the sender, never expiring, dismissable.
   Alternative: fail fast.
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

**Nice-to-know**

12. Disposition of #655: narrow it, as recommended above, or close it.
13. Whether a sender should be told when a held message is finally delivered.
14. Whether the default limits in Decision 3 are the right size.
15. If grammar A is chosen: how long the colon forms keep working.

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
  allowed set, or equals another workspace's address name in any letter case. A workspace whose
  basename equals another's explicit name is reported as needing a name of its own.
- A builder's reply reach survives a Tower restart and a rename of the sender's workspace, and is
  gone once the original message has been pruned from the mailbox.
- A builder addressing `<own workspace>:architect:<other>` is refused under the Spec 755 rule; a
  builder opening a conversation with a named architect in another workspace is refused; the same
  builder replying to that architect succeeds.
- A cross-workspace message shows the qualified sender and a reply command; pasting the reply
  command delivers to the original sender.
- The same parser result is produced by the CLI, Tower and the extension for a shared table of
  addresses.
- A shell id resolves within the workspace and as `<workspace>:<shell-id>`, as today.
- With Tower never connected to the cloud, all of the above pass and `afx://devvm/codev:architect`
  is refused with the stated reason; it is refused the same way on a connected Tower.
- A same-workspace message has a byte-identical header to today's, and a short cross-workspace
  message is typed by the same write path as a short same-workspace one.

**Between my own Towers (stage 2)**

- Headline path, both directions, each direction needing its own grant.
- Another account holds a Tower with the same name as mine: my registration is not bumped, and
  `afx://<that name>/…` reaches mine.
- `afx://ana@mbp/…` written on my own `mbp` resolves as the local address, without the cloud.
- An `afx://` address typed unquoted in Git Bash, PowerShell and cmd arrives unchanged.
- No grant: refused, nothing persisted on the receiving Tower.
- Recipient Tower offline, then online: held at the sender, then delivered once. While held, the
  row is not attempted by the local drainer, raises no escalation after the escalation age, and is
  listed apart from local held mail.
- Three messages sent to an offline peer arrive in the order sent; a fourth sent as the peer
  returns arrives after them.
- A shell on another Tower cannot be addressed, including on one of my own.
- Cloud unreachable at send time: held at the sender; delivered once after reconnect.
- The relay's answer is lost after the receiving Tower accepted: the retry does not deliver twice,
  and is answered with the first message's current state, including after the owner dismissed it
  and after a Tower restart.
- A message whose send time is older than the retention window is refused as expired.
- A sender-held message is refused by the peer on retry (its grant was removed meanwhile): the
  sender's row ends as refused and is not retried again.
- A message whose payload claims a different sending Tower is shown with the Tower the cloud
  authenticated.
- A request to the cross-Tower entry point from localhost, and one through the `/t/` proxy, are
  both rejected.
- A body containing escape sequences, a bracketed-paste terminator, C1 controls, bidirectional
  overrides, zero-width characters, a forged header line, or a leading `!` or `/` arrives as inert
  text under a genuine header, and satisfies the invariant in Decision 7. A body that is not valid
  UTF-8 is refused.
- `--raw`, `--interrupt`, `--no-enter`, `--delay` and `--all` with a remote recipient are refused.
- A recipient Tower renamed in the cloud: the old name fails naming the new one; mail already held
  for it still reaches it.
- Exceeding the per-peer limit is refused as rate limited, at the cloud and, with the cloud's limit
  raised, at the Tower.
- Removing a grant while mail from that peer is held `busy`: it does not deliver; it waits for
  release.
- Remote messaging switched off: everything is refused.
- Discovery lists what the grant covers and nothing more.

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
- The header shows the other owner's email as the cloud reports it.
- Either owner ends the connection, from the Tower and from the cloud: the next send in each
  direction is refused.
- Discovery by another owner returns only granted recipients.

**Non-functional**

- Stage 1 adds no measurable latency to a same-workspace send.
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
| An invitation is accepted by the wrong person after a mistyped address | Low | Medium | The inviter is shown who accepted by verified email; a connection permits nothing without a grant; one command ends it |
| Stale mail arrives long after it was sent | Medium | Medium | Held rows are visible and dismissable on the sending side; the header carries the send time |
| Discovery or outcome reasons leak what someone is working on | Medium | Medium | Discovery limited to granted recipients; outcomes collapsed for other owners; cloud record is Tower-level |
| A Tower name or a handle is taken by a stranger after a rename, or a look-alike handle is registered | Low | High | Names resolve only among Towers already connected to mine, by id; the verified email is shown wherever another owner appears |
| Flooding through the relay | Low | Medium | Limits at the cloud and at the Tower; cap on undelivered mail per peer |

## References

- Issue #1940 (this work); issue #655 (cloud messaging); issue #1871 (canonical Tower slug);
  issue #1165 (device authorization for `afx tower connect`); issue #1189 (server/client isolation)
- Spec 62 (secure remote access); Spec 97 (cloud Tower client); Spec 107 (cloud registration UI)
- Spec 110 (messaging infrastructure, the original `project:agent` grammar)
- Spec 755 (multi-architect support); Spec 786 and Spec 823 (multi-architect coordination)
- Spec 1313 (mailbox-first delivery)
- `codev-cloud` repository: Tower registry, `/t/` proxy and tunnel server
