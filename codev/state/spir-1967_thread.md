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
