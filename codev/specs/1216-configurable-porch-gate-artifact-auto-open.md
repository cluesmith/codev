# Specification: Configurable Porch Gate Artifact Auto-Open

## Metadata

- **ID**: 1216
- **Status**: implemented — pending PR review
- **Created**: 2026-07-22
- **Issue**: [cluesmith/codev#1216](https://github.com/cluesmith/codev/issues/1216)
- **Area**: Porch orchestration and configuration
- **Multi-agent investigation**: Gemini, Codex, and Claude unanimously recommended source-side suppression (Option A)

## Problem Statement

When `porch gate` presents an existing specification, plan, or review artifact for human approval, it automatically invokes `afx open`. That command creates a server-side Tower file tab. The Tower web dashboard intentionally focuses any genuinely new tab, so this automatic file-tab creation can interrupt an architect's current work and steal focus.

This behavior is currently unconditional. Users who review artifacts in an editor, from the terminal, or at a time of their choosing cannot prevent Porch from creating the Tower tab.

## Stakeholders and Desired State

- **Architects and reviewers** need gates to remain visible and actionable without losing the dashboard context they are currently using.
- **Builders** need the same effective preference when Porch runs in an isolated Agent Farm worktree, without copying personal configuration into every worktree.
- **Teams** need an opt-out that can be shared project-wide while still allowing an engineer-specific override.
- **Existing users** need an unchanged default so an upgrade does not silently remove the current review convenience.

In the desired state, Porch still records and presents every gate exactly as it does today. It also reports the mapped artifact path, but creates a Tower file tab only when the effective preference permits the convenience action.

## Current Behavior

The behavior is produced by a chain of otherwise independent components:

1. Porch records the gate request and, when `porch gate` is invoked, resolves the current phase artifact.
2. For an existing artifact in `specify`, `plan`, or `review`, Porch automatically launches `afx open`.
3. `afx open` creates or retrieves a Tower file tab.
4. The web dashboard's generic new-tab behavior selects a newly observed tab, causing the visible focus change.

`porch done` and `porch next` can request or report a pending gate, but they do not independently launch `afx open`. The explicit `porch gate` path is the sole automatic artifact-open producer. Manual `afx open` calls and other sources of new Tower tabs are separate behavior.

The unified configuration loader already supports layered global, project, and project-local configuration. Agent Farm worktrees automatically share the main workspace's `.codev/config.json`, but do not currently share `.codev/config.local.json`; therefore a per-project, per-engineer preference in the main workspace is not visible when a builder invokes `porch gate` from its worktree.

## Goals

1. Give users an authoritative opt-out that prevents Porch from creating automatic artifact tabs at gates.
2. Preserve current behavior for every user who does not opt out.
3. Preserve all gate state, audit commits, approval instructions, and artifact discoverability.
4. Make the preference effective in the real builder-worktree flow, including the per-project, per-engineer configuration layer.
5. Document the setting and its scope clearly.

## Non-Goals

- Changing the dashboard's general rule for focusing newly created tabs.
- Adding a browser-local preference or dashboard settings UI (Option B).
- Changing the behavior of a manual `afx open <file>` command.
- Closing file tabs that already exist or restoring a previously focused tab.
- Adding per-phase or per-gate granularity; this is one boolean preference.
- Changing which phases have artifacts, gate lifecycle semantics, approval requirements, or automatic gate-request commits.
- Solving unrelated file-tab creation or focus behavior outside Porch's automatic gate artifact open.
- Changing pre-existing cross-root artifact resolution behavior when `porch gate` is invoked from a workspace other than the project-owning worktree.

## Constraints and Assumptions

- Gate persistence is authoritative; automatic opening is a best-effort convenience and must remain downstream of the state update.
- The unified configuration loader remains the source of truth for precedence and parsing behavior.
- Builder execution must observe the personal layer without requiring users to copy it manually or introducing a second, Porch-specific precedence contract.
- If worktree setup is changed, it remains idempotent for both newly spawned builders and `afx setup` applied to an existing builder.
- A project-local config is personal and gitignored; making it visible in a worktree must not turn it into committed project data or a builder-writable shared file whose edits mutate the main workspace's personal configuration.
- The dashboard's current behavior for genuinely new tabs is intentional and remains unchanged.

## Baked Decisions

### 1. Use Option A: suppress the producer-side action

The opt-out MUST be enforced before Porch invokes `afx open`. When disabled, no automatic Tower file tab is created, so no client has an automatic artifact tab to focus. The dashboard's generic new-tab behavior remains untouched.

### 2. Configuration key and ownership

The public key is:

```json
{
  "porch": {
    "autoOpenArtifacts": false
  }
}
```

The setting belongs to `porch`, because it controls an action initiated by the Porch gate command rather than a rendering policy intrinsic to the dashboard.

### 3. Opt-out semantics

- Unset: automatic opening is enabled (existing behavior).
- `true`: automatic opening is enabled.
- `false`: automatic opening is disabled.
- Only the explicit boolean value `false` disables the action; omission must remain backward-compatible.

### 4. Project-local behavior is part of v1

A preference in the main workspace's `.codev/config.local.json` MUST affect `porch gate` when the command runs inside an Agent Farm-managed builder worktree for that workspace. The implementation may reuse the normal merged configuration or make the personal config layer available to the worktree, but must not require users to duplicate the setting manually in every builder.

## Functional Requirements

### FR1: Conditional automatic open

For an existing phase artifact, `porch gate` MUST invoke `afx open` when the effective `porch.autoOpenArtifacts` value is unset or `true`, and MUST NOT invoke it when the effective value is `false`.

The condition applies uniformly to:

- specification artifacts at the specification approval gate;
- plan artifacts at the plan approval gate; and
- review artifacts at the PR/review gate.

### FR2: Gate behavior remains intact

Disabling automatic opening MUST NOT change:

- creation or persistence of the pending gate;
- `requested_at` or other Porch state;
- `chore(porch)` audit commits;
- artifact existence or contents;
- the printed artifact path;
- the requirement to wait for human approval; or
- later gate approval and phase transition behavior.

When auto-open is disabled, command output MUST remain truthful: it must identify the artifact without claiming that the artifact is being opened.

### FR3: No-artifact behavior

If the current phase has no mapped artifact, or the resolved artifact does not exist, Porch MUST retain its existing behavior and MUST NOT attempt an open regardless of configuration.

### FR4: Layered configuration

The key MUST participate in the existing merged configuration precedence. At minimum, the following supported locations must behave consistently:

- `~/.codev/config.json` for a user-wide preference;
- `.codev/config.json` for a shared project preference; and
- `.codev/config.local.json` for a per-project, per-engineer preference.

Higher-precedence values override lower-precedence values according to the existing loader contract. Builder-worktree execution MUST observe the same effective project and project-local value as the main workspace.

The chosen worktree mechanism MUST preserve the personal file's ownership and mutation boundary: builder reads may use the effective value, but builder-side writes MUST NOT alter the main workspace's `.codev/config.local.json`.

### FR5: Manual and dashboard behavior remain unchanged

A user-issued `afx open` MUST continue to create/focus a file tab as it does today. New builders, architects, shells, and other newly created Tower tabs MUST retain their existing dashboard focus behavior.

### FR6: Documentation

User-facing configuration documentation MUST explain:

- the exact key and boolean values;
- that default/unset behavior remains enabled;
- that it controls only Porch's automatic gate artifact open;
- that manual `afx open` is unaffected;
- the distinction between shared project config, user-wide config, and per-project personal config; and
- an example opt-out.

Any shipped framework documentation changed for this feature MUST be kept synchronized between the Codev project copy and `codev-skeleton/`.

## Non-Functional Requirements

- **Compatibility:** Existing projects and configurations require no migration; only explicit `false` changes behavior.
- **Reliability:** Suppressing the convenience action cannot prevent, roll back, or corrupt a successfully requested gate.
- **Isolation:** Builder-worktree support must preserve the existing configuration precedence instead of introducing a Porch-specific merge path.
- **Maintainability:** The decision to open must be covered at the gate-command boundary, and worktree propagation must be covered at the shared setup boundary used by both spawn and reconfiguration.
- **Performance:** Reading the preference and evaluating the condition must add no network request or meaningful delay to gate presentation.

## Error Handling

- A failure to launch `afx open` while the feature is enabled retains the current best-effort, detached behavior and must not corrupt gate state.
- Configuration errors must follow the unified configuration loader's established handling. The convenience open must not cause a successfully recorded pending gate to be lost or rolled back.
- The disabled path must not start a detached child process or send a Tower file-tab request.

## Acceptance Criteria

1. With no `porch.autoOpenArtifacts` value, reaching and presenting a gate behaves exactly as before and opens the mapped artifact.
2. With `porch.autoOpenArtifacts: true`, the mapped artifact opens exactly as before.
3. With `porch.autoOpenArtifacts: false`, presenting specification, plan, and review gates creates no automatic file tab and does not steal dashboard focus.
4. In the disabled case, the pending gate, Porch audit commit, artifact path output, approval instructions, and later approval flow remain correct.
5. A personal opt-out in the main workspace's `.codev/config.local.json` is honored when `porch gate` runs from a freshly spawned builder worktree.
6. Running `afx setup` against an existing builder makes a newly added or changed main-workspace personal preference effective without duplicate files, precedence drift, or loss of idempotency.
7. Builder-side writes cannot mutate the main workspace's personal configuration through the propagation mechanism.
8. A higher-precedence local value overrides a conflicting shared/global value according to existing config precedence.
9. Manual `afx open` and the dashboard's generic new-tab auto-focus behavior are unchanged.
10. User-facing docs include the opt-out example and are mirrored where framework documentation is shipped from both trees.
11. Automated tests cover default, explicit true, explicit false, missing artifact, and builder-worktree/project-local behavior.
12. An end-to-end or equivalent integration verification confirms the disabled setting prevents creation of the Tower file tab; unit tests that only assert a boolean helper are insufficient by themselves.
13. Existing relevant Porch, config-loader, worktree-setup, build, and test suites pass.

## Test Scenarios

### Configuration

1. No key in any layer resolves to enabled behavior.
2. `true` in project config resolves to enabled behavior.
3. `false` in project config resolves to disabled behavior.
4. `false` in global config applies across projects unless overridden.
5. A project-local value overrides a conflicting project/global value.
6. A main-workspace project-local value is observed from a freshly spawned builder worktree.
7. Adding or changing that value and running `afx setup` makes it effective in an existing builder without duplication or precedence drift; a repeated setup remains a no-op.
8. An attempted builder-side write through the propagation path does not change the main workspace's personal config.

### Porch gate behavior

1. Existing specification artifact + enabled setting launches one automatic open.
2. Existing plan artifact + disabled setting launches no automatic open.
3. Existing review artifact + disabled setting launches no automatic open.
4. Missing artifact launches no automatic open for either setting.
5. Disabled output prints the artifact path and human-approval instructions without an inaccurate "Opening" message.
6. Gate state and its `chore(porch)` commit are identical apart from the absent open side effect.

### Integration / UX

1. Keep a non-file dashboard tab active, invoke a disabled `porch gate`, and verify no file tab appears and the active tab does not change.
2. Invoke a manual `afx open` and verify the file tab still appears and follows normal dashboard focus behavior.
3. Repeat the disabled gate flow from a builder worktree while the preference exists only in the main workspace's project-local config.

## Alternatives Considered

### Option A: Stop automatic tab creation at the Porch source — Selected

This is authoritative, client-independent, and preserves the semantics of manual file opens and generic new tabs. It prevents both focus theft and unwanted tab clutter.

### Option B: Create the tab but suppress dashboard focus — Rejected for this issue

A browser-local focus preference would leave unwanted server-side tabs, apply only to one client, and require the dashboard to distinguish automatic Porch opens from voluntary manual opens. It can be considered separately if users later want a general per-browser file-tab focus policy.

## Open Questions

- **Critical:** None. The producer-side toggle, key ownership, default, and project-local requirement are fixed.
- **Important:** The implementation plan must choose how the main workspace's personal layer reaches builder execution, identify the canonical user-facing configuration reference to update, and select the narrowest integration boundary that proves no `afx open` request is emitted.
- **Nice-to-know:** A future dashboard preference could independently control focus for all file tabs, but that behavior is outside this specification.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Inverted default changes existing UX | High | Treat only explicit `false` as disabled; test unset and `true` paths |
| Preference works on main but not in builders | High | Require builder-worktree coverage for the main workspace's project-local layer |
| Gate command claims it opened a file when it did not | Medium | Require truthful disabled-path output while retaining artifact path |
| Broad dashboard change breaks focus for other new tabs | Medium | Do not modify generic dashboard auto-focus behavior |
| Worktree config propagation affects unrelated config | Medium | Preserve existing precedence and add focused regression tests for setup/config behavior |
| Gate state is coupled to best-effort UI convenience | High | Keep state persistence independent and unchanged |

## Consultation Log

- **Pre-SPIR investigation (Gemini, Codex, Claude):** All three reviewers favored suppressing the producer-side `afx open` action rather than changing the dashboard's generic tab-focus behavior. The draft adopted that recommendation as Option A and made backward-compatible opt-out semantics explicit.
- **SPIR specification review (Gemini, Codex, Claude):** Gemini and Claude approved the specification. Codex returned a high-confidence comment requesting explicit protection against unintended builder mutation of personal config and direct fresh-spawn plus `afx setup` coverage. Both clarifications were incorporated into the constraints, FR4, acceptance criteria, and configuration test scenarios.

## Contribution Delivery Constraints

These are repository workflow constraints, not product behavior:

- The contributor is not a `cluesmith/codev` maintainer. Push the builder branch only to remote `fork` (`mohidmakhdoomi/codev`).
- Open the upstream cross-fork PR with `gh pr create -R cluesmith/codev --head mohidmakhdoomi:<branch>` targeting `main`.
- Do not self-merge. Done-state is an open upstream PR and architect notification; upstream maintainers merge.
- Complete the Porch workflow as directed by the architect, and commit and push every final `chore(porch)` state transition before declaring the builder done.
