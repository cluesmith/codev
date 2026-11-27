# spir-1967 thread — Tower-to-Tower messaging, stage 2 (Tower half)

## 2026-11-25 — specify

- Spawned strict SPIR. Issue #1967 has no Baked Decisions section; the approved spec 1940 is the
  design. Architect's instruction (20:41Z): short spec pointing at 1940, boundary (Tower half only;
  cloud half is codev-cloud#22; #1871 by bugfix-1871), criteria sorted stand-in vs real cloud, and a
  standalone CONCRETE WIRE CONTRACT section the architect forwards to the cloud's architect.
  Anything wrong in 1940 goes under its own heading.
- Second instruction (20:46Z): fold in the cloud architect's answers (codev-cloud#22 comment
  7174155361), items (a)–(h), and list where they CHANGE 1940.
- Read in source (codev-cloud `origin/main` db41983, read-only): `auth_ok` already carries
  `{towerId, slug, name}`; slugs globally unique (`tower_slug_unique`); `/t/<slug>/X` forwards path
  `/X` down the tunnel with browser headers; only `DELETE /api/towers/:id` takes a `ctk_` key.
  Tower side: tunnel client intercepts `/__tower/metadata` in-process, proxies the rest to the local
  listener with the local key; mailbox `status`/`reason` have CHECK constraints (table rebuild needed
  for new held states).
- Design choices written into the spec (all marked as proposals for the gate):
  - Entry point `POST /__tower/peer` answered INSIDE the tunnel client (never on the local
    listener); secret lives in per-session tunnel state only.
  - Relay call `POST /api/peer/relay`, routing in `x-codev-peer-*` headers, payload bytes opaque to
    the cloud; statement = exact bytes, base64url, HMAC over those bytes.
  - Caps: payload 102400 (2×48 KiB + 4 KiB, S pre-strips controls so escapes cost ≤2 bytes),
    answer 65536; relay timeout 15 s; R answers within 5 s.
- Found in 1940 and listed as departures: statement-id memory must be 10 min not 5 (±5 window);
  rate-limited refusals would strand a 50-message backlog at 30/min per pair (C4: held mail retries);
  D5/D6 disagree on discovery without a grant for own Towers; front-door-only was cut in stage 1;
  future `sentAt` would extend the lifetime; metadata push is dead (#1986) — stage 2 removes it.
- Review round 1 (codex, claude): both REQUEST_CHANGES; all points taken. Codex: records must be
  what each party can see (R records unverified requests against the session); full answer bodies
  for both sources; criterion 8 serialises message calls only. Claude: TLS required for the secret
  (an `http:` server_url becomes `ws:` today — loopback-only exception for the stand-in); address
  union incl. `kind:"id"` builders; sizes/timeouts pinned as protocol-v1 constants (R can't learn
  them from a listing it never fetched); `requestId` and statement fields validated before reaching
  a frame; builder rule on remote addresses now has criteria/tests; 503 retry is unconditional
  back-off; R answers `held busy` rather than block past 5 s; a run of 5 not-verified surfaces the
  peer as "not verifying"; Decision 9's remaining stage-2 surface (Peers panel, inbox show, status
  lines, 3-count indicator) explicitly in scope.
- Spec gate requested (decision main-55 with the owner). While it is pending the architect asked for
  a revision (21:09Z, 21:11Z) folding in three reviews: the cloud architect's review of contract
  revision 1 (codev-cloud#22 comment 7174678201, points [r1]–[r18]), codex round 2 and claude round 2
  (both COMMENT). Contract is now revision 2:
  - Tower's name in the protocol is the SLUG (`self.slug`, `towers[].slug`, statement
    `fromTowerSlug`); `auth_ok.name` is display-only and never used.
  - HTTP 200 only and always means R decided; S reads the source from the status (the `source` field
    is gone). C checks status, content type, size and the outcome header only; S validates the shape.
  - 503 (no live session, hold) before 409 (session without the version, refuse); stream death →
    504; Content-Encoding and self-addressed `x-codev-peer-to` → 400; once a relay was stated, a
    bodyless 401/403/404/429/5xx holds.
  - Exact rules for every statement and payload field (type, encoding, length, bounds); literal-UTF-8
    serialisation pinned (an escaping serialiser would push a 48 KiB emoji body over the cap).
  - S's refusal precedence listed; "how S resolves its row" table (`delivered` and `held` at R both
    end it accepted; `duplicate:true` resolves as the state it reports).
  - Rate-limited held mail stays held for EITHER source (codex/claude both caught that R's own 30/min
    would still strand messages 31–50); R sends `retryAfterSec`.
  - Wrong-clock surface (G12) mirroring G10; statement-id memory scoped to the session.
  - Shared vectors: `packages/types/fixtures/peer-contract-vectors.json`, format given, one worked
    case computed now (Node and Python agree on the MAC); full set ships with the first phase.
  - Cloud costs K1–K6 listed as departures (flood counts lost on deploy, rows written after the
    answer, bad-key limit out of the contract, protocols/switch stored, PUT retried 3×, approximate
    fixed-window limits).
  - New constraint: the plan sorts scenarios into porch's tests check vs on-demand and makes the
    two-Tower + stand-in harness its own phase; injected clocks only. No new dev dependency for the
    property test (seeded generator of our own).
  - OQ1 now states the cost if codev-cloud#22 slips (PR merged and inert, builder stopped, parked at
    verify-approval, resume with `afx spawn 1967 --resume`; the worktree in the meantime is the
    owner's call).
