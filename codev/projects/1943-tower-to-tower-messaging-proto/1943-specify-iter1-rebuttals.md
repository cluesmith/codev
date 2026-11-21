# Spec 1943, specify iteration 1: responses to review

Both reviewers asked for changes (codex: REQUEST_CHANGES, HIGH; claude: REQUEST_CHANGES, HIGH). Every point was accepted. None is rebutted. Each entry below says what changed in the spec, and where.

## Codex

1. **Tower existence leaked: Stage 2 used `unknown-tower`, Stage 3 required a uniform `not-authorized`.**
   - **Accepted.** Part D now has a non-enumerating rule, keyed on the sender's relationship to the Tower rather than on what exists:
     - **one of the sender's own Towers:** `unknown-tower` with the list of own Towers, or full detail inside them;
     - **another owner's Tower that granted the sender something:** a uniform `not-authorized` for any target outside the grant;
     - **any other slug, existing or not:** an identical `unknown-tower`, with no list.
   - Updated: the success criteria (Stage 3), the responsibilities table ("non-enumerating"), and tests 17 and 21. Test 21 asserts byte-identical responses for an existing ungranted slug and a non-existent one.
2. **Email grant identity was underspecified.**
   - **Accepted.** Part C, Identity, now defines the binding:
     - a pending email grant binds once, to the `userId` of the first account that presents that verified email in an attested delivery;
     - from then on it follows that `userId`;
     - an email change keeps the grant, and the frame shows the current email;
     - account deletion voids it;
     - a different account that later verifies the same email never inherits it.
   - Added: a success criterion, test 21a, a risk row, and a cloud pairing-registry duty to report deleted accounts.
3. **The reply path had no delivery mode when no grant exists.**
   - **Accepted.** A reply-path message is delivered in the receiving owner's mode for that owner: the grant's mode if a grant exists, otherwise `hold`. The reply path applies only to other owners.
   - Added: a success criterion, and test 26's held and direct cases.
4. **Rejected-message persistence conflicted with audit.**
   - **Accepted.** The audit table now separates:
     - **the mailbox row:** accepted messages only, delivered or held;
     - **a new inbound relay log on the receiving Tower:** every attempt, rejected ones included, as metadata only (no body). The target as written stays local and is never echoed to the sender.
   - The `rejected` outcome now reads "nowhere deliverable; recorded only as metadata in the relay logs".
   - Added: an assertion in test 21.
5. **Workspace collision behaviour was not deterministic.**
   - **Accepted.** "Workspace and Tower names" now states a six-rule contract:
     1. assignment is persistent;
     2. the first holder keeps an automatic name, and a later registrant is unnamed with the holder named in the error;
     3. a human-set name never steals;
     4. a pin re-applies only if its name is free;
     5. rows that resolve to the same directory are one workspace;
     6. colliding workspaces at upgrade are all unnamed (they are `AMBIGUOUS` today).

     Registering a new workspace never invalidates an existing workspace's address.
   - Test 4 was rewritten to cover registration-time collision, upgrade-time collision, no-steal, precedence and pins, and same-directory spellings.
6. **Relay attestation was described inaccurately.**
   - **Accepted.** I took the stronger of the two options: an unforgeable binding.
     - The cloud MACs each relay attestation (origin Tower, user, email, message id, timestamp, body hash) with a per-tunnel-session secret. The cloud issues that secret in the tunnel handshake, it is held in memory only, and it rotates on reconnect.
     - The proxy marker alone is no longer trusted, because a local caller can set any header.
   - The guarantee is now scoped explicitly. It defends against owner-proxy traffic, local callers and replays. It does not defend against a malicious cloud, which is in the trusted computing base (Q4).
   - Updated: R1, "Provenance and spoofing" item 3, the responsibilities table, cloud work item 2 (new), a success criterion, and test 18.

## Claude

1. **(Must fix) The Tower could not independently verify cloud attestation.**
   - **Accepted, with the reviewer's suggested fix:** cloud-signed attestation that is one-way, not R2's pairwise keypairs.
   - I used a per-tunnel-session MAC secret issued in the handshake rather than a JWKS. It needs no key distribution, and a browser or local caller never holds it. The cloud stores only a bcrypt hash of the `ctk_` key, so it could not key a MAC with that.
   - Test 18 now proves the Tower's check stands alone: forged headers through the owner proxy are refused with the cloud's stripping *disabled*. Previous-session secrets and replays are covered too.
   - The risk row's mitigation now names the MAC as the Tower's independent check.
2. **(Must fix) Stage 1 silently widened builders' reach to every named seat.**
   - **Accepted. Surfaced, and recommended against.** The builder rule now generalizes Spec 755: in every position (unqualified, own workspace, other workspace, Tower-qualified) a builder may *name* only its own spawning architect. Otherwise it reaches front doors. That is today's reach, unchanged.
   - Q7 is now "Builder reach". It covers this point, the alternative (let builders name any seat on own Towers), and why the per-workspace opt-out is no substitute.
   - Updated: Desired State, the success criteria, the resolution table, "Answering #1605", the authorization matrix, the summary table, test 3, and a risk row.
   - **Consequence handled:** reply hints are now "the shortest address the recipient is permitted to use". When none reaches the sender, the hint says to reply through the recipient's own architect. Test 7 covers both cases.
3. **POSIX self-collision.**
   - **Accepted.** Naming rule 5 treats rows that resolve to the same real directory as one workspace. The Constraints section states that `workspaceKey()` is as-given on POSIX (#1870, verified open), so full path-independence on POSIX depends on #1870.
   - Added: test 4's same-directory case and a risk row.
4. **Dedupe retention must outlive the retry window.**
   - **Accepted.** Dedupe records are kept strictly longer than the longest retry window, and the window is bounded by that retention.
   - Added: a success criterion and test 20a.
5. **No ordering invariant for the outbox.**
   - **Accepted.** FIFO per target agent, and no guarantee across targets.
   - Added: a success criterion, test 20b and a risk row.
6. **Mixed-grammar addresses were undefined.**
   - **Accepted.** The legacy colon form is honoured only in a 1-segment address. In a multi-segment address a colon is valid only as the `architect:<name>` agent segment, and anything else is malformed, with a purposeful error.
   - Added: a success criterion and test 1's mixed-grammar cases.
7. **Existing frame contracts were not named.**
   - **Accepted.** Constraints now names three:
     - `isSafeSenderId` excludes `/`;
     - `architectHeaderLabel` recognizes only senders beginning with `architect:`;
     - #1567 bounds a single-write frame to 3 lines and 256 bytes.
   - The #1567 bound is also a stage 1 success criterion and part of test 7.
8. **The stage 3 human surface was missing from the success criteria.**
   - **Accepted.** A criterion now requires grant create, list and revoke; a reachable-peers list; and seeing, reading, releasing and dismissing messages held for release, all without editing files or the database.
   - Test 23 exercises it.
