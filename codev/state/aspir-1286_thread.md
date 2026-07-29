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
