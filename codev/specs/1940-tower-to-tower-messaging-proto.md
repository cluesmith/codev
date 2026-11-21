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

Behind all three sits one missing piece: an address that can name a Tower, a workspace, a kind of
agent and the agent itself. Behind the second and third sits a security problem that has to be
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
- The cloud knows each Tower by an immutable id, a name, a slug that is unique across the whole
  cloud, and the account that owns it. Locally, Tower stores the id, the key and the name the user
  typed, which can differ from the slug (issue #1871, not yet implemented). Tower stores nothing
  about who its owner is.
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

One address grammar names a Tower, a workspace, a kind of agent and an agent. Every address valid
today keeps its meaning. The three goals ship as three stages, each usable on its own.

**Stage 1 — architects on one Tower.** No second Tower, no transport, no Codev Cloud.

> From the `review` architect in `codev`, run `afx send codev-cloud:architect:tunnel "…"`. The
> message appears at the `tunnel` architect's prompt in `codev-cloud`, under a header that names
> `codev:architect:review` and shows the command to reply. The reply arrives the same way.

**Stage 2 — my own Towers.** Through the Codev Cloud tunnel.

> On my dev VM I allow my laptop once. From the laptop's `main` architect I run
> `afx send devvm:codev:architect:local "…"`. It appears at the `local` architect's prompt on the VM,
> marked as coming from my Tower `mbp`. If the VM is switched off, the message is held on the laptop
> and arrives when the VM comes back.

**Stage 3 — someone else's Tower.**

> A collaborator and I connect our Towers through an invitation that each of us confirms while
> signed in to Codev Cloud. I allow their Tower to message one architect of mine. Their message
> arrives held; I read it and release it; my architect sees it marked as from another owner, with
> their email and address. Anything they send to any other agent of mine is refused.

Across all stages: an address that does not resolve fails with the reason and never reaches a
different recipient; a remote message is persisted to the receiving Tower's mailbox and delivered
only through the render gate; the recipient can always tell a remote message from a local one and
always sees an address it can reply to.

The design that delivers this is argued under **Solution Approaches**: the address grammar
(Decision 1), names and renames (Decision 2), the transport and what each party enforces
(Decision 3), the trust model (Decision 4), delivery semantics (Decision 5), discovery (Decision 6)
and provenance (Decision 7).

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
      ships, a Tower-qualified address is refused with a reason that says cross-Tower messaging is
      not available, whether or not the Tower is connected.
- [ ] The address is a structured wire contract in `codev-types`, with one parser and one formatter
      shared by the CLI, Tower and the VS Code extension.
- [ ] Docs, skills and role files that teach addressing are updated in both `codev/` and
      `codev-skeleton/`.

**Stage 2 (my own Towers)**

- [ ] The headline path works between two Towers on one account, both behind NAT.
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
      confirm in a signed-in Codev Cloud session. A Tower credential alone cannot create or accept
      one.
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
- A Tower's slug is unique across Codev Cloud, as it is today.
- The cloud stays as trusted as Spec 97 made it: it can already reach every route of a connected
  Tower on the owner's behalf.
- Local trust is unchanged. Any process holding the local Tower key acts as the owner.
- Remote terminals, remote spawn, remote gate approval and messaging from a web or mobile client
  are out of scope.

## Solution Approaches

### Decision 1: the address grammar

Six candidates from genuinely different families. Each is given its best form. The same nine
addresses are written in each, using two Towers of mine (`mbp`, `devvm`), a collaborator's
(`sam-laptop`), and three workspaces (`codev`, `codev-cloud`, and `codevos.ai`, a real directory
name with a dot in it). The sender is in workspace `codev` on `mbp`.

- **A. URI scheme.** `afx://<tower>/<workspace>/<kind>/<name>`. Short forms are URI relative
  references: a path relative to the sender's workspace, a leading `/` for another workspace on the
  same Tower.
- **B. Email-like.** `<agent>@<workspace>.<tower>`. Short forms drop from the right.
- **C. Slash path, no scheme.** `<tower>/<workspace>/<kind>/<name>`. Short forms drop leading
  segments; the kind word shows where the agent part starts.
- **D. Dotted, DNS-style.** `<agent>.<workspace>.<tower>`, most specific first.
- **E. Handles through a directory.** `@<handle>`. Each addressable agent registers a short handle;
  a directory maps it to the Tower, workspace and agent. Another owner's handles are `@<owner>/…`.
- **F. Colon path.** `<tower>:<workspace>:<agent>`, most general first, where the agent part is
  `architect`, `architect:<name>` or a builder id. It extends today's grammar from two slots to a
  path; short forms drop leading components.

| # | Recipient | A. URI | C. Slash path | F. Colon path |
|---|---|---|---|---|
| 1 | My spawning architect | `architect` | `architect` | `architect` |
| 2 | Architect `review`, my workspace | `architect/review` | `architect/review` | `architect:review` |
| 3 | Builder 1940, my workspace | `builder/spir-1940` | `builder/spir-1940` | `builder-spir-1940` |
| 4 | Main architect of `codev-cloud`, this Tower | `/codev-cloud/architect` | `codev-cloud/architect` | `codev-cloud:architect` |
| 5 | Architect `tunnel` in `codev-cloud`, this Tower | `/codev-cloud/architect/tunnel` | `codev-cloud/architect/tunnel` | `codev-cloud:architect:tunnel` |
| 6 | Main architect of `codevos.ai`, this Tower | `/codevos.ai/architect` | `codevos.ai/architect` | `codevos.ai:architect` |
| 7 | Architect `local` in `codev` on `devvm` | `afx://devvm/codev/architect/local` | `devvm/codev/architect/local` | `devvm:codev:architect:local` |
| 8 | Builder 1940 in `codev` on `devvm` | `afx://devvm/codev/builder/spir-1940` | `devvm/codev/builder/spir-1940` | `devvm:codev:builder-spir-1940` |
| 9 | Main architect of `codev-cloud` on `sam-laptop` | `afx://sam-laptop/codev-cloud/architect` | `sam-laptop/codev-cloud/architect` | `sam-laptop:codev-cloud:architect` |

| # | B. Email-like | D. Dotted | E. Handles |
|---|---|---|---|
| 1 | `architect` | `architect` | `architect` |
| 2 | `review` | `review` | `@review` |
| 3 | `spir-1940` | `spir-1940` | `1940` (builders get no handle) |
| 4 | `architect@codev-cloud` | `architect.codev-cloud` | `@codev-cloud` |
| 5 | `tunnel@codev-cloud` | `tunnel.codev-cloud` | `@tunnel`, or `@codev-cloud-tunnel` if `tunnel` is taken |
| 6 | `main@codevos.ai` | `main.codevos.ai` | `@codevos` |
| 7 | `local@codev.devvm` | `local.codev.devvm` | `@devvm-local` |
| 8 | `builder-spir-1940@codev.devvm` | `builder-spir-1940.codev.devvm` | none; needs a structural form |
| 9 | `main@codev-cloud.sam-laptop` | `main.codev-cloud.sam-laptop` | `@sam/codev-cloud` |

Rows 2, 3 and 4 of candidate F are exactly what is typed today.

| Criterion | A. URI | B. Email-like | C. Slash path | D. Dotted | E. Handles | F. Colon path |
|---|---|---|---|---|---|---|
| Typed at a shell | No quoting; longest. Rows 4 to 6 start with `/`, which Git Bash on Windows rewrites into a file path | No quoting; shortest structural form | No quoting; the shell offers file names as completions | No quoting; compact | `@` at the start of a word is PowerShell's splat operator, so every handle needs quotes there | No quoting in bash, zsh, PowerShell or cmd |
| Written by an agent | Familiar shape. Two syntaxes to keep apart (full and relative); risk of percent-encoding or a trailing slash being added | Order is the reverse of everything agents write today. Row 6 is indistinguishable from a real email address | Looks like a file path; an agent may treat it as one | Looks like a hostname | Shortest, but the agent has to look the handle up | The shape agents already write, with one rule |
| Short forms | Standard relative references, but two of the three need a leading `/` or `//` | Bare name cannot say architect or builder (rows 2, 3) | Fall out cleanly | Ambiguous: two labels could be agent and workspace or workspace and Tower | A handle is already short; no hierarchy to shorten | Fall out cleanly: today's forms are the short forms |
| Dots in workspace names | Fine | Row 6 could be workspace `codevos` on Tower `ai` | Fine | Row 6 cannot be parsed | Fine | Fine |
| Survives a rename | Names only; stable ids sit underneath (Decision 2) | Same | Same | Same | Best: a handle is bound to ids, not names | Same |
| Room for a future component | Best: query, fragment, user part | Poor | A new leading segment | Poor | Directory fields | A new leading component; anything orthogonal becomes a flag |
| Migration from colon forms | Every qualified form changes; colon forms need a deprecation period; docs, skills and prompt strings change in both trees | Everything changes | As A | Everything changes | Everything changes, plus a new directory to build and keep correct | None. Every address valid today keeps its meaning |

**What decides it.**

- **B and D** fail on real data. Workspace directories contain dots (`codevos.ai`,
  `cluesmith.com`), so `main@codevos.ai` has two readings and `main.codevos.ai` has none. Both also
  put the agent first with no room to say what kind of agent it is.
- **E** is the only candidate where a rename costs nothing, and it is the shortest to type. It pays
  for that with a directory: handles must be unique, kept in step with agents that come and go, and
  for other owners published somewhere, which turns discovery into a standing disclosure. A handle
  can be re-bound, so the same text can reach a different agent later, which is the failure the
  "no fallback" constraint exists to prevent. Builders are too short-lived to register, so a
  structural form is needed anyway and the system ends up with two grammars.
- **A, C and F are one idea** — a path from the most general component to the most specific, with a
  kind word marking the agent — in three spellings. The choice between them is about the separator
  and whether the full form carries a scheme.
  - **A** is the most self-describing and the most extensible. A full address is unmistakable in
    prose and always has every component in a fixed position. Its costs are a second syntax for
    short forms, a hazard on Windows for exactly the stage-1 forms, and a migration: the colon forms
    would have to be deprecated and every doc, skill, role file and runtime hint that teaches them
    rewritten, with agents mixing the two for as long as both work.
  - **C** has A's short forms without its scheme, and so without its one clear advantage. It looks
    like a file path to shells and to agents.
  - **F** costs nothing to adopt. Stage 1 is one new form, `<workspace>:architect:<name>`. Stages 2
    and 3 add one leading component. Nothing is deprecated, nothing already written stops working,
    and there is only ever one syntax.

**Recommendation: F, the colon path.** The issue's diagnosis is right that the current grammar
cannot carry a Tower, but the defect is the two-slot split, not the colon. A path with an explicit
kind word removes the overload: the word `architect` stops being a special case the resolver
intercepts and becomes the part of the grammar that says where the agent begins.

A is the runner-up, and the right choice if the owner values a self-describing, extensible address
over continuity. The design in the rest of this spec does not depend on which is chosen: it needs
only that an address parses into `{tower?, workspace?, kind, name?}`.

**The recommended grammar in full.**

```
address   = [ tower ":" ] [ workspace ":" ] agent
agent     = "architect" [ ":" architect-name ]      ; "arch" stays an alias for "architect"
          | local-id                                ; a builder id (or a tail such as 1940), or a
                                                    ; shell id, resolved as today
```

- **Parsing.** If the address contains the word `architect` as a component, the components before
  it are the workspace, or the Tower then the workspace, and at most one component may follow: the
  architect's name. Otherwise the last component is a local id, resolved as it is today (builders by
  exact id then tail, then shells by exact id), and the components before it are the workspace, or
  the Tower then the workspace. Any other shape is malformed and fails naming the
  shape that was expected. A Tower can be named only together with a workspace.
