# Plan: Stage 1 of messaging between workspaces — named architects across workspaces on one Tower

**Specification**: [codev/specs/1940-tower-to-tower-messaging-proto.md](../specs/1940-tower-to-tower-messaging-proto.md)

## Executive Summary

The spec designs three stages. The owner approved it with the recommended answer to every Open
Question, including Open Question 4: **this project builds stage 1 only.** Stages 2 and 3 (my own
Towers, another owner's Tower) become follow-up issues that the architect files. Nothing in this
plan builds a peer, a grant, a relay call, a remote header or an `afx peer` command.

Stage 1 is grammar G on one Tower: today's colon grammar gains one form,
`<workspace>:architect:<name>`, and every form valid today keeps its meaning. `afx://` addresses
are parsed, so that malformed ones fail with the right reason, and then refused: a stage 1 Tower
does not know its own canonical name.

The approach, in the order the phases take it:

1. One structured address type in `codev-types` and one parser and formatter in `codev-sdk`,
   replacing the two-slot `parseAddress`.
2. Both of Tower's resolvers (`resolveTarget` for live terminals, `resolveAgentInRegistry` for
   mail held for an agent with no live terminal) take the structured address. The new form
   resolves, and the builder rule is enforced.
3. A workspace can be given an explicit address name, which is the remedy for two workspaces with
   the same basename.
4. A message from another workspace carries the sender's qualified address in its header and a
   reply command in its footer that the recipient is allowed to run.
5. `afx workspace list` and `afx whoami` show addresses ready to paste.
6. Docs in both trees, and the end-to-end checks.
7. The front-door-only workspace setting, kept apart from everything else (see below).

**The front-door-only setting is its own last phase, on purpose.** The owner has asked about the
opt-in setting in spec Decision 10 and has not ruled; the architect recommended cutting it from
stage 1. Phase 7 holds all of it: the config key, the refusal, its footer row, its mark in the
listing, its doc sentences and its tests. No earlier phase depends on it. If the owner drops it at
plan approval, phase 7 is removed with `porch skip-phase` and phases 1 to 6 ship unchanged. The
default (named architects are addressable from other workspaces) and the builder front-door rule
are not in question and live in phases 2 and 4.

Each phase is one git commit on `builder/spir-1940`, inside a single PR opened in the review
phase.

## Phases (Machine Readable)

<!-- REQUIRED: porch parses this JSON to track phase progress. Keep it in sync when you add or remove phases; at least two phases. -->

```json
{
  "phases": [
    {"id": "phase_1", "title": "Shared address contract and parser"},
    {"id": "phase_2", "title": "Named architects across workspaces and the builder rule"},
    {"id": "phase_3", "title": "Explicit workspace names"},
    {"id": "phase_4", "title": "Qualified provenance and reply commands"},
    {"id": "phase_5", "title": "One-Tower discovery: workspace list and whoami"},
    {"id": "phase_6", "title": "Addressing docs in both trees and end-to-end verification"},
    {"id": "phase_7", "title": "Front-door-only workspace setting (separable)"}
  ]
}
```

## Where each stage 1 criterion is met

| Stage 1 success criterion (spec) | Phase |
|---|---|
| A named architect in another workspace is addressable; delivered or held as a same-workspace message would be, including `no-live-pty` | 2 |
| Every address form valid before resolves to the same recipient | 1 (parser table), 2 (resolver) |
| Cross-workspace header shows the qualified sender; footer says how to reply; same-workspace frames unchanged | 4 |
| A builder can name only its own spawning architect, however the address is qualified | 2 |
| No reply command in a footer is one the recipient's own send would refuse | 4 |
| A front-door-only workspace refuses outside mail to its named architects | 7 |
| An ambiguous workspace name fails naming every match and the remedy; an explicit name removes it | 3 |
| One command lists every workspace with its architects as addresses; `afx whoami` prints the caller's address; a name can be cleared | 5 (list, whoami), 3 (clear) |
| Works on a Tower never connected to Codev Cloud; `afx://` refused with a stated reason, connected or not | 2, checked end to end in 6 |
| The address is a structured contract in `codev-types` with one parser and one formatter shared by the CLI, Tower and the extension | 1 |
| Docs, skills and role files updated in both trees | 6 (and 7 for the opt-in sentences) |

