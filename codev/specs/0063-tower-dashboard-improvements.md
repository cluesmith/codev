# Spec 0063: Tower Dashboard Improvements

## Status: Conceived
## Priority: High
## Target Release: v1.6.0

## Summary

Improve the `codev tower` dashboard with better project management UI and integrated tools for starting local/remote Agent Farm instances.

## Current State

The current tower dashboard shows a list of projects but lacks:
- Clear single-row-per-dashboard layout
- Tools for starting local/remote services
- Actions for creating, adopting, and updating codev projects

## Requirements

### 1. Single Row Per Dashboard

Each registered Agent Farm dashboard should display as a single, clear row in the tower UI.

### 2. Action Buttons

Add action buttons at the top of the dashboard:

| Button | Action | Description |
|--------|--------|-------------|
| **Open Dashboard (Local)** | Opens local directory | Prompts for directory path, runs `afx start` |
| **Open Dashboard (Remote)** | Opens remote SSH target | Prompts for `user@host:/path`, runs `afx start --remote` |
| **Create New Repo** | Initialize new project | Prompts for directory, runs `codev init` |
| **Adopt Existing Repo** | Add codev to existing repo | Prompts for directory, runs `codev adopt` |
| **Update Existing Repo** | Update codev in repo | Prompts for directory, runs `codev update` |

### 3. Command Output Terminal

When any action button is clicked:
1. Open a terminal panel/modal in the tower UI
2. Show real-time output from the command being run
3. Allow user to see success/failure and any prompts
4. Terminal should be closeable after command completes

### 4. Implementation Notes

- Use ttyd or similar for terminal display (consistent with architect terminal)
- Commands should run in the context of the selected/entered directory
- Consider WebSocket for real-time command output
- Error states should be clearly visible

## Non-Goals

- Modifying the architect dashboard UI (this is tower-specific)
- Managing builders from tower (that's the architect's job)

## Acceptance Criteria

1. Tower dashboard shows one row per registered project/dashboard
2. All five action buttons are present and functional
3. Clicking any action button opens a terminal showing command output
4. Commands execute correctly (init, adopt, update, afx start local/remote)
5. Terminal can be closed after command completes
6. Error states are clearly communicated to user

## Open Questions

1. Should the terminal be a modal or a sliding panel?
2. Should we support multiple concurrent terminals?
3. How to handle directory selection - native file picker or text input?
