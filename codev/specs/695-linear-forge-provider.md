# Specification: Linear Forge Provider

## Metadata
- **ID**: 695-linear-forge-provider
- **Status**: draft
- **Created**: 2026-05-01
- **Protocol**: ASPIR

## Problem Statement

Codev's forge abstraction (spec 589) supports GitHub, GitLab, and Gitea via on-disk scripts. MachineWisdom uses Linear for issue tracking but keeps PRs on GitHub. There is no Linear provider, so MW repos with `forge.provider: "linear"` in `.codev/config.json` fall back to GitHub for everything — including issue concepts, which should resolve against Linear.

Additionally, a bug in `buildPresetFromScripts` (forge.ts:110) sets `null` for concepts without a script file. Since `null` means "disabled" in the resolution logic, a Linear provider that only implements issue scripts would disable all PR concepts rather than letting them fall through to the GitHub default. This fundamentally breaks the hybrid forge model where one provider handles issues and another handles PRs.

## Desired State

- A `linear` provider registered in `getProviderPresets()` with 6 issue-oriented concept scripts
- PR concepts (pr-list, pr-exists, pr-merge, pr-search, pr-view, pr-diff, recently-merged) fall through to GitHub defaults — Linear only handles issues
- `buildPresetFromScripts` skips concepts without scripts (omits them from the preset) instead of setting null, so the resolution logic at `getForgeCommand` falls through to the GitHub default
- Issue identifiers are treated as opaque strings (e.g., "ENG-123") throughout the agent-farm CLI — `afx spawn ENG-123 --protocol spir` works
- Linear scripts authenticate via `LINEAR_API_KEY` env var and filter by team via `CODEV_LINEAR_TEAM` (passed from `forge.linear-team` config)

## Stakeholders

- **Primary**: MachineWisdom team (immediate users)
- **Secondary**: Any team using Linear for project management + GitHub for code
- **Upstream**: cluesmith/codev maintainers (PR target)

## Success Criteria

- [ ] `buildPresetFromScripts` no longer sets null for missing scripts — omitted concepts fall through to GitHub default
- [ ] `linear` provider registered with disabled: `['team-activity', 'on-it-timestamps']`
- [ ] 6 Linear scripts exist and produce valid JSON matching forge-contracts.ts interfaces
- [ ] `IssueListItem.number` accepts `string | number`
- [ ] `SpawnOptions.issueNumber` accepts `string | number`
- [ ] `afx spawn ENG-123 --protocol spir` parses correctly (no "Invalid issue number" error)
- [ ] `codev doctor` shows `linear` as a known provider with issue concepts resolved, PR concepts falling through to GitHub
- [ ] All existing tests pass (no regression)

## Constraints

- Scripts must be POSIX sh (curl + jq only) — no node, no python
- LINEAR_API_KEY is required for auth — scripts fail gracefully with helpful stderr if not set
- Scripts must match the JSON output contracts in forge-contracts.ts
- No new runtime dependencies on the codev package
- Must be backward-compatible — existing GitHub/GitLab/Gitea providers unchanged
- The `executeForgeCommand` function must export non-concept forge config keys (e.g., `linear-team`) as `CODEV_LINEAR_TEAM` environment variable

## Solution Approach

Fix the fallback bug first, then add the Linear provider scripts and register the provider. Widen type definitions to accept alphanumeric issue identifiers. Small enhancement to `executeForgeCommand` to pass `forge.linear-team` as `CODEV_LINEAR_TEAM` env var.

## Open Questions

None — the forge abstraction is well-documented (spec 589) and the Linear GraphQL API is stable.
