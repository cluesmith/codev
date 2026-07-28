# Spec 1252 — Shadow-tree local-unique content audit (M11)

<!--
  GENERATED + HAND-CLASSIFIED (Phase 2). The row set and `Divergence` column
  are mechanical (files present in BOTH codev/<sub> and the installed skeleton,
  byte-compared); `Classification`, `Terminal state`, and `Ruling / note` are
  the audited judgments. T11 (shadow-tree-audit.test.ts) PARSES THIS TABLE —
  keep it a fixed 6-column pipe table with Classification in {rot,local-unique}
  and Terminal state in {TS1,TS2,TS3,TS4,pending}. Narrative goes BELOW the
  table, never inside it.
-->

## Count correction vs the spec

The spec said **76** shadow copies. The mechanical enumeration finds **77**:
the spec's count missed `consult-types/integration-review.md` (the drift
audit's `FRAMEWORK_DRIFT_DIRS` covers `protocols`, `roles`, AND
`consult-types`). 74 protocols-tree files (63 .md + 11 .json), 3 roles, 1
consult-types. Drifted: 17, matching the spec.

## Classification method (D1/D2)

- **rot** — local lags the skeleton (missing content, stale references,
  superseded structure). Evidence recorded per row. → TS1: reconcile to
  skeleton (Phase 3), delete with the tree (Phase 4).
- **local-unique** — content present locally, absent from the skeleton, that
  plausibly encodes codev-specific functionality. → **escalated to the
  architect; nothing overwritten or deleted until ruled** (blocking for that
  file only).
- Ambiguity defaults to local-unique/escalate per D2.

Every hunk of each drifted file was classified, not just the file as a whole
(a local-unique paragraph inside an otherwise-rotted file is exactly the loss
M11 exists to prevent). Key evidence used:

