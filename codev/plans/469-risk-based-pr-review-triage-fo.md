# Plan: Risk-Based PR Review Triage for Architect

## Metadata
- **ID**: plan-469
- **Status**: draft
- **Specification**: codev/specs/469-risk-based-pr-review-triage-fo.md
- **Created**: 2026-02-21

## Executive Summary

Implement the risk-based PR review triage system in two phases: first the CLI `consult risk` command that assesses PR risk and recommends review depth, then the documentation updates to the architect role, workflow reference, and a new risk triage guide. This follows Approach 1 from the spec (documentation-first with CLI risk assessment).

## Success Metrics
- [ ] `consult risk pr <N>` correctly assesses risk level based on diff stats and subsystem paths
- [ ] Risk assessment uses "highest factor wins" precedence
- [ ] Architect role and workflow reference updated with triage framework
- [ ] `codev/resources/risk-triage.md` exists with full subsystem path mappings
- [ ] `consult risk` fails cleanly when `gh` is unavailable or PR not found
- [ ] All existing `consult` commands work unchanged (backwards compatible)
- [ ] Test coverage >90% for risk assessment logic

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "risk_engine", "title": "Risk Assessment Engine"},
    {"id": "documentation", "title": "Documentation Updates"}
  ]
}
```

## Phase Breakdown

### Phase 1: Risk Assessment Engine
**Dependencies**: None

#### Objectives
- Implement the `consult risk pr <N>` subcommand
- Create risk assessment logic with subsystem detection and "highest factor wins" precedence
- Log risk assessments to `.consult/history.log`

#### Deliverables
- [ ] New file: `packages/codev/src/commands/consult/risk.ts` — risk assessment logic
- [ ] Modified: `packages/codev/src/cli.ts` — route `risk` subcommand
- [ ] Modified: `packages/codev/src/commands/consult/index.ts` — export `fetchPRData` for reuse
- [ ] Unit tests for risk calculation
- [ ] Integration test for CLI behavior

#### Implementation Details

**`risk.ts`** — Core module with:
- `assessRisk(prNumber: number): RiskAssessment` — main entry point
  - Calls `gh pr view <N> --json additions,deletions,files` to get diff stats
  - Calls `gh pr diff <N> --name-only` to get file list
  - Computes line count risk (additions + deletions): <100 = low, 100-500 = medium, >500 = high
  - Computes file count risk: 1-3 = low, 4-10 = medium, >10 = high
  - Maps each file path to a subsystem using pattern matching
  - Applies "highest factor wins" across lines, files, and subsystem risk
  - Returns `{ level: 'low' | 'medium' | 'high', lines, files, subsystems, highestFactor, recommendedAction }`
- `SUBSYSTEM_PATTERNS: Array<{ pattern: RegExp; subsystem: string; risk: RiskLevel }>` — ordered list of path→subsystem→risk mappings
- `formatOutput(assessment: RiskAssessment): string` — formats the human-readable output with risk level, breakdown, and recommended commands

**CLI routing** (`cli.ts`):
- Add `risk` case to the subcommand switch in the consult action handler
- **Commander argument parsing**: The current `.argument('[subcommand]')` captures only the first positional. To parse `consult risk pr 83`, access remaining positional args via Commander's `Command` object (the last parameter in the action handler) using `command.args` which collects extra positionals when `.allowUnknownOption(true)` is set. Parse `args[0]` as `'pr'` and `args[1]` as the PR number. Error if format doesn't match `pr <N>`.
- Does not require `-m` flag (risk assessment doesn't invoke models)
- No `--risk` flag is added to existing `consult` commands — backwards compatibility is preserved by design. The spec's "override" capability is not a CLI flag; the architect simply ignores the recommendation and runs whatever commands they choose.

**Reuse existing helpers**:
- `fetchPRData(prNumber)` in `index.ts` already calls `gh pr view` and `gh pr diff --name-only`. Export it for reuse. The returned `info` field is a raw JSON string — the risk module will `JSON.parse(info)` to extract `additions` and `deletions` numeric values.
- Also export `logQuery()` from `index.ts` for logging risk assessments.

**Binary file handling**: `gh pr view --json additions,deletions` reports only text line counts — binary files contribute 0 to additions/deletions. `gh pr diff --name-only` includes binary files in the file list. This is the desired behavior: binary files are excluded from line counts but included in file counts, with no special detection needed.

**Cross-cutting factor**: The spec lists cross-cutting as a 4th risk factor. In practice, cross-cutting changes (shared interfaces, APIs, core modules) are captured by the subsystem path patterns — files in `src/state/`, `src/lib/`, or `protocols/` are inherently cross-cutting and already mapped to medium/high risk. Full import-graph-based cross-cutting detection is deferred as over-engineering for current scale.

**Logging**: Append to `.consult/history.log` with `type=risk` using the existing `logQuery()` function, which accepts arbitrary query text. The log format is a plain text line — no schema constraints.

#### Acceptance Criteria
- [ ] `consult risk pr 83` outputs correct risk level, breakdown, and recommended commands
- [ ] Low-risk output: "No consultation needed. Read PR and merge."
- [ ] Medium-risk output: `consult -m claude --type integration pr N`
- [ ] High-risk output: 3 parallel `consult` commands
- [ ] Unknown PR number fails with clear error
- [ ] Missing `gh` CLI fails with clear error
- [ ] Binary files excluded from line counts, included in file counts
- [ ] Subsystem detection correctly maps paths to risk levels
- [ ] "Highest factor wins" precedence works correctly

#### Test Plan
- **Unit Tests** (`packages/codev/src/commands/consult/__tests__/risk.test.ts`):
  - Risk level calculation from various line/file counts
  - Subsystem pattern matching for all defined patterns
  - "Highest factor wins" precedence with mixed signals
  - Edge cases: 0 lines changed, only deletions, single file, binary-only PR
  - Output formatting for each risk level (low/medium/high recommended commands)
  - Subsystem detection with mixed-risk file lists
- **Integration Tests**:
  - CLI invocation with mock `gh` data (mock `execSync`)
  - Error handling: `gh` not found, PR not found, network failure
  - Verify no `-m` flag required for `consult risk`

#### Rollback Strategy
- Delete `risk.ts`, revert `cli.ts` and `index.ts` changes. No other code depends on the new subcommand.

#### Risks
- **Risk**: `gh pr view` JSON format varies across `gh` versions
  - **Mitigation**: Use only stable fields (`additions`, `deletions`, `files`); test against actual `gh` output

---

### Phase 2: Documentation Updates
**Dependencies**: Phase 1

#### Objectives
- Update architect role with risk triage decision framework
- Update workflow reference to show conditional review at Stage 6
- Create risk triage reference document with subsystem mappings
- Document `consult risk` subcommand in CLI docs
- Update both `codev/` (our instance) and `codev-skeleton/` (template for other projects)

#### Deliverables
- [ ] Modified: `codev/roles/architect.md` — risk triage framework in Section 4
- [ ] Modified: `codev-skeleton/roles/architect.md` — same changes
- [ ] Modified: `codev/resources/workflow-reference.md` — conditional review at Stage 6
- [ ] Modified: `codev-skeleton/resources/workflow-reference.md` — same changes
- [ ] New: `codev/resources/risk-triage.md` — full risk triage reference
- [ ] New: `codev-skeleton/resources/risk-triage.md` — same for skeleton
- [ ] Modified: `codev/resources/commands/consult.md` — document `consult risk` subcommand
- [ ] Modified: `codev-skeleton/resources/commands/consult.md` — same for skeleton (if exists, otherwise create)

#### Implementation Details

**Architect role (`architect.md`)**:
Replace Section 4 "Integration Review" with a risk-based triage section:
1. First step: run `consult risk pr <N>` to assess risk
2. Based on output, follow the triage level:
   - Low: Read PR, summarize, approve and tell builder to merge
   - Medium: Run single-model review (`consult -m claude --type integration pr N`)
   - High: Run 3-way CMAP (existing parallel pattern)
3. Keep existing example of posting findings as PR comment

**Workflow reference (`workflow-reference.md`)**:
Update Stage 6 to show:
```
→ 6. COMMITTED
      Architect assesses PR risk: consult risk pr N
      Low: Read + merge | Medium: 1-model review | High: 3-way CMAP
      Architect iterates with builder via PR comments
      ...