## Phase Breakdown

### Phase 1: Shared address contract and parser

**Dependencies**: None

#### Objective

One structured address type and one parser and formatter that every consumer imports. This phase
adds them and proves them against a table; nothing calls them in production yet, so behaviour is
unchanged.

#### Files to Create / Modify

- `packages/types/src/messaging.ts` — add `AgentAddress`
  (`{ owner?, tower?, workspace?, kind: 'architect' | 'id', name? }`, the shape the spec fixes)
  and the parse-error type (a code and the expected shape as text). Export from
  `packages/types/src/index.ts`.
- `packages/sdk/src/address.ts` (new) — `parseAddress(text)` and `formatAddress(address, reader)`.
  It sits beside `agent-names.ts`, where Tower and the extension already share address code, and
  imports only `codev-types`.
- `packages/sdk/package.json` — add the `./address` export.
- `packages/sdk/src/__tests__/fixtures/address-cases.json` (new) — the shared table: input,
  expected structured result or expected error code.
- `packages/sdk/src/__tests__/address.test.ts` (new).
- `packages/codev/src/agent-farm/__tests__/address-conformance.test.ts` (new) and
  `apps/vscode/src/__tests__/address-conformance.test.ts` (new) — each loads the same JSON table
  and runs it through that package's own import of the parser.

#### Deliverables

- [ ] The parser implements the spec's grammar exactly ("The recommended grammar in full"):
  - Local: if a component is the word `architect`, at most one component precedes it (the
    workspace) and at most one follows (the name). `arch` is an alias only where it is the whole
    agent part (`arch`, `codev:arch`). Otherwise a local id, optionally preceded by a workspace.
  - `arch:review` stays the id `review` in a workspace named `arch`; `builder:architect` stays the
    front door of a workspace named `builder`.
  - A local workspace component is not checked against the component rule, so a basename with any
    characters keeps matching as it does today. Input is lower-cased, as today.
  - Remote: `afx://[owner@]tower/workspace:agent`. Components must fit
    `[a-z0-9][a-z0-9._-]*`; owner and Tower are letters, digits and hyphens only; the workspace is
    required and may not be `architect`, `arch` or `builder`. A port, a query, a fragment, a
    percent-encoded character or an empty component is malformed.
  - Every malformed shape returns an error that names the shape that was expected.
- [ ] The formatter prints the shortest form correct for the reader, in the spec's four tiers.
  Stage 1 only ever produces the first two; all four are implemented because the grammar is fixed
  and the round-trip tests need them.
- [ ] `parse(format(a)) = a` for every valid row of the table.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] The table covers every row of the spec's "Shortest correct form" and "Full form" tables for
  candidate G, every form in the spec's "Current State" addressing table, and every malformed
  shape listed in the spec's stage 1 test scenarios.
- [ ] The same table passes in `codev-sdk`, in `packages/codev` and in `apps/vscode`.
- [ ] The SDK's existing import-boundary test still passes: `address.ts` imports nothing but
  `codev-types`.
- [ ] Build and the unit suites of the three packages pass.

#### Test Plan

Table-driven unit tests only. No Tower, no database.

### Phase 2: Named architects across workspaces and the builder rule

**Dependencies**: Phase 1

#### Objective

`afx send codev-cloud:architect:tunnel "…"` reaches the `tunnel` architect in `codev-cloud`, or is
held for it, exactly as a same-workspace message would be. A builder gains no new reach. This is
the phase that closes the gap issue #1940 names first.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/utils/agent-names.ts` — delete the two-slot `parseAddress`;
  re-export the SDK's.
