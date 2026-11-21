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
