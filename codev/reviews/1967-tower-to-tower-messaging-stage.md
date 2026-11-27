# Review: Tower-to-Tower messaging, stage 2 — the Tower half

*Started during implementation to hold findings as they are ruled on; the review phase completes
it.*

## Known residuals

- **A cloud-supplied reason can reach the status (phase 5, architect ruling 2026-11-27T03:36Z).**
  A close reason or `auth_error` reason sent by Codev Cloud reaches the tunnel's last failure, the
  Tower log and `afx tower status` after `sanitizeRemoteDetail` (up to 120 characters, so a
  43-character session secret would fit); this predates Spec 1967, only the cloud can put a secret
  there, and so it rests on the cloud's obligation never to send one, and the secret-echo check
  deliberately covers only `auth_ok`'s `towerId`, `slug` and `name`.
