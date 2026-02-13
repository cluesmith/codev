# Review: Tower Mobile Compaction

## Metadata
- **Date**: 2026-02-08
- **Specification**: codev/specs/0094-tower-mobile-compaction.md
- **Plan**: codev/plans/0094-tower-mobile-compaction.md
- **PR**: #197

## Executive Summary

CSS-only compaction of the Tower overview page for mobile viewports (<=600px). All 7 changes from the spec were implemented in a single phase across 2 commits. One minor JS change added a `.new-shell-row` class to replace fragile inline style targeting. No behavioral changes; desktop layout unchanged.

## Specification Compliance

### Success Criteria Assessment
| Criterion | Status | Notes |
|-----------|--------|-------|
| Each project card ~40-50% shorter on mobile | ✅ | Removed path row, compacted header/terminals/spacing |
| Project name + status + actions on one line | ✅ | `flex-wrap: wrap` with `margin-left: auto` on actions |
| No project path visible on mobile | ✅ | `.instance-path-row { display: none }` |
| Overview/Architect rows compact single-line | ✅ | `.port-item { flex-direction: row }` on mobile |
| Recent projects: name + time + Start inline | ✅ | Row layout, hidden `.recent-path`, 12px time font |
| Share button hidden on mobile | ✅ | `#share-btn { display: none !important }` |
| Desktop (>800px) unchanged | ✅ | All changes inside `@media (max-width: 600px)` |
| All buttons tappable (min 36px) | ✅ | `@media (pointer: coarse)` still sets 44px min-height |

### Deviations from Specification
| Original Requirement | What Was Built | Reason for Deviation |
|---------------------|----------------|---------------------|
| Target inline styles for New Shell row via CSS attribute selector | Added `.new-shell-row` class in JS + CSS | Spec itself recommended this as the better approach |

## Plan Execution Review

### Phase Completion
| Phase | Status | Commits |
|-------|--------|---------|
| Phase 1: Mobile CSS Compaction | Complete | `02629ae`, `e4038a4` |

### Deliverables Checklist
- [x] All 7 mobile compaction changes implemented
- [x] `.new-shell-row` semantic class added (JS + CSS)
- [x] Inline styles moved to CSS class (second commit)
- [x] Build succeeds without errors

## Code Quality Assessment

### Architecture Impact
- **Positive**: Moved inline styles to a proper CSS class (`.new-shell-row`), reducing inline style fragility
- **Technical Debt**: None incurred. All changes are additive CSS within the existing media query block
- **Future Considerations**: The tower.html file is large (single file with inline CSS/JS). A future spec could extract CSS into a separate stylesheet

### Code Metrics
- **Lines Changed**: +112 / -22 (net +90 lines of CSS)
- **Files Modified**: 1 (`packages/codev/templates/tower.html`)
- **JS Changes**: 1 line (added `new-shell-row` class to template literal)

### Security Review
- No security implications. Pure CSS changes with one class name addition.

## Testing Summary

- **Build**: Passes successfully
- **Playwright E2E**: 16/16 pass (10 new + 6 existing, no regressions)
  - Mobile (412x915): share hidden, path hidden, row layouts, touch targets >=36px, recent items compacted
  - Desktop (1280x800): share not CSS-hidden, path visible, default layout
- **Manual verification needed**: Chrome DevTools mobile emulator (Pixel 7, 412px), and ideally real Android device

## Lessons Learned

### What Went Well
1. Single-file, CSS-only scope kept the change minimal and low-risk
2. Spec was very precise with exact CSS snippets, making implementation straightforward
3. The spec's own recommendation to use a semantic class instead of attribute selectors was the right call

### What Was Challenging
1. The `@media (pointer: coarse)` rule sets `min-height: 44px` on `.port-actions a`, which could conflict with the mobile `flex: 0` override. Resolved by leaving a comment noting the coarse pointer rule handles min-height.

### What Would You Do Differently
1. For purely visual changes, a before/after screenshot comparison in the PR would be more valuable than test results

## Follow-Up Actions

### Immediate
- [ ] Architect reviews PR #197 visually on mobile emulator
- [ ] Test on real Android device via tunnel if available

## 3-Way Consultation Results

### Round 1: Post-Implementation
All three models approved with no code changes required.

| Model | Verdict | Confidence | Notes |
|-------|---------|------------|-------|
| Gemini | APPROVE | HIGH | Clean CSS, `!important` acceptable for single-file template |
| Codex | APPROVE | MEDIUM | Recommends manual test pass before merge |
| Claude | APPROVE | HIGH | Noted `min-height` delegation to `pointer: coarse` is correct |

### Round 2: Post-Defend (after Playwright tests added)

| Model | Verdict | Confidence | Issues Raised | Resolution |
|-------|---------|------------|---------------|------------|
| Gemini | APPROVE | HIGH | CSS comment nit (false positive) | No change needed |
| Codex | REQUEST_CHANGES | HIGH | Desktop share-button test flaky when no tunnel | Fixed: test now isolates CSS from inline JS |
| Claude | APPROVE | HIGH | Missing Recent Projects test coverage | Fixed: added 2 tests for recent-path and recent-item layout |

## Conclusion

Straightforward CSS compaction that achieves its goal of reducing vertical space waste on mobile. All 7 spec items implemented with one smart deviation (semantic class over attribute selector). No functional or desktop impact.