- **Short forms.** Leaving out the Tower means this Tower. Leaving out the workspace means the
  sender's workspace. Bare `architect` keeps today's meaning exactly: from a builder, its spawning
  architect; from anyone else, `main`.
- **Components** are lower-cased and must match `[a-z0-9][a-z0-9._-]*`. No escaping or encoding
  exists; a name outside that set is not addressable until it is given one that fits (Decision 2).
  `architect`, `arch` and `builder` are reserved and cannot name a Tower or a workspace. This rule
  bounds what an address can carry. It does not loosen the existing rules for naming an architect
  or a builder, which stay as they are.
- **Shells stay local.** A shell id is addressable within a Tower exactly as today, and never from
  another Tower, including my own: text sent to a shell prompt is a command, with no agent between
  the sender and the machine.
- **Helpful failures.** When a component does not resolve as what its position says but does match
  something else, the error says so: `devvm:architect` fails with "no workspace named `devvm` on
  this Tower; `devvm` is a Tower, and a Tower address needs a workspace:
  `devvm:<workspace>:architect`".
- **Wire form.** On the wire an address is the structured object, never the string. The string is
  for people and agents.
- **Canonical display.** An address is shown in the shortest form that is correct for the reader:
  agent only within a workspace, workspace-qualified within a Tower, Tower-qualified across Towers.

