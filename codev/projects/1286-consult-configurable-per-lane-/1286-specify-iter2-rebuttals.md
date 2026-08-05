# Iteration 2 rebuttals — spec review (1286)

Verdicts: **gemini APPROVE**, **claude APPROVE**, **codex REQUEST_CHANGES**.

Both Codex issues accepted and fixed. Claude's single non-blocking comment was accepted as well —
and on verification it turned out to be a spec-level gap, not the plan-level concern Claude
generously framed it as, so it is fixed here rather than deferred. No pushback on any point.

---

## Codex issue 1 — `consult.reasoningEffort` key-space contradiction — ACCEPTED, FIXED

Correct, and this one was self-inflicted in iteration 1: while resolving the hermes question I wrote
"`consult.models` **and** `consult.reasoningEffort` accept exactly `claude`, `codex`, and `gemini`"
in Desired State, contradicting the Open Questions resolution that `reasoningEffort` accepts only
`codex`. A builder could have implemented either.

**Resolution: the two blocks have deliberately different key spaces**, now stated in its own
paragraph rather than folded into the hermes sentence where the error hid:

- `consult.models` → `{claude, codex, gemini}`
- `consult.reasoningEffort` → `{codex}` only; `claude` and `gemini` are hard errors even though they
  are valid in `models`

`codex` is the only backend exposing `modelReasoningEffort`. The map stays lane-keyed so a second
backend can be added later without a rename. Success criterion and scenario 18 pin the divergence.

## Codex issue 2 — "shell metacharacters" is not concretely defined — ACCEPTED, FIXED

The sharpest point in this round, and Codex identified the right tension: a vague blocklist is both
untestable *and* liable to reject an id a future provider considers valid — which would reintroduce
the staleness this spec exists to eliminate, one layer down.

**Resolution: an exact permitted-character rule replaces the blocklist**:

```
^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$
```

Chosen to already cover the id conventions in use across providers — dotted/namespaced
(`us.anthropic.claude-opus-5`), vendor-prefixed (`openai/gpt-5.6`), tagged (`gpt-5.6:latest`). The
one genuine safety requirement is the leading-`-` exclusion: the gemini lane passes the id as an
argv element, and a leading `-` would be parsed by `agy` as a flag.

The Security section was corrected accordingly. It previously implied the syntax check was what
prevents shell injection; it isn't — `spawn(bin, args)` already makes shell metacharacters inert by
construction. The syntax rule is defence in depth plus the argv-flag fix.

Noted in the spec: if a provider adopts a character outside the set, the fix is widening a
*syntax* class — which goes stale slowly and safely — not maintaining a catalog of *ids*, which
goes stale immediately.

---

## Claude comment — agy's non-blocking skip vs. the fail-fast contract — ACCEPTED, FIXED IN SPEC (not deferred)

Claude flagged this as a plan-phase concern. **Verified against the code first, and it is worse than
flagged — it is a hole in the spec's central contract, so it is fixed here.**

`consult/index.ts:938`: `if (code !== 0 || raw.length === 0 || raw.includes(AGY_NONRESPONSE_MARKER))`
→ `settleSkip()`, which writes `VERDICT: COMMENT`, which porch treats as non-blocking. So under the
iteration-2 spec as written, `consult.models.gemini: "typo-model"` would have produced a *silent
skip* and porch would have advanced the phase — the precise silent-downgrade failure the spec
declares it is preventing. Deferring that to the plan would have meant shipping a fail-fast
guarantee with a documented lane-shaped hole in it.

**Resolution: separate the two behaviors by cause**, now in Desired State:

- **Environment failure** (agy absent / unauthenticated / timed out / non-responsive) → today's
  non-blocking skip, unchanged. The lane is optional and degraded (#1032 / #1033) and this spec
  doesn't touch that.
- **Configuration failure** (a model id the user explicitly set) → hard failure on every lane,
  gemini included. Opting into a specific model is opting out of "quietly proceed without it."

Two mechanisms, in order: pre-spawn syntax validation catches malformed ids with no process spawned
and no output parsing; for a syntactically valid but provider-rejected id, the preferred mechanism is
marker-based detection mirroring the existing `AGY_OAUTH_MARKERS` discrimination, with a
**guaranteed floor that needs no markers** — when `consult.models.gemini` is explicitly set, a
non-zero agy exit is a hard failure rather than a skip. The floor matters because agy's rejection
text is not contractual; the builder is never left without a deterministic rule.

Scenario 19 guards both directions, including the regression case that an *unconfigured* gemini lane
still skips exactly as it does today. Risk table row added.

---

## Net changes to the spec

- Desired State: `consult.reasoningEffort`'s key space split into its own paragraph and narrowed to
  `{codex}`; new "Reconciling fail-fast with the agy lane's non-blocking skip" subsection.
- Fail-fast semantics: blocklist replaced by the exact `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$` rule,
  with the rationale for syntax-over-catalog recorded.
- Security Considerations: corrected to credit `spawn(bin, args)` for injection safety and scope the
  syntax rule to the leading-`-` argv risk.
- Success Criteria: three added (reasoningEffort key space, id syntax incl. namespaced/tagged forms
  passing through unmodified, gemini configured-failure ≠ skip).
- Open Questions: reasoningEffort resolution corrected and annotated; new resolved entry for the
  id-syntax rule.
- Test Scenarios: 17 → 19 (scenario 10 rewritten with concrete accept/reject vectors; 18 divergent
  key spaces; 19 agy skip vs. hard failure).
- Risks: new row for the agy-skip hole.
