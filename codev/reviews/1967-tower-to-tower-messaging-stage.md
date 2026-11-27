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
