---
approved: 2026-02-02
validated: [gemini, codex, claude]
---

# Plan 0088: Porch Version Constant

```json
{"phases": [{"id": "phase_1", "title": "Add version constant"}, {"id": "phase_2", "title": "Display version and add test"}]}
```

## Phase 1: Add version constant

### Files to create
- `packages/codev/src/commands/porch/version.ts` — Export `PORCH_VERSION = '1.0.0'`

## Phase 2: Display version and add test

### Files to modify
- `packages/codev/src/commands/porch/run.ts` — Import `PORCH_VERSION` from `./version.js`, add `console.log(\`  Porch: v${PORCH_VERSION}\`)` in `showStatus()` after the phase line

### Tests
- Add a simple test in `packages/codev/src/commands/porch/__tests__/version.test.ts` that imports `PORCH_VERSION` and verifies it matches `/^\d+\.\d+\.\d+$/`
