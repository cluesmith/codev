# Specification: Project List UI

## Metadata
- **ID**: 0045-project-list-ui
- **Status**: conceived
- **Created**: 2025-12-09
- **Protocol**: SPIR
- **Priority**: high

## Problem Statement

The project list (`codev/projectlist.md`) is a text file that users edit manually. While functional, this creates several issues:

1. **No visual overview**: Users can't see at a glance where all their projects stand
2. **No onboarding**: New users don't know how to get started with Codev
3. **Hidden progress**: The 7-stage lifecycle is invisible - work doesn't feel like it's "moving"
4. **Context switching**: Users must open a separate file to check project status

## Scope

### In Scope
1. **Uncloseable "Projects" tab** in the right panel of the dashboard
2. **Welcome screen** for new users explaining Codev
3. **Status summary** at the top showing current work
4. **7-column Kanban view** showing projects across lifecycle stages
5. **Real-time updates** when projectlist.md changes
6. **Project details** on click/hover

### Out of Scope
- Editing projects through the UI (still edit projectlist.md)
- Creating new projects through the UI
- Drag-and-drop status changes
- Filtering/sorting (initial version shows all)
- Mobile/responsive design

## Desired State

### Dashboard Layout

The right panel of the dashboard will have the Projects tab always visible as the first tab:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ [Projects] [Builder-0039 ×] [spec.md ×] [... +2]                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                        STATUS SUMMARY                                   │ │
│ │  3 in progress • 5 awaiting review • 12 integrated                     │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ ┌───────────┬──────────┬─────────┬─────────────┬─────────────┬───────────┬───────────┬────────────┐
│ │  PROJECT  │ CONCEIVED│SPECIFIED│   PLANNED   │IMPLEMENTING │IMPLEMENTED│ COMMITTED │ INTEGRATED │
│ ├───────────┼──────────┼─────────┼─────────────┼─────────────┼───────────┼───────────┼────────────┤
│ │ 0039 CLI  │          │         │             │     ●       │           │           │            │
│ │ 0044 Wrkfl│          │    ●    │             │             │           │           │            │
│ │ 0045 UI   │    ●     │         │             │             │           │           │            │
│ └───────────┴──────────┴─────────┴─────────────┴─────────────┴───────────┴───────────┴────────────┘
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Welcome Screen (No Projects)

When no projects exist (or projectlist.md is missing), show an onboarding welcome:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                         Welcome to Codev                                    │
│                                                                             │
│   Codev helps you build software with AI assistance. Projects flow         │
│   through 7 stages from idea to production:                                 │
│                                                                             │
│   1. Conceived    - Tell the architect what you want to build              │
│   2. Specified    - AI writes a spec, you approve it                       │
│   3. Planned      - AI creates an implementation plan                      │
│   4. Implementing - Builder AI writes the code                             │
│   5. Implemented  - Code complete, PR ready for review                     │
│   6. Committed    - PR merged to main                                      │
│   7. Integrated   - Validated in production                                │
│                                                                             │
│   To get started, describe what you want to build to the Architect         │
│   (in the left panel). The architect will create your first project.       │
│                                                                             │
│   ────────────────────────────────────────────────────────────────────     │
│                                                                             │
│   Quick tip: Say "I want to build a [feature]" and the architect will      │
│   guide you through the process.                                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Status Summary Section

The top section provides a quick overview:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  STATUS SUMMARY                                                    [↻]     │
│                                                                             │
│  Active: 3 projects                                                         │
│    • 1 implementing (0039 Codev CLI)                                       │
│    • 1 awaiting spec approval (0045 Project List UI)                       │
│    • 1 awaiting plan approval (0044 Workflow Clarity)                      │
│                                                                             │
│  Completed: 42 integrated                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

The [↻] button reloads projectlist.md from disk.

### Kanban Grid

The main area shows projects in a 7-column grid:

**Column Structure:**
| Column | Header | Content |
|--------|--------|---------|
| 0 | PROJECT | Project ID + abbreviated title |
| 1 | CONCEIVED | ● if status is conceived |
| 2 | SPECIFIED | ● if status is specified |
| 3 | PLANNED | ● if status is planned |
| 4 | IMPLEMENTING | ● if status is implementing |
| 5 | IMPLEMENTED | ● if status is implemented |
| 6 | COMMITTED | ● if status is committed |
| 7 | INTEGRATED | ● if status is integrated |

