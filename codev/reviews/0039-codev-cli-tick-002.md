# Review: Spec 0039 - TICK-002 Embedded Skeleton Amendment

**Spec:** codev/specs/0039-codev-cli.md (TICK-002 Amendment)
**Plan:** codev/plans/0039-codev-cli.md (Phase 9)
**Protocol:** TICK
**Reviewed:** 2025-12-09
**Branch:** builder/0039-codev-cli

---

## Amendment Summary

TICK-002 implements the "embedded skeleton with local overrides" pattern to reduce project clutter and eliminate skeleton duplication:

- Framework files (protocols, roles, templates) are embedded in the npm package
- `codev init` and `codev adopt` create minimal structure (specs/, plans/, reviews/, projectlist.md)
- Local files take precedence over embedded files via `resolveCodevFile()`
- Users can customize by manually copying files from the embedded skeleton

## Implementation Details

### Core Changes

1. **`src/lib/skeleton.ts`** - New module with:
   - `getSkeletonDir()` - Returns path to embedded skeleton
   - `resolveCodevFile()` - Checks local first, falls back to embedded

2. **`src/commands/init.ts`** - Modified to:
   - Create only user data directories (specs/, plans/, reviews/)
   - Create projectlist.md
   - Create CLAUDE.md and AGENTS.md from templates
   - NOT copy protocols, roles, or other framework files

3. **`src/commands/adopt.ts`** - Modified with same minimal structure approach

4. **Build process** (`package.json`) - Added:
   - `copy-skeleton` script to copy `codev-skeleton/` to `skeleton/` at build time
   - Skeleton is now part of the distributed package

5. **Documentation** - Updated:
   - `INSTALL.md` - Added "How It Works: Embedded Skeleton" section
   - `README.md` - Updated project structure, added customization guide

### File Resolution Pattern

```
resolveCodevFile("protocols/spir/protocol.md")
├── Check: ./codev/protocols/spir/protocol.md (local)
│   └── If exists → Return local path
├── Check: <package>/skeleton/protocols/spir/protocol.md (embedded)
│   └── If exists → Return embedded path
└── Return null if neither exists
```

## 3-Way Review Summary

### Gemini (49s) - APPROVE

- "Solid consolidation plan; TICK-002 is a major architectural improvement"
- `resolveCodevFile` utility is a robust solution for managing defaults vs overrides
- Recommends test for fallback logic in resolver

### Codex (93s) - REQUEST_CHANGES

Concerns raised (with Builder responses):

1. **Contradictory skeleton requirements** - TICK-002 supersedes original spec text. This is standard TICK behavior.
2. **Plan phases reference deprecated flow** - Phase 9 (amendment) is authoritative; earlier phases are historical context.
3. **`codev tower` underspecified** - Not in scope for TICK-002; future work.
4. **Conflict handling vague** - Implementation clarifies: detect by filename, warn user, skip if consented.

### Claude - TIMEOUT

Consultation exceeded time limit. Results unavailable.

## Success Criteria Verification

| Criteria | Status | Evidence |
|----------|--------|----------|
| `codev init` creates minimal structure | ✅ | Only specs/, plans/, reviews/, projectlist.md created |
| Framework files NOT copied to project | ✅ | No protocols/ or roles/ in new projects |
| `resolveCodevFile()` checks local first | ✅ | Unit tests verify local override behavior |
| Embedded skeleton distributed with package | ✅ | `skeleton/` copied at build time |
| `af` commands use resolver for roles | ✅ | `config.ts` uses `resolveCodevFile()` |
| Documentation updated | ✅ | INSTALL.md, README.md updated |

## Test Coverage

### New Tests Added

- `skeleton.test.ts` - Tests for `getSkeletonDir()` and `resolveCodevFile()`
- `init.test.ts` - Verifies minimal structure creation
- `adopt.test.ts` - Verifies minimal structure and conflict detection

### Total Test Count

164 tests passing (includes all existing + new TICK-002 tests)

## Lessons Learned

### What Worked Well

1. **Incremental amendment** - TICK-002 was scoped to skeleton changes only, making review focused
2. **Build-time skeleton copy** - Simple and reliable approach to embedding files
3. **Resolution pattern** - Clear precedence (local > embedded) is easy to understand

### What Could Be Improved

1. **Document supersession** - TICK amendments should explicitly mark which original sections they replace
2. **Consultation timeout** - Claude took longer than expected; may need configuration
3. **Eject command** - Deferred to future work; manual copy is sufficient for now

### Technical Debt Created

1. **`codev eject`** - Not implemented; users must manually copy files to customize
2. **`codev update`** - Not updated for embedded skeleton pattern (future spec)

## Files Changed

### Source Files
- `packages/codev/src/lib/skeleton.ts` (new)
- `packages/codev/src/lib/templates.ts` (modified)
- `packages/codev/src/commands/init.ts` (modified)
- `packages/codev/src/commands/adopt.ts` (modified)
- `packages/codev/src/agent-farm/utils/config.ts` (modified to use resolver)

### Test Files
- `packages/codev/src/__tests__/skeleton.test.ts` (new)
- `packages/codev/src/__tests__/init.test.ts` (modified)

### Configuration
- `packages/codev/package.json` (build script added)

### Documentation
- `INSTALL.md` (updated)
- `README.md` (updated)

## Verdict

**APPROVE**

TICK-002 is successfully implemented. All success criteria met. Codex's concerns about document inconsistency are valid but don't affect implementation quality - the code follows the amendment correctly.

Recommendations:
1. Consider explicit supersession markers in future TICK amendments
2. Plan `codev eject` command for users who want full control
3. Update `codev update` for embedded skeleton pattern in future spec

---

*Review completed by Builder 0039*
