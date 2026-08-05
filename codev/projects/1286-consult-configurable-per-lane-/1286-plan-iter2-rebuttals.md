# Iteration 2 rebuttals — plan review (1286)

Verdicts: **gemini APPROVE**, **claude APPROVE**, **codex REQUEST_CHANGES**.

All three Codex issues accepted and fixed. Two of Claude's three non-blocking notes folded in; the
third needed no change. No pushback.

---

## Codex issue 1 — `byProtocol` alias validation without alias-aware *resolution* — ACCEPTED, FIXED

The best finding of the round, and it is a hole **I introduced in iteration 1**. I made validation
alias-aware (so `byProtocol.spider` is accepted) but left the resolver keyed on the raw `protocol`
string. `state.protocol` stores whatever name the project was initialized with, so
`byProtocol.spider` can validate cleanly and then never match a project whose `state.protocol` is
`spir`. A config key that passes every check and silently does nothing is precisely the failure class
this spec exists to eliminate — I closed one instance of it and opened another.

Verified the aliases are real and shipped, not hypothetical:
`spir`↔`spider`, `maintain`↔`maint`, `pir`↔`plan-implement-review`.

**Resolution:** add `canonicalProtocolName(workspaceRoot, nameOrAlias)`. `resolveLaneComposition`
canonicalizes its `protocol` argument and `byProtocol` keys are canonicalized as they are read, so
both spellings name the same entry. If a config contains *both* spellings, that is a hard error —
silently picking one would be a coin flip over how much review a protocol gets.

## Codex issue 2 — error must name the config **layer**, not just the key — ACCEPTED, FIXED

Correct, and I had under-delivered against my own spec: the spec says the error must name "the config
key **and layer**", Phase 2 said only "name the config key", and `resolveLaneModel`'s `source` field
was vaguely "a human-readable source" without a contract. With five config layers, naming the key
alone leaves the user grepping five files.

**Resolution:** `resolveLaneModel` returns the supplying layer, and a **pinned three-part error
contract** now applies to all three lanes: provider's verbatim error text + config key + config layer.

The implementation subtlety, now stated so the builder doesn't discover it late: `loadConfig`
deep-merges and *discards* origin, so provenance has to be recovered. The plan explicitly forbids
threading provenance through `deepMerge` — that would rewrite a function the whole config system
depends on to serve one error message — and instead specifies a narrow
`findConfigSource(workspaceRoot, keyPath)` that re-reads the five layers in precedence order on the
error path only. Returns null for values that came from defaults, where the message degrades to the
key alone; that is fine, since a default cannot be the user's typo.

## Codex issue 3 — Phase 3 could degrade to a generic exit-code failure — ACCEPTED, FIXED

Right, and it is the difference between satisfying the control flow and satisfying the requirement.
A bare `agy exited with code 1` leaves a user with a rejected model id and no reason.

Verified the current behavior: `proc.stderr` **is** piped and watched for auth markers
(`index.ts:926`, `watch(b, false)`), but only stdout accumulates into `outChunks` — stderr is
inspected and discarded.

**Resolution:** Phase 3 must retain a bounded tail of agy's output and include it in the hard-failure
message, alongside the key and layer from the Phase 2 contract. Bounded because agy output can be
large and this lands in an error string. Noted as a bonus: once the text is retained, the spec's
*preferred* marker-based rejection detection becomes a small addition rather than new plumbing — the
deterministic floor still doesn't depend on it.

---

## Claude's non-blocking observations

- **(1) `--model-id`'s parsing location unspecified** — folded in: registered with the other consult
  options in `cli.ts` and threaded through `ConsultOptions`; one flag, no per-lane variants (guards
  against the gold-plating Claude flagged in the previous round).
- **(2) `listProtocolNames` will parse `protocol.json`** — folded in: reuse `porch/protocol.ts`'s
  existing `Protocol` types and parsing rather than hand-rolling a second reader, since a second
  parser is how the two drift when the schema changes.
- **(3) `porch done` catch-removal belongs in the PR description** — already required by the plan; no
  change.

---

## Net changes to the plan

- Phase 1: `canonicalProtocolName()` and `findConfigSource()` added as deliverables and specified,
  with the deepMerge-provenance approach explicitly ruled out; reuse of `porch/protocol.ts` parsing;
  three new acceptance criteria.
- Phase 2: three-part error contract (provider text + key + layer) pinned for all lanes;
  `resolveLaneModel` returns the supplying layer; `--model-id` parsing location specified.
- Phase 3: hard failure must carry agy's captured output; new acceptance criterion.