- `packages/codev/src/agent-farm/servers/tower-messages.ts` — `resolveTarget` and
  `resolveAgentInRegistry` take the structured address and a sender context (the sender's local id
  and the sender's workspace). They share one workspace lookup and one "may this sender name this
  architect" check, so the two resolvers cannot disagree. New error codes beside `NOT_FOUND`,
  `AMBIGUOUS` and `NO_CONTEXT`: malformed address, refused, and cross-Tower not available.
- `packages/codev/src/agent-farm/servers/tower-routes.ts` — `handleSend`, `handleDelayedSend` and
  `deliverCronMessage` parse once and pass the sender context; the new error codes map to HTTP
  statuses (400 for malformed and for cross-Tower not available, 403 for refused).
- `packages/codev/src/agent-farm/servers/tower-cron.ts` — a task whose `target` is an `afx://`
  address is refused when the task file is loaded, with the task named.
- `packages/codev/src/agent-farm/commands/interrupt.ts` and
  `packages/codev/src/agent-farm/commands/reset.ts` (`afx refresh`) — refuse an `afx://` address
  before calling Tower. `self-refresh.ts` sends to the caller's own id and accepts no address, so
  it is not changed.
- `packages/sdk/src/tower-client.ts` — `sendMessage` keeps its signature and passes `to` through
  as a string; its failure result gains the error code, so a caller can tell a refusal from a
  malformed address without matching message text.
- Tests: `tower-messages.test.ts`, `spec-755-phase3-routing.test.ts`,
  `spec-1313-registry-resolve.test.ts`, `spec-1307-send-delay.test.ts`, `tower-routes.test.ts`,
  `tower-cron-routes.test.ts`, `agent-names.test.ts`, `tower-client-send.test.ts`, updated or
  extended; one new file for the cross-workspace cases.

#### Deliverables

- [ ] `<workspace>:architect:<name>` resolves against live terminals and against the registry.
  The registry path is not optional: without it, mail to a named architect in another workspace
  that is between sessions is refused when it should be held.
- [ ] An unknown architect name fails naming the workspace, its current architects and its front
  door.
- [ ] **The builder rule.** A sender that is a registered builder may name an architect only if it
  is its own spawning architect, with or without its own workspace in front. `<own
  workspace>:architect:<other>` is refused with today's Spec 755 message, unchanged. A named
  architect in another workspace is refused with a message that names that workspace's front door.
- [ ] **Affinity stays inside the workspace.** The builder lookup uses the sender's workspace, not
  the target's. `<other workspace>:architect` from a builder reaches `main` (else the first
  registered), never that builder's spawning architect. `<own workspace>:architect` from a builder
  keeps today's affinity.
- [ ] Malformed shapes fail with the expected shape, for example `devvm:codev:architect`: "a local
  address has at most a workspace before `architect`".
- [ ] Every `afx://` address is refused with a reason that says cross-Tower messaging is not
  available, whether or not the Tower is connected to Codev Cloud. A malformed `afx://` address
  fails as malformed, not as unavailable.
- [ ] Shell ids resolve as today, alone and as `<workspace>:<shell-id>`. `afx send --all` is
  untouched.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Every address-resolution test that exists before this phase passes without its expectations
  being changed, apart from call signatures.
- [ ] The spec's stage 1 test scenarios for resolution pass: the new form reaches its recipient;
  registered with no live terminal is held `no-live-pty` on the immediate path and on the
  `--delay` path; the builder bullets; the `arch:` and `builder:` reserved-word bullets; the cron
  and `afx interrupt` bullet; the shell bullet.
- [ ] A same-workspace send runs no database query it did not run before (asserted with a spy on
  the state accessors).
- [ ] Build and tests pass.

#### Test Plan

Unit tests on the two resolvers with a fake terminal map and registry. Route-level tests on
`/api/send` for the status codes and for the immediate and delayed hold. A cron loader test for
the refused task.

**Known intermediate state.** After this phase a cross-workspace message to a named architect
arrives under today's header, which names the sender's agent id and not its workspace, as
`<workspace>:architect` mail does today. Phase 4 fixes that. Both are commits in one PR.