```

**Risk triage guide (`risk-triage.md`)**:
New reference document containing:
- Complete risk criteria table
- Subsystem path mapping table (source of truth for documentation)
- Precedence rule explanation
- Example outputs for each risk level
- Quick reference for the architect

**Consult CLI docs (`consult.md`)**:
Add `risk` subcommand section with synopsis, examples, and options.

#### Acceptance Criteria
- [ ] Architect role documents triage as the first step in integration review
- [ ] Workflow reference shows conditional review depth at Stage 6
- [ ] Risk triage guide has complete subsystem mappings matching code
- [ ] Consult CLI docs include `risk` subcommand with examples
- [ ] `codev/` and `codev-skeleton/` versions are in sync for changed files

#### Test Plan
- **Manual Testing**: Read through all documentation for consistency, completeness, and accuracy
- **Cross-reference**: Verify subsystem patterns in `risk-triage.md` match patterns in `risk.ts`

#### Rollback Strategy
- Revert documentation files to previous versions via git.

#### Risks
- **Risk**: `codev/` and `codev-skeleton/` files drift out of sync
  - **Mitigation**: Update both in the same phase, verify with diff

---

## Dependency Map
```
Phase 1: Risk Engine ──→ Phase 2: Documentation
```

Phase 2 depends on Phase 1 because the documentation references the `consult risk` command and its output format, which must be finalized first.

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| `gh` CLI output format changes | Low | Medium | Test against real `gh` output, use stable JSON fields |
| Subsystem patterns miss new paths | Low | Low | "Highest factor wins" catches most cases; patterns are easy to update |

## Validation Checkpoints
1. **After Phase 1**: `consult risk pr <N>` works on a real PR in the repo
2. **After Phase 2**: All documentation is consistent and cross-references are accurate

## Documentation Updates Required
- [ ] `codev/roles/architect.md` (and skeleton)
- [ ] `codev/resources/workflow-reference.md` (and skeleton)
- [ ] `codev/resources/risk-triage.md` (new, and skeleton)
- [ ] `codev/resources/commands/consult.md` (and skeleton if exists)

## Notes

The plan keeps Phase 1 (CLI) and Phase 2 (docs) separate because the documentation references the CLI output format. By implementing the CLI first, we can write documentation that matches the actual output exactly.

Both `codev/` and `codev-skeleton/` are updated in Phase 2 to ensure that new projects adopting Codev get the risk triage framework out of the box.

---

## Amendment History

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
