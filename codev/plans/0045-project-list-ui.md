# Plan: Project List UI

## Metadata
- **Spec**: [0045-project-list-ui.md](../specs/0045-project-list-ui.md)
- **Status**: approved
- **Created**: 2025-12-09
- **Protocol**: SPIR

## Overview

Implement an uncloseable "Projects" tab in the dashboard that displays project status across 7 lifecycle stages, with a welcome screen for new users and real-time updates.

## Architecture Decision

Based on 3-way consultation (Gemini, Codex, Claude): **Keep projectlist.md as the data source**. SQLite migration deferred - markdown is git-friendly, human-editable, and LLM-context-friendly.

## Phase 1: Projects Tab Infrastructure

**Goal**: Add the uncloseable Projects tab as first tab in the dashboard

### Tasks

1. Modify `buildTabsFromState()` to insert Projects tab first:
   ```javascript
   function buildTabsFromState() {
     tabs = [];

     // Projects tab is ALWAYS first and uncloseable
     tabs.push({
       id: 'projects',
       type: 'projects',
       name: 'Projects',
       closeable: false
     });

     // ... rest of existing tabs (files, builders, shells)
   }
   ```

2. Update `renderTabs()` to handle `closeable: false`:
   - No close button (×) for projects tab
   - Add project icon (📋 or similar)

3. Update `renderTabContent()` to handle `type: 'projects'`:
   - Render inline HTML instead of iframe
   - Call new `renderProjectsTab()` function

4. Update `closeAllTabs()` and `closeOtherTabs()` to skip uncloseable tabs

5. Update tab selection to default to Projects on startup

### Exit Criteria
- Projects tab appears as first tab
- Projects tab has no close button
- Clicking Projects tab shows placeholder content
- "Close All Tabs" leaves Projects tab open

## Phase 2: Projectlist Parser

**Goal**: Parse projectlist.md into structured data

### Tasks

1. Add `parseProjectlist(content)` function:
   ```javascript
   function parseProjectlist(content) {
     const projects = [];

     // Extract YAML code blocks
     const yamlBlockRegex = /```yaml\n([\s\S]*?)```/g;
     let match;

     while ((match = yamlBlockRegex.exec(content)) !== null) {
       const block = match[1];
       // Parse project entries (- id: "XXXX" starts a project)
       const projectMatches = block.split(/\n(?=\s*- id:)/);

       for (const projectText of projectMatches) {
         const project = parseProjectEntry(projectText);
         if (project && isValidProject(project)) {
           projects.push(project);
         }
       }
     }

     return projects;
   }
   ```

2. Add `parseProjectEntry(text)` function:
   - Extract id, title, summary, status, priority, files, dependencies, notes
   - Handle nested YAML (files.spec, files.plan, files.review)
   - Use simple regex-based parsing (no external YAML library)

3. Add `isValidProject(project)` function:
   - Must have id (4-digit string, not "NNNN")
   - Must have status (valid lifecycle state)
   - Must have title
   - Filter out example entries (tags contains "example")

4. Add `escapeHtml(text)` for XSS prevention:
   ```javascript
   function escapeHtml(text) {
     const div = document.createElement('div');
     div.textContent = text;
     return div.innerHTML;
   }
   ```

### Exit Criteria
- Parser extracts projects from sample projectlist.md
- Example entries (id: "NNNN") are filtered out
- All user content is escaped
- Malformed YAML returns empty array (no crash)

## Phase 3: Welcome Screen

**Goal**: Show onboarding content when no projects exist

### Tasks

1. Add `renderWelcomeScreen()` function:
   ```javascript
   function renderWelcomeScreen() {
     return `
       <div class="projects-welcome">
         <h2>Welcome to Codev</h2>
         <p>Codev helps you build software with AI assistance...</p>
         <ol>
           <li><strong>Conceived</strong> - Tell the architect...</li>
           ...
         </ol>
         <p class="quick-tip">Quick tip: Say "I want to build..."</p>
       </div>
     `;
   }
   ```

2. Add CSS for welcome screen:
   - Centered, readable typography
   - Clear visual hierarchy
   - Muted colors for stage descriptions

3. Integrate into `renderProjectsTab()`:
   - If no projects or file missing → show welcome screen
   - Otherwise → show status summary + kanban grid

### Exit Criteria
- Welcome screen appears when projectlist.md is missing
- Welcome screen appears when no valid projects exist
- Welcome screen explains the 7-stage lifecycle
- Welcome screen encourages users to start

## Phase 4: Status Summary

**Goal**: Show at-a-glance project counts and active work

### Tasks