**One spec example that stage 1 cannot produce.** The spec's helpful-failure example adds "`devvm`
is one of your Towers, so write `afx://devvm/codev:architect`". A stage 1 Tower has no list of the
owner's Towers, so it gives the shape error without that hint. The hint arrives with the peer list
in stage 2. The spec words the hint as conditional on `devvm` being one of my Towers, so this is
within it; I state it so nobody looks for it.

### Phase 3: Explicit workspace names

**Dependencies**: Phase 2

#### Objective

A workspace can be given an address name of its own. Two workspaces that share a directory
basename stop being unreachable: the error names both and the command that fixes it, and after one
is named, both resolve.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/db/schema.ts`, `db/migrations.ts` — migration v20: a nullable
  `address_name` column on `known_workspaces`, stored lower-cased, with a unique index over
  non-null values as a backstop. `GLOBAL_CURRENT_VERSION` becomes 20.
- `packages/codev/src/agent-farm/db/canonicalize-workspace-paths.ts` — when two spellings of one
  Windows path are merged, the surviving row keeps the explicit name.
- `packages/codev/src/agent-farm/utils/workspace-address.ts` (new, pure) — the naming rules in one
  place: validate a proposed name; find the workspace an address name refers to; give a
  workspace's own address name. Takes rows and the set of active workspaces as arguments, so Tower
  and `afx whoami` (phase 5) use the same code.
- `packages/codev/src/agent-farm/servers/tower-messages.ts` — the workspace lookup from phase 2
  calls it in place of the basename match.
- `packages/codev/src/agent-farm/servers/tower-routes.ts` — `PUT
  /api/workspaces/:encodedPath/address-name`, body `{ "name": string | null }`.
- `packages/types/src/api.ts`, `packages/sdk/src/tower-client.ts` — the request and response
  types, and `setWorkspaceAddressName`.
- `packages/codev/src/agent-farm/commands/workspace-name.ts` (new), `cli.ts` —
  `afx workspace name <name>` and `afx workspace name --clear`, acting on the current workspace.
  No existing command is called `workspace name`; `afx rename` is a different command and is not
  touched.
- Tests: migration test, `workspace-address.test.ts` (new), resolver tests, route test, CLI test.

#### Deliverables

- [ ] The rules of spec Decision 2, "Workspace names":
  - A workspace's address name is its explicit name if it has one, otherwise its basename. A
    workspace with an explicit name no longer answers to its basename.
  - Setting a name is refused, with the reason, when it breaks the component rule, is `architect`,
    `arch` or `builder`, or equals the address name (explicit or basename, any letter case) of any
    other registered workspace, running or not.
  - A workspace registered later whose basename equals an existing explicit name does not take the
    name. Its bare basename fails with a message that says it needs a name of its own.
  - Two unnamed workspaces with one basename: the address fails as ambiguous, listing both paths
    and `afx workspace name <name>`.
  - Changing or clearing a name takes effect at once. Removing a workspace's row frees its name.
- [ ] An explicit name that belongs to a registered workspace which is not running fails saying
  that workspace is not running. It is never delivered to another workspace with that basename.
- [ ] The name table is read only when an address carries a workspace component.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] The spec's stage 1 test scenarios for names pass: shared basename, then both resolve after
  one is named; each refusal on setting; the later-registered workspace; `--clear`; the
  not-running basename; the basename with a space still reached by its local address.
- [ ] The migration test suite passes from every earlier version to v20 and on a fresh database.
- [ ] Build and tests pass.

#### Test Plan

Pure unit tests on the naming module; the existing migration harness for v20; route and CLI tests
for set, change, clear and each refusal.

### Phase 4: Qualified provenance and reply commands

**Dependencies**: Phases 2 and 3

#### Objective

An agent that receives a message from another workspace can see where it came from and can reply
by pasting one command. Same-workspace frames do not change by a byte.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/utils/message-format.ts` — a new formatter for the
  cross-workspace frame. It takes the role from the structured kind and builds the address from
  parts already validated. `architectHeaderLabel`, `senderHeaderLabel`, `isSafeSenderId` and the
  `REPLY_HINT` constant are not changed and keep taking a local id.
