# Reviewer note — two items the architect asked to be put in front of this review explicitly

This note is supplied by the builder at the architect's direction. Please scrutinise both items
below in addition to your normal phase_2 review. Neither has been reviewed by anyone yet.

## 1. An unreviewed behavior change carried over from phase_1: rejecting `[]` as a lane list

**What changed.** `validateLaneList` now rejects an empty array (`[]`) with an error naming `"none"`.
Previously `[]` validated and resolved to `{ models: [], mode: 'normal' }` — zero lanes — making it
an undocumented second spelling of the spec's single explicit skip sentinel, `"none"`.

**Why it is unreviewed.** phase_1 had already received a unanimous APPROVE when I noticed this while
following up a reviewer's separate non-blocking note. I chose to ship it rather than let a known
ambiguity calcify across five more phases, and disclosed it to the architect instead of letting it
pass as reviewed. Tightening is the reversible direction (loosening later is safe; the reverse breaks
live configs), but that is a judgment call, not a reviewed decision.

**The part that most needs your scrutiny — a deliberate asymmetry.** The rejection applies to
user-authored config **only**. The shipped EXPERIMENT and SPIKE protocols declare
`defaults.consultation.models: []` (paired with `enabled: false`) to mean "this protocol runs no
consultations", in four files across both trees:

- `codev-skeleton/protocols/experiment/protocol.json:96`, `codev-skeleton/protocols/spike/protocol.json:32`
- and their `codev/protocols/` mirrors

So `[]` is **forbidden from users but meaningful from protocols**. The boundary holds by
construction, verified rather than assumed:

- `validateConsultationConfig` has exactly one production caller — `config.ts:326`, on
  `merged.porch?.consultation` (user config).
- Protocol models reach `resolveLaneComposition` as the `protocolModels` argument and never pass
  through the validator; with no config, `fallback = { models: protocolModels, mode: 'normal' }`
  returns them untouched.

**Rationale offered for the asymmetry:** protocol JSON is a shipped artifact with established
semantics; config is user input, where an ambiguous synonym is a usability bug. It is documented at
the rejection site, including a warning that routing protocol models through the validator would
break both protocols. A test asserts both shipped protocols still resolve to zero lanes, reading the
real `protocol.json` and guarding its own premise so it fails loudly rather than vacuously if a
protocol stops shipping `[]`.

**Questions for you:** Is the asymmetry the right design, or should `[]` be accepted as an alias for
`"none"` for symmetry? Is documenting it at the rejection site sufficient, or does it belong in
user-facing docs (phase_6)? Is there a third path through the validator I have missed that would
reach protocol-supplied models?

## 2. A bug this phase found by running the code, and the guard added for its class

`--model-id` initially shipped **registered, parsed, present in `--help`, and completely inert**:
`cli.ts`'s action built its `ConsultOptions` object field-by-field and never copied `modelId` across.
20 passing unit tests asserted the configured id reached each SDK — all true, and the flag still did
nothing.

Worth noting for calibration: the first bogus-id run returned `OK` and wrote a review file, and the
plan had *already documented* a risk fitting that symptom ("an SDK swallows a bad id and silently
substitutes"). Probing the SDK directly disproved it — codex rejects unknown ids with a 400
`invalid_request_error`; the id had simply never arrived.

Per the architect, the fix was to extract the cause rather than duplicate the end-to-end test:
`registerConsultOptions()` and `buildConsultOptions()` now live together in
`commands/consult/cli-options.ts`, with a unit test that reads the flag list back out of commander
via `attributeName()` and asserts every non-stats flag is forwarded.

**Questions for you:** Does the extraction leave any CLI behavior changed (it is intended to be a
pure refactor)? Is the `STATS_ONLY_FLAGS` exception list correct and complete? Does the forwarding
test have a vacuous-pass path I have not closed?