1. Add `renderStatusSummary(projects)` function:
   ```javascript
   function renderStatusSummary(projects) {
     const active = projects.filter(p =>
       ['conceived', 'specified', 'planned', 'implementing', 'implemented'].includes(p.status)
     );
     const completed = projects.filter(p => p.status === 'integrated');

     // Group active by status
     const byStatus = groupBy(active, 'status');

     return `
       <div class="status-summary">
         <div class="summary-header">
           <span>STATUS SUMMARY</span>
           <button onclick="reloadProjectlist()" title="Reload">↻</button>
         </div>
         <div class="active-projects">
           Active: ${active.length} projects
           ${renderActiveList(byStatus)}
         </div>
         <div class="completed">Completed: ${completed.length} integrated</div>
       </div>
     `;
   }
   ```

2. Add CSS for status summary:
   - Clear header with reload button
   - Indented active project list
   - Muted completed count

3. Add `reloadProjectlist()` function:
   - Re-fetch projectlist.md
   - Re-render Projects tab

### Exit Criteria
- Summary shows correct active project count
- Summary shows correct integrated count
- Reload button triggers re-fetch
- Active projects grouped by status

## Phase 5: Kanban Grid

**Goal**: Display projects in 7-column lifecycle grid

### Tasks

1. Add `renderKanbanGrid(projects)` function:
   ```javascript
   function renderKanbanGrid(projects) {
     // Filter out terminal states (abandoned, on-hold)
     const activeProjects = projects.filter(p =>
       !['abandoned', 'on-hold'].includes(p.status)
     );

     const columns = ['conceived', 'specified', 'planned', 'implementing',
                      'implemented', 'committed', 'integrated'];

     return `
       <table class="kanban-grid" role="grid">
         <thead>
           <tr>
             <th>PROJECT</th>
             ${columns.map(c => `<th>${c.toUpperCase()}</th>`).join('')}
           </tr>
         </thead>
         <tbody>
           ${activeProjects.map(p => renderProjectRow(p, columns)).join('')}
         </tbody>
       </table>
     `;
   }
   ```

2. Add `renderProjectRow(project, columns)` function:
   - Show project ID + truncated title in first column
   - Show ● in current status column with accent color
   - Show ● in completed columns with muted color
   - Add `data-project-id` for expansion handling

3. Add `renderStageCell(project, stage)` function for clickable stage links:
   - `specified` → Link to spec file (via `/open-file?path=...`)
   - `planned` → Link to plan file
   - `implementing` → Link to builder tab (if active) or builder PR
   - `implemented` → Link to PR
   - `committed` → Link to merged PR
   - `integrated` → Link to review file
   - Non-link stages show indicator only

4. Add CSS for kanban grid:
   - CSS Grid with 8 columns (project + 7 stages)
   - Color coding per status (per spec)
   - Row hover effect
   - Sticky header

5. Add status indicators:
   - Filled circle (●) for current/completed stages
   - Empty for future stages
   - Human-gate indicators (🔒) between conceived→specified and committed→integrated

6. Add ARIA accessibility attributes:
   - `role="grid"` on table, `role="row"` on rows
   - `aria-label` on status indicators: `aria-label="Status: implementing"`
   - `aria-current="step"` on current stage column
   - `tabindex="0"` on rows for keyboard focus

### Exit Criteria
- Grid displays all non-terminal projects
- Correct stage indicator in correct column
- Stage cells are clickable links to relevant artifacts
- Color coding matches spec
- Human-gate stages visually indicated
- Screen reader announces project status correctly

## Phase 6: Project Details Expansion

**Goal**: Show full project details on row click

### Tasks

1. Add `toggleProjectDetails(projectId)` function:
   - Track expanded project ID in state
   - Re-render grid to show/hide details row

2. Add `renderProjectDetails(project)` function:
   ```javascript
   function renderProjectDetails(project) {
     return `
       <tr class="project-details">
         <td colspan="8">
           <div class="details-content">
             <h3>${escapeHtml(project.title)}</h3>
             ${project.summary ? `<p>${escapeHtml(project.summary)}</p>` : ''}
             ${project.notes ? `<p class="notes">${escapeHtml(project.notes)}</p>` : ''}
             ${renderProjectLinks(project)}
             ${renderDependencies(project)}
           </div>
         </td>
       </tr>
     `;
   }
   ```

3. Add `renderProjectLinks(project)` function:
   - Link to spec file (if exists)
   - Link to plan file (if exists)
   - Link to review file (if exists)
   - Use `af open` style URLs

4. Add CSS for expanded details:
   - Subtle background tint
   - Indented content
   - Links styled as buttons

5. Add keyboard support:
   - Enter/Space to toggle expansion
   - Arrow keys to navigate rows

6. Add ARIA for expansion:
   - `aria-expanded="true/false"` on expandable rows
   - `aria-controls` pointing to details region
   - Live region announcement on expand/collapse

### Exit Criteria
- Click row → details expand below
- Click again → details collapse
- Details show title, summary, notes
- File links open in annotation viewer (via `/open-file` endpoint)
- Keyboard navigation works
- Screen reader announces expansion state

## Phase 7: Real-Time Updates

**Goal**: Update UI when projectlist.md changes