- `packages/codev/src/agent-farm/servers/tower-routes.ts` — `formatMessageForTarget` takes a
  sender context whose workspace field is required by its type, so none of its six call sites can
  leave it out: the Decisions tab notice, the delayed send, the registry hold, the dead-session
  hold, the unwritable-session hold and the live path.
- `packages/codev/src/agent-farm/servers/tower-messages.ts` — export the phase 2 permission check
  so the footer can ask it "may this recipient send to that address?".
- Tests: `message-format.test.ts`, `tower-routes.test.ts`, `air-1478-architect-attribution.test.ts`,
  `inbox-routes.test.ts`, plus a new file for the footer table.

#### Deliverables

- [ ] **Case 1, same workspace**: the code path is the one that runs today. The new formatter is
  entered only when the sender's workspace and the recipient's differ.
- [ ] **Case 2, another workspace on this Tower**: the header carries the sender's
  workspace-qualified address, as in the spec:
  `### [ARCHITECT codev:architect:review MESSAGE → tunnel | <time>] ###`. A builder sender reads
  `BUILDER codev:builder-spir-12`. The verb follows today's: `INSTRUCTION` from an architect to a
  builder, `MESSAGE` otherwise.
- [ ] **The footer**, on the footer line so the frame stays three lines, by the rows of spec
  Decision 7 that stage 1 can produce:

  | Recipient | Sender | Footer |
  |---|---|---|
  | An architect | An architect or builder in another workspace | `(reply: afx send codev:architect:review "…")` |
  | A builder | A builder in another workspace | `(reply: afx send codev:builder-spir-12 "…")` |
  | A builder | The front door of another workspace | `(reply: afx send codev:architect "…")` |
  | A builder | A named architect that is not its own | `(reply through your architect: afx send architect "…")` |
- [ ] **How "never an address the recipient may not use" is guaranteed.** Tower works out the
  candidate reply address, then asks the same permission check the resolver uses, with the
  recipient as the sender. A command is printed only if that check passes. One rule, used twice,
  so the footer and the resolver cannot drift apart.
- [ ] **A sender whose workspace has no usable name** (an ambiguous basename, a basename shadowed
  by another workspace's explicit name, or one with characters outside the component rule): the
  header marks the sender as being in another workspace without printing the unusable name, and
  the footer says no reply address exists and that the sender's workspace needs
  `afx workspace name`. It prints no command. A basename is never interpolated into a frame
  unless it fits the component rule, so a directory name cannot forge framing.
- [ ] **Senders that are not agents** keep today's frame whatever the target's workspace:
  `af-cron`, `vscode-user`, `decisions-tab`, an absent sender. None has an address to reply to.
- [ ] `from_agent` and `from_workspace` on the mailbox row hold what they hold today: the local id
  and the local path. The address is composed for the frame only.
- [ ] `--raw` sends are unchanged: no frame, so no header and no footer.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] A same-workspace frame is byte-identical to today's for every sender and recipient kind
  (snapshot taken on the commit before this phase, timestamp masked).
- [ ] Every cross-workspace frame has exactly three lines, and one with a 40-byte body is typed by
  the short write path (`isLongFrame` is false; `BRACKET_MIN_LINES` and `BRACKET_MIN_BYTES` are
  not changed).
- [ ] For every row of the footer table, the printed command is accepted when the recipient sends
  it, and delivers to the original sender.
- [ ] Each of the six call sites produces the cross-workspace header for a cross-workspace send:
  one test per site.
- [ ] Build and tests pass.

#### Test Plan

Unit tests on the formatter. Route-level tests that drive each of the six paths with a sender in
another workspace and read the stored `formatted_message`. A table test that takes each footer
command and resolves it as the recipient.

