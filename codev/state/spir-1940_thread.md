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
