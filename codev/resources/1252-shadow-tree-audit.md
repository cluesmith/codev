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
`consult-types`). 73 protocols-tree files (63 .md + 10 .json), 3 roles, 1
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
| 7 | `protocols/air/protocol.json` | identical | local-unique | TS1 | RULED TS1 (architect, 2026-07-28): cwd migrated to .codev/config.json porch.checks (all four protocols); skeleton json taken |
| 8 | `protocols/air/protocol.md` | identical | rot | TS1 | RECONCILED Phase 3 (was: 1-line delta; skeleton wording current) |
| 9 | `protocols/aspir/builder-prompt.md` | identical | rot | TS1 | RECONCILED Phase 3 (was: missing Multi-PR Mechanics + Verify Phase sections (skeleton has them)) |
| 10 | `protocols/aspir/consult-types/impl-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 11 | `protocols/aspir/consult-types/phase-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 12 | `protocols/aspir/consult-types/plan-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 13 | `protocols/aspir/consult-types/pr-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 14 | `protocols/aspir/consult-types/spec-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 15 | `protocols/aspir/prompts/implement.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 16 | `protocols/aspir/prompts/plan.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 17 | `protocols/aspir/prompts/review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 18 | `protocols/aspir/prompts/specify.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 19 | `protocols/aspir/protocol.json` | identical | local-unique | TS1 | RULED TS1 (architect, 2026-07-28): same ruling as spir |
| 20 | `protocols/aspir/protocol.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 21 | `protocols/aspir/templates/plan.md` | identical | rot | TS1 | RECONCILED Phase 3 (was: local-only TICK Amendments section; TICK retired (no protocol dir in either tree; porch refs only in one stale test)) |
| 22 | `protocols/aspir/templates/review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 23 | `protocols/aspir/templates/spec.md` | identical | rot | TS1 | RECONCILED Phase 3 (was: same TICK Amendments section) |
| 24 | `protocols/bugfix/builder-prompt.md` | identical | rot | TS1 | RECONCILED Phase 3 (was: local says SPIR/TICK; TICK retired) |
| 25 | `protocols/bugfix/consult-types/impl-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 26 | `protocols/bugfix/consult-types/pr-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 27 | `protocols/bugfix/prompts/fix.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 28 | `protocols/bugfix/prompts/investigate.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 29 | `protocols/bugfix/prompts/pr.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 30 | `protocols/bugfix/protocol.json` | identical | local-unique | TS1 | RULED TS1 (architect, 2026-07-28): same ruling as air |
| 31 | `protocols/bugfix/protocol.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 32 | `protocols/experiment/builder-prompt.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 33 | `protocols/experiment/protocol.json` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 34 | `protocols/experiment/protocol.md` | identical | rot | TS1 | RECONCILED Phase 3 (was: local TICK handoff section; TICK retired) |
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
| 52 | `protocols/protocol-schema.json` | identical | rot | TS1 | RECONCILED Phase 3 (was: local example lists tick; TICK retired) |
| 53 | `protocols/research/builder-prompt.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 54 | `protocols/research/protocol.json` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 55 | `protocols/research/protocol.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 56 | `protocols/spike/builder-prompt.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 57 | `protocols/spike/protocol.json` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 58 | `protocols/spike/protocol.md` | identical | rot | TS1 | RECONCILED Phase 3 (was: local mentions TICK; TICK retired) |
| 59 | `protocols/spike/templates/findings.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 60 | `protocols/spir/builder-prompt.md` | identical | rot | TS1 | RECONCILED Phase 3 (was: THE HEADLINE DRIFT: local missing Multi-PR Mechanics + Verify Phase + "Entering verify phase." string) |
| 61 | `protocols/spir/consult-types/impl-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 62 | `protocols/spir/consult-types/phase-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 63 | `protocols/spir/consult-types/plan-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 64 | `protocols/spir/consult-types/pr-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 65 | `protocols/spir/consult-types/spec-review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 66 | `protocols/spir/prompts/implement.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 67 | `protocols/spir/prompts/plan.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 68 | `protocols/spir/prompts/review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 69 | `protocols/spir/prompts/specify.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 70 | `protocols/spir/protocol.json` | identical | local-unique | TS1 | RULED TS1 (architect, 2026-07-28): accept skeleton max_iterations 3 — B2 evidence (rounds 1-2, mean 1.12) persuasive; >3 rounds is a human-attention moment |
| 71 | `protocols/spir/protocol.md` | identical | rot | TS1 | RECONCILED Phase 3 (was: local keeps pre-restructure porch section with obsolete underscore gate IDs (spec_approval); skeleton moved to build-verify model) |
| 72 | `protocols/spir/templates/plan.md` | identical | rot | TS1 | RECONCILED Phase 3 (was: local-only TICK Amendments section; TICK retired) |
| 73 | `protocols/spir/templates/review.md` | identical | rot | TS1 | byte-identical redundant copy; nothing to lose |
| 74 | `protocols/spir/templates/spec.md` | identical | rot | TS1 | RECONCILED Phase 3 (was: same TICK Amendments section) |
| 75 | `roles/architect.md` | identical | rot | TS1 | RECONCILED Phase 3 (was: skeleton generalized labels section to <prefix>/ placeholders; codev-specific area/ recipes already owned by CLAUDE.md — no content lost) |
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

## M7 compatibility audit — COMPLETE (Phase 4, step 4a)

Repo-wide classification of every literal `codev/protocols/` / `codev/roles/`
reference. Production consumers were audited in spec Appendix B (all
resolver-routed or inert). This completes the test tier and non-TypeScript
consumers, as M7 requires before any deletion.

### Test tier — 4 real repo-readers (MUST repoint at `codev-skeleton/` in the deletion commit)

| Test | What it reads | Fix |
|---|---|---|
| `baked-decisions.test.ts` | `codev/protocols/{spir,aspir,air}/builder-prompt.md` + prompt files (Spec 746 PHASE lists) | repoint `relPath` entries to `codev-skeleton/...`; skeleton mirror entries collapse to the same path |
| `bugfix-742-consult-templates.test.ts` | 4 consult-type files under `codev/protocols/{bugfix,spir}` | repoint `repoRoot` joins to `codev-skeleton/` |
| `protocol-prompt-audit.test.ts` | walks `codev/protocols/` wholesale | walk `codev-skeleton/protocols/` |
| `bugfix-685-close-keyword.test.ts` | 6 prompt files across protocols | repoint table to `codev-skeleton/` |

After deletion, `codev-skeleton/` is the single in-repo source (the installed
skeleton is its build-time copy), so repointing keeps these tests validating
the same content agents are served — no assertion weakens.

### Test tier — safe (temp fixtures or string literals only)

`consult.test.ts`, `pr-gate-audit.test.ts` (both build `codev/` trees inside
temp roots), `porch/protocol.test.ts`, `protocol-overrides.test.ts`,
`roles.test.ts`, `spawn-roles.test.ts`, `af-architect.test.ts`,
`tower-utils.test.ts`, `bugfix-527`, `bugfix-744`, `bugfix-619`,
`governance-sweep.test.ts` (strings/paths in messages only),
`framework-ref-audit.test.ts` (scans the skeleton by design).

### Non-TypeScript consumers

| File | Kind | Deletion-safe? |
|---|---|---|
| `scripts/measure-prompt-surface.sh` | two-tier resolve (`codev/` then `codev-skeleton/`) — this project's own script, built deletion-aware | **Yes** — falls through to skeleton |
| `apps/vscode/scripts/publish.sh:15` | comment referencing `codev/protocols/release/` | **Yes** — and `release/` is preserved anyway |

No other shell/yaml/json consumer found outside `node_modules`/`dist`/worktrees.

### Verdict

Deletion is safe once (a) the four repo-reading tests are repointed in the same
commit, and (b) the four ESCALATED json rulings resolve. No production code
path reads the shadow tree by literal path.

## Escalation rulings (architect, 2026-07-28)

- **E1 → TS1**: skeleton's `max_iterations: 3` accepted for spir + aspir. The
  B2 baseline evidence (rounds run 1–2, mean 1.12) was the deciding factor —
  ">3 rounds is a human-attention moment, not an automation moment."
- **E2 → migrate-then-TS1**: `cwd` moved to `.codev/config.json` →
  `porch.checks` for **all four** protocols; skeleton jsons taken.

## E2 config-reach verification (required by the ruling)

`.codev/config.json` is untracked (`.gitignore:11`), so the ruling required
verifying the config reaches every context that runs porch checks before
classifying E2 resolved. Verified against code, not assumption:

| Context | Mechanism | Verified |
|---|---|---|
| Builder worktrees (future spawns) | `spawn-worktree.ts:100–113` symlinks main's `.codev/config.json` into every new worktree when it exists | code read |
| Builder worktrees (existing) | `afx setup <id>` re-applies symlinks; independently covered by the fallback below | docs + fallback |
| Main checkout | file must be created there once (snippet sent to the architect — a builder cannot write outside its worktree) | fallback covers the gap meanwhile |
| Fresh clone (no config anywhere) | porch runs checks at the workspace root; **root `package.json` delegates** `build`/`test` to `packages/codev` via pnpm filters | **empirically proven** — spir/aspir checks ran cwd-less at this worktree's root, green, all session |
| CI | `.github/workflows/test.yml` never invokes porch checks (it only excludes porch e2e dirs from a vitest run) | grep of workflows |

**Key finding: the migration is defense-in-depth, not load-bearing.** Every
context has a working fallback (root delegation) even with no config file
anywhere, so no context can break. No escalate-back needed. This worktree's
`.codev/config.json` now carries the overrides
(`build/test/e2e_tests/build_succeeds/tests_pass → cwd: packages/codev`).

## M7 correction (Phase 4b): 8 repo-reading tests, not 4

The step-4a classification used a path-construction regex and had **four false
negatives** — tests that read `codev/protocols/*` via `path.join` segments,
template literals, or `__dirname` traversal that the regex missed:
`bugfix-744-spir-pr-strategy`, `governance-sweep`, `review-prompt-routing`
(iterated both trees), and `bugfix-619-aspir-prompt`. The deletion itself
caught them (ENOENT), which is the correct failure mode — loud, at the point
of change. All eight are now repointed at `codev-skeleton/`; mirror-parity
constructs collapsed to skeleton-only with explanatory comments. Lesson for
the review: a grep classification of consumers is a hypothesis, not a proof —
the deletion is the test.

## Phase 4 result

- 77 shadow copies deleted; `codev/roles/` and `codev/consult-types/` removed
  entirely; `codev/protocols/` retains only the three preserved local-only
  files (`release/protocol.md`, `maintain/templates/{audit-report,lessons-learned}.md`).
- `copyRoles`/`copyProtocols` (124 lines) removed from `scaffold.ts` with a
  tombstone comment; `copyRoles` test block removed.
- M10 equivalence: `shadow-removal-manifest.json` (77 pre-deletion sha256s) +
  `shadow-removal-equivalence.test.ts` prove the resolver serves byte-identical
  content post-deletion. Assembled-prompt equivalence follows because
  `renderTemplate` is a pure function of the resolved template.
- Allowlist: **empty**. Drift gate: zero findings. All T11 guards green with
  zero pending rows.

## Phase 4 iter-2 additions

- `codev/protocols/release/protocol.md:43` repointed (`cat codev-skeleton/...`)
  — the M7 sweep had not audited codev/'s own preserved content. Verified no
  other fetch of deleted paths exists in preserved files.
- **Deferred to Phase 8 (recorded so it is not lost)**: `CLAUDE.md`/`AGENTS.md`
  contain ~10 prose references to deleted `codev/protocols/...` paths
  (available-protocol listing, RELEASE pointer, SPIR instruction). References,
  not fetches; both files receive Phase 5/7/8 edits where these repoint to
  `codev-skeleton/` (or resolver-neutral wording) as part of governance sync.
