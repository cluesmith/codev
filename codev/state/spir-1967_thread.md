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
