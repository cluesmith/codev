# Spec 1967 — PR review, iteration 1: responses

Codex: COMMENT. Claude: APPROVE. Nothing blocking; porch is at the `pr` gate. Each point is
answered below. The code changes are in `a2f660715`; the document changes are in the review
document.

## Codex (COMMENT)

1. **The template pairs' "byte-identical" criterion was adapted, not met as written.**
   **Addressed (documented).** Each pair keeps the two hunks it already differs by on `main` (the
   title line and the AGENTS.md note), and every edit is identical in both. The architect confirmed
   this reading at 2026-11-27T13:35Z. The review document's Deviations (phase 13) now says the
   criterion was adapted and who confirmed it.
2. **The review's Layer A count predates the review phase's test.**
   **Addressed.** Build and porch's exact test command were run again on `a2f660715`, which
   includes the gap 2 test and this round's fixes. The review document's runs section records
   that result beside the earlier one.
3. **`PeerAcceptedRow` declares `mailboxId` twice in `peer/store.ts`.**
   **Rebutted.** `PeerAcceptedRow` declares it once (`store.ts:720`). The other declaration
   (`store.ts:774`) belongs to `AcceptedInsert`, a separate interface, the input to the insert.
   The TypeScript build would reject a duplicate member.

## Claude (APPROVE)

1. **`outbox.ts` `errorKind()` logged `err.message`, where every sibling logs the class.**
   **Addressed** (`a2f660715`). It now returns `err.constructor.name`, with a comment saying why,
   as `receiver.ts` and `tunnel-client.ts` do. No test asserted the old text. The peer test files
   (348 tests) pass.
2. **Gap 7, a payload claiming a different sending Tower, is cheap to close.**
   **Addressed** (`a2f660715`). Named cases were added at both layers that read it:
   - `peer-contract.test.ts`, `refuses %s as malformed`: new rows "from naming a Tower" and
     "from naming an owner".
   - `peer-receiver.test.ts`, `refuses ${label}, storing nothing`: "a payload whose sender
     claims another sending Tower". The statement names `mbp` and the payload's sender names
     `devvm`. It is refused as `malformed`, with no mailbox row, no accepted-once row and no
     gate attempt.

   Gap 7 is marked closed in the review document.
3. **The no-break-space marker residual should be carried into stage 3.**
   **Addressed (documented).** Follow-up Items names it for the stage 3 design, since stage 3
   admits other owners' Towers. Carrying it into a stage 3 issue is the architect's call, and it
   has been raised with them. This PR leaves Decision 7's rule as written.
4. **`readRelayRequestHeaders` has no production caller.**
   **Addressed** (`a2f660715`). Its doc comment now says it is the cloud's check, that no Tower
   code calls it, and why it is kept in `contract.ts`.
5. **`held-group--release` and `held-group--peer` have no CSS rules.**
   **N/A, checked.** `held-count-three-groups.png`, committed with the review, shows each group
   distinct by its heading and count. The for-release group also carries its own line: "From
   another Tower, waiting for a human: afx inbox release or dismiss". That matches the existing
   `held-group--scheduled`, which has no rule either. No change.