### Phase 5: One-Tower discovery: workspace list and whoami

**Dependencies**: Phase 3

#### Objective

Nobody has to guess an address. One command prints every workspace on this Tower with its agents
as addresses ready to paste, and `afx whoami` prints the caller's own.

#### Files to Create / Modify

- `packages/types/src/api.ts` — the listing's response type.
- `packages/codev/src/agent-farm/servers/tower-routes.ts` — `GET /api/address-book`: each
  workspace with its path, its address name (or why it has none), and its architects, builders
  and shells, each with an address and whether it has a live terminal.
- `packages/sdk/src/tower-client.ts` — `getAddressBook`.
- `packages/codev/src/agent-farm/commands/workspace-list.ts` (new), `cli.ts` —
  `afx workspace list`, with `--json`.
- `packages/codev/src/agent-farm/commands/whoami.ts` — an `address:` line and an `address` field
  in `--json`. It reads `global.db` read-only, as whoami does today, through the phase 3 naming
  module; it still does not need Tower.
- Tests: route test, `workspace-list` CLI test, `whoami` tests.

#### Deliverables

- [ ] `afx workspace list` prints what the spec's sample shows: one block per workspace, one
  address a line, `live` or `no live terminal`. A registered workspace that is not running is
  listed as not running. A workspace whose name is ambiguous or shadowed says so and shows
  `afx workspace name <name>`.
- [ ] Every address it prints resolves when passed to `afx send` from another workspace.
- [ ] `afx whoami` prints the caller's address in the form another workspace would type:
  `codev:architect:main`, `codev:architect:review`, `codev:builder-spir-1940`.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] The listing test feeds each printed address back through the resolver and gets the agent it
  was printed for.
- [ ] whoami's existing output lines and exit codes are unchanged; the address is an added line.
- [ ] Build and tests pass.

#### Test Plan

Route test over a fake registry with two workspaces, named architects, a builder, a shell and a
registered architect with no live terminal. CLI output tests. whoami tests for an architect, a
named architect and a builder.

### Phase 6: Addressing docs in both trees and end-to-end verification

**Dependencies**: Phases 2, 3, 4 and 5

#### Objective

Agents are taught the new form, and the headline path is shown to work on a real Tower process,
from the command a person types to the frame the recipient reads.

#### Files to Create / Modify

Docs, found by grepping both trees for the addressing forms, not from memory:

- `CLAUDE.md` and `AGENTS.md` (kept byte-identical) — the addressing table.
- `codev-skeleton/templates/CLAUDE.md`, `codev-skeleton/templates/AGENTS.md`,
  `codev/templates/CLAUDE.md`, `codev/templates/AGENTS.md`.
- The `afx` skill: `.claude/skills/afx/SKILL.md`, `.codex/skills/afx/SKILL.md` and both copies
  under `codev-skeleton/`. If the build tracks hashes of shipped skills
  (`packages/codev/src/lib/shipped-skill-hashes.ts`), they are regenerated the way the build
  expects.
- `codev/resources/commands/agent-farm.md` and `codev-skeleton/resources/commands/agent-farm.md` —
  `afx send`, `afx workspace list`, `afx workspace name`, `afx whoami`.
- `codev/roles/architect.md`, `codev/roles/builder.md` and both under `codev-skeleton/roles/` —
  what the reply footer means, and for builders that another workspace is reached through its
  front door.
- `codev/resources/arch.md` — the messaging section: the structured address, the one parser, the
  workspace address name. The hot tier is not grown.
- Any other file the grep finds that teaches an address form (the `arch-save` skill and
  `decision-protocol.md` in both trees are candidates) is corrected only where it states the
  grammar.

Tests and checks:

- `packages/codev/src/agent-farm/__tests__/cross-workspace-addressing.e2e.test.ts` (new), in the
  existing harness that spawns a real Tower in an isolated directory.
- A send-latency measurement, kept as an opt-in test so it can be rerun.

#### Deliverables

