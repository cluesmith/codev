# Iteration 1 rebuttals — spec review (1286)

Verdicts: **gemini APPROVE**, **claude APPROVE**, **codex REQUEST_CHANGES**.

All three of Codex's issues were valid and are **accepted and fixed**. Claude's four comments
(non-blocking) overlapped with two of them; all four are also fixed. No rebuttals-as-pushback below
— every point was conceded.

---

## Codex issue 1 — hard-error vs warning contradiction on unknown keys — ACCEPTED, FIXED

Codex is right: Desired State and Success Criteria said unknown `byProtocol` / `modelsByType` keys
are hard errors, while Open Questions offered "strict value validation plus a loud warning" as a
fallback. That is a genuine requirement conflict, and a builder could have implemented either.

**Resolution: hard error, unconditionally.** The warn-and-continue fallback is deleted, not
softened. A typo'd key that silently no-ops is exactly the fail-fast violation this spec exists to
close, so offering a mode that permits it was self-defeating.

## Codex issue 2 — pricing override shape undefined — ACCEPTED, FIXED

Also correct: the spec required `cost_usd` to become `null` "unless an override is supplied" without
ever defining the override. The builder would have had to invent the shape.

**Resolution:** `consult.pricing.codex` is now in the Desired State JSON example with all three
fields spelled out (`inputPer1M`, `cachedInputPer1M`, `outputPer1M`, USD per 1M tokens — mirroring
the existing `CODEX_PRICING` constant so the mapping is mechanical). Added: all three keys are
required together; a partial object is a hard error, because defaulting one rate to a stale gpt-5.4
number would reintroduce the wrong-cost problem the key exists to fix. Codex-only, with the reason
stated (Claude's cost comes from the SDK; the agy lane emits no usage data).

## Codex issue 3 — enumeration source of truth when local and skeleton protocol sets differ — ACCEPTED, FIXED

The strongest of the three. "Discoverable through the four-tier resolver" was hand-waving that isn't
testable.

**Resolution — a new "Key-space discovery" subsection pins one definitive rule**, and the two key
spaces deliberately use *different* set operations:

- `byProtocol` keys = **union** of protocol names across all four tiers. A name visible at any tier
  is a name porch can run, so configuring it is legitimate.
- `modelsByType` keys = **union of `verify.type` from the resolved file only** (tier precedence
  `.codev/` > `codev/` > cache > skeleton). Only the protocol.json that will actually execute
  defines which review types can occur.

The asymmetry is the direct answer to Codex's question: a locally-shadowed protocol contributes its
*name* but only its *own* review types — the shadowed skeleton copy's types do not leak in.
Scenario 16 tests exactly this divergence case, in both directions.

---

## Claude comment 1 (pricing shape not in Desired State) — same as Codex 2, fixed there.
## Claude comment 2 (metrics migration framed as "proposed" not decided) — ACCEPTED, FIXED

Promoted from Open Questions into Desired State as a firm in-scope decision: idempotent
`ALTER TABLE ADD COLUMN` guarded by `PRAGMA table_info`, `model` column keeps its lane-name meaning
so `consult stats`' `GROUP BY model` is unaffected. Scenario 13 now also asserts the migration is
re-runnable and preserves existing rows.

## Claude comment 3 (`modelsByType` has the same discovery problem as `byProtocol`) — ACCEPTED, FIXED

Correct, and the observation about `investigation` / `critique` existing only in RESEARCH's
`verify.type` is what makes a hardcoded type list untenable. The new discovery rule covers both key
spaces explicitly rather than discussing only `byProtocol`.

## Claude comment 4 (is `hermes` a valid `consult.models` key?) — ACCEPTED, FIXED

Genuinely ambiguous in the draft. **Resolved: no.** The hermes backend is invoked as `hermes chat -q`
and exposes no model selector, so accepting the key would silently do nothing — the failure mode
this spec is built to prevent. `consult.models.hermes` is a hard error naming the three lanes that
do accept ids; `hermes` remains a valid *lane name* in `porch.consultation.*` lists. Stated in
Desired State, in Success Criteria, and tested by scenario 17.

---

## Net changes to the spec

- Desired State: `consult.pricing.codex` added to the JSON example with full field list; new
  paragraphs on which lanes accept ids (hermes excluded) and on pricing-key completeness.
- Fail-fast semantics: partial-pricing error added; unknown-key behavior stated as hard error with
  no warn mode; new "Key-space discovery" subsection defining both key spaces exactly.
- Cost and observability: metrics migration promoted to a decided, in-scope requirement.
- Success Criteria: three new criteria (unknown-key hard error, hermes key rejection, pricing
  completeness); metrics criterion tightened to cover migration idempotency.
- Open Questions → Important: all four resolved and marked, plus the new hermes question, retained
  with their resolutions so the reasoning survives.
- Test Scenarios: 15 → 17 (key-space discovery incl. the shadowed-protocol case; hermes lane keys);
  scenarios 13 and 14 tightened.
- Risks: the "enumeration proves brittle" mitigation no longer names a warn-and-continue fallback.
