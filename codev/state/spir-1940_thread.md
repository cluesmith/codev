# spir-1940 thread — Tower-to-Tower messaging protocol (issue #1940)

## 2026-11-20/21 — specify, research

- Strict SPIR. No spec existed; drafting from the issue. No Baked Decisions section in the issue.
- Architect update mid-research (2026-11-21T01:35Z), issue body re-read:
  1. Stage order is now: named architects across workspaces on ONE Tower (no transport, no cloud),
     then my own Towers, then another owner's Tower.
  2. Addressing: compare several genuinely different address families side by side with the same
     real addresses; `afx://` is one candidate, not the starting conclusion.
  3. Transport is directed: the Codev Cloud tunnel, as the single security choke point. Direct
     Tower-to-Tower links get a short set-aside note. Spec must split cloud-enforced vs
     Tower-enforced and list the work that lands in the codev-cloud repo.
- Read the current codev-cloud source (GitHub `develop`, not the stale local checkout from Feb):
  `/t/<slug|ULID>/…` proxy authenticates a cloud USER (session or `cpat_` PAT) who must own the
  tower; tower rows carry ULID id, userId, name, globally-unique slug, machineId. No teams, no
  cross-user grants, no Tower-to-Tower relay today. Every piece of cross-Tower relay is new cloud work.
- Research facts that shaped the draft: `from` on `/api/send` is self-asserted (only charset-checked);
  `/api/send` is already reachable through the tunnel for the owner's cloud session with no caller
  identity attached; Tower cannot originate requests over the tunnel (cloud is the h2 client);
  headers never show the sender's workspace, so a cross-workspace recipient has no reply address;
  #1871 (canonical slug) is not implemented; no rate limit on sends today.
- Draft spec written. Recommendations I am putting to the owner, not settling:
  - Grammar: F, an extended colon path `[tower:][workspace:]agent` (agent = `architect[:name]` or a
    builder id). Zero migration; stage 1 is one new form `<workspace>:architect:<name>`. Runner-up
    is the `afx://` URI. Six families compared with the same nine addresses. Email-like and dotted
    forms break on real workspace names containing dots (`codevos.ai`).
  - Trust: cloud vouches for the sending Tower's identity; grants live on and are enforced by the
    receiving Tower (default deny, including my own Towers). End-to-end Tower keys set aside: the
    cloud can already reach every route of a connected Tower, so signatures buy little today.
  - Other owners: architects only, hold-for-release by default, connection only via a signed-in
    cloud session.
  - Offline Tower: hold at the sender (never in the cloud), exactly-once by message id.
  - Open question 4 asks whether this project goes on to plan+implement stage 1 or stops at the spec.

## 2026-11-21 — specify, iteration 1 review (codex + claude, both REQUEST_CHANGES)

- Both reviews were about precision, not direction. Accepted every point; nothing rebutted.
- codex: scope of this project vs follow-ups made explicit (stage 1 criteria are 1940's, under the
  recommended answer to Open Question 4); builder "reply" reach defined (a mailbox row from that
  sender, identity-keyed, lapses with retention); grant withdrawal spelled out in three effects;
  exactly-once given a lifecycle (id + send time, dedupe record lives as long as the row, receiver
  refuses mail older than the retention window as expired); hold-for-release described honestly as
  a safeguard against the remote sender, not a barrier against a local process holding the Tower
  key; body normalisation given a testable invariant; workspace naming rules completed; limits
  table with defaults and fixed outcomes.
- claude (verified against the code): shells are addressable today and my grammar had dropped them
  — grammar widened to a local id; shells never reachable from another Tower. Sender-held outbound
  mail must be a distinct kind so Spec 1313's drainer and 60s escalation do not treat a closed
  laptop as a starved agent. The sending leg is outbound HTTPS, only the receiving leg is the
  tunnel — corrected. Four header cases, not three. Frame growth must not flip the write path
  (short frame vs chunked paste). Ordering per sender Tower and recipient stated.
