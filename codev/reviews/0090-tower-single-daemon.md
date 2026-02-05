# Review 0090: Tower as Single Daemon Architecture

## Summary

**Status**: IMPLEMENTED
**Date**: 2026-02-05
**Consultation**: 2 APPROVE (Gemini, Claude), 1 COMMENT (Codex)

## Implementation Highlights

### Phase 4 Complete: Cleanup and Migration

Successfully refactored Agent Farm so that tower is the single daemon managing all projects:

1. **Tower owns all terminals**: `projectTerminals` registry tracks architect/builder/shell terminals per project
2. **`af dash` is now an API client**: Calls tower's `/api/projects/:path/activate` and `/api/projects/:path/deactivate`
3. **dashboard-server.ts deleted**: Tower handles everything directly
4. **Project API handlers**: Tower serves `/project/:path/api/state`, `/project/:path/api/tabs/*`

### Key Changes

| File | Change |
|------|--------|
| `tower-server.ts` | Added project terminal registry, project API handlers, direct terminal management |
| `dashboard-server.ts` | **DELETED** |
| `start.ts` | Now calls tower activation API instead of spawning dashboard-server |
| `stop.ts` | Now calls tower deactivation API |
| `status.ts` | Queries tower API for project status |
| `tower-test-utils.ts` | Updated helpers to use tower API |
| `tower-baseline.test.ts` | Updated tests for tower-only architecture |

### Test Results

- **641 tests passed** across 46 test files
- All tower baseline tests updated and passing
- Manual E2E testing verified:
  - `af tower start` / `af tower stop`
  - `af dash start` / `af dash stop`
  - `af status`

## Consultation Feedback

### Gemini (APPROVE - HIGH confidence)
- Praised test-first approach (Phase 0)
- Note: Clarify `base_port` purpose in single-daemon model

### Codex (COMMENT - MEDIUM confidence)
- Security: Consider binding to localhost by default, rate limiting on more endpoints
- Concurrency: Add load testing for many concurrent PTYs
- Testing: Some baseline tests exercise legacy behavior

### Claude (APPROVE - HIGH confidence)
- Well-designed architectural consolidation
- Minor suggestions:
  - Add IPv6 localhost check (`::1`) to auth middleware
  - Consider CSRF protection for browser-based API calls
  - Specify behavior when tmux is not installed

## Future Improvements (from consultations)

1. **Security hardening**: IPv6 localhost check, CSRF protection, broader rate limiting
2. **Load testing**: Stress tests for many concurrent PTY sessions
3. **Error handling**: Document tmux-not-installed error path
4. **Operational**: Log retention, health check intervals

## Lessons Learned

1. **Test-first approach was valuable**: Phase 0 baseline tests caught regressions early
2. **Incremental migration worked**: Each phase was independently verifiable
3. **Single daemon simplifies operations**: No more stale state between dashboard processes
4. **API client pattern is cleaner**: `af dash` calling tower API is more maintainable than spawning processes
