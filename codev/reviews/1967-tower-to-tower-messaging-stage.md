# Review: Tower-to-Tower messaging, stage 2 — the Tower half

*Started during implementation to hold findings as they are ruled on; the review phase completes
it.*

## Readings neither spec states

- **A re-registration drops the cached peer list (phase 7; architect ruling, 2026-11-27T06:36Z).**
  - **What drops it.** When this Tower's registration changes its server URL or its Tower id,
    three things are dropped before anything reads them: the cached peer list, its former names
    and the relay evidence.
  - **What keeps it.** A new key for the same Tower on the same cloud, as `afx tower connect
    --reauth` gives, keeps all three.
  - **What stays regardless.** Grants and the switch stay, because a person set them.
  - **The mechanism.** `peer_settings.listing_scope`, `forgetListingUnlessFor`, and
    `PeerList.scoped()`.
  - **The ruling.** Neither spec states this. The ruling is the architect's, not the owner's;
    the owner has been told and may overrule. The wire contract does not change, so nothing goes
    to the cloud side.
- **Discovery lists running workspaces only (phase 10; architect ruling, 2026-11-27T10:27Z).**
  - **What is listed.** `afx peer show` lists what a message could reach now: the agents of
    workspaces that are running on the peer. An agent of a running workspace with no live
    terminal is listed `not live`, because mail for it is accepted and held.
  - **What is not.** A stopped workspace is not listed. Spec 1940's address book resolves a
    name only to a running workspace, so step 13 refuses mail to a stopped one as
    `no-such-agent`. Listing it would offer an address a message cannot reach.
  - **The ruling.** Neither spec states this; Spec 1940 has a full grant show "every active
    workspace". The ruling is the architect's, not the owner's; the owner has been told and may
    overrule.
- **The receiving Tower's query limit counts answered queries only (phase 10; architect ruling,
  2026-11-27T10:27Z).**
  - **The rule.** R counts a query against its 10-a-minute limit only once it has passed the
    grant check, as a message's limit is checked after its grant. So a peer with no grant is
    refused `no-grant` every time and never reaches R's limit.
  - **What bounds such a peer.** Codev Cloud's per-pair query limit, which stands in front of R.
  - **The ruling.** Neither spec states the order. The ruling is the architect's, not the
    owner's; the owner has been told and may overrule.

## Phases closed by porch's force-advance

Porch closes a plan phase at its 3-iteration ceiling when the last round still has a
REQUEST_CHANGES. The fix for that round then gets no consult review before the next phase.

- **Phase 5 (the tunnel's peer entry point).** The iteration 3 fix, `c21f5b932`, had no consult
  round. The architect ran the codex review (APPROVE) and the claude review (COMMENT) of it
  themselves (main, 2026-11-27T03:31Z and 03:36Z), and asked for one small follow-up commit
  with no review round: `e05573ba2`.
- **Phase 7 (peer listing and the cloud client).** The iteration 3 fix, `3cd856ef1`, was not
  re-reviewed by consult. The architect read its source diff, ran the three test files it
  touches (86 passed) and found nothing to change (main, 2026-11-27T06:36Z).
- **Phase 9 (afx send across Towers).** Iteration 3's codex point was right: the CLI's 1 MiB
  guard measured each file, not the request Tower reads. The fix, `10e5fe397`, has the SDK
  measure the encoded request and refuse one past Tower's ceiling with no call
  (`REQUEST_TOO_LARGE`). It was not re-reviewed by consult. The architect read its source diff,
  ran the two test files it touches (26 and 19 passed) and found nothing to change; the
  PR-level review covers it (main, 2026-11-27T09:31Z).
- **Phase 12 (the Peers panel and the three-count indicator).** Iteration 3's codex point was
  right: a caller could mark a folder with its own pid and `exec` Playwright, keeping the pid, and
  the teardown would then remove that folder. The fix, `a38f0f2b0`, has the main process own its
  run by an in-memory record, and the teardown refuse a run it holds no record of. It was not
  re-reviewed by consult. The architect read it, checked that `removePeersDirs` removes only a
  direct child of the temp directory with the run prefix, and found nothing to change, with no
  consult round before phase 13 (main, 2026-11-27T12:54Z).

## For the real-cloud run at verify-approval

Each of these is checked here only against the stand-in or a mocked answer, and waits for the
real Codev Cloud and real Towers:

- the same Tower name on another account; the cloud's refusal of a relay request through `/t/`;
  the cloud's per-peer limit; both Towers behind NAT (the plan's four);
- a recipient's terminal that itself survived a Tower restart, receiving the mail held across it
  (layer B shows the database, `peer_outbox` and `peer_accepted` surviving, and delivery resuming
  to an agent activated again);
- the Peers panel's no-relay state, browser-checked only with a mocked answer (the architect's
  note at phase 12 close, 2026-11-27T12:54Z).

## Known residuals

- **A cloud-supplied reason can reach the status (phase 5, architect ruling 2026-11-27T03:36Z).**
  A close reason or `auth_error` reason sent by Codev Cloud reaches the tunnel's last failure, the
  Tower log and `afx tower status` after `sanitizeRemoteDetail` (up to 120 characters, so a
  43-character session secret would fit); this predates Spec 1967, only the cloud can put a secret
  there, and so it rests on the cloud's obligation never to send one, and the secret-echo check
  deliberately covers only `auth_ok`'s `towerId`, `slug` and `name`.
- **The frame marker is read as `###` (phase 6).** Decision 7 escapes a body line "that begins
  the frame marker" and neither spec spells the marker out. The header and the footer both
  begin with `###`, so a body line whose first character other than a space or a tab begins
  `###` gets a backslash in front of it. `#` and `##` lines are left as written.
- **A marker line led by a no-break space is not escaped (phase 6, claude review).** Decision 7
  escapes a line whose first character other than a space or a tab begins the marker. U+00A0 is
  not on its removal list, so a body line written as a no-break space and then `###…` keeps its
  marker and can look like a frame line. That is faithful to Decision 7 as written; widening
  the rule is a spec change.
