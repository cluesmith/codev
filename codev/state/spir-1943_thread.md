# spir-1943: Tower-to-Tower messaging protocol (independent second draft)

## Project
Issue #1943. This is a second spec draft written from the same brief as #1940. The brief bars reading `.builders/spir-1940/`, the `builder/spir-1940` branch, any `1940-*` spec or project file, and `codev/state/pending-decisions.md`. I honoured that: I saw only #1940's title, once, in an issue-search listing, and never opened its body. SPIR, strict mode. The design is the deliverable for now.

## Phase: SPECIFY

### What I found, verified in source
- **Grammar overload.** `parseAddress` splits on the first colon. `architect:<name>` and `<ws>:architect` have the same shape and are told apart only by intercepting the literal `architect`. `<ws>:architect:<name>` falls through to builder lookup and returns NOT_FOUND.
- **Cross-workspace provenance is already wrong on one Tower.** The frame never names the sender's workspace, so a message from marketmaker's `main` reads `ARCHITECT:main` to shannon. The builder reply hint is hard-coded to `afx send architect`.
- **Issue #1605 matters.** It is open and records a front-door-only decision ("the gap is the design"). The owner later commented that forwarding is a real cost. Goal 1 reverses #1605, so the spec answers its encapsulation and trust-ingress arguments explicitly and asks the owner to confirm (Q5).
- **The cloud is already in every connected Tower's TCB.** The tunnel client stamps the local key on every cloud-originated request, and `/api/send` is not blocked. This shaped the trust recommendation: cloud-attested identity plus enforcement on the receiving Tower, no end-to-end crypto in v1.
- **Codev Cloud facts** (codev-cloud `origin/main`, 2026-11-17; my local checkout there is stale):
  - slugs are globally unique;
  - it runs single-instance with no pub/sub;
  - authorization is owner-only;
  - there are no orgs or sharing;
  - a `ctk_` key works only on `DELETE /api/towers/:id`;
  - there is no relay or messaging feature;
  - the Tower's metadata POST targets an endpoint that does not exist, and the cloud pulls `GET /api/projects` instead.
- **The H2 tunnel cannot carry Tower-initiated requests** because of the role reversal. So the outbound leg is HTTPS with the Tower key, and the inbound leg is the tunnel.

### Recommendations in the draft
- **Grammar:** path-like, right-anchored `[[tower/]workspace/]agent`. `architect:<name>` is kept, legacy `<ws>:<agent>` is deprecated, a 4th leading segment is reserved, and `afx://` remains a possible later spelling.
- **Workspace names:** unique per Tower. Precedence is human-set, then config-pinned, then basename. A colliding workspace is left unnamed rather than auto-suffixed.
- **Trust:**
  - same-owner Towers are trusted by default;
  - other owners are default-deny, using an allow-list by verified email;
  - grants are capability records held on the receiving Tower;
  - other owners reach architects only;
  - builders never originate cross-owner sends.
- **Human in the loop:** messages from other owners are held for release by default, with `direct` as an opt-in per grant.
- **Transport:** cloud relay with a sender-side outbox, idempotent message ids, and the first outcome returned synchronously.

### Open for the owner at spec-approval
- **Critical:**
  - Q1: posture toward other owners;
  - Q2: default trust between own Towers;
  - Q3: grammar choice;
  - Q4: the cloud as identity root, and whether it may read bodies.
- **Important:** Q5–Q11, including the #1605 reversal and #655 subsumption.

### CMAP iteration 1 (codex and claude both REQUEST_CHANGES); all findings accepted
- **Attestation.**
  - The Tower could not tell forged owner-proxy headers or local callers from a real relay delivery.
  - Now: the cloud MACs each relay attestation with a per-tunnel-session secret issued in the tunnel handshake, held in memory and rotated on reconnect.
  - That makes the Tower's check real, and test 18 proves it with the cloud's stripping disabled.
- **Builder reach.**
  - Stage 1 would have let builders name every seat on the Tower.
  - Now: the generalized Spec 755 rule, under which a builder names only its own spawning architect anywhere and otherwise uses front doors. Surfaced as Q7.
- **Non-enumerating rule.** Unknown and ungranted slugs both answer `unknown-tower`. Inside a Tower that granted the sender something, the answer is a uniform `not-authorized`.
- **Email grants.** A grant binds once to a `userId` and follows that id. Account deletion voids it, and email reuse never inherits it.
- **Reply-path messages.** Delivered in the grant's mode when a grant exists, otherwise `hold`.
- **Rejected attempts.** Recorded as metadata only, in an inbound relay log. They are not mailbox rows.
- **Workspace names.** The contract is now deterministic:
  - first holder keeps the name;
  - humans never steal;
  - pins apply only when free;
  - one directory counts as one workspace (POSIX, #1870);
  - colliding workspaces at upgrade are all unnamed.
- **Delivery.**
  - Dedupe records outlive the retry window.
  - The outbox is FIFO per target agent.
  - A colon in a multi-segment address is malformed.
- **Constraints** now name `isSafeSenderId`, which excludes `/`, `architectHeaderLabel`, and the #1567 3-line/256-byte single-write bound.
- **Stage 3 human surfaces** are now success criteria.
