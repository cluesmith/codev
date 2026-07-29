# aspir-1286 — consult: configurable per-lane models and per-review-type lane selection

## Specify phase — started

Strict-mode ASPIR builder for issue #1286. No spec existed on spawn, so I'm drafting it.

### Codebase reconnaissance (before drafting)

Hardcoded model pins found:
- `packages/codev/src/commands/consult/index.ts:417-419` — codex lane: `model: 'gpt-5.4'`, `modelReasoningEffort: 'medium'`
- `packages/codev/src/commands/consult/index.ts:558` — claude lane: `model: 'claude-opus-4-6'`
- agy/`gemini` lane (`~line 846`) passes **no** `--model` → agy's default. Confirmed via `agy --help`:
  `--model  Model for the current CLI session` — so the gemini lane *can* take a configured id too.

Lane-selection resolution today:
- `porch/next.ts:63-90` `resolveConsultationModels()` — config `porch.consultation.models` > protocol `verify.models`,
  with special modes `none` / `parent`, validated against `VALID_MODELS`.
- `porch/index.ts:436-452` — a **second, inline, unvalidated copy** of the same precedence logic in `porch done`.
  Single-source-of-truth violation; any new precedence rule must consolidate these or they will drift.

Cost/metrics coupling:
- `CODEX_PRICING` (index.ts:386) is hardcoded to gpt-5.4 rates; Claude cost comes from the SDK (`total_cost_usd`).
- `consultation_metrics.model` stores the **lane name** ('codex'), not the model id — once ids are configurable
  you can no longer tell from metrics which model actually ran.

### Design position going into the spec

Fail-fast is required by the issue, but a **static allowlist of model ids is the wrong mechanism** — it recreates
exactly the rot this issue is about (and this repo's own lesson: never assert a model id doesn't exist from a
cached catalog). Position: validate *shape* and *lane names* strictly; let the provider be the authority on id
validity, and surface provider rejection loudly with a non-zero exit and no fallback to the hardcoded default.

Per-protocol scoping (`byProtocol`) rides along, per the issue's note about PIR's CMAP-2 cost invariant.

## Specify — iteration 1 review

gemini APPROVE · claude APPROVE · **codex REQUEST_CHANGES**. All three Codex issues were real; conceded
and fixed, plus Claude's four non-blocking comments. Rebuttals in
`codev/projects/1286-.../1286-specify-iter1-rebuttals.md`.

Codex's sharpest catch: the draft said unknown `byProtocol`/`modelsByType` keys are a hard error in
Desired State, then offered "loud warning" as a fallback in Open Questions — a real requirement
conflict a builder could have resolved either way. Fixed to hard-error unconditionally.

The one that needed actual design work was Codex's third: "validated against protocols/review types
discoverable through the four-tier resolver" was untestable hand-waving. The resolution is that the
two key spaces need **different set operations**, which wasn't obvious until forced to write it down:

- `byProtocol` keys = **union** of protocol names across all four tiers (any visible name is runnable)
- `modelsByType` keys = `verify.type` from the **resolved** file only, tier precedence applied
  (only the protocol.json that will actually execute defines which review types can occur)

So a locally-shadowed protocol contributes its *name* but not the shadowed skeleton copy's review
types. Scenario 16 tests that divergence in both directions.

Also resolved: `consult.pricing.codex` shape spelled out (all three per-1M rates required together —
a partial object errors, since defaulting one rate to a stale gpt-5.4 number reintroduces the exact
wrong-cost bug the key exists to fix); metrics `ALTER TABLE` migration promoted from "proposed" to
decided and in-scope; `consult.models.hermes` rejected (the `hermes chat -q` backend has no model
selector, so accepting the key would silently do nothing) while `hermes` stays valid as a lane name
in `porch.consultation.*`.

Iteration 2 consultation running.