- Cloud architect confirmed revision 2 (codev-cloud#22 comment 7174920555; vector reproduces there).
  Revision 3 takes their four corrections and one suggestion: C's ten-step order of checks as a
  table in section 4 (401 before header validation, so a keyless caller learns nothing); per-pair
  counters only after the recipient check, so `unknown-tower` cannot grow them, and an invalid kind
  counts as a message; the email rule's excluded code points written out in the contract (Decision
  7's list plus tab, LF, U+2028, U+2029); media-type-only check of R's answer; a run of
  `500 cloud-error` shown like not-verified (G15).

## 2026-11-25 — plan

- spec-approval approved by the owner (main-55, 23:41Z, relayed by the architect); ran `porch
  approve` myself. The owner adopted C1–C14, G1–G15, K1–K6, the accepted-once ordering and OQ1
  (merge when the stand-in criteria pass, feature inert; verify-approval waits for a human run
  through the real cloud).
- Plan: 11 phases. Key choices: one contract module (`peer/contract.ts`; shapes and constants in
  codev-types); the stand-in relay never imports it (no mirrored misreading); no mailbox rebuild —
  additive no-CHECK columns (v18 precedent) for arrived remote mail incl. `release_hold`, and
  sender-held mail in its own `peer_outbox` table so the local drainer can't see it; test layers:
  porch's check runs `*.test.ts` only (unit + in-process stand-in/pipeline on injected clocks),
  two-Tower e2e / Playwright / Windows on demand. Harness is phase 2; vectors ship in phase 1;
  migration tested on a backup-API copy of a real global.db in phase 3; Playwright in phase 10.
- Plan review round 1: codex REQUEST_CHANGES (4), claude COMMENT (7); all taken after checking each
  against the tree. Notable: the default Playwright config reuses port 4100 (new isolated
  `playwright.peers.config.ts`); `startTower` can't pre-write cloud-config (harness spawns directly,
  bugfix-1515 pattern, throwaway HOME); no persisted "deregistered" marker on main (`not-registered`
  works from the cloud's 401; the marker half waits for #1871); held counts are computed in
  `servers/overview.ts`. Sending split (outbox/in-process vs end to end) and discovery made its own
  phase: 13 phases now.
- Contract revision 4 (architect relay, cloud correction; committed alone as 68cff8fe4): a ceiling of
  600 calls/min per Tower across all /api/peer routes, checked at C's step 4 (made-up query
  recipients were otherwise unlimited); query 429 refused and never held, message 429 like any 429;
  "C never answers 200" is about the relay call only; bad PUT body → 400 malformed.
- Plan review round 2: codex REQUEST_CHANGES (3), claude COMMENT (5); all taken. Notable:
  `pruneTerminal` can delete a delivered remote row before the 30-day accepted-once window ends, so
  `peer_accepted` now carries the message's state itself, updated in the same transaction as the
  mailbox row; the peers Playwright config creates and removes its own temp dirs and refuses live
  paths; the 1313 held-count suite stays in the default run (it is route-mocked); grant mode flags
  `--deliver|--hold` named; peer record/outbox prune (never under 30 days).
- Plan review round 3: codex REQUEST_CHANGES (2), claude REQUEST_CHANGES (2 + 6 minor); all taken.
  Notable: the first mailbox insert and the accepted-once insert are one transaction (PK decides a
  race); a tunnel-client audit hook gives the record and the clock surface every request that dies
  at steps 1–8; `dismissHeldForAgent` (afx cleanup) is set-based, so the accepted-once mirror covers
  set-based writers too; the Windows three-shell `afx://` check had no home (windows.yml is all
  bash) — phase 5 adds `windows-probe.mjs --argv` and bash/pwsh/cmd steps.
