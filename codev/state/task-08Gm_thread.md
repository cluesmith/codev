# Builder task-08Gm — thread

## Task
Fix broken build on main: `packages/codev/src/commands/doctor.ts` imported `formatBytes` twice (from `../lib/migration-backup-audit.js` and `../agent-farm/servers/session-log-sweep.js`), causing TS2300 duplicate identifier. Landed via PR #1243.

## Work log
- Confirmed both imports and both call sites: line 111 (session-log summary, uses `measureSessionLogs` data) and line 847 (migration-backup reclaimable bytes).
- Aliased the session-log-sweep import as `formatBytes as formatLogBytes` and updated line 111 to `formatLogBytes(bytes)`. The migration-backup import and its call site (line 847) are unchanged.
- Verifying with `npx tsc --noEmit` in `packages/codev` before creating the PR.