- [ ] The addressing table in every file above states: the new form; that architects and humans
  may name any architect on the Tower; that a builder names only its own architect and otherwise
  uses a front door; `afx workspace list` as the way to find an address.
- [ ] The stage 2 and stage 3 role guidance (what "REMOTE" and "OTHER OWNER" mean) is not added.
  Those headers do not exist yet.
- [ ] **End-to-end test, on a Tower that has never connected to Codev Cloud**: two workspaces,
  each with `main` and a named architect, and a builder. Through `POST /api/send` as the CLI
  calls it:
  - the named architect in the other workspace receives the message under a qualified header;
  - the footer's reply command, taken from the stored frame and sent unchanged as the recipient,
    reaches the original sender;
  - a named architect with no live terminal has its mail held `no-live-pty`;
  - a builder naming another workspace's named architect is refused and nothing is stored;
  - `afx://devvm/codev:architect` is refused with the stated reason;
  - two workspaces with one basename fail as ambiguous, and both resolve after one is named.
- [ ] **The non-functional check from the spec**: the median of 100 same-workspace sends to a
  recipient whose mail is held, measured on the commit before phase 1 and on this branch. The
  second is within 5%, or 1 ms, of the first, whichever is larger. Both numbers go in the review.
- [ ] **Windows**: the on-demand workflow is dispatched on the branch with the suites on, because
  the change touches workspace-keyed code, and the run is linked in the PR:
  `gh workflow run windows.yml --ref builder/spir-1940 -f purpose='Spec 1940 stage 1 addressing' -f suites=true`.
- [ ] A scenario-to-test table in the review: each bullet of the spec's "Addressing (stage 1)"
  test scenarios beside the test that covers it.

#### Acceptance Criteria

- [ ] `diff CLAUDE.md AGENTS.md` is empty, and so is the diff of each template pair.
- [ ] A grep of both trees for the old statement of the grammar ("four addressing forms",
  "cross-workspace" rows without the new form) finds nothing left to fix.
- [ ] The end-to-end test passes against the built CLI and Tower.
- [ ] The latency check is within its bound.
- [ ] Build, unit suites and the e2e suite pass.

#### Test Plan

The e2e test above, the latency measurement, the Windows workflow run, and a read of every changed
doc against the resolver's actual behaviour.

**What this phase cannot check.** The check on the owner's own Tower, with real architect
terminals in two real workspaces, needs the build installed there, which a builder does not do
from its worktree. That is the `verify` phase after merge: from one workspace's named architect,
`afx send <other-workspace>:architect:<name> "…"`, see it arrive, paste the reply.

**Issue #1605.** The PR body says stage 1 supersedes it and why (spec Decision 10). I do not close
it; the architect does when the PR merges.

### Phase 7: Front-door-only workspace setting (separable)

**Dependencies**: Phases 2, 4, 5 and 6

**This phase can be dropped at plan approval without touching any other.** It adds one config key
and the behaviour behind it. Nothing in phases 1 to 6 reads the key or mentions it.

#### Objective

A workspace can choose to take mail from other workspaces only at its front door. Mail from
outside to one of its named architects is refused with an error that names the front door, and
nothing is rerouted.

#### Files to Create / Modify

- `packages/codev/src/lib/config.ts` — `messaging.frontDoorOnly` (boolean, default false) on
  `CodevConfig`, read from the workspace's `.codev/config.json` through the existing loader.
- `packages/codev/src/agent-farm/servers/tower-messages.ts` — the phase 2 permission check
  refuses a sender outside the workspace that names one of its architects. The config is read
  only on that path, so no other send pays for it.
- `packages/codev/src/agent-farm/utils/message-format.ts` and the footer rule from phase 4 — one
  more row: a message from a named architect in such a workspace carries
  `(reply via its front door: afx send codev-cloud:architect "…")`. The header still names the
  true sender.
- `packages/codev/src/agent-farm/servers/tower-routes.ts` and `commands/workspace-list.ts` — the
  listing marks the workspace "front door only" and shows callers in other workspaces only its
  front door.
