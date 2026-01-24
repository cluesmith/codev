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

Implement a new setting in the dashboard that allows users to disable the close confirmation dialog globally for their session.

**Key Design Decisions:**

1. **Scope**: Per-session setting (stored in localStorage)
2. **Default**: Confirmations enabled (safe default for new users)
3. **UI Location**: Settings panel in the dashboard
4. **Persistence**: Browser localStorage (per-browser, not per-user account)

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
2. Store the setting in localStorage (key: `skipCloseConfirmation`)
3. When enabled, close builder/shell tabs immediately without dialog
4. Default to disabled (confirmations shown)
5. Shift+click behavior remains unchanged (always bypasses regardless of setting)

**SHOULD:**
1. Show a tooltip explaining what the setting does
2. Provide visual feedback when the setting is changed
3. Apply immediately without page refresh

**COULD:**
1. Add keyboard shortcut hint near the setting
2. Show count of tabs that would be affected

### Non-Functional Requirements

1. **Performance**: No measurable impact on tab close latency
2. **Storage**: Single localStorage key, minimal footprint
3. **Accessibility**: Setting toggle must be keyboard navigable and screen reader friendly

## UI Design

### Settings Location

The setting will appear in a new "Settings" section of the Dashboard tab, below the existing quick actions.

```
┌──────────────────────────────────────┐
│ Dashboard                            │
├──────────────────────────────────────┤
│ Quick Actions                        │
│ [+ Builder] [+ Shell] [Open File]    │
├──────────────────────────────────────┤
│ Settings                             │
│                                      │
│ ☐ Skip close confirmation for        │
│   running processes                  │
│   (Tip: Shift+click always skips)    │
└──────────────────────────────────────┘
```

### Toggle States

- **Unchecked (default)**: "Close confirmation dialogs will be shown"
- **Checked**: "Tabs will close immediately without confirmation"

## Implementation Scope

### In Scope

1. Settings toggle in Dashboard tab
2. localStorage persistence
3. Modified `closeTab()` behavior in `dialogs.js`
4. Updated dashboard rendering in `main.js`

### Out of Scope

1. User authentication/account-based settings
2. Server-side setting storage
3. Per-tab-type settings (all or nothing)
4. Annotation editor `beforeunload` behavior (separate concern)

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

## Open Questions

### Critical
*None - requirements are clear*

### Important
1. Should the setting sync across tabs in the same browser? (Current: Yes, via localStorage + storage event listener)

### Nice-to-Know
1. Do users want per-tab-type control (builders vs shells)? (Deferred to future enhancement if requested)

## Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Users enable setting then accidentally close important work | Medium | Low | Clear tooltip, Shift+click remains as explicit bypass |
| localStorage cleared unexpectedly | Low | Low | Default to safe behavior (confirmations enabled) |

## Consultation Log

*To be populated after multi-agent consultation*

### First Consultation (After Draft)
- **Date**: Pending
- **Models consulted**: Gemini 3 Pro, GPT-5 Codex
- **Key feedback**: TBD
- **Changes made**: TBD

### Second Consultation (After Human Review)
- **Date**: Pending
- **Models consulted**: Gemini 3 Pro, GPT-5 Codex
- **Key feedback**: TBD
- **Changes made**: TBD
