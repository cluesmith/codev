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
