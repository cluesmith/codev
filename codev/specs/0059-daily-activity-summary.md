# Spec 0059: Daily Activity Summary

## Summary

Add a "What did I do today?" button to the dashboard that uses AI to summarize the day's development activity and time spent.

## Motivation

At the end of a workday, developers often need to:
- Report progress in standups or status updates
- Track time for billing or productivity
- Remember what they accomplished across multiple tasks

Currently, reconstructing this requires manually reviewing git logs, PR activity, and project changes. An AI-powered summary can instantly provide this information.

## Requirements

### 1. UI Element

- Clock icon button in the dashboard header (next to existing controls)
- Tooltip: "What did I do today?"
- Clicking opens a modal with the activity summary

### 2. Data Sources

The summary should analyze:
- **Git commits** on all branches today (author = current user)
- **PRs created/merged** today (via `gh pr list` for GitHub PRs)
- **Builder activity** (spawned, completed, PRs created) from state.db
- **Project status changes** in projectlist.md (via git diff since midnight)
- **Files modified** (list of filenames, not full diffs)

**Timezone:** "Today" means local machine time (midnight to now).

### 3. Time Tracking

- Calculate approximate time spent based on:
  - First commit timestamp to last commit timestamp
  - Builder session durations (from state.db)
  - Gap detection (if >2 hours between commits, assume break)
  - Merge overlapping time intervals (commits + builder sessions) to avoid double-counting
- Display as "Active time: ~X hours Y minutes"

### 4. AI Summary

- Use `consult` CLI to generate the summary (enables multi-model support and logging)
- Summary should include:
  - High-level accomplishment statement
  - List of key tasks completed
  - Projects worked on
  - PRs created/merged
  - Notable decisions or blockers resolved
- Tone: Professional, suitable for standup or status report

### 5. Output Format

Modal displays:
```
## Today's Summary
[AI-generated narrative summary]

### Activity
- X commits across Y branches
- Z files modified
- N PRs created, M merged

### Projects Touched
- 0058: File Search Autocomplete (implementing → implemented)
- 0045: Project List UI (reviewed PR)

### Time
Active time: ~4 hours 30 minutes
First activity: 9:15 AM
Last activity: 2:45 PM

[Copy to Clipboard] [Close]
```

### 6. Copy to Clipboard

- "Copy to Clipboard" button formats summary as markdown
- Suitable for pasting into Slack, email, or standup notes

### 7. Error Handling

- **Zero activity:** Show friendly message "No activity recorded today"
- **AI failure:** Show raw data (commits, PRs, time) without narrative summary
- **Partial data:** Display whatever is available (e.g., git works but gh fails)
- **Loading state:** Show spinner while fetching data and generating summary

## Non-Requirements

- Persistent storage of summaries (generate fresh each time)
- Multi-day or date range reports (future enhancement)
- Integration with external time tracking tools
- Automatic end-of-day triggers

## Technical Considerations

- Git commands: `git log --since="midnight" --author="$(git config user.name)"`
- GitHub PRs: `gh pr list --author "@me" --search "created:>=YYYY-MM-DD"`
- Builder history from state.db `builders` table
- Project status: `git diff $(git log --since=midnight --format=%H | tail -1)^ -- codev/projectlist.md`
- AI generation via `consult` CLI

**Security:** Only send commit messages and file names to AI, not full diffs or file contents. This avoids leaking secrets that may be in code.

## Acceptance Criteria

- [ ] Clock icon button visible in dashboard header
- [ ] Clicking button opens activity summary modal
- [ ] Summary includes git commits from today
- [ ] Summary includes PR activity (via gh CLI)
- [ ] Summary includes builder activity
- [ ] Time tracking shows approximate active hours
- [ ] AI generates natural language summary via consult CLI
- [ ] Copy to clipboard works
- [ ] Modal can be closed with Escape or X button
- [ ] Zero activity shows friendly message
- [ ] Loading state shows spinner
