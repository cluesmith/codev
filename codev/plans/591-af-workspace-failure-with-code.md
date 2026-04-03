# Plan: Agent Harness Abstraction

## Metadata
- **Specification**: `codev/specs/591-af-workspace-failure-with-code.md`

## Executive Summary

Implement an extensible agent harness system that replaces hardcoded Claude-specific `--append-system-prompt` flags with per-harness role injection. Three phases: (1) create the harness module with built-in providers and config parsing, (2) refactor all call sites to use it, (3) add integration tests.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "harness-module", "title": "Harness Provider Module + Config"},
    {"id": "call-site-refactor", "title": "Call Site Refactoring"},
    {"id": "integration-tests", "title": "Integration Tests"}
  ]
}
```

## Phase Breakdown

### Phase 1: Harness Provider Module + Config
**Dependencies**: None

#### Objectives
- Create the harness provider module with interface, built-in providers, custom config parsing, and resolution function
- Add harness config fields to the UserConfig type system

#### Deliverables
- `packages/codev/src/agent-farm/utils/harness.ts` — new file
- `packages/codev/src/agent-farm/types.ts` — updated UserConfig
- `packages/codev/src/agent-farm/__tests__/harness.test.ts` — new test file

#### Implementation Details

**`harness.ts`** — New module containing:

1. `HarnessProvider` interface with `buildRoleInjection()` and `buildScriptRoleInjection()`
2. Built-in provider objects: `CLAUDE_HARNESS`, `CODEX_HARNESS`, `GEMINI_HARNESS`
3. `BUILTIN_HARNESSES` registry map: `{ claude, codex, gemini }`
4. `buildCustomHarnessProvider(config)` — constructs a HarnessProvider from a custom config definition, expanding `${ROLE_FILE}` and `${ROLE_CONTENT}` template variables
5. `resolveHarness(harnessName: string | undefined, userConfig: UserConfig)` — resolves a harness name to a provider:
   - `undefined` → returns `CLAUDE_HARNESS` (default)
   - matches built-in → returns built-in
   - matches key in `userConfig.harness` → builds custom provider
   - otherwise → throws descriptive error

**`types.ts`** — Add to `UserConfig`:
```typescript
shell?: {
  architect?: string | string[];
  architectHarness?: string;    // NEW
  builder?: string | string[];
  builderHarness?: string;      // NEW
  shell?: string | string[];
};
harness?: Record<string, {       // NEW
  roleArgs: string[];
  roleEnv?: Record<string, string>;
  roleScriptFragment: string;
  roleScriptEnv?: Record<string, string>;
}>;
```

#### Acceptance Criteria
- `resolveHarness('claude')` returns claude provider
- `resolveHarness('codex')` returns codex provider with `-c model_instructions_file=<path>` args
- `resolveHarness('gemini')` returns gemini provider with `GEMINI_SYSTEM_MD` env var
- `resolveHarness(undefined)` defaults to claude
- `resolveHarness('nonexistent')` throws clear error
- Custom harness from config correctly expands `${ROLE_FILE}` and `${ROLE_CONTENT}`
- Missing required fields in custom harness throw descriptive error

#### Test Plan
- **Unit Tests**: Test each built-in provider's `buildRoleInjection()` and `buildScriptRoleInjection()` outputs. Test resolution logic (built-in, custom, default, error). Test template variable expansion. Test custom harness validation (missing required fields).

---

### Phase 2: Call Site Refactoring
**Dependencies**: Phase 1

#### Objectives
- Replace all 5 hardcoded `--append-system-prompt` locations with harness provider calls
- Update `buildArchitectArgs()` return type and its 3 callers
- Fix side issues (deprecated Codex flag, "Claude exited" message)

#### Deliverables
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts` — updated
- `packages/codev/src/agent-farm/commands/architect.ts` — updated
- `packages/codev/src/agent-farm/servers/tower-utils.ts` — updated
- `packages/codev/src/agent-farm/servers/tower-terminals.ts` — updated (2 call sites)
- `packages/codev/src/agent-farm/servers/tower-instances.ts` — updated (1 call site)
- `packages/codev/src/commands/consult/index.ts` — side fix
- `packages/codev/src/agent-farm/utils/config.ts` — add harness resolution helpers
- `packages/codev/src/agent-farm/__tests__/spawn-worktree.test.ts` — updated
- `packages/codev/src/agent-farm/__tests__/af-architect.test.ts` — updated

