# PR Review Risk Triage Guide

Quick reference for the architect's risk-based PR review process. For the full integration review workflow, see `codev/roles/architect.md` Section 4.

## Risk Assessment

When a builder PR arrives, assess risk before choosing review depth.

### Step 1: Check Size and Scope

```bash
gh pr diff --stat <N>
gh pr view <N> --json files | jq '.files[].path'
```

### Step 2: Determine Risk Level

**Precedence: highest factor wins.** If any single factor is high, the overall risk is high.

| Factor | Low | Medium | High |
|--------|-----|--------|------|
| **Lines changed** | < 100 | 100-500 | > 500 |
| **Files touched** | 1-3 | 4-10 | > 10 |
| **Subsystem** | Docs, tests, cosmetic | Features, commands, shared libs | Protocol, state mgmt, security |
| **Cross-cutting** | No shared interfaces | Some shared code | Core interfaces, APIs |

### Step 3: Execute Review

| Risk | Action | Cost |
|------|--------|------|
| **Low** | Read PR, summarize, tell builder to merge | $0 |
| **Medium** | `consult -m claude --type integration pr N` | ~$1-2 |
| **High** | 3-way CMAP (Gemini + Codex + Claude in parallel) | ~$4-5 |

## Subsystem Path Mappings

| Path Pattern | Subsystem | Risk |
|-------------|-----------|------|
| `packages/codev/src/commands/porch/` | Protocol orchestrator | High |
| `packages/codev/src/tower/` | Tower architecture | High |
| `packages/codev/src/state/` | State management | High |
| `codev/protocols/` | Protocol definitions | High |
| `codev-skeleton/protocols/` | Protocol templates | High |
| `packages/codev/src/commands/af/` | Agent Farm commands | Medium |
| `packages/codev/src/commands/consult/` | Consultation system | Medium |
| `packages/codev/src/lib/` | Shared libraries | Medium |
| `packages/codev/src/commands/` (other) | CLI commands | Medium |
| `codev/roles/` | Role definitions | Medium |
| `codev-skeleton/roles/` | Role templates | Medium |
| `codev/resources/` | Documentation | Low |
| `codev/specs/`, `codev/plans/`, `codev/reviews/` | Project artifacts | Low |
| `packages/codev/tests/` | Tests only | Low |
| `*.md` (not in `protocols/`) | Documentation | Low |

## Typical Mappings by Protocol

- **Low**: Most bugfixes, ASPIR features, documentation, UI tweaks, config updates
- **Medium**: SPIR features, new commands, refactors touching 3+ files, new utility modules
- **High**: Protocol changes, porch state machine, Tower architecture, security model changes

**Note:** Protocol type is a heuristic, not the primary signal. An ASPIR PR that changes core state management should still be high-risk. Always check the actual diff.

## Example Workflows

### Low Risk: Bugfix (12 lines, 1 file, tests/)

```bash
$ gh pr diff --stat 120
 packages/codev/tests/unit/foo.test.ts | 12 ++++++------
 1 file changed, 6 insertions(+), 6 deletions(-)

# Low risk — read and approve
gh pr comment 120 --body "## Architect Review

Low-risk test fix. Corrects assertion in foo.test.ts.

---
Architect review"

af send 0042 "PR approved, please merge"
```

### Medium Risk: New Feature (180 lines, 5 files, commands/)

```bash
$ gh pr diff --stat 121
 packages/codev/src/commands/consult/risk.ts | 120 +++++++++++++
 packages/codev/src/cli.ts                    |  15 ++
 packages/codev/tests/unit/risk.test.ts       |  45 +++++
 2 files changed, 180 insertions(+)

# Medium risk — single-model review
consult -m claude --type integration pr 121
```

### High Risk: Protocol Change (650 lines, 14 files, porch/)

```bash
$ gh pr diff --stat 122
 packages/codev/src/commands/porch/run.ts     | 200 ++++++++++++------
 packages/codev/src/commands/porch/next.ts     | 150 ++++++++++----
 packages/codev/src/state/project.ts           |  80 +++++---
 ... 11 more files
 14 files changed, 420 insertions(+), 230 deletions(-)

# High risk — full 3-way CMAP
consult -m gemini --type integration pr 122 &
consult -m codex --type integration pr 122 &
consult -m claude --type integration pr 122 &
wait
```
