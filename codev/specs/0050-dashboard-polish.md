# Spec 0050: Dashboard Polish

**Status:** conceived
**Protocol:** SPIR
**Priority:** Medium
**Dependencies:** None
**Blocks:** None

---

## Problem Statement

Two usability issues in the agent-farm dashboard:

1. **TICKs not visible**: When expanding a project in the dashboard, TICK amendments aren't shown. Users can't see the evolution of a spec without opening the file.

2. **Starter page gets stuck**: When there's no `projectlist.md`, the dashboard shows the starter page. But if the user creates `projectlist.md` (e.g., via `codev init` in another terminal), the dashboard doesn't detect it and stays stuck on the starter page.

---

## Requirements

### 1. Project Row Click Behavior

Currently clicking anywhere on a project row expands it. This should be refined:

- **Title only**: Only clicking the project title should expand/collapse
- **Title styling**: Title should be underlined to indicate it's clickable
- **Other areas**: Clicking status, priority, etc. should NOT expand

```html
<!-- Current (wrong) -->
<div class="project-row" onclick="toggle()">...</div>

<!-- Fixed -->
<div class="project-row">
  <span class="project-title clickable" onclick="toggle()">0039: Codev CLI</span>
  <span class="status">integrated</span>
  ...
</div>
```

### 2. Show TICKs in Project View

When a project is expanded in the dashboard, display its TICK amendments:

```
▼ 0039: Codev CLI
  Status: integrated
  TICKs: 001, 002, 003, 004, 005

  TICK-001: Port consult to TypeScript
  TICK-002: Embedded skeleton with eject
  TICK-003: Revert to copy-on-init
  TICK-004: Fetch skeleton from GitHub
  TICK-005: codev import command
```

**Data source**: Parse `ticks:` field from projectlist.md and optionally read TICK sections from spec file for descriptions.

### 2. Poll for projectlist.md Creation

When in starter page mode (no projectlist.md detected):

1. Start a polling interval (~15 seconds)
2. Check if `codev/projectlist.md` exists
3. If found, reload the project list and exit starter mode
4. Stop polling once projectlist.md is found

**Implementation**: Add `setInterval` in starter page JavaScript that calls an endpoint to check file existence.

---

## Technical Approach

### TICK Display

1. Parse projectlist.md for `ticks:` array
2. If project has ticks, show them in expanded view
3. Optionally: Read spec file, extract TICK amendment titles using regex:
   ```
   ## TICK Amendment: .* \(TICK-(\d+)\)
   ### Problem
   (.*)
   ```

### Starter Page Polling

```typescript
// In dashboard client-side JS
if (isStarterMode) {
  const pollInterval = setInterval(async () => {
    const response = await fetch('/api/projectlist-exists');
    if (response.ok) {
      const { exists } = await response.json();
      if (exists) {
        clearInterval(pollInterval);
        window.location.reload();
      }
    }
  }, 15000); // 15 seconds
}
```

Add server endpoint:
```typescript
// GET /api/projectlist-exists
app.get('/api/projectlist-exists', (req, res) => {
  const exists = fs.existsSync(path.join(projectRoot, 'codev/projectlist.md'));
  res.json({ exists });
});
```

---

## Success Criteria

- [ ] Project title is underlined and is the only clickable element for expand/collapse
- [ ] Clicking other parts of project row does NOT expand
- [ ] Expanded project view shows TICK list when project has ticks
- [ ] TICK display shows amendment number and optionally title
- [ ] Starter page polls for projectlist.md every 15 seconds
- [ ] Dashboard automatically refreshes when projectlist.md is created
- [ ] Polling stops once projectlist.md is detected (no resource leak)

---

## Out of Scope

- Full TICK content display (just show list, not full amendment text)
- Real-time file watching (polling is sufficient)
- Editing TICKs from dashboard