- Plan gate (2026-11-26): the owner ruled main-58 "approve" — the thirteen-phase plan as it is, no
  lean cuts; the delivery-time grant check discussed with the architect is not adopted. Merged
  origin/main (d84036762, #1871's fix) — merge, never rebase. Applied the architect's six
  corrections from fresh codex/claude reviews (plan 1301 → 1355 lines): the peer_accepted mirror
  names every mailbox writer and covers reason and release_hold changes (setHeldVerdict); a
  KeyedSerializer.runWithin deadline for the receiver's 5 s answer; the extended held-count
  Playwright suite runs only through the isolated peers config; the release_hold exclusion names
  its queries (listHeld must keep returning held-for-release rows) and the grep exempts
  schema/migrations; the two-Tower harness reuses startTower via extraEnv; not-registered reads
  #1871's deregistered_at.
- Phase 1 (implement, after a context refresh at the plan gate): `peer-wire.ts` in codev-types
  (shapes + the v1 constants, no runtime deps), `peer/contract.ts` (the one module), the shared
  vectors `packages/types/fixtures/peer-contract-vectors.json` (140 cases), and two test files.
  - Vectors generated by a scratch Node script using node:crypto only (not contract.ts). Every
    case's HMAC-SHA-256 and SHA-256 cross-checked once in Python (`python3 -I`, stdlib only, from
    the scratchpad, not committed): Python and Node agree on all 140; the worked case matches
    section 11 byte for byte (433-byte statement, 578 chars, MAC FepqsX…kiMQ, hash 25d8ef53…0be3).
  - Readings I took where the contract is silent (flag to the cloud with the vectors):
    a duplicate key in the statement is step 4 (`not-verified`), not step 3; statement bytes that
    are not a JSON object at all (not UTF-8, BOM, array, not JSON) are step 3 `unsupported-version`,
    as the step's "Otherwise" reads literally; base64url is strict (no padding, no `+`/`/`,
    canonical trailing bits) so a padded MAC is `not-verified`; both freshness windows are
    inclusive (±300 000 ms passes, ±300 001 does not; sentAt exactly 30 days old passes);
    "JSON integer" is the parsed value (Number.isSafeInteger), as JSON Schema reads it.
  - S's side: a non-200 whose body does not fit its status's row in section 6 is "an answer without
    the body"; C's answers carrying 200-only fields (detail, duplicate) have them dropped, not
    rejected (the status decides). A discovery answer leaves out any address that fails section 4,
    so one odd workspace name cannot make S refuse the whole answer.
  - Payload duplicate keys are `malformed` at R (the spec says "parses as the kind's schema").
  - Gotcha: the Write tool, and Bash heredocs, turn a typed backslash-u-2028 escape into the literal
    character U+2028 (a JS syntax hazard in a regex, and it breaks consult's codex event parser).
    Fixed in contract.ts; tests build such characters with String.fromCodePoint.
- Phase 1 landed at acaf1f178; the architect re-verified the 45 verified vectors in Python and posted
  the file to codev-cloud #22. The cloud reads none of the five readings differently. Two
  clarifications folded in (no behaviour change, no revision number, per the architect): the spec
  now says "integer" is judged on the parsed value, and that an unpaired surrogate in
  fromOwnerEmail is not-verified; the vectors gain two cases (v as 1.0, issuedAt as 1.7641e12, both
  verified) appended after the unchanged 140. Python cross-check rerun on all 142: agrees.
  For phase 8: the cloud notes that a statement that is not a JSON object at all ends a send as
  refused (unsupported-version), not held.
- Phase 1 review, iteration 1: claude APPROVE (HIGH); codex REQUEST_CHANGES (2). The first codex
  run crashed twice on a literal line-separator character in this thread (consult bug #1818);
  fixed at 519d01159 and rerun. Taken: an answer's detail over 500 characters (code points) is now
  tower-error at S, as section 6's shape says; claude's polish (reason-linked fields read only with
  the accepted reason; R's unsupported-version refusal requires supported). Rebutted, and put to
  the architect: statementId stays a 22-character shape check, not a canonical-16-bytes decode
  (R never decodes it; the cloud agreed the vectors as they are; tightening flips six cases).
- Architect ruling (2026-11-26T22:52Z) on codex point 1: the rebuttal stands, statementId keeps the
  shape check. Folded in: a contract sentence (strict base64url applies to what R decodes: the
  statement header, the MAC, the session secret; statementId is shape-only and its canonical
  16-byte form, randomness and freshness are C's), and the five verified vectors that rely on it
  renamed to say so (names only; bytes and verdicts unchanged). Correction to my earlier count:
  five cases depend on the reading, not six; three more have non-canonical ids but step 1 or 4
  decides them first. If codex raises the point again: to the architect, not a third round.
- Phase 1 review, iteration 2: codex COMMENT (HIGH), claude APPROVE (HIGH); statementId not
  raised again. Taken as polish: R's rate-limited refusal is its own ReceiverAnswer variant (only
  it may carry retryAfterSec; codex); the statement-header cap is measured in UTF-8 bytes; a
  discovery answer says truncated only when an address was left out (budget against the
  untruncated envelope; tested at exactly 65 536 and 65 537); the vectors test asserts every
  case's statementId is unique (the file's comment promises it and the cloud relies on it).
  For phases 6 and 10 (claude): encodeAnswerJson throws above 65 536 bytes; R's answer path must
  catch that and answer, not kill the stream.

## 2026-11-26 — phase 2: stand-in relay and two-Tower harness

- After a context refresh at the phase boundary. Files: `__tests__/helpers/stand-in-relay.ts`,
  `helpers/two-towers.ts`, `helpers/seeded-generator.ts`, and three tests:
  `stand-in-relay.test.ts` (49, layer A), `seeded-generator.test.ts` (5, layer A; not in the
  plan's file list, added so the generator is tested on its own), `two-towers-harness.e2e.test.ts`
  (4, layer B).
- The stand-in imports only `codev-types` shapes and constants plus `node:crypto`, `ws`, `http2`;
  a structural test checks it imports nothing of `peer/contract.ts` or any production peer module.
  As the issuing side it rebuilds 42 of the 47 verified vectors byte for byte, MAC included (the
  other five are serialised as C does not write: keys reversed, an unknown field, `1.0`, …), and
  its own field rules refuse all 73 step-4 cases (duplicate-key cases left out: JSON.parse hides
  them). One cross-check uses contract.ts: a statement the stand-in issues verifies there.
- Readings the stand-in takes where the contract leaves order open (in its header comment):
  within step 2, malformed before unsupported-version; a missing version header is
  unsupported-version, a missing `to` is malformed; on `PUT /api/peer/state` a bad body (400)
  before the limits, as the relay checks headers before limits. Left out on purpose: the `/t/`
  proxy (`tunnelRequest` sends any request down a tunnel, which is what a failed second barrier
  looks like at R) and a bad-key rate limit (C's number, [r16]).
- Faults: `setOffline`, `answer-late` (forward reaches R, S told 504), `reset-stream`, `deploy()`,
  modes `absent`/`null`, `bodyless` (never 200), `setStatesNoVersion`, `writeRecordUnchecked`
  (→ 500 cloud-error), `wrong-secret`, `replay-statement`, `answer-delay` (to see calls in
  flight). Originated forwards: `forward()`, `replay()`, `tunnelRequest()`.
- Layer B, on demand (load average 2.4–2.9 each time), three runs:
  1. 3/4: my restart test asked `/api/status` whether the workspace ran; that route leaves out
     workspaces under the temp directory. Switched to the address book (the CLI's own view).
  2. 3/4: after the restart the architect never came back. Tower's design, not a harness bug:
     on startup reconcile SIGTERMs the shellpers of temp-directory workspaces and deletes their
     rows (`isTemporaryWorkspace`, servers/tower-terminals.ts). The restart test now checks what
     persists (held mail in the same database, same port, same cloud identity, a new session
     secret) and re-activates the workspace to get its architect back.
     **For phase 9:** after `HarnessTower.restart()`, activate workspaces again before expecting
     a recipient agent; the database (and so peer_outbox / peer_accepted) is what survives.
  3. 4/4 in 12.8 s. Teardown report empty: no Tower process, no shellper, no directory, the
     stand-in's port closed.
- Porch's exact tests command (`npm test -- --exclude='**/e2e/**'` in packages/codev), run once
  with the e2e file in place: 463 passed, 14 skipped (477 files), 10 297 tests, exit 0. Its
  reporter does not print passing files, so I listed what the same config collects
  (`vitest list --filesOnly --exclude='**/e2e/**'`): 477 files, including stand-in-relay.test.ts
  and seeded-generator.test.ts, and not two-towers-harness.e2e.test.ts. Build check passed.

## 2026-11-26 — phase 2 review, iteration 1

- Codex REQUEST_CHANGES (1), Claude APPROVE with 5 minor points. Rebuttal:
  `codev/projects/1967-tower-to-tower-messaging-stage/1967-phase_2-iter1-rebuttals.md`.
- Disputed (codex): `PUT /api/peer/state` with an unknown field. Not changed: section 0 says
  receivers ignore fields they do not know, everywhere; "a body that is not this object" is a
  body without `remoteMessaging` as "on"/"off", and all of those are already 400 in the test.
  A comment at the check and the test's name now say so.
- Accepted (claude), all five: unchecked record writes are per Tower (`ownerOverride`, only the
  statements that Tower sends) with `restoreRecord`; a test for `rotateKey` closing the session
  [r5]; `replay-statement` keyed per pair; `forward.answer` kept on the 502 path; wall time.
  **For phase 8:** break one direction of a pair with `writeRecordUnchecked(<sender>, …)`; the
  other direction stays healthy. Undo with `restoreRecord`.
- Wall time, layer A files of this phase: stand-in-relay.test.ts + seeded-generator.test.ts,
  57 tests, about 1.4 s (three repeat runs of the stand-in file: 1.41–1.43 s each).
- Architect ruling (main, 2026-11-26T23:46Z), recorded here and in the plan:
  1. A red on-demand run in a test this phase is writing may be diagnosed, fixed and rerun, then
     reported with the phase; one in an earlier phase's test, or one whose cause I have not found,
     goes to the architect BEFORE any rerun. (Phase 2's runs 1 and 2 were within this.)
  2. The restart limit is written into the plan (phase 2 harness text and a "waits for real
     Towers" row of the scenario table): layer B shows the database, `peer_outbox` and
     `peer_accepted` surviving a restart and delivery resuming to an agent activated again, not
     mail reaching a terminal that itself survived; that waits for the real-Tower walkthrough at
     verify-approval. Harness workspaces stay in the temp directory.
  3. `seeded-generator.test.ts` outside the plan's file list is fine.
- Layer B rerun after these changes (load 1.7): 4/4 in 12.9 s, teardown report empty.

## 2026-11-26 — phase 2 review, iteration 2

- Codex REQUEST_CHANGES (1, new; the unknown-field point was not raised again). Claude APPROVE,
  agreeing with the iteration 1 rebuttal from the spec text. Response:
  `1967-phase_2-iter2-rebuttals.md`; nothing disputed.
- Accepted (codex): the stand-in read `PUT /api/peer/state` with a 4 096-byte cap of its own
  invention; the contract sets no size for that body. Now read whole; a test sends a 20 000-char
  unknown field and gets 204.
- Claude's minor points: empty `to` added to the stand-in's listed readings; `answer-delay`
  documented as not counting against the relay timeout (**phases 8/9:** a forward held past the
  timeout uses `answer-late` or a short `relayTimeoutMs`); `inFlight` documented as counting from
  authentication, bad headers included (**phases 8/9:** scope "never two in flight" to the calls
  that matter); the tower-offline re-check moved before forward faults are taken, so a one-time
  fault is never spent on a 503. Left as is: the state route's count-before-400 order, no
  CONNECT protocol on the stand-in's H2 client, per-account slugs.
- Layer B rerun after these changes: 4/4 in 12.8 s.

## 2026-11-26 — phase 2 review, iteration 3: both APPROVE

- Codex APPROVE, no issues. Claude APPROVE, two minor helper points, both taken as polish
  before the phase advances (as phase 1 did): a fault is now taken only on a call it can change
  (`replay-statement` needs an earlier statement for the pair, so `wrong-secret` still applies
  when it waits; of `answer-late`/`reset-stream`/`answer-delay` only the first that applies is
  taken), and `resetInFlight()` restarts the per-pair maximum. **For phases 8/9:** call
  `resetInFlight()` before the part of a test whose concurrency you assert.
- Layer A: 58 tests, about 1.8 s, three runs green.

## 2026-11-26 — phase 3: peer storage and the mailbox migration

- Re-entered after a context refresh at the phase boundary; merged `origin/main` first
  (`da3ca92ca`, nothing under `db/`), so v21 is the next free migration number.
- **Migration v21**, additive, one transaction (a failure inside it leaves no column, no table,
  no marker; a test injects one with a view where `peer_tower_names` belongs). `mailbox` gains
  `remote_tower_id`, `remote_message_id`, `remote_sender` (JSON, validated through a new
  `readWireSenderAddress` in `contract.ts`), `remote_owner_email`, `release_hold`. New tables come
  from one text, `PEER_SCHEMA`, which `GLOBAL_SCHEMA` embeds and v21 executes.
- **Choices the plan left open**, recorded for later phases:
  - No CHECK on any enumerated value in the new tables either (v18's reason: stage 3 would
    need a rebuild to add one); `peer/store.ts` enforces each set and throws on an unknown stored
    value. Reasons in the record and the outbox are held to their shape (lower-case words and
    hyphens), since phase 8's own refusal reasons are not listed yet.
  - Grant scopes are `front-door`, `architect`, `architects` (every architect of a workspace),
    `all`; modes `deliver`, `hold`. Key is (peer, workspace, scope, architect) with `''` for
    "none" in the two key columns; the store maps it to `null`.
  - `peer_settings` is one row; no row reads as off. It also carries the cached listing's own
    fields (refreshed-at, the relay it stated, the cloud's limits), so **phase 7** has the "has
    this cloud stated a relay" memory across a restart if it wants it.
  - `peer_outbox.seq` is acceptance order; `to_address` is stored for `afx inbox` and the
    record without parsing the payload.
  - ~~Remote rows need a non-null initial reason; phase 6 passes `busy`.~~ **Superseded in
    review round 1 (below): phase 6 inserts with `reason: null`;** a duplicate is told `busy`
    from `peer_accepted` until the first gate attempt sets the real reason.
  - The mirror is derived from the row's post-image (`UPDATE … RETURNING`), so the mapping lives
    in one place (`acceptedStateOf` via `reportedReason`), and the mirror statement is guarded
    (`state IS NOT ? OR reason IS NOT ?`), so a detail-only move or a no-op rewrites nothing.
  - A mailbox row can outlive its accepted-once row (held past the 30-day expiry); the mirror
    then skips it, and a retry is refused `expired` at step 12.
  - `markDelivered` clears `release_hold` rather than refusing: a row moved to held for release
    while its write was already under way reached the terminal, and must not deliver twice.
  - `holdForRelease` acts on remote rows only.
  - `enqueueRemote` (accepted-once insert first, then the mailbox row, one transaction; a PK
    conflict writes nothing and returns the existing row) and `duplicateAnswer` (state to
    answer) are in place now so the writers can be tested on real remote rows; **phase 6**
    adds the failure-injection and concurrency tests around them.
  - The inbox list and show routes now report `reportedReason`, so a held-for-release row reads
    `held-for-release` there; phase 11 adds the groups.
  - Not touched: `db/canonicalize-workspace-paths.ts` (Windows boot re-keying). The new tables'
    writers store canonical keys from the start; no peer row predates this.
- **For phase 11:** a released row's escalation and starvation clocks start at `created_at`, so a
  row held for release for days escalates (visibility only) as soon as it is released and still
  stuck. Worth deciding when release lands.
- **Copy check (on demand)**, my `~/.agent-farm/global.db` copied with the backup API into the
  scratch directory, migrated, compared, deleted: v20 to v21; 26 163 mailbox rows before and
  after; 8 held rows before and after, all `no-live-pty` without `detail` or `not_before` (the only
  held kind present), unchanged and all 8 returned by the drainer's query; second run logged
  nothing; switch off with no row, no grant. Every reason, detail and `not_before` combination
  is covered by the automated test instead. The 10 tables the migrations own in that copy match
  the v20 fixture exactly (columns, types, defaults, indexes, triggers); the copy also has two
  tables no migration creates (`port_allocations` from pre-Spec-0098 installs, `_consolidation`
  from the #1118 boot step), which v21 does not touch.
- Fixture: `__tests__/fixtures/global-db/v20-upgraded-schema.sql`, generated once by running the
  v20 runner on a v1 database and dumping `sqlite_master`.
- Existing tests updated for the new version: `send-architect-identity.test.ts` (version pin
  20 to 21) and `spec-1313-migration.test.ts` (the v15 column list now includes v21's columns).

### Phase 3, review round 1 (codex REQUEST_CHANGES, claude APPROVE)

All three codex points were right; fixed:
- **Held for release reports no gate detail.** `reportedDetail` sits next to `reportedReason`,
  and the inbox list and show routes use both, so a row that was `busy:user-text` reads
  `held-for-release` alone while held and `busy:user-text` again once released (route-level
  test in `inbox-routes.test.ts`).
- **An answer that resolves an outbox row replaces the last pair, a null reason included**
  (`resolveOutbox` no longer COALESCEs). A resolution no answer made (dismissal, expiry) keeps
  the last answer's pair, and may not carry a reason of its own.
- **Back to the plan's representation:** mail held for release is stored `reason = NULL,
  release_hold = 1` (`enqueueRemote` refuses a reason with `releaseHold`), and
  `RemoteEnqueueInput.reason` is nullable again. What a duplicate is told for a held row with no
  gate verdict yet (accepted and not attempted, or released and not attempted) is `busy`, the
  contract's answer for an accepted message whose write has not started; the mailbox keeps the
  NULL. This replaces my earlier "phase 6 passes busy at insert" note: **phase 6 inserts with
  `reason: null`** and the first gate attempt sets the reason.
From claude's notes: `checkedState` now refuses `held` without a reason on write and on read
(so a bad row fails where it is written); `payloadSize` has its own non-negative-integer check.
Handoffs kept for later: **phase 7** normalises the cloud listing before `writeListing` (the
store throws on an unknown switch state or a non-integer protocol, so raw cloud JSON would fail
a whole refresh); **phase 12** re-checks that the dashboard badge (which excludes held-for-release
rows) and its popover list (which includes them) agree once phases 11 and 12 land.
Layer A wall time is in the phase 3 commit: 45 tests, 1.36 to 1.50 s over three runs; now 51.

### Phase 3, review round 2 (codex APPROVE, claude APPROVE)

Both approved. Claude's three minor notes were cheap, so I took them before advancing:
`dismissHeldWithKey` and `supersede` now say `AND remote_tower_id IS NULL` in SQL (and the
first no longer sets `release_hold`, which a local row never carries), `release()` says
`AND remote_tower_id IS NOT NULL` like `holdForRelease()`, and the superseded phase 6 note
above is struck through. A test breaks both invariants by hand and finds neither row reached.

## 2026-11-27 — phase 4: the remote-messaging switch and grants

- Re-entered after a context refresh at the phase boundary. Files: `peer/grants.ts` (matcher,
  grant-request checks, tower-ref resolution), `peer/switch.ts`, `servers/peer-routes.ts`
  (wired from `tower-routes.ts` by the `/api/peer/` prefix, after the key check),
  `commands/peer.ts` + `cli.ts`, `peer` settings in `lib/config.ts` (`resolvePeerSettings`),
  the drainer's prune pass now also runs `prunePeerStorage` with `peer.recordRetentionDays`,
  SDK client calls + codev-types request/response types, and `parseTowerRef` in the one shared
  address parser (`tower-ref = [owner "@"] tower`, same owner/Tower rules as an `afx://`
  authority; phases 7/8/11 need it for `peer show`/`peer log --peer`).
- **Readings I took where the plan and spec are silent** (flag at review):
  - **Overlapping grants: hold wins.** If several grants cover a recipient, the mail is held for
    release if any of them holds it. Avoids defining which of front-door / named architect is
    "more specific"; one grant can keep mail out of a prompt, none can let in what another
    holds. `afx peer grants` prints the rule when one Tower has both modes.
  - **Grant addresses must name the workspace** (`codev:architect:local`, not
    `architect:local`), and only architects: a builder/shell address is refused pointing at
    `--all` (Decision 4's four scopes have no single-builder grant).
  - **A grant may name a registered workspace that is not running** (Decision 4 says
    "registered"): the lookup is `findWorkspaceByAddressName` with every registered workspace
    counted as running. Architect existence = a row in the registry (`architect` table).
  - **The matcher reads the world at the moment of asking**: an architect-naming scope covers
    only an architect registered in its workspace now, so an architect grant stops matching
    when it is removed and applies again when the name returns (in the matcher itself, not
    only via step 13's no-such-agent). `--all` covers whatever resolved, a shell excepted.
  - **Tower-refs resolve from the cached listing only** (phase 7 fetches it). `grant` takes a
    current name only; a former name is refused naming the current one. `revoke` and
    `grants <tower>` also accept a former name, so grants to a renamed or vanished Tower can
    still be listed and removed. `owner@tower` is NOT_AVAILABLE (stage 3); this Tower's own
    name (cloud-config `tower_name`) or id is NOT_A_PEER.
  - **Human flag enforced twice**: the CLI refuses before calling Tower, and the route
    refuses without `humanApproved: true`. **Added, not in the plan:** `on` and `grant` are
    refused (403 NOT_OVER_TUNNEL) when the request carries the tunnel marker
    `x-codev-tunnel-proxy`, the precedent being `/api/ide/session`. Off and revoke are allowed
    through the tunnel (they only narrow).
  - `afx peer revoke <tower>` with no recipients removes every grant for the peer; `--all`
    there means the `--all` grant only. Revoking what does not exist is a 404, exits non-zero.
  - Config: a malformed `peer.*` value throws naming the key; `afx peer limits` reports it
    (500 CONFIG_INVALID); the drainer falls back to 30 days as it does for the mailbox's own
    retention. Retention below 30 is used as 30 by the resolver and again by the store.
- **For phase 6:** use `matchGrant(listGrants(db, peer), peer, recipient, world)`; `null` is
  `no-grant`, `mode: 'hold'` stores `release_hold = 1`. Withdrawal on switch-off / revoke is
  still phase 6's drainer re-check (as planned); note that a lazy re-check means a row that was
  accepted, then the switch went off and back on before the drainer passed, would deliver.
  Decision 4 says such mail "stays so when the switch is turned on again"; phase 6 should
  decide whether `setSwitch`/revoke move rows eagerly (cheap: `holdForRelease` per row).
  - **Grant recipients carrying a control character are refused** (INVALID_PARAMS) before any
    lookup. Local address parts are deliberately lenient (Spec 1940), so without this a
    refusal could quote ESC sequences back to the CLI's terminal; text that fails to parse is
    quoted printable-ASCII and cut short, the shared parser's rule.
- **For phase 7:** `resolvePeerTower` is the seam for "a send to a name it does not know"
  refreshing the listing; `setSwitch` returns `changed` for the switch-state report.
  `store.writeListing` checks a listed slug only for being non-empty, and `afx peer grants`
  prints listed slugs: the listing fetch should hold each slug (and `self.slug`) to the
  Tower-name rule (`parseTowerRef`) before caching it.
- Layer A wall time: 0.9 s for the three new codev files (80 tests), 0.19 s for the SDK's
  address + peer-client files (188 tests), three runs each. Full `npm test` (porch's
  command): 467 files, 10436 passed, 230.7 s.
- **Phase 4 review (iter 1): codex APPROVE, claude APPROVE**, both HIGH. Taken from claude's
  non-blocking comments, as a follow-up commit: every peer-route refusal message is passed
  through one sanitizer as it leaves Tower (Cc, Cf, Zl, Zp → `?`; letters of any script kept),
  which also covers what the reviewer did not list (the architect name in "not registered",
  the shared workspace lookup's not-found echo); `shown()` at the address-quoting sites; the
  tunnel marker refuses on any value (the shutdown route's idiom); an oversized body is no
  longer called "not valid JSON". Not taken: moving `PEER_MIN_RETENTION_DAYS` into
  codev-types. `lib/config.ts` already imports from `agent-farm/`, and retention is
  Tower-local policy, not wire protocol. The lazy-withdrawal carry-forward stays with phase 6.
- **Architect, 2026-11-27T02:01Z, on phase 4:** both choices accepted. (1) Hold wins: written
  as one line in the spec (R's check 14); phase 13's docs say it too. (2) `on` and `grant`
  refused through the tunnel: follows from the design's threat table (a request through the
  cloud's proxy carries the local key). Consequences carried forward: **phase 12**, the Peers
  panel loaded through the cloud shows turning on and granting as unavailable there, with the
  reason, and does not offer a button that fails with 403; **phase 13**, the docs say these two
  are done at the machine. Narrow readings (architect-only grants, builders only under --all,
  former names list and revoke but do not create) accepted. **Phase 6:** withdrawal on
  switch-off and revoke is EAGER (matches the approved scenarios' "waits for release"); an
  off-then-on must not release mail by itself. **Phase 5** dispatches the Windows workflow
  with the three-shell probe.

## 2026-11-27 — phase 5: tunnel handshake, session secret and the verified entry point

- Delivered: `auth` carries `peer: {protocols: [1], remoteMessaging}`, with the switch read
  afresh on every connect and reconnect. `auth_ok`'s `slug` and `relay` are read. The secret is
  kept only in per-session state, only over `wss:` or to a loopback cloud host. Everything at
  or under `/__tower/peer` that comes down the tunnel is answered by the entry point and never
  proxied. Steps 1 to 8 run through contract.ts, with a session-scoped 10-minute statement-id
  memory. A verified request goes to the injected handler (Tower's phase 5 stub refuses
  `remote-off`). The audit hook gets one event per request (Tower supplies a no-op). The dead
  `POST /api/tower/metadata` push is gone (#1986, closed by the PR), along with the mock's
  handler and `lastMetadata`. tower-tunnel.ts exposes `getTunnelPeerSession()` (slug and relay
  state, never the secret) and logs the relay state per connect.
- Design choices, for review:
  1. The handshake and TLS helpers (`buildPeerHandshake`, `readRelayOffer`,
     `isSecureCloudTransport`) live in contract.ts, the wire format's one home. tunnel-client
     only decides what to keep (`takeRelay`). Loopback means `localhost`, `[::1]` or a
     dotted-quad `127.x`. `[::ffff:127.0.0.1]` is not loopback here (conservative).
  2. A `TunnelClient` built without `peer` options states nothing (`peer` absent), keeps no
     secret (relay `not-stated`), and answers every entry request not-verified. Tower always
     passes them.
  3. Interception is generous on purpose. `isUnderPeerEntryPath` checks the raw and
     once-decoded path, reads backslashes as `/`, collapses repeated slashes, resolves dot
     segments, ignores case, and matches as a prefix (so `/__tower/peers` is caught too;
     nothing of ours lives there). Anything matched is answered by the entry point: step 1
     unless the request is exactly `POST /__tower/peer`.
  4. An auth response that does not parse is not echoed if it names `sessionSecret`, and a
     failure while handling `auth_ok` never echoes the message (the old catch-all echoed the
     raw frame).
  5. A switch that cannot be read fails the connect attempt rather than stating a guess.
  6. A handler that throws resets the stream (INTERNAL_ERROR) without an answer. The request
     still had its one `handed-on` event. The stub never throws.
  7. Step 1 also covers a stream that ends before its body does: one event, no answer. Past
     the 102 400-byte cap, the answer is written and the rest of the request is refused with
     RST_STREAM NO_ERROR.
  8. On cleanup the session's secret reference is dropped and the id memory cleared.
- **Harness incident (layer B), architect ruling 2026-11-27T02:26Z, option 2.** The two
  two-Tower files run in one vitest call both took ports 14100 and 14101. Each file then
  talked to the other's Towers (another fork, another key), so every call got 401. Fixed in
  its own commit to the phase 2 helper (cd54ced1c):
  - ports now come from the OS;
  - a HarnessTower fails, naming the port, unless its own process prints its listening line,
    and refuses calls once that process has exited;
  - tests cover four distinct ports for two pairs started at once, and the loud failure.
  Reruns (load 1.7 to 2.1):
  - peer-entry-point.e2e alone: 6/6, 1.5 s;
  - two-towers-harness.e2e alone: 6/6, 17.1 s;
  - both in one call: 12/12, 17.0 s.
  Every teardown report was empty, with no worktree Tower left running. **For later phases:**
  two-Tower files can now run together; `HarnessTower.output` holds each Tower's output.
- Layer A, `peer-entry-point.test.ts`: 70 tests. Most of its wall time is the in-process
  client's reconnect back-off (1 to 3 s per reconnect), so the file sets a 20 s test timeout.
  The TLS case connects for real over `ws:` to a non-loopback name, which a `dns.lookup` spy
  sends to the loopback stand-in.
- Wall time, layer A files of this phase (`peer-entry-point.test.ts` 70 tests and
  `tunnel-client.test.ts` 83 tests, together): 15.7 s, 16.3 s and 17.3 s over three runs.
  Porch's full tests command: 468 files passed, 14 skipped; 10 508 tests passed, 116 skipped;
  235.4 s; exit 0. The build check passed.
- Windows workflow dispatched at 4defee646 (load 1.75): probe with the three-shell `afx://`
  argv steps, plus `suites=true`.
  https://github.com/cluesmith/codev/actions/runs/45929432410
- **Phase 5 review (iter 1): codex REQUEST_CHANGES, claude APPROVE**, both HIGH. Response:
  `1967-phase_5-iter1-rebuttals.md`; nothing disputed. Taken (codex):
  - no log line or state reason carries a handler's error message (it can quote the
    statement or body): the error's class only;
  - no state reason or log line carries an unparseable auth response (it can carry the secret
    without the exact label): its byte count only;
  - an unknown auth type is shown only when it looks like one;
  - tests for both.

  Taken (claude): the stale metadata comment, the `h2Session` rename (it caught the
  window-size call reading the wrong `session`), and the clock comment on the id memory.
  **For phase 6:** the body read shares the 5 s answer deadline. A phase 6 handler that
  wants its failures diagnosable logs safe facts itself, because the entry point logs only
  the error's class.
- **Windows run 45929432410 (4defee646) was red.**
  - Green: both probe legs (x64, ARM64), all six `afx://` argv steps (Git Bash, PowerShell,
    cmd) byte for byte, CLI tests and install verification.
  - Red: Unit tests. All 10 198 tests passed, but `bugfix-1871-cloud-identity` failed in
    teardown with EBUSY unlinking its own test.db.
  - Cause: since phase 5 each `auth` the client sends states the switch, read via
    `getGlobalDb()`, and that suite
    (the real tower-tunnel and a real db) never closed it.

  Reported to the architect before any rerun. Ruling 2026-11-27T02:50Z: close the db in that
  suite's `afterEach` after `shutdownTunnel` and before the `afterAll` removal, give any other
  such file the same close, and re-dispatch once.

  Audited every test naming tower-tunnel; only bugfix-1871 opens a real global db through
  `auth_ok`, so it is the only file changed.
- Windows re-dispatch (the one the ruling allows) at 94b6bd1a2, with the review fixes and the
  bugfix-1871 close together, `suites=true`:
  https://github.com/cluesmith/codev/actions/runs/45930869011
- **Windows re-dispatch 45930869011 (94b6bd1a2): green.**
  - Both probe legs, with all six `afx://` argv steps byte for byte.
  - Unit tests, including bugfix-1871's teardown, CLI tests and install verification.
  - The phase's Windows criterion is met.
- **Phase 5 review (iter 2): codex REQUEST_CHANGES (new point), claude APPROVE**, both HIGH.
  Response: `1967-phase_5-iter2-rebuttals.md`; nothing disputed.
  - Taken (codex): an `auth_ok` whose `towerId`, `slug` or `name` repeats the session secret
    it carries is not used at all, before anything is kept, persisted (cloud-config) or
    logged. The comparison covers the secret as sent and decoded into base64url, base64 or
    hex, and applies whether or not the secret would have been taken. Tested against a clean
    control, and shown to fail with the check disabled.
  - Taken (claude): a test that the old session's secret and ids are dropped on a reconnect
    and on a disconnect; the comment wording (the switch is read when the client sends
    `auth`).
  - **Left for the architect (claude, non-blocking):** an unreadable switch fails the connect
    attempt, which takes the dashboard, VS Code remote and `/t/` down with it. Stating `off`
    with a WARN would also be fail-closed for messaging, but it is a fallback. Kept as built
    (design choice 5, the owner's fail-fast rule); asked in the phase report.
- **Architect, 2026-11-27T03:05Z, on the unreadable switch:** keep fail-the-attempt (no
  fallback; stating `off` would report what Tower does not know). Conditions, built:
  - an ERROR line once per failing run naming the cause (`global.db could not be read
    (<class> <code>)`, never the message);
  - `afx tower status` shows `Last failure` while the connection is down: from
    `TunnelClient.getLastFailure()`, served as `lastFailure` in `/api/tunnel/status`, which
    is an optional field in the SDK type.

  Tests for both. The architect tells the owner, since a database fault now takes remote
  access down too; if overruled, it is a one-line change in `readSwitchForAuth`.

- **Phase 5 review (iter 3, the last porch allows): codex REQUEST_CHANGES, claude APPROVE**,
  both HIGH. Response: `1967-phase_5-iter3-rebuttals.md`; nothing disputed.
  - Taken (codex, and claude's point 1): the repeated-secret check now builds every spelling
    from `relay.sessionSecret` as sent, whatever becomes of the offer, so unsupported and
    malformed offers are covered too. The table has unrepeated controls for both.
  - Taken (claude): `lastFailure` is no longer overwritten by `circuit breaker reset`, the
    half-open retry or `disconnect()`.
  - Both new tests fail with their fix removed. Layer B rerun after a rebuild: 6/6, no test
    Tower left running.