- Process note: I edited the spec while the claude lane was still running, which tripped the
  working-tree-changed warning (#1649) on its output. The writer was me. Next time, wait for every
  lane before touching the file.
- Slip: the first draft commit carries a Co-Authored-By trailer, against the owner's global rule.
  Already pushed by porch before I noticed; left as is rather than force-push. No trailers since.

## 2026-11-21 — spec sent back by the owner at the gate (not approved); second revision

Three architect messages (02:48Z, 02:49Z, 02:51Z), all applied:

1. **Owner in the address; Tower names per owner (owner ruling).** Checked codev-cloud's current
   source: slugs are globally unique and a taken name is silently bumped to `<name>-2`; accounts
   have a verified email and display name but no handle; `/t/<slug>/` already looks up by slug AND
   owner. So per-owner names need a cloud change (slug unique per account) and an owner part needs
   a new cloud concept (account handle). Decision 1 redone with seven candidates, eleven rows
   (three cross-owner, two owners each with a Tower `mbp`, one owner with two Towers), shortest and
   full forms. **Recommendation changed from F to G**: today's colon grammar on one Tower, and
   `afx://[owner@]tower/` in front of it to leave the Tower. Reason: with the owner in, F is five
   positional parts and the count is what tells a person from a machine. Stage-1 form
   `codev-cloud:architect:tunnel` is identical under F and G. Runner-up: F with a marked owner.
2. **Invitation flow** (new Decision 8): four alternatives; recommended is an invitation emailed
   by Codev Cloud to a named address, usable only by that account. Seven-step walkthrough of what
   each owner does and sees, plus failure cases and the first grant. Nothing about a pending
   invitation is ever shown on the invitee's Towers (it is text from a stranger).
3. **Command surface** (new Decision 9): one noun, `afx peer`, plus `afx workspace list|name` and
   `afx inbox release`; table of stage / who may run it / Tower or cloud; sample output for the
   most-used commands; what `afx status` and the dashboard show. `afx tower log` and
   `afx tower disconnect` already exist with other meanings, so the record is `afx peer log` and
   ending a connection is `afx peer end`.

Also moved hold-for-release and its release command from stage 3 to stage 2, because removing a
grant already converts mail to held-for-release in stage 2.

Second review requested by the architect. Porch is parked at the gate and hands out no further
consultation, so the two lanes are run by hand with the same command shape porch used (iter2
output files), on the architect's instruction.

## 2026-11-21 — second review round (codex + claude, run by hand at the architect's request)

- Both REQUEST_CHANGES again, both on precision. Applied all but two.
- Rebutted with evidence: (1) claude said the stage order inverts the owner's — it read the stale
  `.builder-prompt.txt`; the issue was reordered by the owner at 01:35Z. (2) claude said the 48 KB
  cap is only the `--file` cap — it is `MAX_MESSAGE_BYTES`, enforced on the message in the CLI and
  in Tower's `/api/send`.
- Real catches: the frame must stay three lines (4+ lines or >256 bytes flips a message onto the
  paste path, and the reply hint lives on the footer line for exactly that reason); "exactly once"
  was really "one mailbox row"; a fixed 30-day message lifetime replaces the receiver-dependent
  expiry; workspace-name collisions now defined for both orders of events; mixed-version behaviour
  added; workspace/agent in a remote header are the sending Tower's claim, only owner and Tower
  are cloud-authenticated.
- No edits were made while a lane was running this time; neither output carries the #1649 warning.

## 2026-11-21 — third revision (owner read it against the second draft, spir-1943; gate still pending)

Owner leans to grammar G (not a ruling). Six changes asked for; all made. Allowed to read the
second draft and take what is better, not its grammar.

1. **#1605 (front door only)** — new Decision 10 answers its three arguments one by one, adds a
   front-door-only setting per workspace (in `.codev/config.json`) with the error message #1605
   asked for, and recommends closing #1605 as superseded when stage 1 merges. Default is open.
2. **Genuine relay traffic** — adopted the second draft's mechanism: a secret per tunnel session
   issued in the handshake, in memory only; every relayed request carries a MAC'd statement of
   sender Tower, owner, message id, time and payload hash; replays refused. Found in source why
   this is needed: the tunnel client forwards over loopback with the real local key and a marker
   header, so neither the listener nor any header proves anything.
3. **Builder rule** — replaced reply-reach (mailbox lookup) with the plain rule: a builder names
   only its own spawning architect, otherwise front doors. Footer never offers an address the
   recipient may not use. No case found that the plain rule fails; it costs one hop in a rare one.
4. **Stage 2 walkthrough** — nine steps, two machines, every command and its output, plus what a
   skipped step looks like. The switch covers sending too, so both Towers need `afx peer on`.
5. **Connections** — now join two owners, once; grants stay per Tower. Cost bounded by showing a
   Tower to other owners only while its remote messaging is on.
6. **Existing code** — new section. `isSafeSenderId` pattern does not change (the address is
   composed by Tower from validated parts; remote senders go in new mailbox columns);
   `architectHeaderLabel`/`senderHeaderLabel` would mislabel an address, so new frames take the
   role from the structured kind; `formatMessageForTarget` has six call sites and no sender
   workspace; measured body budgets on the short path (103 / 87 / 68 / 26 bytes); cron,
   interrupt/refresh, SDK and VS Code callers each stated.

Review plan, as instructed: codex + claude on this text, apply, then both again on the final
text, and stop there whatever the verdicts. No edits while a lane is running.

## 2026-11-21 — third revision: two review passes done; stopped as instructed

- Pass 1 (iter3): codex REQUEST_CHANGES, claude COMMENT. All points applied, none rebutted
  (statement id + consume-before-authorization on the attestation; exact code-point list for
  remote bodies; stage 1 refuses every `afx://`; held-for-release never expires; narrow grants in
  the stage 2 walkthrough; "At a glance" table). Committed `23ad14da5`.
- Pass 2 (iter4), on `23ad14da5`: codex REQUEST_CHANGES, claude COMMENT. **Not applied** — the
  architect said to stop after the second pass whatever the verdicts, so the gate version is one
  both reviewers actually read. Eleven open points plus four small ones, listed in
  `codev/projects/1940-tower-to-tower-messaging-proto/1940-specify-iter4-open.md`. I agree with
  all eleven; none needs a design change, each is a sentence or a row.
- Slip, corrected: force-staged an ignored review output (`*.txt` under `codev/projects/` is
  gitignored on purpose); unstaged before committing.

## 2026-11-21 — the fifteen open points applied (architect instruction, 03:57Z)

Applied all eleven numbered points and the four smaller ones from the final pass, in a commit
that touches only the spec (`90ebb0245`), so the diff against `23ad14da5` reads point by point.
No further review round, by instruction: the gate text is now one step ahead of what codex and
claude read. Number 11: chose to serialise relay calls per peer (one sentence, one test) over
narrowing the ordering promise. Checked in source before writing point 6: the resolver intercepts
only the literal `architect` before a colon, so `arch:review` today is agent `review` in a
workspace called `arch`. Gate still pending; the owner has not approved.

## 2026-11-23 — spec-approval APPROVED by the human; entering plan

- Architect relayed (18:57Z): the human approved `spec-approval`, decision main-26 via the
  Decisions tab, on the spec text at `90ebb0245`. Checked first that the spec is byte-identical to
  that commit, then ran `porch approve 1940 spec-approval --a-human-explicitly-approved-this`.
- The approval adopts the recommended answer to every Open Question. In particular: grammar G;
  Tower names per owner; and Open Question 4, so **this project plans and builds STAGE 1 ONLY**.
  Stages 2 and 3 become follow-up issues that the architect files. Do not plan them.
- **Carry into the plan:** the owner has asked about the front-door-only opt-in setting
  (Decision 10) and has NOT ruled. The architect recommended cutting it from stage 1. Until he
  rules, plan it as its own separable phase (or clearly separable item) so it can be dropped at
  plan approval without reworking the rest. The default (open) and the builder front-door rule
  are not in question.
- Next gate is `plan-approval`, the owner's. Stop there.
- Still unanswered: whether to rewrite history for the Co-Authored-By trailer on `d4cb7e648`.
  All later commits carry no trailer; keep it that way.
- Porch's first plan-phase task is a context refresh at boundary `enter:plan`.

## 2026-11-23 — plan drafted (stage 1 only); plan review running

- Context refreshed at `enter:plan`, re-oriented from the state file, then read the spec and the
  source the plan has to name: both resolvers in `tower-messages.ts`, the six
  `formatMessageForTarget` call sites, `message-format.ts`, the send CLI, whoami, the
  `known_workspaces` table and its migrations, the SDK's `sendMessage`.
- Plan committed as `28af9b821`: seven phases. 1 shared parser; 2 the new form in both resolvers
  plus the builder rule; 3 explicit workspace names (migration v20); 4 provenance and reply
  footers; 5 `afx workspace list` and whoami; 6 docs in both trees and end-to-end checks; 7 the
  front-door-only setting.
- **Front-door-only is phase 7 and nothing depends on it**, as the architect asked: it can be
  dropped with `porch skip-phase` at plan approval and phases 1 to 6 ship unchanged.
- Things found in source that shaped the plan:
  - The builder lookup in both resolvers is keyed on the TARGET workspace today. A builder id that
    exists in two workspaces would get affinity in the wrong one. Phase 2 keys it on the sender's
    workspace.
  - `afx whoami` reads `global.db` read-only and does not need Tower. The naming rules go in a
    pure module so whoami and Tower share them.
  - `self-refresh` sends to its own id and takes no address; only `interrupt` and `refresh` need
    the `afx://` refusal in the CLI.
- Choices the spec left to the plan, stated in it: the footer asks the resolver's own permission
  check before printing a reply command; a sender workspace with no usable name gets a footer
  with no command; cron and UI senders keep today's frame; the "`devvm` is one of your Towers"
  hint waits for stage 2's peer list.
- Review lanes for the plan are codex and claude (porch's 2-way), running in the background.

## 2026-11-23 — plan review iteration 1 applied

- codex REQUEST_CHANGES (6 points), claude COMMENT (9). All checked against the source first.
  Fourteen applied as asked; responses in
  `codev/projects/1940-tower-to-tower-messaging-proto/1940-plan-iter1-rebuttals.md`.
- Not applied as asked:
  - codex wanted phase 7 (front-door-only) made mandatory and the docs phase moved after it. The
    plan now says it IS built unless the owner drops it, and phase 7 reruns phase 6's checks. It
    stays last and separable, because that is the architect's instruction pending the owner's
    ruling.
  - codex wanted the end-to-end test to run the built `afx send`. It cannot: the binary always
    connects to port 4100, the live Tower. The test drives the CLI's own `send` function against
    a test Tower with only the port replaced; the installed binary is the verify phase's check.
- Real catches from the reviews: `loadConfig` merges global and local layers, so the
  front-door key is read from the committed `.codev/config.json` only; `senderWorkspace` can be
  the literal `unknown` and must not count as another workspace; `mailbox-wiring.ts` also calls
  the registry resolver; the listing has to know its caller or it prints addresses a builder
  cannot use; the latency baseline is taken in phase 1 before any code changes.
- Slip: I appended to this log while the review lanes were running, and both reviews flagged
  "working tree changed". The plan was not touched, so the reviews stand. No writes to the tree
  during a review from now on.

## 2026-11-23 — plan-approval APPROVED by the human; phase 7 cut; entering implement

- Architect relayed (21:21Z) the human's ruling main-31 from the Decisions tab: "approve, cut".
  Checked the plan was byte-identical to `5140a82a8`, then ran
  `porch approve 1940 plan-approval --a-human-explicitly-approved-this`.
- **Phase 7 (front-door-only setting) is CUT by the owner.** Recorded with `porch skip-phase 1940
  phase_7` straight after porch copied the phases, before any phase 1 work. Phases 1 to 6 must not
  add the config key, the refusal, a "front door only" mark in `afx workspace list`, or opt-in
  sentences in the docs. The default (open) and the builder front-door rule stay.
- The spec's stage 1 criterion for a front-door-only workspace is dropped with it. One paragraph
  added to the plan's summary citing the ruling; the review must say the same. The approved spec's
  design sections are not edited.
- Issue #1605 still closes as superseded at merge. The architect closes it, not me.
- **Standing owner ruling main-32, for every implement phase:** if the local full suite fails only
  on tests unrelated to my change, each passing alone, STOP and tell the architect; do not loop.
  A green GitHub run on a draft PR for the same code may then stand in for porch's local tests
  check for that phase, and the architect checks that run before I skip anything. Run targeted
  tests while iterating.
- Next gate is `pr`, the owner's. Stop there.
- First act of phase 1, per the plan: write the send-latency measurement and record the baseline
  median, with its commit, before the parser is written.

## 2026-11-23 — phase 1: latency baseline taken BEFORE any production change

- `packages/codev/src/agent-farm/__tests__/send-latency.e2e.test.ts` written first, as planned.
  Opt-in (`CODEV_SEND_LATENCY=1`), real Tower in an isolated dir, 15 warm-up + 100 timed
  same-workspace sends through `POST /api/send` to an inert builder terminal (held `no-profile`),
  each held row dismissed outside the timed region.
- **Baseline, on `732ad0118`** (production code untouched; only the test file and the fixture
  JSON existed), five runs, machine busy (load average 14.6):
  medians 4.573, 2.152, 2.121, 2.217, 2.191 ms. **Baseline = 2.19 ms** (median of the five).
  The first run was the outlier (max sample 151 ms). Bound for phase 6: max(5%, +1 ms) → 3.19 ms.
- Note for phase 6: one run is not enough on this machine; take five and compare medians of
  medians.
- Gotchas met: the worktree had no `node_modules` and no `dist` (ran `pnpm install` and the
  build); a workspace under the temp dir is left out of `GET /api/workspaces`, so the test waits
  on a probe send instead of the listing; vitest only shows the test's stdout line with
  `--reporter=verbose` when piped.

## 2026-11-23 — phase 1 built: shared address contract and parser

- `AgentAddress`, `AddressReader` and the parse-error types in `codev-types`; `parseAddress`,
  `formatAddress`, `completeAddress` in `packages/sdk/src/address.ts` (new `./address` export).
  Nothing in production calls them yet, so behaviour is unchanged.
- One table, `packages/types/fixtures/address-cases.json` (90 parse rows, 18 format rows), run by
  the SDK, by `packages/codev` and by `apps/vscode`, each through its own import.
- Choices made while writing it:
  - The first `architect` component is the kind word, so `architect:architect` is the architect
    named `architect`, as today, and never a workspace.
  - `formatAddress` reads its own output back before returning it and throws if it does not give
    the same address. So it cannot print text that reaches someone else (a local workspace called
    `architect`, an id `arch`, a name with a colon). Phase 4 checks a name before formatting; the
    throw is the backstop.
  - `:agent` and `a:b:c` are now parse errors (they resolved to NOT_FOUND before). They surface to
    users in phase 2, when the resolvers switch over.
- Checks: build passes; unit suite 8358 passed, 108 skipped; SDK 354 passed; VS Code unit 1388
  passed, check-types and lint clean.

## 2026-11-23 — phase 1 review iteration 1 applied

- codex REQUEST_CHANGES (owner handles must start with a letter, per spec Decision 2: applied,
  separate `OWNER_PATTERN`). claude APPROVE with six observations; applied the mistyped-scheme
  one (`afx:/…` and `afx//…` now fail as `REMOTE_BAD_SCHEME` naming `afx://`; `afx:architect`
  stays valid because a workspace may be called `afx`) and tightened one test assertion.
- **Carry into phase 3:** `isAddressComponent` rejects upper case. `afx workspace name Codev` must
  lower-case BEFORE validating, or the user is told off for capitals that the spec says are
  simply folded.
- **Carry into phase 4:** `formatAddress` throws on an address with no text form. Check the name
  with `isAddressComponent` first; the throw must never surface as a 500 on `/api/send`.
- The review lanes ran against an untouched tree this time; no "working tree changed" warning.

## 2026-11-23 — phase 1: one intermittent failure of porch's tests check, not identified

- After the review fixes (`05616e92f`), `porch done` failed its `tests` check once (build passed).
  I had piped porch's output through `tail`, so the failing test's name was lost.
- The same suite on the same code then passed twice: my own full run (8366 passed, 108 skipped)
  and porch's second run. Load average was about 26 at the time. Nothing in the change touches
  production code paths (only `packages/sdk/src/address.ts`, the types and the table).
- So: an unidentified intermittent failure under load, one occurrence. Not blocked. For the
  review's Flaky Tests section. From now on porch's output is kept whole in the scratchpad so a
  failing test can be named.

## 2026-11-23 — phase 2 built: named architects across workspaces, the builder rule

Resumed after a context refresh at the phase boundary.

**First, the four items carried from claude's phase 1 review** (all in the SDK and the types):
`completeAddress` no longer deletes an owner that has no Tower; `AgentAddress` is a discriminated
union, so an id with no name is a type error (the formatter still checks it at runtime, for wire
JSON); a parse error quotes a refused value as printable ASCII, cut at 64 characters; an address
longer than 512 characters fails as `ADDRESS_TOO_LONG`. Five new rows in the shared table.

**The resolvers.** `resolveTarget` and `resolveAgentInRegistry` take the structured address and a
sender context `{ id, workspace }`. The old two-slot `parseAddress` is deleted; the routes read
the text once with `parseTarget`. Both resolvers share one workspace lookup (`locateWorkspace`)
and one permission check (`refusalToNameArchitect`).

- *Permission* is asked of the sender's workspace for every target; *affinity* applies only when
  the target workspace is the sender's. A builder writing `<other>:architect` reaches `main`
  there and costs no database read; the #1094 warning no longer fires for it.
- New error codes and statuses: `MALFORMED_ADDRESS` 400, `CROSS_TOWER_UNAVAILABLE` 400,
  `REFUSED` 403. The SDK's `sendMessage` failure result carries `errorCode`.

**Decisions I made, for the review to check:**

1. **The Spec 755 refusal keeps its code.** A builder naming another architect in its *own*
   workspace still gets `NOT_FOUND` / 404 with the unchanged message. Only the new case, a named
   architect in *another* workspace, is `REFUSED` / 403. The plan says both "403 for refused" and
   "every resolution test passes without its expectations changed"; the existing test pins
   `NOT_FOUND` for the Spec 755 case, and `bugfix-1333` pins how the client shows it. So the two
   refusals have different codes. If the owner would rather have one code, it is a two-line
   change plus two test expectations.
2. **Two test expectations did change**, beyond the two the plan names. `tower-messages.test.ts`
   had two malformed-address tests (`project:` and a blank target) expecting `NO_CONTEXT`. They
   now expect `MALFORMED_ADDRESS`. The status is 400 either way; on the wire `error` moves from
   `INVALID_PARAMS` to `MALFORMED_ADDRESS` for text that is not an address. I read these as
   parse tests, not resolution tests, but it is a change to an existing expectation and I am
   saying so.
3. **The sender's workspace is `workspace ?? fromWorkspace`** from the request body. Every caller
   sends them equal or sends only `workspace`.
4. **A builder id sent with no workspace is still held to the rule.** The lookup falls back to
   matching the id alone, so leaving the workspace out of the request opens nothing.
5. **A builder is refused before the name is looked up**, so it cannot learn which architects
   another workspace has from the error.
6. The cross-Tower refusal text is one constant, used by Tower, the cron loader, `afx interrupt`
   and `afx refresh`. It does not quote the address.

**Tests.** New `spec-1940-cross-workspace-resolve.test.ts` (both resolvers, fake terminal map and
registry, including the query-count assertions). In `tower-routes.test.ts`, a block that runs the
*real* resolvers behind `/api/send` against the in-memory registry: delivery, the immediate and
`--delay` hold, the builder rule, each status code, `afx://` on a connected and a never-connected
Tower, and cron targets. I checked the affinity tests fail when affinity is allowed to leak
across workspaces (11 failures), then restored the code.

`spec-1307-send-delay.test.ts` is listed in the plan but tests only the timer registry and calls
no resolver, so it is unchanged; the delayed path is covered in `tower-routes.test.ts`.

## 2026-11-23 — phase 2: porch's tests check failed once again, not identified

- `porch done` on `d6124d76c` failed its `tests` check (build passed). Porch prints only the
  first lines of a failed check, all npm warnings, and keeps no copy, so the failing test is
  again unnamed even though I kept porch's whole output this time.
- The same suite on the same commit then passed twice: my own full run (8494 passed, 108
  skipped, exit 0) and porch's second run. Load average was 23 to 27 around all three runs.
- Second occurrence on this project (the first was in phase 1, on a change that touched no
  production path). An intermittent failure under load, cause unknown. For the review's Flaky
  Tests section. Not blocked.
- To name it next time: porch cannot tell me, so the only way is to have a full-output run of my
  own fail. Running the suite in a loop to catch it would add load to a machine that is already
  loaded, so I have not.

## 2026-11-23 — phase 2 review iteration 1: a misroute in the registry fallback, fixed

- codex REQUEST_CHANGES, claude APPROVE. Both pointed at the same thing: for bare `architect`
  from a builder with no architect of its own, in a workspace with no `main`, the live resolver
  refuses with the Spec 755 message and the registry resolver answered "the first registered".
  Because the route goes to the registry on any `NOT_FOUND`, the builder's mail was held for, and
  then delivered to, an unrelated architect. Older than this phase (the old code had the same
  lines); fixed here because phase 2's claim is that the two resolvers agree.
- The registry now refuses exactly where the live resolver does. The starved-mail notice keeps
  its "else the first registered" step, now written in `escalateHeldToOwner` itself, with the
  same results as before. **This goes in the PR body as an adjacent bug fixed in place.**
- New tests reproduce it: three fail against the pre-fix resolver, one of them a route test that
  finds mail stored for the wrong architect.
- **Carry into phase 6:** `codev/resources/arch.md` (near line 817) still describes the old
  two-slot `parseAddress` intercept.

## 2026-11-23 — phase 2 iteration 1: BLOCKED on porch's tests check under machine load

- `porch done` on the fix commit `d106d3984` failed its `tests` check (build passed). This time
  my own full-output run failed too, so the failures have names: **92 tests in 17 files, every
  one a timeout** of 5 seconds or more. Load average was 33 when porch finished and 49 during my
  run. Top CPU users were `fseventsd` and `XprotectService` at about 80 to 87 percent each, plus
  another builder's test run. None of it is this builder.
- The 17 files, none touched by this project: `commands/consult/__tests__/` (`claude-cli-lane`,
  `tripwire-wiring`, `agy-lane-model`, `bugfix-1754-dotenv-auth`, `lane-models`,
  `agy-auth-cache`), `src/__tests__/` (`doctor`, `claude-cli`, `bugfix-1455-pr-create-concept`,
  `forge`, `consult`), `agent-farm/__tests__/` (`ide-extensions`, `bugfix-1267-launch-loop`,
  `ide-version`, `pir-1233-session-launch-loop`, `ide-command`, `ide-server-unready`). They are
  the tests that start a subprocess. Every test file this phase touches passed in that same run.
- The phase 2 code before the fix passed the full suite twice (8494 passed). The fix changes one
  function in `tower-messages.ts` and one call site in `mailbox-wiring.ts`.
- NOT done: running the 17 files alone. At load 49 they would time out for the same reason and
  add to the load.
- Per ruling main-32 I have stopped and told the architect. Not looping on `porch done`.
  Full output: scratchpad `full-suite-phase2-2.txt` (not committed).

## 2026-11-23 — draft PR #1957 opened for CI; main merged in to let CI start

- Architect's answer to the blocker (relaying ruling main-32): open a draft PR so GitHub runs the
  full suite on a clean runner; report the result; skip or reconfigure nothing until the
  architect has checked the run. No more local full-suite runs for now.
- Draft PR #1957 opened and recorded (`porch done 1940 --pr 1957 --branch builder/spir-1940`).
- GitHub started **no** checks: the branch conflicted with `main` (112 commits ahead of the
  branch point), and a conflicting pull request has no merge commit to test. So I merged
  `origin/main` in. One conflict, `packages/sdk/src/tower-client.ts`: `main` (the #1950 CLI
  additions) added `connectionRefused` to the same two result shapes this branch added
  `errorCode` to. Kept both. One of my SDK tests changed to expect `connectionRefused: true` on
  a refused connection.
- After the merge: types and SDK build; SDK suite 392 passed; `packages/codev` type-check clean;
  13 targeted test files, 610 tests, passed; VS Code type-check clean. The full `packages/codev`
  suite was NOT run locally (architect's instruction); CI is the check.
- So CI tests the merge of this branch with `main`, not `d106d3984` alone. Told the architect.

## 2026-11-23 — phase 2 recorded with the local tests check skipped under main-32

- GitHub on PR #1957: 8 of 8 green at `6804f57c7` (branch with `main` merged in). The architect
  checked the run and gave the word.
- The 17 files that had timed out, run alone in one vitest invocation at load ~10: 17 files, 586
  passed, 1 skipped. So the ruling's conditions are met: the failures were unrelated and each
  file passes alone.
- On the architect's instruction: `porch.checks.tests.skip = true` added to this worktree's
  gitignored `.codev/config.local.json` only, `porch done 1940` run once (build check ran and
  passed), the key removed in the same command, file compared byte-for-byte with its original.
  `.codev/config.json` (a symlink to the shared config) was not touched. Nothing under `.codev`
  is staged or committed.
- The draft PR body says the phase 2 local suite was skipped and on what grounds.
- **For phase 3 (architect's correction): build, push, then TELL THE ARCHITECT BEFORE running
  `porch done`.** The owner is deciding (main-38) whether GitHub's run may come first without a
  local failure. Do not assume an order. No local full-suite runs; targeted tests only.
- Flaky Tests section for the review: the three failures of porch's tests check (one in phase 1,
  two in phase 2) are load timeouts in subprocess-spawning tests; the 17 files are named in the
  entry above.

## 2026-11-23 — phase 2 review iteration 2: issue #1633 fixed in place

- codex REQUEST_CHANGES, claude APPROVE. Both confirm the iteration 1 misroute is fixed.
- Codex's one point is issue #1633 (open, area/tower): with no `main`, the registry's "first
  registered" was the alphabetically first architect, because `getArchitects` sorted by id.
  Claude called it out of scope. I fixed it: the spec says "the first registered", the same
  address reached two recipients depending on whether terminals were up, and the fix is the one
  line the issue proposes (`ORDER BY (id != 'main'), started_at`). **PR body must name #1633 as
  fixed; the ARCHITECT decides whether and when to close it.**
- Other callers checked: `commands/stop.ts` (order irrelevant) and `tower-instances.ts` (sibling
  relaunch order at workspace start, now registration order, so the first architect survives a
  restart).
- The pinned test in `air-1477-owner-escalation-wiring.test.ts` flipped from `alpha` to `zeta`,
  as its own comment asked. Five new or flipped tests fail against the old query.
- **Carry into phase 4** (claude): error strings interpolate a local workspace name that was not
  checked against the component rule. Phase 4's rule about basenames in frames does not cover
  those strings; do not assume it does.
- Code changed, so the phase 2 skip no longer applies to this head. Order from the architect:
  push, wait for GitHub green on the new head, tell the architect BEFORE the next `porch done`.

## 2026-11-23 — phase 2 iteration 3 build recorded; notes for the review and verify phases

- GitHub green 8 of 8 on PR #1957 at `66ea5c747` (the #1633 fix), checked by the architect, who
  allowed the one-time skip for both `porch done` calls on that head. Both run: build check
  passed each time, tests check skipped, local config restored in the same command and
  byte-identical to its original. Only `status.yaml`, this log and porch's context file have
  changed since `66ea5c747`.
- If code or tests change again in phase 2: push, wait for green, ask the architect.
- The architect closes issue #1633 when the PR merges. Not me.
- **For the PR body, the review document and the verify-phase notes** (architect's instruction):
  sibling architects now relaunch `main` first, then by registration time, at workspace start.
  It was name order. To verify: in a workspace with two siblings registered in non-alphabetical
  order, restart the workspace and check they come back in registration order.
- **Phase 3: build, push, tell the architect BEFORE `porch done`.**

## 2026-11-23 — phase 2 COMPLETE (review round 3: codex APPROVE, claude APPROVE)

- Porch advanced to phase 3. Phase 2's commits: `d6124d76c` (feature), `d106d3984` (registry
  refuses where the live resolver does), `6df1df753` (merge of `main`), `66ea5c747` (issue #1633,
  architects in registration order). GitHub green on PR #1957 at `66ea5c747`.
- Claude's round 3 notes, none blocking, carried forward:
  1. **Phase 3:** `locateWorkspace` decides "the sender's own workspace" by comparing paths
     (`found.workspacePath === workspaceKey(sender.workspace)`). A sender whose workspace is
     spelled differently from the live map's key loses affinity and is refused. It fails closed
     and cannot break a send that works today. Phase 3's naming module is the place to put this
     comparison behind one helper.
  2. **Review document, known boundary:** the live front door is the terminal map's insertion
     order. An architect terminal that is deleted and registered again moves to the end, so in a
     workspace with no `main` the live front door can differ from the registry's until the next
     workspace start. Not fixed.
  3. **Phase 6:** `codev/resources/arch.md` lines 817 to 818 still describe the two-slot
     intercept and `resolveAgentInWorkspace`, which no longer exists.

## 2026-11-23 — I leaked 18 shellper processes; fix is the FIRST commit of phase 3

- The architect found 18 orphaned shellpers started from this worktree's build between 13:25 and
  13:27 PST. They are mine: `packages/codev/src/agent-farm/__tests__/send-latency.e2e.test.ts`
  (the opt-in latency measurement from phase 1). Its `afterAll` calls `tower.stop()` and deletes
  the workspace but never deactivates the workspace, and shellpers outlive Tower by design. Ten
  test Towers: two runs that failed before the builder was registered (architect only), eight
  full runs (architect and builder).
- **Do NOT kill the 18.** The architect has asked the owner and will say. PIDs at the time:
  51040 75335 82868 82873 84628 84873 87597 87599 88261 88269 88649 88666 88757 88771 90187
  90190 91497 91520.
- **Fix, agreed with the architect, to make before any phase 3 test run:** `afterAll`
  deactivates the workspace (`POST /api/workspaces/<encoded>/deactivate`) before stopping Tower,
  then polls and asserts that no process whose command line names that Tower's `socketDir`
  survives. Run the test once to prove the assertion. Phase 6's latency rerun must be on the
  fixed teardown.
- The three existing e2e files checked by reading: `send-integration` and `tower-baseline`
  deactivate in teardown; `tower-api` deactivates in the test body with `cleanupAllTerminals` in
  `afterAll` as the backstop. No leak found there. Reported.

## 2026-11-23 — phase 3 started: the shellper leak fixed first (`9725f56a3`)

Resumed after a context refresh at the phase boundary.

- `send-latency.e2e.test.ts` `afterAll` now deactivates the workspace before `tower.stop()`, then
  polls and asserts that no process whose command line names that Tower's `socketDir` survives.
  `beforeAll` asserts the same listing is non-empty while the terminals are up, so the teardown
  check cannot pass vacuously. The listing is a new helper, `pidsNamingSocketDir`, in
  `helpers/tower-test-utils.ts`.
- Proof: two runs, one test Tower each. Both passed. My shellper list before and after is the same
  18 PIDs (zero new), and the count of `sleep 3600` children is unchanged.
- I did not prove the assertion by leaking on purpose: that would start shellpers I may not kill.
  The `beforeAll` check is the evidence that the detector sees a live shellper.
- The old 18 are NOT killed; the owner's word is still awaited.
- The two runs read 3.10 ms and 5.03 ms at load 15 to 20 (baseline 2.19 ms, bound 3.19 ms). Single
  loaded runs prove nothing either way; phase 6 takes five on a quiet machine. Noted so that a
  high phase 6 reading is not a surprise.

## 2026-11-23 — phase 3 built: explicit workspace names

**What exists now.** Migration v20 adds a nullable `address_name` to `known_workspaces` with a
partial unique index. `utils/workspace-address.ts` holds every naming rule (validate, find, own
name, same-workspace comparison) and reads nothing itself. `locateWorkspace` calls it in place of
the basename match. `PUT /api/workspaces/:encodedPath/address-name`, `setWorkspaceAddressName` in
the SDK, and `afx workspace name <name>` / `--clear`.

**Decisions I made, for the review to check:**

1. **The spec and the plan disagree on one sentence, and I followed the spec.** The plan says of a
   workspace registered later whose basename equals an existing explicit name: "its bare basename
   fails with a message that says it needs a name of its own". The spec says "the explicit name
   keeps resolving to the workspace that holds it". Both cannot hold for the same text. So:
   the name resolves to its holder while the holder runs (no error exists to carry a message);
   when the holder is NOT running the address fails, says the holder is not running, and names the
   running workspace with that basename as needing a name of its own. `workspaceAddressName` also
   reports such a workspace as having no name, with the reason, for phase 5's listing.
2. **"Address name of any other workspace" is read by the spec's own definition**: explicit name
   if it has one, otherwise basename. So a workspace may take a name equal to the basename of a
   workspace that has an explicit name (that workspace no longer answers to its basename). If
   that workspace later clears its name it is shadowed, and the clear says so: the response
   carries `addressName: null` and the reason, and the CLI prints it as a warning.
3. **Ambiguity is among running workspaces only**, as before this phase. A stopped workspace with
   the same basename does not make a running one ambiguous. Setting a name is checked against
   every registered workspace, running or not, as the spec says.
4. **A running workspace with no `known_workspaces` row counts as registered and unnamed** (a
   stray worktree architect, and every test that fakes the terminal map).
5. **An explicit name is at most 64 characters**, and is lower-cased before the component rule.
6. **Error codes on the naming route**: 400 `INVALID_NAME` and `RESERVED_NAME`, 409 `NAME_TAKEN`,
   404 `NOT_FOUND` for a workspace Tower has no row for. The body is the usual
   `{ error, message }`.
7. **`afx workspace name` run in a builder worktree names the builder's workspace**, not the
   worktree (it uses `detectWorkspaceRoot` from `send.ts`, which every `afx send` already uses).
8. **Error wording changed** for an unknown or ambiguous workspace ("Workspace 'x' …", was
   "Project 'x' …"). No test pinned the old text; the codes are unchanged. Three new cases have
   their own text: not running, addressed under another name, and the shadowed newcomer.
9. **Windows path merge**: the surviving `known_workspaces` row keeps its own name, else takes the
   dropped row's. The code reads the column only where it exists.

**Tests.** `workspace-address.test.ts` (47, pure, including two exhaustive checks over every
arrangement of three workspaces: a workspace's own name resolves to it, and an accepted name
never moves an existing one). Migration v20 from v15 to v19 and fresh. Both resolvers
(`spec-1940-cross-workspace-resolve.test.ts`, now 121), including the name table being read only
for an address that names a workspace. The route and the send route together against one
registry in `tower-routes.test.ts`. The CLI, the SDK wire contract, and the path merge. Four
mutations (drop the name in the merge, stop preferring the holder, lose "own workspace" for an
explicit name, skip validation in the route) each fail tests.

**Carry forward.** Phase 4: `workspaceAddressName` returns a basename as it is, which need not fit
the component rule; check before formatting. Phase 5: `afx whoami` and the listing use the same
module with `getRegisteredWorkspaces(db)` on a read-only handle; `whoami.ts` still reads the old
`name` column for display.

**Checked on a real Tower** (a one-off e2e file, not committed: phase 6 owns the kept one). Built
Tower on an isolated port and directory, two workspaces whose directories are both `codev`:
`codev:architect` fails 409 listing both paths; the real `workspaceName` command, run from a
subdirectory of the second workspace with only the port replaced, names it `work`; then
`codev:architect` and `work:architect` each store mail in the right workspace; `WORK`,
`architect`, `my notes` and an unregistered path are refused with `NAME_TAKEN`, `RESERVED_NAME`,
`INVALID_NAME`, `NOT_FOUND`; with the named workspace stopped, `work:architect` fails "is not
running" and the name still cannot be taken; a clear reports no address name and the reason, and
the ambiguity returns. Teardown deactivated both workspaces; shellper list unchanged.

**Verification so far**: 75 targeted test files in `packages/codev` (1893 tests, 4 workers), the
SDK suite (400), `npm run build` in `packages/codev`, type-check. One existing test needed its
`state.js` mock extended (`spec-1313-registry-resolve.test.ts`). The full local suite was NOT
run (standing order); GitHub's run on the pushed head is the full check.

## 2026-11-23 — phase 3: porch's tests check failed once under its own load; conditions for main-32 met

- Architect's answer (main-38 not ruled, so main-32 as written): plain `porch done` once at
  one-minute load under 18. Run at load 12.7. Build passed (21 s); **tests check failed** (93 s).
  Load was 33 when it ended: the suite itself is what loads the machine. Not rerun.
- Failed files, from vitest's results cache
  (`packages/codev/node_modules/.vite/vitest/<hash>/results.json`, a list of
  `[":<file>", { duration, failed }]`), none touched by this project:
  `src/__tests__/windows-console-spawn-guard.test.ts` (NEW to the list: a static scan that parses
  the source tree with the TypeScript compiler), `agent-farm/__tests__/bugfix-1267-launch-loop`,
  `ide-command`, `pir-1233-session-launch-loop`, `commands/consult/__tests__/agy-auth-cache`
  (those four are among phase 2's 17).
- The five alone, one vitest invocation, load about 15: 5 files, 76 tests, all passed.
- GitHub on PR #1957 at `0a553e80b`: 8 of 8 green (Unit Tests run 45288994982). Told the
  architect; waiting for the word before the one-time skip.
- **For the review** (architect's instruction): record the plan/spec sentence and my reading, so
  the owner sees it at the `pr` gate; include the real-Tower transcript below. The Flaky Tests
  section gains this fourth failure of porch's tests check and the new file.

**Transcript of the one-off real-Tower check** (isolated port and directories; `<tmp>` is the
test's temp root; trimmed to the lines that matter):

```
AMBIGUOUS 409 {"error":"AMBIGUOUS","message":"Workspace 'codev' is ambiguous: 2 workspaces have that directory name: <tmp>/a/codev, <tmp>/b/codev. Give one a name of its own by running `afx workspace name <name>` in it."}
[ok] This workspace is now addressed as 'work'.
[info] Another workspace reaches its front door with: afx send work:architect "…"
TO_A 200 {"ok":true,"resolvedTo":"main","deferred":true,"delivered":false,"held":true,"reason":"no-live-pty","detail":null,"bodyLength":5}
TO_B 200 {"ok":true,"resolvedTo":"main","deferred":true,"delivered":false,"held":true,"reason":"no-live-pty","detail":null,"bodyLength":5}
REFUSALS [{"ok":false,"error":"'work' is already the name of the workspace <tmp>/b/codev. (NAME_TAKEN)","errorCode":"NAME_TAKEN"},{"ok":false,"error":"'architect' is a reserved word in addresses and cannot be a workspace name. (RESERVED_NAME)","errorCode":"RESERVED_NAME"},{"ok":false,"error":"'my notes' cannot be a workspace name: use letters, digits, '.', '_' and '-', starting with a letter or a digit. (INVALID_NAME)","errorCode":"INVALID_NAME"},{"ok":false,"error":"Workspace <tmp>/nowhere is not registered with Tower. Start it once first: afx workspace start (NOT_FOUND)","errorCode":"NOT_FOUND"}]
STOPPED 404 {"error":"NOT_FOUND","message":"Workspace 'work' (<tmp>/b/codev) is not running."}
CLEARED {"ok":true,"result":{"explicitName":null,"addressName":null,"unaddressableReason":"it shares the directory name 'codev' with <tmp>/a/codev; give it a name of its own: afx workspace name <name>"}}
 ✓ src/agent-farm/__tests__/tmp-phase3-check.e2e.test.ts > phase 3 one-off: names on a real Tower > ambiguous, then named through the CLI command, then both resolve; refusals; clear 1038ms
      Tests  1 passed (1)
```

## 2026-11-23 — phase 3, review iteration 1: codex REQUEST_CHANGES, claude APPROVE

- `porch done` for the build ran with the one-time tests skip, on the architect's word after
  they checked GitHub's run on `0a553e80b` (local config restored byte-identical in the same
  command, nothing under `.codev` staged).
- **Codex**: the 64-character limit on a workspace name is not in the spec. Correct, it was my
  addition. **Removed.** Consequence left as it is and raised with the architect: an address is at
  most 512 characters (`MAX_ADDRESS_LENGTH`, phase 1), so a name too long to fit in one can be set
  and then not written; the sender gets the parser's length error.
- **Claude** (non-blocking, fixed in place): the name route ignored the write's result (now 500
  `INTERNAL_ERROR` when no row was updated); a unique-index refusal would have been an uncaught
  throw (now 409 `NAME_TAKEN`); errors named a workspace by its directory, not by what the sender
  wrote (`workspaceLabel(target)`, six error texts in both resolvers). Left: the handler reads
  the name table twice.
- The two write failures cannot be reached through the route on POSIX, so their tests put a
  SQLite trigger on the real test database: one takes the name between check and write, one makes
  the update skip its row.
- Checked: three mutations (catch rethrows, unstored write answers 200, label back to the
  directory) each fail tests; 38 test files that touch the resolver, the route or the naming
  module (1053 tests) pass; type-check and `npm run build` pass. Code changed after the green
  run, so: push, wait for GitHub, ask the architect before `porch done`.

## 2026-11-24 — phase 3: a name must fit in an address (architect's decision)

- With the 64-character limit gone, a name too long for a 512-character address could be set and
  never written. Raised it; the **architect decided** (not a new spec rule, it follows from the
  spec's address limit, and the project fails fast): refuse at set time any name whose front door
  `<name>:architect` would not pass the shared parser, derived from the parser, no constant of
  mine, message says too long for an address and gives the parser's limit.
- Done with one addition to the shared address module: `tryFormatAddress` (the formatter's
  answer as a value; `formatAddress` calls it and throws as before). `validateProposedName`
  formats the front door with it; the refusal quotes the parser's sentence.
- Tests: longest that fits accepted, one more refused, at the naming module and at the formatter;
  a 600-character name refused through the route. SDK suite 404, 39 codev files 1178, extension
  conformance 122, type-check, build: all pass.
- **For the review**: record this as following from the spec's 512-character address limit.
- Order from here: push, GitHub green on the new head, tell the architect; they check the run;
  then the one-time skip for BOTH `porch done` calls of this round (phase 3 already had its local
  failure).

## 2026-11-24 — phase 3, review iteration 2: codex REQUEST_CHANGES, claude APPROVE

- Both `porch done` calls of iteration 1's round ran with the one-time tests skip, on the
  architect's word after they checked GitHub's run on `18a9c86a8` (config restored each time).
- **Codex**: the naming route refuses a Windows UNC workspace path. True, and not this phase's:
  the path check is the same line the four existing `/api/workspaces/:path/…` routes use,
  including activate, so a UNC workspace cannot be started through Tower today either.
  **Architect's decision: rebut**, name it in the review as a known boundary, cite follow-up issue
  #1960 ("tower: workspace routes refuse Windows UNC workspace paths; the path check is copied
  inline in every route"). Do not refactor the shared check here.
- **Claude**, two notes fixed on the architect's instruction: the naming module told workspaces
  apart by the text of a path (now one list keyed by `workspaceKey`; a lookup returns a running
  workspace in the spelling it runs under); `findWorkspaceByAddressName` trusted its caller to
  lower-case (now does it itself). Two left on purpose, **to list in the review**: no `PUT` in
  `Access-Control-Allow-Methods` (no browser caller), `quoted()` duplicated across the package
  boundary.
- Checked: the four pinning tests fail against the previous module; 39 codev test files (1184
  tests), type-check and build pass. Next: push, GitHub green, tell the architect before
  `porch done`.

**Round 3 of phase 3's review starts** (2026-11-24). Both `porch done` calls of round 2 ran with
the one-time skip after the architect checked GitHub on `4c9d9c967`. Architect's warning: porch
force-advances a phase at its third review iteration, so a fix made after round 3 is never
re-reviewed. If round 3 asks for changes: tell the architect what it found BEFORE fixing, and
list any commit no reviewer saw under its own heading in the PR body and the review.

## 2026-11-24 — phase 3 COMPLETE (round 3: codex APPROVE, claude APPROVE)

- Round 3: both lanes approve, no blocking issue, so no commit of phase 3 went unreviewed.
  Porch advanced to phase 4 (`60146eece`). No code changed after the last reviewed head.
- Claude's two non-blocking notes from round 3, **not fixed now** (a fix after round 3 would be
  seen by no reviewer); carried so a later phase's review sees them:
  1. **`NAME_TAKEN` wording when the basename is shared.** A and B both `codev`, neither named:
     A asking for `codev` is told "'codev' is already the address of the workspace B, by its
     directory name". At that moment `codev` is the address of nothing (it is ambiguous), and
     the message gives no way forward (name B something else first). Fix the sentence in
     **phase 5**, which touches the naming module's texts for the listing, or say it in phase
     6's docs.
  2. Two rows for one directory under two spellings, each with a different name: which name
     `everyWorkspace` keeps depends on row order. Unreachable after boot canonicalization; a
     comment at most (phase 5, with note 1).
- **For the review document** (collected from this phase):
  - plan/spec disagreement on one sentence (a later workspace whose basename equals an existing
    explicit name) and my reading (the spec's);
  - the real-Tower transcript above;
  - the address-fit rule as following from the spec's 512-character address limit (architect's
    decision), via `tryFormatAddress`;
  - known boundary: workspace routes refuse Windows UNC paths, issue #1960;
  - left on purpose: no `PUT` in `Access-Control-Allow-Methods`; `quoted()` duplicated across
    the package boundary; `getRegisteredWorkspaces()` read twice in the name route;
  - Flaky Tests: porch's local tests check failed once in phase 3 on five unrelated files (all
    pass alone); every later `porch done` of phase 3 used the one-time skip on the architect's
    word after GitHub was green on the same head (heads `0a553e80b`, `18a9c86a8`, `4c9d9c967`).
- **Phase 4 order** (architect): build, push, tell the architect BEFORE `porch done`.

## 2026-11-24 — phase 4 built: qualified provenance and reply commands

Resumed after a context refresh at the phase boundary.

**Owner ruling main-38, "ci-first"** (relayed by the architect, 00:33Z), in force until issue
#1956 is fixed: no local full-suite run and no plain `porch done`. Per phase: targeted tests,
build and type-check locally; push; GitHub green on that exact head; tell the architect; on
their word the one-time tests skip. A red GitHub run is fixed, never skipped. This replaces
main-32's "let the local check fail once first".

**What exists now.** A message from an agent in another workspace is framed with the sender's
workspace-qualified address and a reply on the footer line:

```
### [ARCHITECT codev:architect:review MESSAGE → tunnel | <time>] ###
hello
###############################  (reply: afx send codev:architect:review "…")
```

- `utils/message-format.ts`: `formatCrossWorkspaceMessage`, with the types `CrossWorkspaceOrigin`
  and `ReplyRoute`. The role word comes from the address's kind. Every address part is checked
  against the component rule in the formatter itself, whatever the caller checked.
- `servers/tower-messages.ts`: `refusalToAddress` (the builder rule on its own, exported) and
  `crossWorkspaceOrigin` (who it is from, how to reply).
- `servers/tower-routes.ts`: `formatMessageForTarget(recipient, sender, message, raw)`. The
  sender's `workspace` is required by the type; all six call sites pass it.

**The snapshot was taken first.** Commit `39bfd1f32` holds only the test of the frames that
must not change (22 cases: every same-workspace sender and recipient kind, no sender workspace,
the workspace `unknown`, the non-agent senders across workspaces, raw sends). It was written
and passed against the code before any production change, and passes unchanged after.

**Decisions I made, for the review to check:**

1. **Where the logic lives.** The plan put the composition in `tower-routes.ts` with the
   permission check exported from `tower-messages.ts`. I put the composition
   (`crossWorkspaceOrigin`) in `tower-messages.ts` beside the resolvers, because it calls them,
   and the route only asks it. `refusalToAddress` is exported as the plan says and the footer
   asks it; the test table asks it too.
2. **When the front door is offered.** A builder may not name an architect in another workspace,
   so for a named architect sender the candidate is the front door `<ws>:architect`. It is
   offered only when the front door, resolved as the recipient by the real resolvers (live, then
   registry), reaches that sender NOW. So: `main` gets it while it is the front door; with no
   `main`, the first registered architect gets it; `main` does not get it while it has no
   terminal and another architect has one (the front door then reaches the other). The spec's
   row says "the `main` architect"; the plan's says "the front door". I followed the plan's
   wording and the acceptance criterion ("delivers to the original sender"). The answer is true
   when the frame is written and can change after, as any address can.
3. **A sender with no name of its own** (`from: architect`, a terminal that names no architect)
   is shown as `<ws>:architect` and answered at the front door.
4. **What counts as an agent.** The cross-workspace frame is used only when the sender's id reads
   as a local agent id through the shared parser: `architect`, `architect:<name>` or an id, with
   no workspace and no Tower, each name fitting the component rule. `af-cron`, `vscode-user` and
   `decisions-tab` are excluded by name. `architect-3` (an id that only looks like an
   architect's) is excluded, as today's label code refuses to call it a builder. Anything else
   keeps today's frame.
5. **No usable workspace name**: header `ARCHITECT architect:review (another workspace) MESSAGE`,
   footer `(no reply address; the sender's workspace needs: afx workspace name <name>)`. Also
   used for a directory called `architect` with a builder sender, whose address text would read
   as a named architect.
6. **An architect recipient that no candidate is allowed for** gets the plain footer. Stage 1
   cannot produce it (architects are not restricted); it is there so the type is total.
7. **Sender workspace for the frame is what the mailbox stores** (`fromWorkspace ?? workspace`),
   and the literal `unknown` is now one constant used by the fallback and the check.

**Known boundaries (for the review):**

- A reply command names the sender's workspace by its address name. If that workspace is not
  running, or was never registered with Tower (a send from a directory Tower does not know),
  the reply fails with the resolver's "not running" / "not found" message. The footer checks
  permission, not that the workspace is up.
- `from` and `fromWorkspace` are what the sender says. A local sender can claim any id and any
  workspace, as before this phase; the spec treats every local sender as the same owner.
- A `from` that itself carries a workspace (`codev:builder-x`) keeps today's frame, which prints
  it as `BUILDER codev:builder-x`. That is today's behaviour and is unchanged.

**Tests.** `message-format.test.ts` (+19: frames, verbs, footers, three lines, a 40-byte body on
the short path, the spec's 87 bytes of body for its example frame, forged parts refused).
`spec-1940-reply-footer.test.ts` (new, 37: the footer table, each printed command resolved as
the recipient by the real resolvers and reaching the sender; front door cases; unusable names;
ids that are not agents). `tower-routes.test.ts` (+17 beyond the snapshot: one test per
agent-bearing path plus `--interrupt`, the reply taken from the stored frame and sent back
through the route, mailbox row fields, the short write, unusable names, an explicit name; the
Decisions tab notice asserted whole). `air-1478-architect-attribution.test.ts` (+3) and
`inbox-routes.test.ts` (+1). Eleven mutations each fail tests: front door always offered,
permission always granted, no component check on the workspace name, each of the five paths
losing the sender's workspace, `unknown` not treated as unknown, non-agent senders not excluded,
the same-workspace check dropped.

**Checked on a real Tower** (a one-off e2e file, not committed: phase 6 owns the kept one). Built
Tower on an isolated port and directory; three workspaces, two of them directories called
`codev`. Each frame below was read from the stored `formatted_message`; each reply was sent
through `POST /api/send` as the recipient. `<tmp>` is the test's temp root.

```
SAME    ### [ARCHITECT:main MESSAGE → main | <time>] ###            (same workspace: today's frame, plain footer)
UNNAMED ### [ARCHITECT architect:main (another workspace) MESSAGE → main | <time>] ###
        ###############################  (no reply address; the sender's workspace needs: afx workspace name <name>)
NAMED   200 {"explicitName":"one","addressName":"one"}
CROSS   ### [ARCHITECT one:architect:main MESSAGE → main | <time>] ###
        ###############################  (reply: afx send one:architect:main "…")
REPLY   200, stored for main in <tmp>/a/codev:
        ### [ARCHITECT codev-cloud:architect:main MESSAGE → main | <time>] ###
        ###############################  (reply: afx send codev-cloud:architect:main "…")
TO_BUILDER_FROM_MAIN    ### [ARCHITECT one:architect:main INSTRUCTION → builder-spir-7 | <time>] ###
                        ###############################  (reply: afx send one:architect "…")
BUILDER_REPLY           200, stored for main in <tmp>/a/codev:
                        ### [BUILDER codev-cloud:builder-spir-7 MESSAGE → main | <time>] ###
TO_BUILDER_FROM_REVIEW  ### [ARCHITECT one:architect:review INSTRUCTION → builder-spir-7 | <time>] ###
                        ###############################  (reply through your architect: afx send architect "…")
BUILDER_NAMES_REVIEW    403 REFUSED "builder builder-spir-7 may only address its own spawning architect; reach that workspace through its front door: afx send one:architect "…""
THROUGH_ARCHITECT       200, stored for main in <tmp>/codev-cloud: ### [BUILDER builder-spir-7 MESSAGE → main | <time>] ###
```

The builder's registry row was inserted into that Tower's throwaway database by the test (there
is no spawn on a test Tower). Teardown deactivated all three workspaces and asserted that no
process naming that Tower's socket directory survived: passed. The 18 old leaked shellpers I
was told not to kill are no longer running (first five PIDs checked: gone); I did not touch
them.

**Verification**: 58 test files in `packages/codev` that touch the resolver, the route, the
formatter, the naming module or the write path (1810 tests, 4 workers); type-check;
`npm run build`. The full local suite was NOT run (ruling main-38); GitHub's run on the pushed
head is the full check.

## 2026-11-24 — phase 4: build recorded; review round 1 starts

- GitHub 8 of 8 green on `ba33ee37b` (runs 45300455783 Tests, 45300455800 CLI Integration
  Tests). The architect checked the run and gave the word; `porch done` for the build ran with
  the one-time tests skip under ruling main-38 (local config restored byte-identical in the same
  command, nothing under `.codev` staged). The build check ran and passed.
- **Architect's answers, for the review document:**
  1. Front door: keep as built. Record it as a deliberate reading of the spec's "the `main`
     architect" row: the same thing in a workspace that has a `main`, and the only correct
     answer in one that does not. Name the case it adds (no `main`, the sender is the first
     registered) and what a builder sees when the front door does NOT reach the sender
     (`reply through your architect`).
  2. Layout (reply logic in `tower-messages.ts`): fine.
  3. Record the known boundary: the footer checks permission, not that the sender's workspace
     is running.
- The 18 old leaked shellpers: killed by the architect on the owner's word, each checked
  against Tower's terminal list first.
- **Phase 5 order** (architect): build, push, tell them when GitHub is green; carry the two
  phase 3 notes (the `NAME_TAKEN` wording for an ambiguous basename, and the comment on which
  name wins).

## 2026-11-24 — phase 4 COMPLETE (round 1: codex APPROVE, claude APPROVE)

- Round 1: both lanes approve, no blocking issue; no commit of phase 4 went unreviewed. Porch
  advanced to phase 5 (`ce4bfb7d6`). No code changed after the reviewed head `ba33ee37b`.
- One `porch done` in phase 4, with the one-time tests skip (ruling main-38) after GitHub was
  green on `ba33ee37b`. **For the PR body and the review's Flaky Tests section:** phase 4 ran no
  local full suite at all, by that ruling.
- Claude's four non-blocking notes:
  1. `crossWorkspaceOrigin` resolves the front door even when the first candidate is already
     allowed (an architect recipient), and throws the answer away. **Fix as the first commit
     of phase 5**, so phase 5's review sees it: ask about the front door only when the
     sender's own address is refused.
  2. **For the review document:** a stored frame's reply command can go stale. The frame is
     composed when the message is stored and delivered as stored, so mail held for a long time
     (or sent with `--delay`) carries the sender's workspace name as it was then; if that
     workspace is renamed meanwhile, the pasted command fails. Inherent to mailbox-first, and
     true of today's reply hint in spirit; not changed.
  3. **For the review document:** with the sender's workspace stopped, an architect recipient
     is still offered the sender's address (which would fail "not running") while a builder is
     told to reply through its architect. Both follow from the rules; it cannot arise for a
     message that was just sent from a running workspace.
  4. **For the review document** (carried from phase 2, still out of scope): resolver error
     strings interpolate an unchecked local workspace name. They travel in an HTTP body to the
     sender's own CLI, never into another agent's prompt; `addressForFrame` does not cover
     them.
- **For the review document** (collected from this phase):
  - the front door rule as a deliberate reading of the spec's "the `main` architect" row
    (architect agreed): offered when the real resolver says the front door reaches the sender
    now; the case it adds (no `main`, the sender is the first registered); a builder otherwise
    sees `reply through your architect`;
  - layout: the reply logic is in `tower-messages.ts`, not `tower-routes.ts` as planned;
  - known boundaries: the footer checks permission, not that the sender's workspace is running
    or registered; `from` and `fromWorkspace` are what the sender says; a `from` that carries
    a workspace keeps today's frame;
  - the real-Tower transcript above.
- **Phase 5 order** (architect): build, push, tell them when GitHub is green, wait before
  `porch done`. Carried into phase 5: the lazy front door (note 1), the `NAME_TAKEN` wording
  for a shared basename and the comment on which name wins (phase 3), `afx whoami` and the
  listing through the naming module with `getRegisteredWorkspaces(db)` on a read-only handle.

## 2026-11-24 — phase 5 built: the address book, `afx workspace list`, the whoami address

Resumed after a context refresh at the phase boundary.

**First commit, `47aedc3ef`: the lazy front door** (phase 4 reviewer's note). `crossWorkspaceOrigin`
resolves the front door only when the sender's own address is refused. A test pins it by counting
reads of the name table: one for an architect recipient, two for a builder.

**What exists now.**

- `GET /api/address-book?workspace=<path>&from=<id>` (`servers/tower-address-book.ts`, the handler
  in `tower-routes.ts`, the type in `codev-types`, `TowerClient.getAddressBook` in the SDK). Every
  workspace Tower has registered: the running ones with their architects, builders and shells, then
  the ones not running. Each agent has an address, `live`, `sendable`, and `reachThrough` when the
  caller may not name it.
- `afx workspace list [--json]` (`commands/workspace-list.ts`). It says who is asking exactly as
  `afx send` says who is sending. Its output for the spec's sample is the spec's sample, character
  for character.
- `afx whoami` prints `address: <address>` as its last line, and `address` in `--json`. When there
  is none: `address: none (<reason>)`, and `addressUnavailable` in `--json`. Lines before it and
  exit codes are as they were.
- `printableAddressName` in the naming module: the address name, refused when it is a directory name
  outside the component rule. The reply footer (phase 4), the listing and whoami all use it, so one
  rule decides what is ever printed as an address.

**Decisions I made, for the review to check:**

1. **`sendable` is the resolver's answer, not a second copy of its rules.** The plan says the field
   "comes from the phase 2 permission check, asked as the caller". I do ask that check
   (`refusalToAddress`), and it decides whether a way in is shown. But `sendable` itself is found by
   writing the address as text, reading it back with the shared parser and resolving it as the
   caller, live terminals then the registry, as the send route does; it is true only if that reaches
   the agent on that line. Two cases the permission check alone gets wrong, both tested: a shell
   whose id is the tail of a builder's id (the address reaches the builder), and two registered
   builders whose ids differ only in letter case.
2. **`live` is the send route's own test**: the session exists and is writable. Found by the
   real-Tower run below: my first version read the terminal map and called an agent `live` whose
   mail the send route then held as `no-live-pty`.
3. **A workspace with no usable name.** Its agents have `address: null` and are printed in
   brackets with `no address`, except for the caller's own workspace, where the short form
   (`architect:review`) is given and is checked the same way.
4. **A directory name outside the component rule** (a space, a capital the file system kept is
   lower-cased and fine; a colon, a leading dot) is listed as having no address name, with
   `afx workspace name <name>`. The resolver still matches such a name, as before; it is only never
   printed as an address, which is the rule phase 4 set for frames.
5. **A workspace that is not running is listed with no agents.** Nothing sent to it resolves, so
   listing its registry rows as addresses would print lines that fail.
6. **The way in.** For a builder, an architect in another workspace shows that workspace's front
   door (`reach through codev-cloud:architect`, the plan's example). Another architect in its OWN
   workspace shows `reach through architect`, its own architect. The way in is itself resolved as
   the caller and left out when it reaches nobody.
7. **whoami and "running".** The naming rules need to know which workspaces are running, and only
   Tower holds that list. whoami reads `terminal_sessions` from global.db on its read-only handle
   (a workspace with a terminal row is counted as running) and counts the caller's own workspace as
   running. Tower writes those rows when it starts a terminal and deletes them when the workspace
   stops, so the two agree except in the moment between. I chose this over "every registered
   workspace counts as running", which would deny an address for ever to a workspace that shares a
   directory name with a stale row. **The architect should confirm this reading.**
8. **whoami with no address**: no fallback to the directory name. global.db unreadable, a database
   from before migration v20, or a workspace with no usable name each give `address: none (why)`.
   Identity and exit code are unaffected, as for the `workspace` line.
9. **The carried phase 3 notes.** `NAME_TAKEN` for an unnamed workspace's directory name now reads
   "is the directory name of the workspace X, which has no name of its own. Choose another name, or
   first give that workspace one by running `afx workspace name <name>` in it", true whether or not
   the two share the name. `everyWorkspace` carries the comment on which name wins when two rows
   spell one directory, and two tests pin it.

**Known boundaries (for the review):**

- The listing reads the name table once and resolves each address against the table as it is at
  that moment. A rename in between gives lines marked not sendable, never a wrong `sendable`
  (tested).
- On this machine global.db has 52 registered workspaces and 12 running. The not-running ones are
  one line each, after the running ones.
- `--json` is Tower's response as it came. Paths and reasons in the text output have control
  characters replaced, so a path cannot forge a line of the listing.

**Tests.** `spec-1940-address-book.test.ts` (new, 34: the table for an architect and a builder; six
callers each fed back through the real resolvers; liveness; unusable names; addresses that would
reach another agent). `tower-routes.test.ts` (+10: the route as an architect and as a builder, every
listed address then SENT through `POST /api/send` as that caller, stored for the agent it was
printed for, or refused with the way in accepted). `workspace-list.test.ts` (new, 16).
`spec-1134-whoami.test.ts` (+15; three existing exact-output assertions gained the added line).
`workspace-address.test.ts` (+12). `spec-1940-reply-footer.test.ts` (+1). SDK
`tower-client-address-book.test.ts` (new, 4). Twenty-four mutations of the new code each fail a
test; two survived at first and each got a test.

**Checked on a real Tower** (a one-off e2e file, not committed: phase 6 owns the kept one). Built
Tower on an isolated port and directory; three workspaces, two of them directories called `codev`.
The listing is `GET /api/address-book` printed by `formatAddressBook`; each `send` is
`POST /api/send` as that caller; `afx whoami` is the built CLI run in the workspace against that
Tower's database. The architects there run `bash` and take no input, which is why they read
`no live terminal`; the builder is an inert `sh`.

```
$ afx workspace list        # as architect:main in <tmp>/a/codev, two directories called codev
(no address name)    <tmp>/a/codev
  no address name: it shares the directory name 'codev' with <tmp>/b/codev; give it a name of its own: afx workspace name <name>
  architect:main                no live terminal
  architect:review              no live terminal
(no address name)    <tmp>/b/codev
  no address name: it shares the directory name 'codev' with <tmp>/a/codev; give it a name of its own: afx workspace name <name>
  (architect:main)              no live terminal    no address
codev-cloud          <tmp>/codev-cloud
  codev-cloud:architect:main    no live terminal
  codev-cloud:builder-spir-7    live
$ afx whoami                # architect review in <tmp>/a/codev
address: none (this workspace has no address name: it shares the directory name 'codev' with <tmp>/b/codev; give it a name of its own: afx workspace name <name>)
$ afx workspace name one    # in <tmp>/a/codev
$ afx workspace list        # as architect:review in <tmp>/a/codev (now `one`)
one            <tmp>/a/codev
  one:architect:main            no live terminal
  one:architect:review          no live terminal
codev          <tmp>/b/codev
  codev:architect:main          no live terminal
codev-cloud    <tmp>/codev-cloud
  codev-cloud:architect:main    no live terminal
  codev-cloud:builder-spir-7    live
  send one:architect:main -> 200 resolvedTo=main held(no-live-pty)
  send one:architect:review -> 200 resolvedTo=review held(no-live-pty)
  send codev:architect:main -> 200 resolvedTo=main held(no-live-pty)
  send codev-cloud:architect:main -> 200 resolvedTo=main held(no-live-pty)
  send codev-cloud:builder-spir-7 -> 200 resolvedTo=builder-spir-7 held(no-profile)
$ afx workspace list        # as builder-spir-7 in <tmp>/codev-cloud
one            <tmp>/a/codev
  one:architect:main            no live terminal    reach through one:architect
  one:architect:review          no live terminal    reach through one:architect
codev          <tmp>/b/codev
  codev:architect:main          no live terminal    reach through codev:architect
codev-cloud    <tmp>/codev-cloud
  codev-cloud:architect:main    no live terminal
  codev-cloud:builder-spir-7    live
  send one:architect:main -> 403 REFUSED          send one:architect -> 200 resolvedTo=main
  send one:architect:review -> 403 REFUSED        send one:architect -> 200 resolvedTo=main
  send codev:architect:main -> 403 REFUSED        send codev:architect -> 200 resolvedTo=main
  send codev-cloud:architect:main -> 200 resolvedTo=main
  send codev-cloud:builder-spir-7 -> 200 resolvedTo=builder-spir-7
$ afx whoami                # architect review in <tmp>/a/codev
address: one:architect:review          send from <tmp>/codev-cloud -> 200 resolvedTo=review
$ afx whoami                # architect main in <tmp>/b/codev
address: codev:architect:main          send from <tmp>/codev-cloud -> 200 resolvedTo=main
$ afx whoami                # architect main in <tmp>/codev-cloud
address: codev-cloud:architect:main    send from <tmp>/a/codev -> 200 resolvedTo=main
```

(The whoami lines above show only the `address:` line; the three lines before it were as today.)
The test also asserted, for each send, that "held for want of a terminal" and `live: false` in the
listing are the same fact. Teardown deactivated all three workspaces and asserted that no process
naming that Tower's socket directory survived: passed.

**A fifth bare `cd`.** In one command of this phase I wrote `cd packages/codev && python3 …` with
no parentheses. The next command was `cd` back to the worktree root; nothing was written or staged
from the wrong directory.

## 2026-11-24 — phase 5: GitHub red on `f3ed3d453`, fixed

GitHub's Unit Tests job failed at its first step, the `/tmp` residue check: a string in
`workspace-list.test.ts` (a made-up path in the control-character test) began with `/tmp`, and the
check refuses a test file that names `/tmp` without an allowlist entry. No unit test ran in that
job. Fixed by using a path that is not under `/tmp`; the allowlist is untouched.
`node scripts/tmp-residue-check.mjs` passes locally, which I should have run before pushing: it is
the first step of the job. The other seven jobs on that head were green.

## 2026-11-24 — phase 5: build recorded; review round 1 starts

- GitHub 8 of 8 green on `6462b2563` (runs 45305995695 Tests, 45305995758 CLI Integration
  Tests). The architect checked the run and gave the word (01:53Z); `porch done` for the build
  ran with the one-time tests skip under ruling main-38 (local config restored byte-identical in
  the same command, sha1 confirmed, nothing under `.codev` staged). The build check ran and
  passed. **For the PR body and the review's Flaky Tests section:** phase 5 ran no local full
  suite, by that ruling.
- **Architect's answers, for the review document:**
  1. whoami's "running" (a `terminal_sessions` row plus the caller's own workspace): right.
     Record it and its boundary: a stale row left after a crash counts a workspace as running
     that is not.
  2. The three readings (sendable from the real resolvers; live as the send route's test; a
     stopped workspace listed with no agents and an unwritable directory name with no address
     name): fine.
- **FIRST COMMIT OF PHASE 6** (architect, found by running this build's CLI against the
  INSTALLED Tower, the state every user is in right after upgrading: new CLI, old Tower):
  1. `afx workspace list` prints a bare `[error] Not found`. A 404 on the address-book route
     must say what it means: this Tower is older than this CLI and has no address book; restart
     Tower to pick up the new version, with the commands.
  2. `afx whoami` prints `address: none (global.db does not hold workspace names yet; start
     Tower once: afx workspace start)`. Tower was running, so the advice is wrong. Say the
     database has not been migrated by a Tower of this version, and that restarting Tower fixes
     it.
  3. Test both against a stub of the old shapes: a 404, and a database at schema 19.
- **Phase 6 order** (architect): build, push, tell them when GitHub is green.