### Decision 2: names, identity and renames

An address is made of names. Names change. Everything durable is therefore bound to an identity
that does not change, and names are resolved to identities at the moment of sending.

| Component | Name used in an address | Identity underneath | On rename |
|---|---|---|---|
| Tower | Its Codev Cloud slug (canonical per #1871) | The cloud's immutable Tower id | Peers learn the new slug from the cloud the next time they refresh. The old name stops resolving, and the error names the new one |
| Workspace | An explicit address name if one has been set, else the directory basename | The workspace key Tower already uses (`workspaceKey()` of its path) | The old name stops resolving on that Tower |
| Architect | Its name (Spec 755) | Name within workspace | Not renameable today |
| Builder | Its id | Id within workspace | Not renameable |

- **Grants, mailbox rows, held outbound mail and audit records store identities**, so a rename
  never silently changes who is allowed or where held mail is going.
- **A Tower name is resolved only through the sender's own peer list** (Decision 6), never by
  looking the slug up globally. If a peer renames its Tower and a stranger later registers the old
  slug, the old name does not start reaching the stranger: the stranger is not a peer.
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
- **A Tower not connected to Codev Cloud has no Tower name** and does not need one: nothing outside
  it can address it.

Alternatives considered: local aliases for peers (my own nickname for someone's Tower) — rejected
because the sender and the recipient would then write the same Tower differently, and a reply
address would not be the address the other side knows itself by. Workspace ids in addresses —
rejected as unreadable; the id belongs underneath.

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
| Who is sending | Authenticates the sending Tower by its key on every relayed message and stamps the Tower id, current name, owner account and whether sender and recipient share an owner. No field of the message can set these | Takes the sender's Tower and owner only from that stamp, and only on the tunnel | Stamps the sending workspace and agent, as well as it can identify them (see Decision 7) |
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
2. A peer listing for a Tower credential: the other Towers on the same account, and the Towers
   connected by invitation, each with id, current slug, owner and whether it is online.
3. Cross-owner connections (stage 3): create an invitation, accept it, list and end connections.
   Creation and acceptance require a signed-in user session, and a page where an owner sees and
   ends their connections.
4. Carrying discovery queries the same way as messages (Decision 6).
5. Guaranteeing that the browser proxy cannot reach the relay entry point or forge its stamp.
6. Rate limits and the metadata record.
7. Ending a Tower's cross-owner connections when the Tower is deregistered.

Stage 1 needs none of this.

### Decision 4: the trust model

**Identity.**

- A **Tower** is identified by its Codev Cloud registration: the immutable Tower id, proved to the
  cloud by the Tower's key each time it authenticates. The slug is a label for that id.
- An **owner** is a Codev Cloud account with a verified email. The cloud binds each Tower to one
  owner.
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
- **Between two owners (stage 3):** one owner creates an invitation naming one of their Towers; the
  other accepts it for one of theirs. Both steps happen in a signed-in Codev Cloud session, so no
  agent on either machine can connect a Tower to a stranger using credentials it can read from
  disk. Invitations are single-use and expire. There is no way to send an unsolicited request to a
  Tower. Once connected, each owner adds grants on their own Tower. A grant to another owner's
  Tower must name its recipients and defaults to *hold for release*.

**Authorization.**

- Default deny, on every Tower, for every peer including my own.
- A grant names the peer Tower and a set of recipients: one architect in one workspace, every
  architect in a workspace, or (own Towers only) everything.
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
| Which Towers can I reach? | My peer list: one command shows every Tower on my account and every Tower connected by invitation, with its name, owner, whether it is online, and what I have granted it |
| How did I come to know them? | My own: they are registered to my account. Someone else's: I accepted, or issued, an invitation. There is no directory of other people's Towers and no search |
| What is running on a peer? | One command asks the peer through the relay. The peer's Tower answers; the cloud passes the answer through and keeps no directory of workspaces or agents |
| How much does a peer reveal? | Exactly what the asker could message. One of my own Towers with a full grant sees every active workspace, architects by name, builders by id, and which are live. Another owner sees the recipients they have been granted, as addresses, and nothing else: no other workspace names, no builders, no liveness |
| And on one Tower (stage 1)? | One command lists every workspace on this Tower with its architects, as addresses |

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
  ### [REMOTE, your Tower mbp · mbp:codev:architect:main → local | <time>] ###
  ### [REMOTE, OTHER OWNER sam@example.com · sam-laptop:codev-cloud:architect:main → main | <time>] ###
  ```

  Cases 2 to 4 end with a reply command carrying that address.
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

### Staging

| Stage | Delivers | Needs |
|---|---|---|
| 1. Architects on one Tower | The grammar and its structured wire form; `<workspace>:architect:<name>`; qualified provenance and replies; the builder rule; explicit workspace names; the one-Tower listing; docs in both trees | Nothing outside this repository |
| 2. My own Towers | Peers, grants, the relay path, remote headers, sender-side hold, exactly-once, discovery, rate limits, records, the off switch | #1871; `codev-cloud` items 1, 2, 4, 5, 6 |
| 3. Another owner's Tower | Invitations and connections, hold for release and its release command, other-owner headers and role guidance, collapsed outcomes, filtered discovery | `codev-cloud` items 3 and 7 |

**Issue #655** (cloud messaging) asked for two things. Agents on different machines messaging each
other through the cloud, and the question of how such a sender is authenticated, are subsumed by
stages 2 and 3. A human sending and reading messages from the web or a phone is not covered here.
Recommendation: narrow #655 to that remainder and point it at this spec for addressing and grants.

## Open Questions

**Critical (blocks progress)**

1. **Which address grammar?** Recommended: F, the colon path. Runner-up: A, the URI. Everything
   else in this spec holds under either.
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
10. **Where a cross-owner connection is confirmed.** Recommended: only in a signed-in Codev Cloud
    session, never by a command an agent could run.

**Nice-to-know**

11. Disposition of #655: narrow it, as recommended above, or close it.
12. Whether a sender should be told when a held message is finally delivered.
13. Whether the default limits in Decision 3 are the right size.
14. If grammar A is chosen: how long the colon forms keep working.

## Test Scenarios

**Addressing (stage 1)**

- Every existing address form resolves as before, including bare `architect` from a builder, from a
  legacy builder and from a non-builder.
- `codev-cloud:architect:tunnel` reaches `tunnel`; an unknown architect name fails naming the
  workspace; an architect registered but with no live terminal is held `no-live-pty`.
- Malformed shapes fail with the expected shape: two components after `architect`, a Tower with no
  workspace, an empty component, a character outside the allowed set, a reserved word used as a
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
- With Tower never connected to the cloud, all of the above pass and `devvm:codev:architect` is
  refused with the stated reason; it is refused the same way on a connected Tower.
- A same-workspace message has a byte-identical header to today's, and a short cross-workspace
  message is typed by the same write path as a short same-workspace one.

**Between my own Towers (stage 2)**

- Headline path, both directions, each direction needing its own grant.
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

- An invitation cannot be created or accepted with a Tower key; it can with a signed-in session;
  it cannot be used twice or after it expires.
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
| Colon positions misread (a Tower name where a workspace was meant) | Medium | Low | Parsing is anchored on the kind word; errors say what the name is |
| Stale mail arrives long after it was sent | Medium | Medium | Held rows are visible and dismissable on the sending side; the header carries the send time |
| Discovery or outcome reasons leak what someone is working on | Medium | Medium | Discovery limited to granted recipients; outcomes collapsed for other owners; cloud record is Tower-level |
| A slug is reused by a stranger after a rename | Low | High | Tower names resolve only through the peer list, by id |
| Flooding through the relay | Low | Medium | Limits at the cloud and at the Tower; cap on undelivered mail per peer |

## References

- Issue #1940 (this work); issue #655 (cloud messaging); issue #1871 (canonical Tower slug);
  issue #1165 (device authorization for `afx tower connect`); issue #1189 (server/client isolation)
- Spec 62 (secure remote access); Spec 97 (cloud Tower client); Spec 107 (cloud registration UI)
- Spec 110 (messaging infrastructure, the original `project:agent` grammar)
- Spec 755 (multi-architect support); Spec 786 and Spec 823 (multi-architect coordination)
- Spec 1313 (mailbox-first delivery)
- `codev-cloud` repository: Tower registry, `/t/` proxy and tunnel server
