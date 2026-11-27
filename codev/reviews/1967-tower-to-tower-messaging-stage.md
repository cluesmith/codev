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
- **A long agy delivery can outlast C's relay timeout (phase 6).** agy is written line by line
  (10 ms a line, `PLAIN_CHUNKED`), so a 48 KiB body of very short lines takes longer to write
  than C's 15-second relay timeout. R answers only once a pass that started has finished, so S
  can see `no-answer` for a message R went on to deliver. S then holds and retries, and the
  retry is a duplicate that reports the true state. A local send to an agy terminal has the
  same pacing. claude and codex are written as one bracketed paste and finish well inside it.
- **The frame marker is read as `###` (phase 6).** Decision 7 escapes a body line "that begins
  the frame marker" and neither spec spells the marker out. The header and the footer both
  begin with `###`, so a body line whose first character other than a space or a tab begins
  `###` gets a backslash in front of it. `#` and `##` lines are left as written.
