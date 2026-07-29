# Iteration 3 rebuttals — spec review (1286)

Verdicts: **gemini APPROVE**, **claude APPROVE**, **codex REQUEST_CHANGES**.

Codex's single issue accepted and fixed. Claude's single non-blocking observation verified and also
fixed. No pushback.

---

## Codex issue — `consult.reasoningEffort.codex` value space undefined — ACCEPTED, FIXED

Correct and precisely scoped. Iterations 2 and 3 pinned the *key* space (`{codex}` only) but the
spec gave `"high"` only as an example and never said what the legal *values* are or who validates
them — leaving the three-way implementation fork Codex names: enum validation, pass-through, or
silent acceptance.

**Resolution: a closed enum, validated locally at config-load time.** Accepted values are exactly
`minimal | low | medium | high | xhigh`; anything else hard-errors before any consultation runs;
unset yields `medium` (today's pinned value).

The set was not guessed — it was read from the SDK actually installed:

```
@openai/codex-sdk/dist/index.d.ts:237
type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
```

**Why this validates locally when model ids explicitly do not.** This is the obvious objection —
the spec spends several paragraphs arguing against local allowlists, then adds one — so the spec now
answers it with a table rather than a sentence. The distinction is the *shape of the value space*,
not a preference:

- A **model id** is an open, provider-owned catalog that changes between provider releases. Codev
  cannot know the valid set; any local list is stale the day a model ships. → provider is authority.
- A **reasoning effort** is a closed union shipped *as a type* by a dependency Codev already pins.
  The valid set is a compile-time artifact of `package.json`, not a remote fact. → validate locally.

With one binding condition, now a requirement: the accepted set must be **bound to the SDK's
exported type** so that an SDK upgrade changing the union produces a **compile error**, not a
silently divergent list. A hand-copied literal that drifts from the SDK would be the same class of
bug as a model-id allowlist — just slower-moving. That condition is what makes the local validation
safe, so it is stated as a requirement rather than left to implementation taste.

---

## Claude observation — `config.ts` header says "three layers" — ACCEPTED, FIXED (pulled into scope)

Verified: `packages/codev/src/lib/config.ts:4-7` describes three layers (defaults → global →
project), while the loader has five (defaults → framework cache → global → project → local) and the
function-level docstring at `:224` correctly says so.

Claude called it pre-existing and optional. Pulling it into scope anyway, because this spec's whole
config surface sits on that stack and both the spec and the new user-facing docs say "five layers" —
leaving the header contradicting them would be shipping a known documentation conflict alongside
documentation that is supposed to clarify. It is a comment-only change, recorded in Notes as an
in-scope drive-by so it doesn't read as scope creep at PR time.

---

## Net changes to the spec

- Desired State: new paragraph fixing `consult.reasoningEffort.codex`'s value space to the SDK enum,
  plus a table contrasting it with the model-id rule and the SDK-type-binding requirement.
- Success Criteria: one added (enum values, load-time rejection, SDK-type binding).
- Open Questions: new resolved entry recording the value-space decision and its rationale.
- Test Scenarios: scenario 3 extended with the reject vectors (`"highest"`, `""`, non-string).
- Notes: `config.ts` header fix recorded as an in-scope drive-by.
