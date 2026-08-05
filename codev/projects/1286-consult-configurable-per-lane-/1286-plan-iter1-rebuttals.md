# Iteration 1 rebuttals — plan review (1286)

Verdicts: **gemini APPROVE**, **claude APPROVE**, **codex REQUEST_CHANGES**.

All three Codex issues accepted and fixed; each was a real gap where a builder could have followed
the plan literally and still produced something the spec forbids. Claude's three non-blocking
observations reviewed, with one explicitly declined and the reason given.

---

## Codex issue 1 — validators defined but their invocation point unspecified — ACCEPTED, FIXED

Correct, and the failure mode is exactly as described: the plan said "pure, independently testable
validators" without saying who calls them, so a builder could wire them at consult/porch resolution
time, pass every Phase 1 unit test, and still violate the spec's requirement that malformed config
fails at **load time**.

**Resolution: validators are invoked from `loadConfig()` in `lib/config.ts`**, immediately after the
existing custom-harness validation. This isn't a new pattern — `loadConfig` already calls
`validateCustomHarnessConfig` for precisely this reason, so the precedent is cited in the plan as the
thing to imitate. Added as an acceptance criterion asserted by a test that calls `loadConfig` alone
and expects a throw, so "validation happens at load time" is verified rather than assumed.

Also recorded: the **accepted blast radius**. Because `loadConfig` is shared, malformed
`consult.models` will fail `afx status` and other unrelated commands, not just consultations. That is
the intended fail-fast behavior and is already how a malformed `harness` block behaves — but it is
surprising enough that it belongs in the plan as a deliberate choice rather than surfacing as a
"regression" at review.

## Codex issue 2 — key-space discovery has no canonical implementation point — ACCEPTED, FIXED

The most valuable finding of the round. "Reuse `lib/skeleton.ts`" was hand-waving, and verification
confirms Codex's reading precisely:

- `lib/skeleton.ts` exposes `resolveCodevFile` (single file, four tiers) and `listSkeletonFiles`
  (skeleton tier only). **Neither enumerates protocol names across tiers.**
- `porch/protocol.ts:53-77` walks protocol directories for alias lookup, but over **three** tiers —
  it omits the framework cache — and returns on the first alias match rather than building a set.

So the most correctness-sensitive part of Phase 1 had no implementation and the builder would have
improvised it.

**Resolution: a new shared API, specified with its location and semantics** —
`listProtocolNames(workspaceRoot?): Set<string>` added to `lib/skeleton.ts`, walking all **four**
tier directories (matching `resolveCodevFile`'s tier list, not `findProtocolFile`'s three-tier one).
Review-type discovery then reads the *resolved* `protocol.json` per name and unions `verify.type`.

**Added beyond what Codex raised — aliases.** Protocols may declare an `alias` that porch resolves
by, so a user can legitimately write `byProtocol.<alias>`. Enumeration that returned only directory
names would reject config the CLI itself accepts — a fail-fast rule that fails *correct* config,
which is worse than the gap it closes. `listProtocolNames` therefore includes declared aliases.

Also noted, deliberately **not** fixed: `findProtocolFile`'s alias scan skipping the cache tier is a
pre-existing inconsistency. Out of scope for #1286; the new API is written correctly rather than
copying the bug, and it is flagged for a follow-up issue.

## Codex issue 3 — Phase 4 depends on Phase 2 only, but metrics must cover the agy lane — ACCEPTED, FIXED

Correct. The agy lane records metrics through its own paths, including `settleSkip`, which writes a
row for a *skipped* consultation. With Phase 4 gated on Phase 2 alone, codex and claude would record
resolved ids while gemini silently wrote `NULL` — and that gap would read as a data bug rather than
an unfinished phase.

**Resolution: Phase 4 now depends on Phases 2 and 3**, with the reasoning stated in the phase body
and the dependency map updated. Sequencing after Phase 3 means every call site that can emit a
metrics row already knows its resolved id. Semantics pinned for the skip case: the id is recorded
when one was configured and left null when none was, so null means "no model was chosen" rather than
"we forgot to record it".

---

## Claude's non-blocking observations

- **(a) Phase 4's migration could partly parallelize with Phase 2** — Claude concluded it wasn't
  worth changing, and Codex's issue 3 has since moved Phase 4 *later*, not earlier. No change.
- **(b) `--model-id` shouldn't be skipped or gold-plated** — agreed; it stays a single Phase 2
  deliverable that outranks config and reuses the same syntax validator. No new scope.
- **(c) Phase 5 must keep the `{ models, mode }` return shape** — already the stated constraint;
  Claude's confirmation is noted, no change needed.

## Architect input folded in this round (issue #1288)

Not a reviewer finding, but applied here since the plan was being revised: #1288 changes shipped
defaults to `claude-opus-5` / `gpt-5.6-sol`. The plan's default-preservation tests are restructured
into two layers so a defaults change doesn't silently invalidate them:

- **Layer A (rebase-proof)**: zero-config → SDK receives the module's *default constant*.
- **Layer B (one deliberate pin)**: a single test asserting those constants are the ids shipped at
  this commit.

Layer A alone is tautological — it would pass even if a default were changed by mistake — which is
why B is a separate, intentionally-edited line. `gpt-5.6-sol` added to Phase 1's accept-vectors: a
real id whose `-sol` suffix is load-bearing is a better check that the syntax rule isn't too tight
than an invented example. A rebase-and-check-#1288 step is recorded as a precondition for implement.

---

## Net changes to the plan

- Phase 1: validation invocation point (`loadConfig`) with the harness precedent and accepted blast
  radius; `listProtocolNames()` specified as a new `lib/skeleton.ts` API incl. aliases and the
  four-tier correction; two acceptance criteria added; `gpt-5.6-sol` accept-vector.
- Phase 2: default-preservation restructured into Layers A/B; acceptance criterion reworded off
  literal ids.
- Phase 4: dependencies → Phases 2 and 3, with the agy/`settleSkip` reasoning and null semantics.
- Success Metrics: zero-behavior-change metric now required to survive #1288 without edits.
- Notes: #1288 context, the pre-implement rebase requirement, and the architect-owned post-merge opt-in.
