# Plan 0059: Daily Activity Summary

## Overview

Add a "What did I do today?" clock button to the dashboard that:
1. Collects activity data (git, PRs, builders)
2. Calculates time spent
3. Generates AI summary via `consult` CLI
4. Displays in a modal with copy-to-clipboard

## Dependencies

- `gh` CLI for GitHub PR data
- `consult` CLI for AI summary generation
- state.db for builder activity

## Implementation Phases

### Phase 1: Backend API Endpoint

**Goal:** Create `/api/activity-summary` endpoint that collects all data.

**Files to modify:**
- `packages/codev/src/agent-farm/servers/dashboard-server.ts`

**Changes:**
1. Add new API route `/api/activity-summary`
2. Collect data from multiple sources (see Phase 2-5)
3. Return JSON with all activity data

**Response structure:**
```typescript
interface ActivitySummary {
  commits: Array<{ hash: string; message: string; time: string; branch: string }>;
  prs: Array<{ number: number; title: string; state: string; url: string }>;
  builders: Array<{ id: string; status: string; startTime: string; endTime?: string }>;
  projectChanges: Array<{ id: string; title: string; oldStatus: string; newStatus: string }>;
  files: string[];
  timeTracking: {
    activeMinutes: number;
    firstActivity: string;
    lastActivity: string;
  };
  aiSummary?: string;
  error?: string;
}
```

### Phase 2: Git Activity Collection

**Goal:** Collect today's commits from all branches.

**Implementation:**
```typescript
async function getGitCommits(): Promise<Commit[]> {
  const author = execSync('git config user.name').toString().trim();
  const output = execSync(
    `git log --all --since="midnight" --author="${author}" --format="%H|%s|%aI|%D"`
  ).toString();

  return output.trim().split('\n').filter(Boolean).map(line => {
    const [hash, message, time, refs] = line.split('|');
    const branch = refs?.match(/HEAD -> ([^,]+)/)?.[1] || 'detached';
    return { hash: hash.slice(0, 7), message, time, branch };
  });
}

async function getModifiedFiles(): Promise<string[]> {
  // Get unique files from today's commits
  const output = execSync(
    `git log --all --since="midnight" --author="$(git config user.name)" --name-only --format=""`
  ).toString();
  return [...new Set(output.trim().split('\n').filter(Boolean))];
}
```

### Phase 3: GitHub PR Collection

**Goal:** Fetch PRs created/merged today via `gh` CLI.

**Implementation:**
```typescript
async function getGitHubPRs(): Promise<PR[]> {
  const today = new Date().toISOString().split('T')[0];
  try {
    const output = execSync(
      `gh pr list --author "@me" --state all --search "created:>=${today}" --json number,title,state,url`
    ).toString();
    return JSON.parse(output);
  } catch (err) {
    console.error('Failed to fetch PRs (gh CLI not available?):', err.message);
    return [];
  }
}
```

### Phase 4: Builder Activity Collection

**Goal:** Query state.db for today's builder sessions.

**Implementation:**
```typescript
async function getBuilderActivity(db: Database): Promise<Builder[]> {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);

  return db.prepare(`
    SELECT id, status, created_at, updated_at
    FROM builders
    WHERE created_at >= ? OR updated_at >= ?
    ORDER BY created_at DESC
  `).all(midnight.toISOString(), midnight.toISOString());
}
```

### Phase 5: Project Status Changes

**Goal:** Detect status changes in projectlist.md today.

**Implementation:**
```typescript
async function getProjectChanges(): Promise<ProjectChange[]> {
  try {
    // Get the first commit hash from today
    const firstCommit = execSync(
      `git log --since="midnight" --format=%H -- codev/projectlist.md | tail -1`
    ).toString().trim();

    if (!firstCommit) return [];

    // Get diff of projectlist.md
    const diff = execSync(
      `git diff ${firstCommit}^ HEAD -- codev/projectlist.md 2>/dev/null || echo ""`
    ).toString();

    // Parse status changes from diff (simplified)
    const changes: ProjectChange[] = [];
    const statusPattern = /[-+]\s+status:\s+(\w+)/g;
    // ... parse logic
    return changes;
  } catch {
    return [];
  }
}
```

### Phase 6: Time Tracking Calculation

