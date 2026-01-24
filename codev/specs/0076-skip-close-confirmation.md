# Spec 0076: Skip Close Confirmation

**Status:** Draft
**Protocol:** SPIDER
**Created:** 2026-01-24
**Author:** Builder

## Problem Statement

The Agent Farm dashboard currently shows a confirmation dialog when closing tabs for builders and shells that have running processes. While this prevents accidental termination of active work, it creates friction for power users who frequently manage multiple tabs and understand the consequences of their actions.

### Current Behavior

1. **Close button click** on builder/shell tab → Shows confirmation dialog
2. **Shift+click** on close button → Bypasses confirmation (existing workaround)
3. **Files** → Close immediately without confirmation
4. **Already-exited processes** → Close immediately without confirmation (Bugfix #132)

### Pain Points

1. **Workflow friction**: Users who know what they're doing must either:
   - Click through the confirmation dialog every time
   - Remember to hold Shift when clicking close

2. **Discovery**: The Shift+click workaround is undocumented and not discoverable

3. **Consistency**: Some users may prefer to always skip confirmations once they're familiar with the system

## Stakeholders

- **Power users**: Want faster workflows without confirmation dialogs
- **New users**: Need protection from accidental termination
- **Architect role**: May want different behavior than builders

## Proposed Solution

Add a persistent setting to disable close confirmation dialogs for tabs with running processes.

### Approach: Settings Toggle

Implement a new setting in the dashboard that allows users to persistently disable the close confirmation dialog globally.

**Key Design Decisions:**

1. **Scope**: Persistent browser setting (stored in localStorage)
2. **Default**: Confirmations enabled (safe default for new users)
3. **UI Location**: Settings section in the Dashboard tab (new collapsible section)
4. **Persistence**: Browser localStorage - persists across browser sessions (per-browser, not per-user account)
5. **Cross-tab sync**: Changes sync to other open dashboard tabs via `storage` event listener

### Alternatives Considered

#### Alternative A: Keyboard Modifier Enhancement
Enhance the existing Shift+click behavior with better documentation.

**Pros:**
- Already implemented
- Per-action control
- No UI changes needed

**Cons:**
- Still requires modifier key on every close
- Not discoverable
- Doesn't satisfy "always skip" use case

#### Alternative B: Context Menu Option
Add "Close without confirmation" to the tab context menu.

**Pros:**
- Discoverable through right-click
- Per-action control

**Cons:**
- More clicks than Shift+click
- Still per-action, not persistent

#### Alternative C: Environment Variable
Use an environment variable to control confirmation behavior.

**Pros:**
- Set once, forget it
- Works across sessions

**Cons:**
- Requires restart when changed
- Not discoverable
- Too technical for many users

### Selected Approach: Settings Toggle (Approach A enhanced)

The settings toggle approach provides the best balance of:
- Persistence (set once per browser)
- Discoverability (visible in settings UI)
- Safety (default to confirmations enabled)
- Flexibility (can be changed anytime)

## Detailed Requirements

### Functional Requirements

**MUST:**
1. Add a toggle setting "Skip close confirmation for running processes"
2. Store the setting in localStorage (key: `skipCloseConfirmation`, value: `"true"` or absent)
3. When enabled, close builder/shell tabs immediately without dialog
4. Default to disabled (confirmations shown) - when key is absent or any value other than `"true"`
5. Shift+click behavior remains unchanged (always bypasses regardless of setting)
6. Cross-tab synchronization via `storage` event listener - when setting changes in one tab, other tabs read the new value
7. Integrate cleanly with Bugfix #132 logic - the already-exited process check happens first (short-circuit), then setting is checked

**SHOULD:**
1. Show a tooltip/hint text explaining what the setting does
2. Provide visual feedback when the setting is changed (checkbox state change is sufficient)
3. Apply immediately without page refresh

**COULD:**
1. Add keyboard shortcut hint near the setting ("Tip: Shift+click always skips")
2. Show count of running tabs that would be affected

### Non-Functional Requirements

1. **Performance**: No measurable impact on tab close latency
2. **Storage**: Single localStorage key, minimal footprint
3. **Accessibility**: Setting toggle must be keyboard navigable and screen reader friendly
4. **Client-side only**: This is a UI-only preference. It does not affect server-side process lifecycle - closing a tab still terminates the process via the existing DELETE API call

### Edge Cases

1. **Process exits between click and check**: The Bugfix #132 check (`/api/tabs/:id/running`) runs first. If the process exited, the tab closes immediately regardless of the setting. This preserves the existing fast-path behavior.
2. **Tabs created after toggling**: New tabs inherit the current setting value (read from localStorage at close time, not tab creation time).
3. **Multiple browser windows**: Each window reads from the same localStorage. If user changes setting in Window A, Window B will see the new value on next close attempt (or immediately if storage event listener is implemented).
4. **localStorage unavailable**: Falls back to showing confirmations (safe default).

## UI Design

### Settings Location

The setting will appear in a new "Settings" collapsible section in the Dashboard tab, following the existing pattern of the Tabs, Files, and Projects sections. This provides consistency with the existing UI.

```
┌──────────────────────────────────────┐
│ Dashboard                            │
├──────────────────────────────────────┤
│ ▼ Tabs                               │
│   [+ Create new shell]               │
│   [+ Create new worktree + shell]    │
│   ⬡ Architect  ● builder-42          │
├──────────────────────────────────────┤
│ ▼ Files                              │
│   [file tree...]                     │
├──────────────────────────────────────┤
│ ▼ Projects                           │
│   [project list...]                  │
├──────────────────────────────────────┤
│ ▼ Settings                           │
│   ☐ Skip close confirmation for      │
│     running processes                │
│     (Tip: Shift+click always skips)  │
└──────────────────────────────────────┘
```

### Toggle States

- **Unchecked (default)**: "Close confirmation dialogs will be shown"
- **Checked**: "Tabs will close immediately without confirmation"

## Implementation Scope

### In Scope

1. Settings toggle UI in Dashboard tab content area
2. localStorage read/write for persistence
3. Modified close behavior to check the setting before showing confirmation
4. Storage event listener for cross-tab sync

### Out of Scope

1. User authentication/account-based settings
2. Server-side setting storage
3. Per-tab-type settings (all or nothing)
4. Annotation editor `beforeunload` behavior (separate concern)
5. Changes to `closeOtherTabs()` or `closeAllTabs()` (these already bypass confirmation)

## Success Criteria

### Acceptance Tests

1. **Toggle visibility**: Settings toggle visible in Dashboard tab
2. **Default state**: Toggle is unchecked by default on fresh browser
3. **Persistence**: Setting persists across page refreshes
4. **Behavior when disabled**: Closing running builder shows confirmation
5. **Behavior when enabled**: Closing running builder closes immediately
6. **Shift+click override**: Shift+click bypasses regardless of setting
7. **Accessibility**: Toggle navigable by keyboard, labeled for screen readers

### Non-Functional Tests

1. Close latency unchanged when setting enabled
2. localStorage key created only after first toggle interaction

### Automated Testing Guidance

1. **E2E test**: Toggle the setting, spawn a builder, close it, verify no confirmation modal appears
2. **E2E test**: Toggle the setting OFF, spawn a builder, close it, verify confirmation modal appears
3. **E2E test**: Verify Shift+click bypasses regardless of setting state
4. **Unit test**: Verify localStorage read defaults to confirmations enabled when key is absent
5. **Unit test**: Verify localStorage read with `"true"` value returns skip-enabled
6. **Regression test**: Verify Bugfix #132 behavior (already-exited processes) still works with setting enabled

## Open Questions

### Critical
*None - requirements are clear*

### Important
*None - cross-tab sync moved to requirements*

### Nice-to-Know
1. Do users want per-tab-type control (builders vs shells)? (Deferred to future enhancement if requested)

## Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Users enable setting then accidentally close important work | Medium | Low | Clear tooltip, Shift+click remains as explicit bypass |
| localStorage cleared unexpectedly | Low | Low | Default to safe behavior (confirmations enabled) |

## Consultation Log

### First Consultation (After Draft)
- **Date**: 2026-01-24
- **Models consulted**: Gemini 3 Pro, GPT-5 Codex
- **Verdicts**: Gemini APPROVE (with suggestions), Codex REQUEST_CHANGES

**Gemini feedback (APPROVE, HIGH confidence):**
1. Move cross-tab sync from "Open Questions" to "Requirements" - **DONE**
2. Be explicit about localStorage string comparison (`=== 'true'`) - **DONE** (added to MUST #2)
3. Ensure Settings section follows existing collapsible pattern - **DONE** (clarified in UI Design)

**Codex feedback (REQUEST_CHANGES, HIGH confidence):**
1. Contradictory "per-session" vs localStorage persistence - **FIXED** (changed to "Persistent browser setting")
2. Cross-tab synchronization unspecified - **FIXED** (added as MUST #6)
3. Missing automated testing guidance - **FIXED** (added "Automated Testing Guidance" section)
4. Edge cases not described - **FIXED** (added "Edge Cases" section)
5. Clarify client-side only nature - **FIXED** (added to Non-Functional Requirements #4)
6. Files vs behaviors in implementation scope - **FIXED** (changed to behavior descriptions)

### Second Consultation (After Human Review)
- **Date**: Pending
- **Models consulted**: Gemini 3 Pro, GPT-5 Codex
- **Key feedback**: TBD
- **Changes made**: TBD
