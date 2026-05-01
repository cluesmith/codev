# Plan: Linear Forge Provider

## Metadata
- **Spec**: 719-linear-forge-provider
- **Protocol**: ASPIR
- **Created**: 2026-05-01

## Phase 1: Fix fallback bug in buildPresetFromScripts

**Goal**: Concepts without scripts should be omitted from the preset (not set to null), so they fall through to GitHub defaults via the resolution logic in `getForgeCommand`.

**Files**:
- `packages/codev/src/lib/forge.ts:99-114`

**Change**: In `buildPresetFromScripts`, remove the `else { preset[concept] = null; }` branch. Only include concepts that have a script file on disk or are explicitly disabled.

**Done when**: A provider with only issue scripts does NOT disable PR concepts. PR concepts resolve to the GitHub default.

## Phase 2: Register linear provider and pass config env vars

**Goal**: Register `linear` in `getProviderPresets()` and enhance `executeForgeCommand` to pass non-concept forge config keys as environment variables.

**Files**:
- `packages/codev/src/lib/forge.ts:127-131` — add `linear` to `_providerPresets`
- `packages/codev/src/lib/forge.ts:305-330` — enhance `executeForgeCommand` to export forge config keys as `CODEV_` env vars

**Changes**:
1. Add `linear: buildPresetFromScripts('linear', ['team-activity', 'on-it-timestamps'])` to `_providerPresets`
2. In `executeForgeCommand`, after resolving `forgeConfig`, extract non-concept keys (keys not in `KNOWN_CONCEPTS` and not `provider`) and export them as uppercased `CODEV_` prefixed env vars. E.g., `forge.linear-team: "ENG"` → `CODEV_LINEAR_TEAM=ENG`.

**Done when**: `getKnownProviders()` includes "linear". Scripts receive `CODEV_LINEAR_TEAM` from forge config.

## Phase 3: Widen issue identifier types

**Goal**: Accept alphanumeric identifiers (e.g., "ENG-123") throughout the agent-farm CLI and type system.

**Files**:
- `packages/codev/src/lib/forge-contracts.ts:33` — `number: number` → `number: number | string`
- `packages/codev/src/agent-farm/types.ts:17` — `issueNumber?: number` → `issueNumber?: number | string`
- `packages/codev/src/agent-farm/types.ts:67` — `issueNumber?: number` → `issueNumber?: number | string`
- `packages/codev/src/agent-farm/cli.ts:195` — change argument description from "Issue number" to "Issue identifier"
- `packages/codev/src/agent-farm/cli.ts:230-231` — accept alphanumeric: if `parseInt` fails but matches `/^[A-Z]+-\d+$/i`, keep as string

**Done when**: `afx spawn ENG-123 --protocol spir` parses without error. TypeScript compiles without type errors.

## Phase 4: Create Linear forge scripts

**Goal**: Implement 6 POSIX sh scripts in `packages/codev/scripts/forge/linear/`.

**Scripts**:

| Script | Concept | Env Vars | Output |
|--------|---------|----------|--------|
| `auth-status.sh` | auth-status | LINEAR_API_KEY | exit code 0 = authenticated |
| `user-identity.sh` | user-identity | LINEAR_API_KEY | plain text display name |
| `issue-view.sh` | issue-view | LINEAR_API_KEY, CODEV_ISSUE_ID | JSON: {title, body, state, comments[]} |
| `issue-list.sh` | issue-list | LINEAR_API_KEY, CODEV_LINEAR_TEAM | JSON: [{number, title, url, labels, createdAt, author, assignees}] |
| `issue-comment.sh` | issue-comment | LINEAR_API_KEY, CODEV_ISSUE_ID, CODEV_COMMENT_BODY | exit code 0 = success |
| `recently-closed.sh` | recently-closed | LINEAR_API_KEY, CODEV_LINEAR_TEAM, CODEV_SINCE_DATE | JSON: [{number, title, url, labels, createdAt, closedAt}] |

All scripts:
- Use `curl -s` for HTTP + `jq` for JSON transformation
- Auth via `Authorization: $LINEAR_API_KEY` header
- Linear GraphQL endpoint: `https://api.linear.app/graphql`
- Map Linear fields to forge-contracts.ts interfaces (e.g., `issue.identifier` → `number`, `issue.team.states` → derive `state`)
- Fail with exit 1 and stderr message if LINEAR_API_KEY is not set

**Done when**: Each script runs successfully with a real LINEAR_API_KEY and produces valid JSON matching the contracts.

## Phase 5: Verification

**Goal**: Confirm everything works end-to-end.

**Checks**:
1. TypeScript compiles: `pnpm run build` from workspace root
2. Existing tests pass: `pnpm test` from workspace root
3. `codev doctor` shows linear as known provider
4. Manual verification: run scripts with LINEAR_API_KEY set, confirm JSON output

**Done when**: All checks pass. Ready for PR.

## Sequencing

Phases 1-3 are code changes (TypeScript). Phase 4 is script creation (shell). Phase 5 is verification. Phases 1-3 must be sequential (each builds on prior). Phase 4 can be done after Phase 2 (needs the directory to exist and provider registered). Phase 5 is last.
