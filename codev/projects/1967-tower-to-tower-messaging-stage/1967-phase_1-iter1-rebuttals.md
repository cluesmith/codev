# Phase 1, iteration 1: response to review feedback

Codex: REQUEST_CHANGES (2 points). Claude: APPROVE (HIGH), with optional polish. Each point was
checked against the contract (spec, Wire Contract section, revision 4) before acting.

## Codex 2: `detail` longer than 500 characters is accepted — ACCEPTED, changed

Section 6's answer table types `detail` as "string, at most 500 characters", and "S validates the
shape of every answer. A 200 whose body does not fit this shape ... is treated as `tower-error`."
The reader already refused a non-string `detail`, so refusing an over-long one is the same rule.

- `readAnswerBody` now refuses a `detail` of more than 500 characters, counted as code points
  (the same count R's encoder caps at), so the 200 becomes `tower-error`.
- Tests: 500 code points (4-byte emoji) is read; 501 is `tower-error`; a detail R's encoder was
  handed at 501 code points is capped and read back by S.
- `printableDetail` keeps its strip and cap, as the contract says S does before printing.

## Codex 1: `statementId` is not checked as the canonical base64url of 16 bytes — NOT CHANGED

The contract's rule for the field (section 5) is "String of exactly 22 characters from A–Z, a–z,
0–9, `-`, `_`: the base64url of 16 random bytes, new for every statement". I read the part
after the colon as how C makes the value, not as a further check R can make, for three reasons:

1. **R never decodes a statement id.** It is a replay key, compared as a string against the
   session's memory (step 8). The strict base64url decoding in `contract.ts` applies to the
   values R decodes and uses as bytes: the statement header, the MAC and the session secret.
   A non-canonical spelling of a statement id carries no bytes anywhere and cannot alias another
   id (two different strings are two different keys).
2. **The rest of that clause is not checkable either.** "random" and "new for every statement" are
   C's obligations; R enforces only their consequence, through the replay memory. The checkable
   rule is the character shape, and R checks exactly that.
3. **The shared vectors are agreed with the cloud as they stand.** The cloud architect reviewed
   the file at acaf1f178 and 979c4a9e0 and confirmed every verified case with the primitives C
   issues with (codev-cloud #22, comments 7204918145 and later). Tightening the rule would
   flip five verified cases of that file whose hand-written ids are not canonical spellings: the
   one the review names, the pretty-printed statement, the 4096-byte header, `v` as 1.0 and
   `issuedAt` as 1.7641e12. (Three more cases have non-canonical ids, but step 1 or step 4 decides
   them first, so their verdict is the same under either reading.) That is a contract change for
   no security gain.

**Ruling (architect, main, 2026-11-26T22:52Z), quoted:** "your rebuttal stands; keep the shape
check. I checked it against the contract and contract.ts: the field rule's checkable part is '22
characters of the alphabet'; R uses the id only as a string key in the step 8 memory and never
decodes it, so a non-canonical id cannot alias another; and the id is inside the MAC'd statement,
so only C can choose it. A decode-and-length check would add code and reject nothing an attacker
could send."

As the ruling also directs, so that the text and the file cannot be read two ways:

- the contract now says, under the statement's field table, that strict base64url applies to the
  values R decodes (the statement header, the MAC and the session secret), that `statementId` is
  checked by shape only, and that its canonical 16-byte encoding, randomness and freshness are C's
  obligations;
- the names of the five verified vectors that rely on it now say that the shape rule decides
  them. No verdict changes, and no statement or MAC bytes change.

Per the ruling, if this point is raised again after reading the above, it goes to the architect
rather than to a third round.

## Claude's polish — ACCEPTED, changed

- **Fields that go with a reason were read off the raw body** (`contract.ts:850`). `retryAfterSec`
  and `supported` are now read only when the outcome *accepted* that reason. Before, a `delivered`
  answer with a stray `"reason":"rate-limited"` kept `retryAfterSec`, and one with a stray
  `"reason":"unsupported-version"` and no `supported` was wrongly refused as `tower-error`. Tests
  cover both.
- **`ReceiverAnswer` let R omit `supported` with `unsupported-version`.** That refusal is now its own
  variant with `supported` required, so a phase 5 omission is a compile error; a `@ts-expect-error`
  test pins it.
- Not changed, by design: the structural grep is a repo-wide tripwire whose failure names the file;
  `readRelayRequestHeaders` is the plan's "reading the four relay headers" and serves as a
  conformance check; the step 3 `unsupported-version` reading is agreed with the cloud and noted
  for phase 8 (refused, not held); header names appear as keys in `peer-wire.ts`'s types because
  codev-types cannot import from packages/codev.

## Checks

`npx tsc --noEmit` (packages/codev) clean; both test files type-checked; the two contract test files
pass (245 tests). Porch's build and tests checks run again on `porch done`.
