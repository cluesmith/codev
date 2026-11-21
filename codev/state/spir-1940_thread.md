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
