# Review: Documentation Audit for v2.0.7

## Metadata
- **Date**: 2026-02-17
- **Specification**: codev/specs/386-documentation-audit.md
- **Plan**: codev/plans/386-documentation-audit.md

## Executive Summary

Comprehensive audit and update of all public-facing and developer-facing markdown documentation across three tiers: public (GitHub visitors), developer reference (architects/builders), and skeleton templates (shipped to other projects). Eliminated all stale references to removed technologies (tmux, ttyd, state.json, ports.json) and outdated CLI syntax (npx agent-farm, codev tower, af spawn -p) across 30+ files. Created missing release notes for v2.0.1, v2.0.2, and v2.0.6. Added deprecation notices to obsolete files.

## Spec Compliance

### Success Criteria Assessment
| Criterion | Status | Notes |
|-----------|--------|-------|
| Root README.md exists with required sections | ✅ | Already existed; audited and fixed stale references |
| CHANGELOG.md covers all releases | ✅ | Rewritten to cover v0.2.0 through v2.0.6 |
| CLAUDE.md and AGENTS.md in sync | ✅ | Root pair: byte-identical. Skeleton pair: differs only in title/header by design |
| Zero stale references in audited files | ✅ | Comprehensive grep confirms zero hits in instructional docs |
| All CLI examples use current syntax | ✅ | Verified across all tiers |
| Release notes for every tagged release | ✅ | Created v2.0.1, v2.0.2, v2.0.6; all major/minor releases covered |
| Obsolete files identified | ✅ | INSTALL.md, MIGRATION-1.0.md: deprecation banners added; builders.md: updated |

### Deviations from Specification
| Original Requirement | What Was Built | Reason |
|---------------------|----------------|--------|
| "No root README.md" | README.md already existed | Spec's initial assessment was incorrect; README was audited and fixed |
| "Release notes for v2.0.4–v2.0.7" | Only v2.0.6 created | v2.0.4, v2.0.5, v2.0.7 tags don't exist — versions were skipped |
| cmap-value-analysis marked out of scope | Minor label edits made | "tmux scroll saga" → "terminal scroll saga" — defensible consistency fix |

## Plan Execution Review

### Phase Completion
| Phase | Status | Iterations | Notes |
|-------|--------|------------|-------|
| Phase 1: tier_1_public | Complete | 1 | 10 files modified, 3 release notes created |
| Phase 2: tier_2_developer | Complete | 1 | 13 files modified, deepest work on arch.md |
| Phase 3: tier_3_skeleton | Complete | 1 | 8 files modified, including MANIFESTO.md |
| Phase 4: final_verification | Complete | 1 | Verification report + missed codev/roles fixes |

## Lessons Learned

### What Went Well
1. **Tier-based organization** — Working tier-by-tier prevented context overload and made consultations focused
2. **3-way consultation effectiveness** — Reviewers consistently caught real issues: af start/stop in arch.md (Claude), config.json references (Gemini), codev/roles/ files missed entirely (all three)
3. **Comprehensive grep sweep** — Running a final stale pattern grep across the entire repo in Phase 4 caught edge cases

### Challenges Encountered
1. **`consult --protocol` failing with multiple projects** — The worktree had 14+ project dirs in `codev/projects/`, causing the consult CLI to error. Resolved by using `--prompt-file` flag to bypass project detection.
2. **codev/roles/ vs codev-skeleton/roles/** — Fixed skeleton roles in Phase 3 but forgot the live `codev/roles/` copies. The dual-directory structure (codev/ for our instance, codev-skeleton/ for distribution) is a known footgun. Reviewers caught this in Phase 4.
3. **arch.md complexity** — This 1900+ line file had stale references in glossary, file tree, ADRs, and CLI quick-reference. Required multiple passes and reviewers caught additional issues each time.

### What Would Be Done Differently
1. **Grep codev/roles/ alongside codev-skeleton/roles/** — Always audit both locations for any pattern
2. **Run the final stale reference sweep BEFORE Phase 4** — Would have caught codev/roles/ issues earlier
3. **Include SPIDER→SPIR in the stale patterns list** — The protocol rename was missed in the original spec's known issues table

### Methodology Improvements
- **Consult CLI needs better multi-project support** — The "Multiple projects found" error in builder worktrees is a recurring issue. The `--prompt-file` workaround should be documented or the CLI should support `--project-id` to disambiguate.
- **Documentation audit should be a MAINTAIN protocol task** — The stale reference patterns list and tier structure could be formalized as a MAINTAIN checklist item for quarterly runs.

## Follow-up Items
- [ ] Update `protocols/maintain/protocol.md` example to use Shellper/node-pty instead of tmux/ttyd (out of scope for this audit)
- [ ] Consider adding release notes for patch versions (v1.4.1, v1.5.5–v1.5.28, etc.)
- [ ] Add `codev import` documentation to `codev-skeleton/resources/commands/codev.md`