#### Implementation Details

**`spawn-worktree.ts`** — Two functions to update:

1. `startBuilderSession()` (line 597): Import `resolveHarness`. Get builder harness from config. Call `provider.buildScriptRoleInjection(roleContent, roleFile)`. Generate `export` lines from returned `env`. Replace hardcoded `--append-system-prompt "$(cat '${roleFile}')"` with the harness fragment. Change "Claude exited" to "Agent exited" in restart message.

2. `buildWorktreeLaunchScript()` (line 668): Same pattern. Both functions need the harness name passed in (from config) or resolved internally.

**`architect.ts`** (line 29): Write role to `<workspaceRoot>/.architect-role.md` (align with `tower-utils.ts`). Call `resolveHarness(harnessName).buildRoleInjection(role.content, roleFilePath)`. Spread returned args into spawn args. Merge returned env into spawn env.

**`tower-utils.ts`** (line 175): `buildArchitectArgs()` return type changes from `string[]` to `{ args: string[]; env: Record<string, string> }`. Resolve harness, call `buildRoleInjection()`, return combined args and env.

**Caller updates** — Three callers of `buildArchitectArgs()`:
- `tower-terminals.ts:536` — destructure `{ args, env }`, pass env to session creation
- `tower-terminals.ts:725` — same pattern for resume
- `tower-instances.ts:377` — same pattern for workspace launch

**Config helpers** — Add `getArchitectHarness()` and `getBuilderHarness()` to `config.ts` that read `architectHarness`/`builderHarness` from UserConfig and call `resolveHarness()`.

**Consult side fix** — `consult/index.ts:383`: Change `experimental_instructions_file` to `model_instructions_file` in the Codex SDK config.

#### Acceptance Criteria
- Claude workflows unchanged (regression-safe)
- No remaining references to `--append-system-prompt` except inside `CLAUDE_HARNESS` provider
- `buildArchitectArgs()` returns `{ args, env }` and all callers handle it
- `architect.ts` writes role to `.architect-role.md`
- "Agent exited" message in restart loop
- `consult` uses `model_instructions_file` for Codex

#### Test Plan
- **Unit Tests**: Update `spawn-worktree.test.ts` to test with claude harness (regression) and verify no hardcoded `--append-system-prompt` outside the provider. Update `af-architect.test.ts` similarly.
- **Manual Testing**: If possible, verify `afx workspace start` with claude config still works.

---

### Phase 3: Integration Tests
**Dependencies**: Phase 2

#### Objectives
- Add comprehensive integration tests verifying all call sites produce correct commands for each harness type
- Verify custom harness config end-to-end

#### Deliverables
- `packages/codev/src/agent-farm/__tests__/harness-integration.test.ts` — new test file

#### Implementation Details

Integration tests that verify the final output of each call site for each harness type:

1. **`buildWorktreeLaunchScript()` integration**: For each harness (claude, codex, gemini, custom), verify the generated bash script contains the correct role injection fragment and env exports.

2. **`buildArchitectArgs()` integration**: For each harness, verify the returned args and env are correct. For claude: `--append-system-prompt` with content. For codex: `-c model_instructions_file=<path>`. For gemini: env `GEMINI_SYSTEM_MD`.

3. **Custom harness end-to-end**: Define a custom harness in mock config, resolve it, verify template expansion works correctly with `${ROLE_FILE}` and `${ROLE_CONTENT}`.

4. **Error cases**: Unknown harness name, missing required fields in custom harness config.

5. **No-role behavior**: Verify all call sites skip harness injection when role is `null`.

#### Acceptance Criteria
- All test scenarios from spec section "Test Scenarios" (1-8) have corresponding test cases
- Tests pass for all 3 built-in harnesses + custom harness + error cases
- No-role behavior tested

#### Test Plan
- **Integration Tests**: Parameterized tests across harness types for each call site function.

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| `tower-terminals.ts` env propagation may not reach PTY sessions | High | Verify how `createPtySession()` handles env vars; may need to update PTY creation |
| `architect.ts` `shell: true` spawn with multiline role content | Medium | Existing issue — not introduced by this change. Document for future fix. |
| Codex `model_instructions_file` flag may change again | Low | Verified against current Codex v0.117.0; easy to update |
