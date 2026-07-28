# Rebuttal — Phase 2 (Quiescence observability), iteration 1

**Verdicts**: Gemini APPROVE (HIGH) · Claude APPROVE (HIGH) · Codex REQUEST_CHANGES (HIGH)

Codex's single issue is accepted and fixed. Notably, **two reviewers reached opposite conclusions on
exactly this point**, so the reasoning for siding with Codex is recorded below rather than left implicit.

---

## Codex — REQUEST_CHANGES

### Issue: "Missing route/integration coverage for the actual wire contract"

**Accepted.** The four tests I added exercised `session.info` directly and stopped there. That pins the
field on the *class*; it pins nothing about the *response*. The entire reason phase 2 exists is that
`afx reset` reads this value over HTTP — the class already had a working `lastDataAt` getter since
Spec 467, and if in-process access were sufficient the phase would have been unnecessary.

Codex is also holding me to my own written criteria, which is the stronger form of the argument:

- Acceptance criterion, verbatim: *"`GET /api/terminals/:id` includes `lastDataAt` as an epoch-ms number."*
- Test plan, verbatim: *"**Integration**: terminal info endpoint returns the field."*

Neither was satisfied. A phase whose acceptance criterion names an endpoint needs a test that calls it.

**Changed** — two tests added to `tower-routes.test.ts` under a new
`GET /api/terminals/:id (Spec 1273 — lastDataAt on the wire)` block:

1. The serialised response carries `lastDataAt` as a `number` with the expected value.
2. An unknown terminal returns 404 `NOT_FOUND` — so a missing field can never be mistaken for a
   successful response that merely lacks it.

95 route tests pass.

---

## Claude — APPROVE, but explicitly contradicts the above

Claude reviewed the same gap and concluded the opposite:

> The plan mentioned an integration test ("terminal info endpoint returns the field"), but the endpoint
> is a pure `JSON.stringify(session.info)` passthrough — the unit test pinning the field's presence on
> `info` is the right level of coverage. **No gap here.**

**I sided with Codex.** Claude's premise is factually correct — the handler today is
`res.end(JSON.stringify(session.info))` — but the conclusion does not follow:

1. **"Pure passthrough" is a property of today's code, not of the contract.** A future change that
   selects or reshapes fields at the route (redaction, a projection for a lighter list payload, a
   version envelope) would break the wire contract while every `session.info` unit test stayed green.
   The consumer depends on the response, so the response is what deserves the pin.
2. **The acceptance criterion names the endpoint.** Declining to test it means shipping a phase whose
   stated criterion is unverified, and later readers would have to re-derive that the omission was
   deliberate.
3. **The cost is two cheap tests.** When one reviewer says a test is missing and another says it is
   redundant, and the test is nearly free, the asymmetry favours writing it: the downside of a
   redundant test is trivial, the downside of an unpinned wire contract is a silent break in the signal
   R4 depends on before it types `/clear` into a live builder's terminal.

Recording the disagreement rather than quietly following the approving reviewer — the majority verdict
was APPROVE, and it would have been easy to ship on that.

Claude's other observation, that the `tower-client.ts` diff also contains phase 1's `escape` option, is
correct and expected: both phases touch that file and phase 1 landed first.

---

## Gemini — APPROVE

No issues raised.

---

## Net effect

Two route-level tests added; no production code changed. The phase's stated acceptance criterion is now
actually verified.