**Goal:** Calculate active time by merging intervals.

**Implementation:**
```typescript
interface TimeInterval { start: Date; end: Date; }

function mergeIntervals(intervals: TimeInterval[]): TimeInterval[] {
  if (intervals.length === 0) return [];

  // Sort by start time
  intervals.sort((a, b) => a.start.getTime() - b.start.getTime());

  const merged: TimeInterval[] = [intervals[0]];
  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1];
    const current = intervals[i];

    // If overlapping or within 2 hours, merge
    const gapHours = (current.start.getTime() - last.end.getTime()) / (1000 * 60 * 60);
    if (gapHours <= 2) {
      last.end = new Date(Math.max(last.end.getTime(), current.end.getTime()));
    } else {
      merged.push(current);
    }
  }
  return merged;
}

function calculateActiveTime(commits: Commit[], builders: Builder[]): TimeTracking {
  const intervals: TimeInterval[] = [];

  // Add commit timestamps (treat each as 5-minute interval)
  for (const commit of commits) {
    const time = new Date(commit.time);
    intervals.push({ start: time, end: new Date(time.getTime() + 5 * 60 * 1000) });
  }

  // Add builder sessions
  for (const builder of builders) {
    intervals.push({
      start: new Date(builder.created_at),
      end: builder.updated_at ? new Date(builder.updated_at) : new Date()
    });
  }

  const merged = mergeIntervals(intervals);
  const totalMinutes = merged.reduce((sum, i) =>
    sum + (i.end.getTime() - i.start.getTime()) / (1000 * 60), 0
  );

  return {
    activeMinutes: Math.round(totalMinutes),
    firstActivity: merged[0]?.start.toISOString() || '',
    lastActivity: merged[merged.length - 1]?.end.toISOString() || ''
  };
}
```

### Phase 7: AI Summary Generation

**Goal:** Generate narrative summary via `consult` CLI.

**Implementation:**
```typescript
async function generateAISummary(data: ActivityData): Promise<string> {
  // Build prompt with commit messages and file names only (security)
  const prompt = `
Summarize this developer's activity today for a standup report:

Commits (${data.commits.length}):
${data.commits.map(c => `- ${c.message}`).join('\n')}

PRs: ${data.prs.map(p => `#${p.number} ${p.title} (${p.state})`).join(', ') || 'None'}

Files modified: ${data.files.length} files

Active time: ~${Math.round(data.timeTracking.activeMinutes / 60)} hours

Write a brief, professional summary (2-3 sentences) focusing on accomplishments.
  `.trim();

  try {
    const output = execSync(
      `./codev/bin/consult --model gemini general "${prompt.replace(/"/g, '\\"')}"`,
      { timeout: 60000 }
    ).toString();
    return output.trim();
  } catch (err) {
    console.error('AI summary failed:', err.message);
    return '';
  }
}
```

### Phase 8: UI - Clock Button & Modal

**Goal:** Add clock icon button and modal to dashboard.

**Files to modify:**
- `packages/codev/templates/dashboard-split.html`

**Button HTML (in header):**
```html
<button class="activity-summary-btn" onclick="showActivitySummary()" title="What did I do today?">
  <span class="activity-icon">🕐</span>
</button>
```

**Modal HTML:**
```html
<div id="activity-modal" class="activity-modal hidden">
  <div class="activity-modal-backdrop" onclick="closeActivityModal()"></div>
  <div class="activity-modal-container">
    <div class="activity-modal-header">
      <h2>Today's Summary</h2>
      <button class="activity-modal-close" onclick="closeActivityModal()">×</button>
    </div>
    <div id="activity-modal-content" class="activity-modal-content">
      <div class="activity-loading">Loading activity...</div>
    </div>
    <div class="activity-modal-footer">
      <button onclick="copyActivitySummary()">Copy to Clipboard</button>
      <button onclick="closeActivityModal()">Close</button>
    </div>
  </div>