**Visual Indicators:**
- Current stage: Filled circle (●) with accent color
- Completed stages: Filled circle (●) with muted color
- Future stages: Empty
- Human-gated transitions: Small lock icon between conceived→specified and committed→integrated

**Row Behavior:**
- Click row to expand project details below
- Details show: full title, summary, notes, dependencies, links to spec/plan/review files

### Color Coding

| Status | Dot Color | Row Background |
|--------|-----------|----------------|
| conceived | Yellow | Light yellow tint |
| specified | Blue | Light blue tint |
| planned | Blue | Light blue tint |
| implementing | Orange | Light orange tint |
| implemented | Purple | Light purple tint |
| committed | Green | Light green tint |
| integrated | Gray | No tint |
| abandoned | Red | Light red tint, strikethrough |
| on-hold | Gray | Light gray tint, italic |

### Data Source

The UI reads from `codev/projectlist.md`:

1. **Initial load**: Fetch and parse projectlist.md
2. **Polling**: Compare content hash every 5 seconds (debounce 500ms after change detected)
3. **On change**: Re-parse and update UI, preserving expanded row state

**Project Schema** (fields used by UI):
```yaml
- id: "0045"              # Required, 4-digit string (filter out "NNNN" examples)
  title: "Brief title"    # Required, display in grid
  summary: "Description"  # Optional, shown in details
  status: conceived       # Required, one of: conceived|specified|planned|implementing|implemented|committed|integrated|abandoned|on-hold
  priority: high          # Optional, for sorting
  files:
    spec: codev/specs/... # Optional, link to spec file
    plan: codev/plans/... # Optional, link to plan file
    review: codev/reviews/...  # Optional, link to review file
  dependencies: []        # Optional, list of project IDs
  notes: ""               # Optional, shown in details
```

**Parsing Logic:**
```javascript
function parseProjectlist(content) {
  const projects = [];

  // Extract YAML code blocks
  const yamlBlocks = content.match(/```yaml\n([\s\S]*?)```/g) || [];

  for (const block of yamlBlocks) {
    // Simple line-by-line YAML parser for project entries
    // Look for "- id:" lines to identify project starts
    // Extract key: value pairs until next "- id:" or end of block

    // Filter out example entries (id: "NNNN", id: "0001" with tags: [example])
    // Validate id is 4-digit numeric string
  }

  return projects;
}
```

**Error Handling:**
- **File missing**: Show welcome screen
- **File empty**: Show welcome screen
- **Malformed YAML**: Show error banner "Could not parse projectlist.md" with [Retry] button, preserve last good state if available
- **Missing required fields**: Skip that project entry, log warning to console
- **Partial file write**: Debounce polling to avoid reading mid-write

### Terminal States (abandoned, on-hold)

Projects with status `abandoned` or `on-hold` are NOT shown in the main Kanban grid. Instead:
- Show in a separate collapsible "Terminal Projects" section below the grid
- `abandoned`: Red text, strikethrough title
- `on-hold`: Gray text, italic title, shows reason from notes

### Tab Behavior

**Uncloseable:**
- Projects tab has no close button (×)
- Cannot be closed via context menu "Close All"
- Always appears as first tab

**Switchable:**
- Can switch to other tabs normally
- Returns to Projects tab when clicked

## Technical Approach

### File Structure

Modify existing files:
- `packages/codev/src/agent-farm/templates/dashboard-split.html` - Add Projects tab content and logic

No new files required - all contained in the existing dashboard template.

### Implementation Steps

1. **Add Projects tab to tab bar**
   - Insert as first tab, always present
   - No close button
   - Special "projects" type

2. **Add Projects content area**
   - Welcome screen (when no projects)
   - Status summary section
   - Kanban grid

3. **Implement projectlist.md parser**
   - Fetch file via `/file` endpoint
   - Parse YAML blocks
   - Extract project entries

4. **Implement polling**
   - Check file mtime every 5 seconds
   - Re-render on change

5. **Style the grid**
   - CSS grid for 8 columns
   - Responsive column widths
   - Color coding per status

### API Dependencies

Uses existing dashboard endpoints:
- `GET /file?path=codev/projectlist.md` - Read projectlist content

