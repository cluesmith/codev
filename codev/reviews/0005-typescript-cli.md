# Review: Agent Farm CLI (Spec 0005)

**Review Date**: 2025-12-02
**Status**: Complete with fixes
**Protocol**: SPIR

## Summary

Migrated the architect CLI from bash to TypeScript, creating the `agent-farm` npm package. The implementation provides all core functionality with type safety, better error handling, and npm distribution support.

## What Went Well

1. **Clean TypeScript architecture** - Clear separation between commands, utils, servers, and state management
2. **Comprehensive type definitions** - All interfaces properly typed with strict mode
3. **Test coverage** - 31 tests covering config, state, shell utilities, and types
4. **ES Module support** - Modern `"type": "module"` with NodeNext resolution
5. **Cross-platform port detection** - Native Node socket binding instead of `lsof`

## Issues Identified by Multi-Agent Consultation

### GPT-5 Codex Findings

| Issue | Severity | Status |
|-------|----------|--------|
| Shell injection in `commandExists` | High | **Fixed** - Now uses `spawn('which', [cmd])` |
| Unsafe branch names from spec files | High | **Fixed** - Sanitizes to `[a-z0-9_-]` |
| Detached process failures silent | Medium | Documented for future |
| `parseInt` can return NaN | Medium | **Fixed** - Added validation |
| Partial rollback on worktree failure | Low | Documented for future |
| `</script>` in JSON injection | Low | Documented for future |

### Gemini Pro Findings

| Issue | Severity | Status |
|-------|----------|--------|
| Race conditions in state management | High | Documented - needs file locking |
| Shell injection via `cmd.split(' ')` | High | Documented - needs shell-quote parser |
| Zombie processes if CLI crashes | Medium | Documented for future |
| CORS `*` too permissive | Medium | **Fixed** - Restricted to localhost |
| `fs.readFileSync` blocks event loop | Low | Documented for future |
| 500ms timeout is flaky | Low | Documented for future |

## Fixes Applied

### 1. Shell Injection Prevention
```typescript
// Before (vulnerable):
await execAsync(`command -v ${command}`);

// After (safe):
const child = spawn('which', [command], { stdio: 'ignore' });
```

### 2. Cross-Platform Port Detection
```typescript
// Before (Unix only):
await execAsync(`lsof -i :${port}`);

// After (cross-platform):
const server = net.createServer();
server.listen(port, '127.0.0.1');
```

### 3. CORS Restriction
```typescript
// Before (too permissive):
res.setHeader('Access-Control-Allow-Origin', '*');

// After (localhost only):
if (origin?.startsWith('http://localhost:') || origin?.startsWith('http://127.0.0.1:')) {
  res.setHeader('Access-Control-Allow-Origin', origin);
}
```

### 4. Input Validation
```typescript
// Port validation
const parsedPort = Number(options.port);
if (!Number.isFinite(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
  fatal(`Invalid port: ${options.port}`);
}

// Branch name sanitization
const safeName = specName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
```

## Known Limitations (Deferred)

1. **Race conditions** - State file read-modify-write can race. Needs file locking (`proper-lockfile`) for high-concurrency scenarios.

2. **Command argument parsing** - `cmd.split(' ')` breaks on quoted arguments with spaces. Should use `shell-quote` parser.

3. **Zombie processes** - If CLI crashes between spawn and state save, orphan processes remain. Consider daemon architecture.

4. **Blocking I/O in servers** - `fs.readFileSync` in request handlers. Should use async for better concurrency.

5. **Startup timing** - Fixed 500ms delay before opening browser. Should poll for port readiness.

## Lessons Learned

### 1. Multi-Agent Consultation is Essential
Both GPT-5 and Gemini identified critical security issues I missed:
- Shell injection vulnerabilities
- CORS misconfiguration
- Input validation gaps

**Takeaway**: Always consult multiple models before marking implementation complete.

### 2. Platform-Specific Code is Fragile
Using `lsof` worked on macOS but would fail on Windows/minimal Linux. Native Node solutions are more portable.

**Takeaway**: Prefer Node built-ins over shell commands when possible.

### 3. Security Requires Explicit Attention
Shell injection, CORS, input validation - these are easy to overlook when focused on functionality.

**Takeaway**: Add security review as explicit checklist item in SPIR protocol.

### 4. Concurrency is Hard
State management race conditions weren't obvious until pointed out. Single-user CLI assumptions break down.

**Takeaway**: Consider concurrent access even for "simple" local tools.

## Test Results

```
 ✓ src/__tests__/types.test.ts (10 tests)
 ✓ src/__tests__/config.test.ts (5 tests)
 ✓ src/__tests__/state.test.ts (6 tests)
 ✓ src/__tests__/shell.test.ts (10 tests)

 Test Files  4 passed (4)
      Tests  31 passed (31)
```

## Files Changed

### New Files
- `agent-farm/` - Complete TypeScript package
  - `src/index.ts` - CLI entry point
  - `src/types.ts` - Type definitions
  - `src/state.ts` - State management
  - `src/utils/` - Config, logger, shell utilities
  - `src/commands/` - start, stop, status, spawn, util, annotate
  - `src/servers/` - Dashboard and annotation servers
  - `src/__tests__/` - Test suite
  - `templates/` - HTML templates
  - `package.json`, `tsconfig.json`

### Documentation
- `codev/plans/0005-typescript-cli.md` - Implementation plan
- `codev/reviews/0005-typescript-cli.md` - This review

## Recommendations for Future

1. **Add file locking** before any production use with concurrent access
2. **Implement shell-quote parsing** for complex command arguments
3. **Add integration tests** for full CLI workflow
4. **Consider process manager** (PM2-style) for better lifecycle management
5. **Add Windows support** if cross-platform needed

## Approval

- [x] Plan created and reviewed
- [x] Implementation complete
- [x] Tests written and passing (31/31)
- [x] Multi-agent consultation completed
  - [x] GPT-5 Codex review
  - [x] Gemini Pro review
- [x] Critical security fixes applied
- [x] Review document created