</div>
```

**Styles:**
```css
.activity-summary-btn { background: none; border: none; cursor: pointer; font-size: 20px; }
.activity-modal { position: fixed; inset: 0; z-index: 1000; }
.activity-modal.hidden { display: none; }
.activity-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.5); }
.activity-modal-container {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 600px; max-width: 90vw; max-height: 80vh;
  background: #2a2a2a; border-radius: 8px; overflow: hidden;
}
.activity-modal-content { padding: 20px; overflow-y: auto; max-height: 60vh; }
.activity-loading { text-align: center; color: #888; padding: 40px; }
```

### Phase 9: Frontend JavaScript

**Goal:** Implement modal logic, data fetching, and rendering.

**Implementation:**
```javascript
let activityData = null;

async function showActivitySummary() {
  document.getElementById('activity-modal').classList.remove('hidden');
  document.getElementById('activity-modal-content').innerHTML =
    '<div class="activity-loading"><span class="spinner"></span> Loading activity...</div>';

  try {
    const response = await fetch('/api/activity-summary');
    activityData = await response.json();
    renderActivitySummary(activityData);
  } catch (err) {
    document.getElementById('activity-modal-content').innerHTML =
      `<div class="activity-error">Failed to load activity: ${err.message}</div>`;
  }
}

function renderActivitySummary(data) {
  if (data.commits.length === 0 && data.prs.length === 0 && data.builders.length === 0) {
    document.getElementById('activity-modal-content').innerHTML =
      '<div class="activity-empty">No activity recorded today</div>';
    return;
  }

  const hours = Math.floor(data.timeTracking.activeMinutes / 60);
  const mins = data.timeTracking.activeMinutes % 60;

  document.getElementById('activity-modal-content').innerHTML = `
    ${data.aiSummary ? `<div class="ai-summary">${escapeHtml(data.aiSummary)}</div>` : ''}

    <h3>Activity</h3>
    <ul>
      <li>${data.commits.length} commits across ${new Set(data.commits.map(c => c.branch)).size} branches</li>
      <li>${data.files.length} files modified</li>
      <li>${data.prs.length} PRs (${data.prs.filter(p => p.state === 'MERGED').length} merged)</li>
    </ul>

    <h3>Time</h3>
    <p>Active time: ~${hours}h ${mins}m</p>
    <p>First activity: ${formatTime(data.timeTracking.firstActivity)}</p>
    <p>Last activity: ${formatTime(data.timeTracking.lastActivity)}</p>
  `;
}

function closeActivityModal() {
  document.getElementById('activity-modal').classList.add('hidden');
}

function copyActivitySummary() {
  if (!activityData) return;

  const hours = Math.floor(activityData.timeTracking.activeMinutes / 60);
  const mins = activityData.timeTracking.activeMinutes % 60;

  const markdown = `## Today's Summary

${activityData.aiSummary || ''}

### Activity
- ${activityData.commits.length} commits
- ${activityData.files.length} files modified
- ${activityData.prs.length} PRs

### Time
Active time: ~${hours}h ${mins}m
`;

  navigator.clipboard.writeText(markdown);
  showToast('Copied to clipboard', 'success');
}
```

## Testing Checklist

**UI:**
- [ ] Clock icon visible in dashboard header
- [ ] Clicking opens modal
- [ ] Modal shows loading spinner
- [ ] Escape key closes modal
- [ ] X button closes modal
- [ ] Backdrop click closes modal

**Data Collection:**
- [ ] Git commits from today displayed
- [ ] PR data shown (if gh CLI available)
- [ ] Builder activity from state.db shown
- [ ] Files modified list accurate

**Time Tracking:**
- [ ] Active time calculated correctly
- [ ] Overlapping intervals merged
- [ ] Gaps >2 hours treated as breaks

**AI Summary:**
- [ ] Consult CLI generates summary
- [ ] Summary displays in modal
- [ ] Graceful fallback if AI fails

**Error Handling:**
- [ ] Zero activity shows friendly message
- [ ] Partial data displayed when some sources fail
- [ ] Loading state visible

**Copy:**
- [ ] Copy button works
- [ ] Markdown format correct
- [ ] Toast notification shown

## Files Changed Summary

| File | Changes |
|------|---------|
| `packages/codev/src/agent-farm/servers/dashboard-server.ts` | New `/api/activity-summary` endpoint |
| `packages/codev/templates/dashboard-split.html` | Button, modal, JavaScript, CSS |

## Estimated Scope

- ~150 lines TypeScript (backend)
- ~200 lines JavaScript (frontend)
- ~80 lines CSS
- ~50 lines HTML