- **TICK is retired**: no `tick/` protocol dir exists in either tree; porch
  source references it only in one stale test; the porch skill text naming
  TICK is stale. All TICK references in local copies are therefore rot. (But
  note: the skeleton's own porch phase prompts still emit TICK-amendment
  language — upstream inconsistency, flagged for Phase 8's governance sweep.)
- **Obsolete gate IDs**: local `spir/protocol.md`'s retained porch section uses
  `spec_approval` (underscore) — porch's actual gate is `spec-approval`. The
  "local additions" predate the skeleton's restructure; they are what the
  skeleton deleted, not new content.
- **architect.md**: the skeleton *generalized* the labels section to
  `<prefix>/` placeholders for adopters; the codev-specific `area/` recipes the
  local copy hardcodes are already owned by CLAUDE.md (single-owner rule), so
  taking the skeleton loses nothing.

## Audit table (77 rows)

| # | File | Divergence | Classification | Terminal state | Ruling / note |
|---|---|---|---|---|---|
| 1 | `consult-types/integration-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 2 | `protocols/air/builder-prompt.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 3 | `protocols/air/consult-types/impl-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 4 | `protocols/air/consult-types/pr-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 5 | `protocols/air/prompts/implement.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 6 | `protocols/air/prompts/pr.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 7 | `protocols/air/protocol.json` | differs | local-unique | pending | cwd: packages/codev x3 — functional monorepo check cwd; sanctioned home is .codev/config.json porch.checks (Spec #550). ESCALATED. |
| 8 | `protocols/air/protocol.md` | differs | rot | TS1 | 1-line delta; skeleton wording current |
| 9 | `protocols/aspir/builder-prompt.md` | differs | rot | TS1 | missing Multi-PR Mechanics + Verify Phase sections (skeleton has them) |
| 10 | `protocols/aspir/consult-types/impl-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 11 | `protocols/aspir/consult-types/phase-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 12 | `protocols/aspir/consult-types/plan-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 13 | `protocols/aspir/consult-types/pr-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 14 | `protocols/aspir/consult-types/spec-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 15 | `protocols/aspir/prompts/implement.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 16 | `protocols/aspir/prompts/plan.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 17 | `protocols/aspir/prompts/review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 18 | `protocols/aspir/prompts/specify.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 19 | `protocols/aspir/protocol.json` | differs | local-unique | pending | max_iterations 8 (local) vs 3 (skeleton) x5 — CMAP loop bound. ESCALATED. |
| 20 | `protocols/aspir/protocol.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 21 | `protocols/aspir/templates/plan.md` | differs | rot | TS1 | local-only TICK Amendments section; TICK retired (no protocol dir in either tree; porch refs only in one stale test) |
| 22 | `protocols/aspir/templates/review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 23 | `protocols/aspir/templates/spec.md` | differs | rot | TS1 | same TICK Amendments section |
| 24 | `protocols/bugfix/builder-prompt.md` | differs | rot | TS1 | local says SPIR/TICK; TICK retired |
| 25 | `protocols/bugfix/consult-types/impl-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 26 | `protocols/bugfix/consult-types/pr-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 27 | `protocols/bugfix/prompts/fix.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 28 | `protocols/bugfix/prompts/investigate.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 29 | `protocols/bugfix/prompts/pr.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 30 | `protocols/bugfix/protocol.json` | differs | local-unique | pending | cwd: packages/codev x2 — same as air. ESCALATED. |
| 31 | `protocols/bugfix/protocol.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 32 | `protocols/experiment/builder-prompt.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 33 | `protocols/experiment/protocol.json` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 34 | `protocols/experiment/protocol.md` | differs | rot | TS1 | local TICK handoff section; TICK retired |
| 35 | `protocols/experiment/templates/notes.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 36 | `protocols/maintain/builder-prompt.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 37 | `protocols/maintain/consult-types/impl-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 38 | `protocols/maintain/consult-types/pr-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 39 | `protocols/maintain/prompts/maintain.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 40 | `protocols/maintain/prompts/review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 41 | `protocols/maintain/protocol.json` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 42 | `protocols/maintain/protocol.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 43 | `protocols/maintain/templates/maintenance-run.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 44 | `protocols/pir/builder-prompt.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 45 | `protocols/pir/consult-types/impl-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 46 | `protocols/pir/consult-types/pr-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 47 | `protocols/pir/prompts/implement.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 48 | `protocols/pir/prompts/plan.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 49 | `protocols/pir/prompts/review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 50 | `protocols/pir/protocol.json` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 51 | `protocols/pir/protocol.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 52 | `protocols/protocol-schema.json` | differs | rot | TS1 | local example lists tick; TICK retired |
| 53 | `protocols/research/builder-prompt.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 54 | `protocols/research/protocol.json` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 55 | `protocols/research/protocol.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 56 | `protocols/spike/builder-prompt.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 57 | `protocols/spike/protocol.json` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 58 | `protocols/spike/protocol.md` | differs | rot | TS1 | local mentions TICK; TICK retired |
| 59 | `protocols/spike/templates/findings.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 60 | `protocols/spir/builder-prompt.md` | differs | rot | TS1 | THE HEADLINE DRIFT: local missing Multi-PR Mechanics + Verify Phase + "Entering verify phase." string |
| 61 | `protocols/spir/consult-types/impl-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 62 | `protocols/spir/consult-types/phase-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 63 | `protocols/spir/consult-types/plan-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 64 | `protocols/spir/consult-types/pr-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 65 | `protocols/spir/consult-types/spec-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 66 | `protocols/spir/prompts/implement.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 67 | `protocols/spir/prompts/plan.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 68 | `protocols/spir/prompts/review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 69 | `protocols/spir/prompts/specify.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 70 | `protocols/spir/protocol.json` | differs | local-unique | pending | max_iterations 8 vs 3 x5 — same as aspir. ESCALATED. |
| 71 | `protocols/spir/protocol.md` | differs | rot | TS1 | local keeps pre-restructure porch section with obsolete underscore gate IDs (spec_approval); skeleton moved to build-verify model |
| 72 | `protocols/spir/templates/plan.md` | differs | rot | TS1 | local-only TICK Amendments section; TICK retired |
| 73 | `protocols/spir/templates/review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 74 | `protocols/spir/templates/spec.md` | differs | rot | TS1 | same TICK Amendments section |
| 75 | `roles/architect.md` | differs | rot | TS1 | skeleton generalized labels section to <prefix>/ placeholders; codev-specific area/ recipes already owned by CLAUDE.md — no content lost |
| 76 | `roles/builder.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 77 | `roles/consultant.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
## Local-only entries (NOT shadow copies — preserved, T8)

| File | Why it survives |
|---|---|
| `codev/protocols/release/` (whole dir) | Genuine local-only protocol; no skeleton counterpart |
| `codev/protocols/maintain/templates/audit-report.md` | Local-only template; no skeleton counterpart |
| `codev/protocols/maintain/templates/lessons-learned.md` | Local-only template; no skeleton counterpart |

## Open escalations (4 files, 2 questions)

Sent to the architect via afx send (Phase 2). Blocking those 4 files only;
the 13 rot files proceed to Phase 3 reconciliation.

1. **max_iterations 8 (local) vs 3 (skeleton)** — `spir/protocol.json`,
   `aspir/protocol.json`. Behavioral: bounds the CMAP iterate-until-approve
   loop. No config override exists for this field. Options: accept skeleton's 3
   (TS1); retain forked json codev-only (TS3, allowlisted); promote 8 into the
   skeleton (TS2).
2. **`"cwd": "packages/codev"` in check commands** — `air/protocol.json`,
   `bugfix/protocol.json`. Functional: monorepo check cwd. The sanctioned
   mechanism is `.codev/config.json` → `porch.checks` cwd overrides (Spec
   #550), which this repo does not currently use. Recommended: migrate cwd to
   config (making spir/aspir/air/bugfix consistent), then take skeleton json —
   TS1-after-migration. Note spir/aspir currently pass only because the repo
   root's package.json happens to have build/test scripts.