No new backend endpoints required.

## Success Criteria

### Functional
- [ ] Projects tab appears as first tab, cannot be closed
- [ ] Welcome screen shows when no projects exist
- [ ] Status summary shows correct counts
- [ ] Kanban grid displays all projects with correct stage indicators
- [ ] Clicking a row expands project details
- [ ] UI updates within 5 seconds of projectlist.md changes
- [ ] Color coding matches status
- [ ] Human-gated stages (conceived→specified, committed→integrated) are visually indicated
- [ ] Terminal states (abandoned, on-hold) shown in separate section
- [ ] Example projects (id: "NNNN") are filtered out

### Security
- [ ] All user content (title, summary, notes) is HTML-escaped
- [ ] No eval() or Function() in parser
- [ ] XSS test: `<script>alert(1)</script>` in title renders as text

### Accessibility
- [ ] Keyboard navigation works (Tab, Enter, Arrow keys)
- [ ] Screen reader announces status changes
- [ ] Status indicators use shape + color (not color alone)

## Security

### XSS Prevention

All user-generated content from projectlist.md MUST be escaped before rendering:

```javascript
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Use for all: title, summary, notes, file paths
```

### Path Restrictions

The `/file` endpoint is already restricted to files within the project directory by the dashboard server. The UI only requests `codev/projectlist.md` - no user-controlled paths.

### Safe Parsing

The simple line-by-line YAML parser does NOT use `eval()` or `Function()`. It only extracts string values using regex matching on known patterns (`key: "value"` or `key: value`).

## Accessibility

### Keyboard Navigation

- Tab/Shift+Tab to navigate between rows
- Enter/Space to expand/collapse row details
- Arrow keys to move between rows when focused

### Screen Reader Support

- Use semantic HTML: `<table>` with `<th>` headers
- ARIA labels on status indicators: `aria-label="Status: implementing"`
- Announce row expansion: `aria-expanded="true/false"`

### Color-Blind Accessibility

Status indicators use both color AND shape:
- ● Filled circle for current stage (with color)
- ○ Empty circle for completed stages
- Each status column header includes status name, not just color

## Constraints

- Must work within existing dashboard-split.html (vanilla HTML/JS)
- No new npm dependencies (simple YAML parser inline, not js-yaml)
- Must handle malformed projectlist.md gracefully
- Must not slow down dashboard load time significantly
- All user content must be HTML-escaped before rendering

## Test Plan

### Automated Tests (Parser Unit Tests)

Create `tests/projectlist-parser.test.js` with:

1. **Valid input**: Parse sample projectlist, verify project count and fields
2. **Example filtering**: Verify `id: "NNNN"` and `tags: [example]` entries are excluded
3. **Missing fields**: Verify projects with missing `id` or `status` are skipped
4. **Malformed YAML**: Verify parser returns empty array (not throws)
5. **Status mapping**: Verify each status maps to correct column index
6. **XSS prevention**: Verify `<script>` in title is escaped to `&lt;script&gt;`

### Manual Testing

1. **Welcome screen**: Delete/rename projectlist.md, verify welcome shows
2. **Initial load**: Have projectlist.md with projects, verify grid populates
3. **Stage accuracy**: Verify each project shows dot in correct column
4. **Tab persistence**: Close all other tabs, verify Projects remains
5. **Live update**: Edit projectlist.md externally, verify UI updates within 5s
6. **Expand/collapse**: Click project row, verify details show/hide
7. **Color coding**: Verify each status has correct colors
8. **Keyboard nav**: Tab through rows, Enter to expand, verify focus management
9. **Error banner**: Corrupt projectlist.md, verify error shows with Retry button

### Edge Cases

- Empty projectlist.md (just template, no projects) → welcome screen
- Malformed YAML (parser should not crash) → error banner
- Very long project titles (>50 chars) → truncate with ellipsis, full title on hover
- Many projects (100+) → scrollable grid, no layout break
- Terminal states (abandoned, on-hold) → separate section, different styling
- XSS attempt (`<script>` in title) → escaped, shows as text

## References

- Dashboard template: `packages/codev/src/agent-farm/templates/dashboard-split.html`
- Project lifecycle: `codev/projectlist.md` (lifecycle documentation section)
- Spec 0007: Split-Pane Dashboard (parent feature)
