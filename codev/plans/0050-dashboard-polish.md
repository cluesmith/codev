# Plan 0050: Dashboard Polish

**Spec:** codev/specs/0050-dashboard-polish.md
**Status:** planned

---

## Overview

Three UX improvements to the agent-farm dashboard:
1. Clickable title only for expand/collapse
2. Show TICKs in expanded project view
3. Poll for projectlist.md creation on starter page

---

## Implementation Steps

### Phase 1: Project Row Click Behavior

**Files to modify:**
- `packages/codev/src/agent-farm/templates/dashboard.html`

**Changes:**

1. **Update project row HTML structure:**
   ```html
   <!-- Change from -->
   <div class="project-row" onclick="toggleProject('${id}')">

   <!-- To -->
   <div class="project-row">
     <span class="project-title" onclick="toggleProject('${id}')">${id}: ${title}</span>
   ```

2. **Add CSS for clickable title:**
   ```css
   .project-title {
     text-decoration: underline;
     cursor: pointer;
   }
   .project-title:hover {
     color: #58a6ff;
   }
   ```

3. **Remove onclick from parent div**

**Testing:**
- Click title → expands/collapses
- Click status/priority/other areas → no action

---

### Phase 2: Show TICKs in Project View

**Files to modify:**
- `packages/codev/src/agent-farm/templates/dashboard.html`
- `packages/codev/src/agent-farm/lib/projectlist-parser.ts` (if exists, or create)

**Changes:**

1. **Parse ticks from projectlist.md:**
   - Already parsed as `ticks: [001, 002, 003]` array
   - Pass to template rendering

2. **Update expanded project view template:**
   ```html
   <div class="project-details" id="details-${id}">
     <div class="project-meta">
       <span>Status: ${status}</span>
       <span>Priority: ${priority}</span>
     </div>
     ${ticks.length > 0 ? `
       <div class="project-ticks">
         <strong>TICKs:</strong> ${ticks.map(t => `<span class="tick-badge">TICK-${t}</span>`).join(' ')}
       </div>
     ` : ''}
   </div>
   ```

3. **Add CSS for tick badges:**
   ```css
   .tick-badge {
     background: #238636;
     color: white;
     padding: 2px 6px;
     border-radius: 3px;
     font-size: 0.85em;
     margin-right: 4px;
   }
   ```

**Testing:**
- Expand project with ticks → shows TICK badges
- Expand project without ticks → no TICK section

---

### Phase 3: Poll for projectlist.md Creation

**Files to modify:**
- `packages/codev/src/agent-farm/templates/dashboard.html` (starter page section)
- `packages/codev/src/agent-farm/servers/dashboard-server.ts`

**Changes:**

1. **Add server endpoint:**
   ```typescript
   // GET /api/projectlist-exists
   app.get('/api/projectlist-exists', (req, res) => {
     const projectlistPath = path.join(projectRoot, 'codev/projectlist.md');
     res.json({ exists: fs.existsSync(projectlistPath) });
   });
   ```

2. **Add client-side polling (in starter page JS):**
   ```javascript
   // Only run if in starter mode (no projectlist)
   if (document.querySelector('.starter-page')) {
     const pollInterval = setInterval(async () => {
       try {
         const response = await fetch('/api/projectlist-exists');
         const { exists } = await response.json();
         if (exists) {
           clearInterval(pollInterval);
           window.location.reload();
         }
       } catch (e) {
         // Ignore fetch errors, keep polling
       }
     }, 15000);
   }
   ```

**Testing:**
- Start dashboard with no projectlist.md → shows starter page
- Create projectlist.md in another terminal
- Wait up to 15 seconds → dashboard auto-refreshes

---

## File Summary

| File | Changes |
|------|---------|
| `templates/dashboard.html` | Title-only click, TICK display, polling JS |
| `servers/dashboard-server.ts` | Add `/api/projectlist-exists` endpoint |

---

## Testing Checklist

- [ ] Title click expands project
- [ ] Non-title click does nothing
- [ ] Title has underline styling
- [ ] Projects with ticks show TICK badges
- [ ] Projects without ticks show no TICK section
- [ ] Starter page polls every 15s
- [ ] Creating projectlist.md triggers refresh
- [ ] No console errors
- [ ] Polling stops after projectlist detected

---

## Estimated Scope

~100-150 lines of changes across 2 files. Straightforward UI work.
