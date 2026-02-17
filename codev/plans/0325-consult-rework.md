# Plan: Consult CLI Rework

## Metadata
- **ID**: 325
- **Status**: draft
- **Specification**: codev/specs/0325-consult-rework.md
- **Created**: 2026-02-16

## Executive Summary

Rewrite the consult CLI from positional subcommands (`consult -m gemini spec 42`) to flag-based mode routing (`consult -m gemini --protocol spir --type spec`). Three modes: general (ad-hoc prompts), protocol-based (structured reviews with auto-detected context), and stats (unchanged). Key improvements: protocol-owned prompt templates, PR reviews via diff, Gemini file access via `--yolo` + cwd.

Four phases: (1) migrate prompt templates into protocol directories and update protocol.json verify.type values, (2) rewrite the consult CLI with new mode routing and context resolution, (3) update porch command generation, (4) documentation and cleanup.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "prompt-migration", "title": "Prompt template & protocol.json migration"},
    {"id": "cli-rewrite", "title": "CLI rewrite — mode routing, context resolution, Gemini file access"},
    {"id": "porch-integration", "title": "Porch command generation update"},
    {"id": "docs-cleanup", "title": "Documentation & cleanup"}
  ]
}
```

## Phase Breakdown

### Phase 1: Prompt template & protocol.json migration
**Dependencies**: None

#### Objectives
- Move review prompt templates from shared `codev/consult-types/` into protocol-specific `consult-types/` directories
- Create new prompt directories for tick and maintain protocols
- Update `verify.type` values in all protocol.json files (both `codev/` and `codev-skeleton/`)

#### Files

**Create (protocol-specific consult-types):**
- `codev/protocols/spir/consult-types/spec-review.md` — copy from `codev/consult-types/spec-review.md`
- `codev/protocols/spir/consult-types/plan-review.md` — copy from `codev/consult-types/plan-review.md`
- `codev/protocols/spir/consult-types/impl-review.md` — copy from `codev/consult-types/impl-review.md`
- `codev/protocols/spir/consult-types/pr-review.md` — copy from `codev/consult-types/pr-ready.md` (renamed)
- `codev/protocols/spir/consult-types/phase-review.md` — copy of impl-review.md
- `codev/protocols/bugfix/consult-types/impl-review.md` — copy from shared
- `codev/protocols/bugfix/consult-types/pr-review.md` — copy from pr-ready.md (renamed)
- `codev/protocols/tick/consult-types/spec-review.md` — copy from shared
- `codev/protocols/tick/consult-types/plan-review.md` — copy from shared
- `codev/protocols/tick/consult-types/impl-review.md` — copy from shared
- `codev/protocols/tick/consult-types/pr-review.md` — copy from pr-ready.md (renamed)
- `codev/protocols/maintain/consult-types/impl-review.md` — copy from shared
- `codev/protocols/maintain/consult-types/pr-review.md` — copy from pr-ready.md (renamed)

**Mirror in skeleton:**
- `codev-skeleton/protocols/spir/consult-types/` — same files as above
- `codev-skeleton/protocols/bugfix/consult-types/` — same files
- `codev-skeleton/protocols/tick/consult-types/` — same files
- `codev-skeleton/protocols/maintain/consult-types/` — same files

**Remove (old shared prompts):**
- `codev/consult-types/spec-review.md`
- `codev/consult-types/plan-review.md`
- `codev/consult-types/impl-review.md`
- `codev/consult-types/pr-ready.md`
- `codev-skeleton/consult-types/spec-review.md`
- `codev-skeleton/consult-types/plan-review.md`
- `codev-skeleton/consult-types/impl-review.md`
- `codev-skeleton/consult-types/pr-ready.md`

**Keep (shared):**
- `codev/consult-types/integration-review.md` — shared across protocols
- `codev-skeleton/consult-types/integration-review.md`

**Modify (protocol.json verify.type values):**
- `codev/protocols/spir/protocol.json` — specify: `spec-review` → `spec`, plan: `plan-review` → `plan`, implement: `impl-review` → `impl`, review: `pr-ready` → `pr`
- `codev/protocols/bugfix/protocol.json` — `impl-review` → `impl`
- `codev/protocols/maintain/protocol.json` — `impl-review` → `impl`
- `codev-skeleton/protocols/spir/protocol.json` — same changes as above
- `codev-skeleton/protocols/bugfix/protocol.json` — same
- `codev-skeleton/protocols/maintain/protocol.json` — same

**Modify (protocol-schema.json):**
- `codev-skeleton/protocols/protocol-schema.json` — update `verify.type` enum to match new values

#### Acceptance Criteria
- [ ] Each protocol has its own `consult-types/` directory with correct prompt files
- [ ] Old shared files removed (except `integration-review.md`)
- [ ] All protocol.json `verify.type` values use new short names (spec, plan, impl, pr)
- [ ] Skeleton mirrors all changes
- [ ] `integration-review.md` remains in shared `codev/consult-types/`

---

### Phase 2: CLI rewrite — mode routing, context resolution, Gemini file access
**Dependencies**: Phase 1

#### Objectives
- Rewrite `packages/codev/src/commands/consult/index.ts` with new mode-based architecture
- Update `packages/codev/src/cli.ts` Commander.js registration
- Implement context resolution for both builder and architect modes
- Add PR diff fetching for `--type pr` reviews
- Enable Gemini file access via cwd setting

#### Files

**Rewrite:**
- `packages/codev/src/commands/consult/index.ts` — Complete rewrite of the main entry point

**Modify:**
- `packages/codev/src/cli.ts` — Update Commander.js registration (remove positional subcommand, add new flags)

#### Implementation Details

**Mode detection** (in order of precedence):
1. If first arg is `stats` → stats mode (delegate to existing `handleStats`)
2. If `--type` is present → protocol mode
3. If `--prompt` or `--prompt-file` is present → general mode
4. If none → error with usage help

**Input validation:**
- `--prompt` + `--type` together → error (mode conflict)
- `--prompt` + `--prompt-file` together → error
- `--protocol` without `--type` → error
- `--protocol` and `--type` validated with `isValidRoleName()` pattern (alphanumeric + hyphens only)

**Context resolution (protocol mode):**

Builder detection: `process.cwd()` contains `/.builders/`. If `--issue` is explicitly provided, override to architect mode.

*Builder context* — extract project ID from porch state:
- Parse `codev/projects/<id>-*/status.yaml` to get project ID and title
- `--type spec`: glob `codev/specs/<id>-*.md`, error on zero/multiple matches
- `--type plan`: glob `codev/plans/<id>-*.md`, same error handling
- `--type impl`: `git diff $(git merge-base HEAD main)` for full diff stat + file list
- `--type pr`: `gh pr list --head $(git branch --show-current) --json number --jq '.[0].number'` → fetch PR diff via `gh pr diff <N>`
- `--type phase`: read `current_plan_phase` from status.yaml, use `git show HEAD` for phase-scoped diff
- `--type integration`: same as pr with integration template

*Architect context* — require `--issue <N>`:
- `--type spec`: glob `codev/specs/<N>-*.md`
- `--type plan`: glob `codev/plans/<N>-*.md`
- `--type impl`: find PR via `gh pr list --search "<N>"`, get branch, diff from merge-base
- `--type pr`: find PR via `gh pr list --search "<N>"`, fetch diff via `gh pr diff`
- `--type phase`: error ("phases only exist in builders")
- `--type integration`: same as pr with integration template

**Prompt resolution:**
1. If `--protocol` given → read `codev/protocols/<protocol>/consult-types/<type>-review.md`
2. If `--type` alone → read `codev/consult-types/<type>-review.md`
3. Error if file not found

**Role construction:**
- Load `codev/roles/consultant.md` as base role (same as today)
- Append resolved prompt template
- For general mode: no template, just the prompt/prompt-file content as the query

**Query construction per type:**
- `spec`: file path in prompt, model reads from disk
- `plan`: file path + spec path in prompt, model reads from disk
- `impl`: diff stat + changed file list + spec/plan paths in prompt, model reads from disk
- `pr`: PR metadata + full diff (`gh pr diff`) + changed file list in prompt, model reads from disk
- `phase`: phase-scoped diff (`git show HEAD`) + spec/plan/phase context in prompt
- `integration`: same as pr with integration template

**PR review changes:**
- Include full `gh pr diff <N>` output in the prompt (not just file names)
- Model still reads files from disk for surrounding context

**Gemini file access:**
- Already uses `cwd: workspaceRoot` when spawning (line 643)
- Already uses `--yolo` which auto-approves tool calls including file reading
- Add instruction to prompt: "You have file access. Read files directly from disk to review code."
- Remove the `--output-format json` flag — let Gemini output text directly (structured JSON parsing was fragile)

**Preserved behavior:**
- Model aliases (pro, gpt, opus)
- Claude SDK nesting guard bypass (CLAUDECODE env var)
- Codex SDK integration (read-only sandbox)
- Metrics recording (same schema, map new type values to reviewType field)
- `process.exit(0)` in cli.ts (preserved)
- Context prepend for iteration > 1

**Removed:**
- `--role` / `-r` flag and custom role loading (`loadCustomRole`, `listAvailableRoles`)
- `--dry-run` / `-n` flag and all dry-run code paths
- Positional subcommand parsing
- `loadReviewTypePrompt` with skeleton fallback cascade (replaced by direct path resolution)
- `VALID_REVIEW_TYPES` constant (replaced by path-based validation)

#### Acceptance Criteria
- [ ] `consult -m gemini --prompt "test"` invokes Gemini with the prompt
- [ ] `consult -m codex --prompt-file test.md` reads file and sends to Codex
- [ ] `consult -m claude --protocol spir --type spec` auto-detects spec in builder worktree
- [ ] `consult -m gemini --protocol spir --type pr` includes PR diff in prompt
- [ ] `consult -m codex --protocol spir --type phase` scopes to current phase commit
- [ ] `consult -m gemini --type integration` uses shared integration-review.md
- [ ] `consult -m claude --protocol spir --type spec --issue 42` works from architect
- [ ] Mode conflicts error cleanly
- [ ] Metrics recording works with new structure
- [ ] Gemini prompt includes file access instruction

---

### Phase 3: Porch command generation update
**Dependencies**: Phase 2

#### Objectives
- Update porch's consult command generation to match the new CLI format
- Remove `getConsultArtifactType()` function (no longer needed — porch reads type from protocol.json)
- Verify porch-generated commands work end-to-end

#### Files

**Modify:**
- `packages/codev/src/commands/porch/next.ts` — Lines ~427-481: rewrite consult command generation

#### Implementation Details

**Current porch command format (line 445-446):**
```typescript
`consult --model ${m} --type ${verifyConfig.type}${planPhaseFlag}${contextFlag} --protocol ${state.protocol} --project-id ${state.id} --output "${outputPath}" ${consultType} ${state.id}`
```

**New format:**
```typescript
`consult -m ${m} --protocol ${state.protocol} --type ${verifyConfig.type}${planPhaseFlag}${contextFlag} --project-id ${state.id} --output "${outputPath}"`
```

Key changes:
- Remove positional args (`${consultType} ${state.id}`) — no longer needed
- `verifyConfig.type` now contains short values (`spec`, `plan`, `impl`, `pr`) from updated protocol.json
- `--model` shortened to `-m`
- Remove `getConsultArtifactType()` function — its mapping is no longer needed since protocol.json verify.type values match the `--type` flag directly
- Same changes apply to partial review regeneration (line ~480-481)

#### Acceptance Criteria
- [ ] Porch generates valid new-format consult commands
- [ ] Partial review regeneration uses same new format
- [ ] No references to removed positional subcommand
- [ ] `getConsultArtifactType()` removed
- [ ] Build succeeds (`npm run build`)

---

### Phase 4: Documentation & cleanup
**Dependencies**: Phase 3

#### Objectives
- Rewrite CLI documentation for consult command
- Update CLAUDE.md/AGENTS.md consultation examples
- Clean up any remaining references to old format

#### Files

**Rewrite:**
- `codev/resources/commands/consult.md` — Full rewrite with new command format
- `codev-skeleton/resources/commands/consult.md` — Mirror of above

**Modify:**
- `CLAUDE.md` — Update `consult` command examples in the CLI Command Reference section
- `AGENTS.md` — Same updates (must match CLAUDE.md)
- `codev-skeleton/CLAUDE.md` — Update if it has consult examples
- `codev-skeleton/AGENTS.md` — Same

#### Acceptance Criteria
- [ ] `consult.md` documents all three modes with examples
- [ ] CLAUDE.md/AGENTS.md examples use new format
- [ ] No references to old positional subcommands in docs
- [ ] No references to removed flags (--role, --dry-run)

## Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Gemini file access doesn't work with --yolo | Low | Medium | Verify during Phase 2; fallback to passing file contents in prompt |
| Porch generates commands before consult is updated | Medium | High | Phase ordering: consult rewrite (Phase 2) before porch update (Phase 3) |
| Protocol.json changes break other porch logic | Low | Medium | Grep for all verify.type references before changing |
| Missing prompt templates cause runtime errors | Low | High | Phase 1 copies all files before Phase 2 removes old resolution |

## Validation Checkpoints
1. **After Phase 1**: All protocol directories have consult-types/, old shared files removed, protocol.json updated. Build succeeds.
2. **After Phase 2**: `consult -m gemini --prompt "test"` and `consult -m codex --protocol spir --type spec` work. Build succeeds.
3. **After Phase 3**: Full porch → consult pipeline works. `porch next` generates valid commands.
4. **After Phase 4**: Documentation is consistent with implementation.
