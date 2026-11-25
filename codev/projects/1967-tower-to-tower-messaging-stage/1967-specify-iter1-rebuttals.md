# Spec 1967, specify iteration 1: responses to review

Both reviewers asked for changes. Every point was accepted and changed in the spec (commit
`407d64534`). Nothing is disputed.

## Codex (REQUEST_CHANGES)

1. **Records: R cannot record what never reaches it, nor vouch for an unverified sender.**
   Accepted. Contract section 8 now says each party records what it can see: the sending Tower
   every outbound attempt (each relay call, including retries, and every local refusal); the
   receiving Tower every request that reaches its entry point, recorded against the tunnel session
   with the sender `unverified` until the MAC verifies, then by the statement's Tower and, once
   parsed, the full addresses; the cloud every relay call. Criterion 17's "What is verified here"
   cell says the same.
2. **Cloud answers underspecified.** Accepted. Section 6 now opens with one answer shape for both
   sources: a field table (`v`, `source`, `outcome`, `reason`, `detail`, `retryAfterSec`,
   `supported`, `duplicate`, `addresses`, `truncated`), with type and presence for each;
   `Content-Type: application/json`; and `x-codev-peer-outcome` present on every answer from either
   source. Example cloud bodies are shown, and the HTTP status table lists each cloud outcome and
   reason.
3. **Criterion 8 vs concurrent queries.** Accepted. Criterion 8's cell now says the in-flight
   assertion is on **message** relay calls, and that discovery queries are not serialised with
   messages. Section 4 says "one message relay call at a time per peer".

## Claude (REQUEST_CHANGES)

1. **No TLS requirement for the session secret.** Accepted. Verified: `buildTunnelWsUrl` maps
   `http:` to `ws:`. The contract's principles now require `wss:` for taking a secret and `https:`
   for the peer calls, with the one exception of a loopback cloud (tests); any other plain-HTTP
   cloud is treated as having no relay. It appears in the principles, in section 1, as a new
   success criterion, as gap G8, as a test scenario and as a risk.
2. **Address shape is architect-only.** Accepted. Section 4 now defines the address as stage 1's
   two-kind union, gives a builder example (`kind: "id"`), says `name` is required for `id`, says R
   resolves `id` as a local id does and refuses a shell as `not-addressable`, and the discovery
   example includes a builder. Discovery scope per grant (one architect, a workspace's architects,
   `--all` with builders) is stated. A success criterion and test scenarios cover builders across
   Towers.
3. **`maxAnswerBytes` / `maxPayloadBytes` unknowable to R.** Accepted, with the reviewer's cleaner
   option. A new "Protocol constants" table pins the text, payload, statement-header and answer
   sizes, the three timeouts, freshness, statement-id memory and lifetime as protocol-v1 constants.
   The listing's `limits` now carries only the cloud's rate limits.
4. **`requestId` and header-bound fields unvalidated.** Accepted. The cloud validates
   `x-codev-peer-request-id` as a canonical lower-case UUID (and kind and version) before
   forwarding; R's step 4 validates every statement field against a stated rule (ids, Tower name,
   email length and control characters, handle). Payload addresses must fit the component rule and
   the 512-character `MAX_ADDRESS_LENGTH`, or the answer is `malformed`. A new success criterion
   states the frame invariant for arbitrary statement and payload values, with a property test in
   the scenarios; gap G11 records it.
5. **No criterion for the builder rule on remote addresses.** Accepted. A new success criterion and
   test scenarios cover: a builder naming another Tower's architect that is not its own is refused
   by its own Tower with no call made; the front door is reached under a grant; and each of
   Decision 7's builder footer rows prints a command the builder's own send accepts.

**Clarifications, all taken:**

- **503 retry gating contradiction.** Retrying is now unconditional back-off (5 s rising to 2 min)
  whatever the listing says; a listing showing the peer back only brings the next retry forward.
  The 503 row says "Holds, retries".
- **R's 5-second deadline under lock contention.** R answers `held`, `busy` if the write cannot
  start within 5 seconds, and the row drains as held local mail does (gap G9, and a test scenario).
- **Unbounded `not-verified` loop.** After five in a row for one peer, the peer is shown as "not
  verifying" in `afx peer list`, the Peers panel and the record until any other answer (gap G10,
  test scenario).
- **Decision 9's other stage 2 surface.** Now explicitly in scope in Desired State: `afx inbox` in
  three groups, `afx inbox show`, `afx inbox dismiss`, `afx status`, `afx tower status`, the
  read-only Peers panel (stage 3 parts excluded) and the three-count indicator. Playwright
  verification of the UI is added to Constraints and Test Scenarios.
- **Mailbox `CHECK` third option.** Constraints now names the migration v18 precedent (no `CHECK`,
  values enforced in TypeScript) beside a table rebuild and separate tables.
- **Open Question 1.** The recommendation is strengthened: it is the only answer consistent with
  "each stage ships its headline path". The alternative stays listed, marked as such, because the
  choice is the owner's, not the builder's.
- **Length.** Not changed, as the reviewer suggested.
