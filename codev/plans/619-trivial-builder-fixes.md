---
approved: 2026-03-17
validated: [architect]
---

# Plan: Trivial Builder Fixes

## Metadata
- **ID**: 619
- **Specification**: codev/specs/619-trivial-builder-fixes.md

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Fix all three bugs"}
  ]
}
```

## Phase 1: Fix all three bugs

### 1a. ASPIR builder-prompt

Both files:
- `codev-skeleton/protocols/aspir/builder-prompt.md`
- `codev/protocols/aspir/builder-prompt.md`

Find the line referencing SPIR protocol and change to ASPIR:
```
Follow the ASPIR protocol: `codev/protocols/aspir/protocol.md`
```

### 1b. spawnTask porch init

In `packages/codev/src/agent-farm/commands/spawn.ts`, find `spawnTask()`. After worktree creation, when `hasExplicitProtocol` is true and not resuming, call `initPorchInWorktree()` — matching what `spawnSpec()` does.

### 1c. Fragile phases check

In `packages/codev/src/commands/porch/checks.ts`, in `runArtifactCheck()` case `has_phases_json`:

Change:
```typescript
const has = content.includes('"phases":');
```
To:
```typescript
const has = /"phases"\s*:/.test(content);
```

## Validation

1. `npm run build` — compiles
2. `npx vitest run src/commands/porch/` — tests pass