### Tasks

1. Add polling mechanism:
   ```javascript
   let projectlistHash = null;

   async function pollProjectlist() {
     const response = await fetch('/file?path=codev/projectlist.md');
     const content = await response.text();
     const newHash = hashString(content);

     if (newHash !== projectlistHash) {
       projectlistHash = newHash;
       // Debounce: wait 500ms before re-rendering
       clearTimeout(projectlistDebounce);
       projectlistDebounce = setTimeout(() => {
         projectsData = parseProjectlist(content);
         renderProjectsTab();
       }, 500);
     }
   }

   // Poll every 5 seconds
   setInterval(pollProjectlist, 5000);
   ```

2. Add `hashString(str)` function:
   - Simple hash for change detection
   - Can use DJB2 or similar

3. Preserve expanded state across updates:
   - Track `expandedProjectId` in state
   - Restore after re-render

4. Handle errors:
   - File not found → show welcome screen
   - Parse error → show error banner with Retry button
   - Preserve last good state if available

### Exit Criteria
- UI updates within 5 seconds of file change
- Expanded row state preserved across updates
- File missing → welcome screen
- Parse error → error banner (not crash)

## Phase 8: Terminal States and TICK Projects

**Goal**: Show abandoned/on-hold projects separately and handle TICK amendments

### Tasks

1. Add visual indicator for TICK protocol projects:
   - Check `protocol: tick` in project data
   - Show small badge or icon (🔧) next to project ID
   - TICK projects appear in same grid as SPIR (same lifecycle stages)
   - Tooltip or expansion shows "TICK amendment to spec XXXX"

2. Add `renderTerminalProjects(projects)` function:
   ```javascript
   function renderTerminalProjects(projects) {
     const terminal = projects.filter(p =>
       ['abandoned', 'on-hold'].includes(p.status)
     );

     if (terminal.length === 0) return '';

     return `
       <details class="terminal-projects">
         <summary>Terminal Projects (${terminal.length})</summary>
         <ul>
           ${terminal.map(p => renderTerminalProject(p)).join('')}
         </ul>
       </details>
     `;
   }
   ```

3. Add styling for terminal projects:
   - Collapsible section (using `<details>`)
   - `abandoned`: Red text, strikethrough
   - `on-hold`: Gray text, italic, show reason

### Exit Criteria
- Terminal projects not in main grid
- Shown in collapsible section below grid
- Visual distinction (strikethrough/italic)
- TICK projects show badge indicator
- TICK amendment target shown in details

## Files to Modify

| File | Changes |
|------|---------|
| `agent-farm/templates/dashboard-split.html` | Add Projects tab, parser, renderer |

## Files to Create

None - all changes contained in existing dashboard template.

## Testing

### Automated (Parser Unit Tests)

Create inline tests or separate test file:
1. Parse valid projectlist → correct project count
2. Filter example entries → "NNNN" excluded
3. Missing required fields → project skipped
4. Malformed YAML → empty array (no throw)
5. XSS in title → escaped in output

### Manual Testing

1. **Welcome screen**: Remove/rename projectlist.md → welcome shows
2. **Status summary**: Verify counts match file
3. **Kanban grid**: Verify stage indicators correct
4. **Stage links**: Click specified stage → opens spec file
5. **Stage links**: Click implementing stage → opens builder or PR
6. **Expansion**: Click row → details show
7. **Live update**: Edit file externally → UI updates in 5s
8. **Error handling**: Corrupt file → error banner
9. **Keyboard**: Tab through rows, Enter to expand
10. **TICK indicator**: TICK project shows badge, hover shows amendment target

### Accessibility Testing

1. **Screen reader**: Use VoiceOver (Mac) to verify:
   - Project status announced correctly ("Status: implementing")
   - Row expansion announced ("expanded"/"collapsed")
   - Table structure is navigable
2. **Keyboard-only**: Complete all operations without mouse
3. **Color contrast**: Verify status colors meet WCAG AA (4.5:1)
4. **Shape + color**: Status uses both (● circle + color, not color alone)

## Risks

| Risk | Mitigation |
|------|------------|
| Large projectlist (100+ projects) | Add virtual scrolling if needed (defer) |
| Parser edge cases | Robust regex, graceful fallback |
| Polling performance | Hash comparison, debounce renders |
| Accessibility compliance | Test with VoiceOver, include ARIA from start |

## Success Metrics

- [ ] Projects tab appears first, uncloseable
- [ ] Welcome screen for empty/missing projectlist
- [ ] Status summary with correct counts
- [ ] Kanban grid with 7 stage columns
- [ ] Stage cells are clickable links to artifacts
- [ ] Row expansion shows details
- [ ] Live updates within 5 seconds
- [ ] XSS test passes (`<script>` in title renders as text)
- [ ] Keyboard navigation works
- [ ] TICK projects display with badge indicator
- [ ] Screen reader announces project status and expansion state