- The docs of phase 6, both trees — the opt-in sentence and the key, wherever
  `.codev/config.json` keys are documented.
- Tests: resolver, footer, listing, and the e2e file from phase 6 gains one case.

#### Deliverables

- [ ] With the setting on, mail from another workspace to a named architect is refused with the
  spec's text: "`codev-cloud` takes mail from other workspaces only at `codev-cloud:architect`.
  Send it there, and name the seat you want in the first line." Nothing is delivered to `main`.
- [ ] Mail inside the workspace, mail to its front door and mail to one of its builders are
  delivered as before.
- [ ] The footer and the listing behave as described above.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] The spec's front-door-only test scenario passes in full.
- [ ] With the setting absent or false, every test of phases 2 to 6 passes unchanged.
- [ ] Build and tests pass.

#### Test Plan

Resolver tests with the config on and off; one footer row; one listing case; one e2e case with a
real `.codev/config.json` in the test workspace.

**If this phase is dropped**, the owner's ruling should also say whether issue #1605 still closes
as superseded. Its requested error message for `<workspace>:architect:<name>` ships only here; the
clear error for an architect name that does not exist ships in phase 2 either way.

## Out of scope for this plan

Everything the spec assigns to stages 2 and 3: the `afx peer` commands, grants, the relay path,
remote and other-owner headers, sender-side hold, `afx inbox release` and the three inbox groups,
the status lines, the dashboard's Peers panel, account handles, invitations, and every change in
the `codev-cloud` repository. The VS Code extension gains no new send; it only gains access to the
shared parser.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Replacing `parseAddress` changes what an existing address resolves to | Medium | High | Phase 1's table includes every form valid today; phase 2's acceptance is that existing resolver tests pass with their expectations untouched |
| Only one of the two resolvers learns the new form, so mail to an offline named architect is refused when it should be held | Medium | Medium | Both take the same structured address and share one workspace lookup and one permission check; the hold is tested on the immediate and delayed paths |
| A builder gains a line to every architect on the Tower once the form parses | Medium | High | The builder rule ships in the same commit as the form (phase 2), keyed on the sender's workspace, with a test per bullet of the spec's builder scenarios |
| One of the six `formatMessageForTarget` call sites gives a cross-workspace message a same-workspace header | Medium | Medium | The sender's workspace is required by the function's type; one test per call site |
| A same-workspace frame changes by accident | Low | High | The new formatter is entered only when workspaces differ; byte-identical snapshot test |
| A reply command is printed that the recipient's own send refuses | Medium | Medium | The footer asks the resolver's own permission check before printing a command |
| A workspace basename with unusual characters forges framing through the new header | Low | High | A name enters a frame only if it fits the component rule; otherwise the no-reply-address footer |
| The longer header pushes short messages onto the paste path | Low | Low | Limits unchanged; test that a 40-byte cross-workspace body stays on the short path |
| Migration v20 fails on a database that skipped a version | Low | High | Run through the existing per-version migration harness; a nullable column needs no backfill |
| The front-door-only setting is cut after work has been built on it | Medium | Low | It is the last phase and nothing depends on it |
| Stage 1 slows every send | Low | Medium | The name table and the config are read only on cross-workspace paths; measured in phase 6 |

## Documentation Updates

- `CLAUDE.md` and `AGENTS.md`, byte-identical; the four template copies in `codev/templates/` and
  `codev-skeleton/templates/`.
- The `afx` skill in `.claude/skills/`, `.codex/skills/` and both under `codev-skeleton/`.
- `codev/resources/commands/agent-farm.md` and its skeleton twin.
- `codev/roles/architect.md`, `codev/roles/builder.md` and their skeleton twins.
- `codev/resources/arch.md` (cold tier). `arch-critical.md` and `lessons-critical.md` are not
  grown; anything learned is routed by tier in the review.
- The review at `codev/reviews/1940-tower-to-tower-messaging-proto.md`, with the scenario-to-test
  table and the latency numbers.
