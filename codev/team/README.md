# Team Directory

The `codev/team/` directory defines who is on the team and enables the Team tab in Tower.

## Team Member Profiles

Each team member has a file in `people/<github-handle>.md` with YAML frontmatter and an optional markdown body.

### Required Frontmatter

```yaml
---
name: Full Name
github: github-handle
role: Short role description
---
```

| Field | Description |
|-------|-------------|
| `name` | Display name (as the person prefers to be called) |
| `github` | GitHub username — must be valid (alphanumeric + hyphens, max 39 chars). The filename should match this handle. |
| `role` | Brief role or focus area (e.g., "Lead Architect", "Developer — Forge Subsystem") |

### Optional Body

Below the frontmatter, add a short paragraph describing:
- What the person is currently working on
- Their area of expertise or focus
- Any relevant context for the team

### Example

```markdown
---
name: Jane Smith
github: janesmith
role: Developer — Search Subsystem
---

Jane is building the full-text search feature (#42), including the indexer,
query parser, and results ranking. Previously worked on the caching layer.
```

## Messages

`messages.md` is an append-only team communication log. Use `af team message "your message"` to post — don't edit the file directly.

## When Does the Team Tab Appear?

The Team tab in Tower only shows when `codev/team/people/` has **2 or more valid member files**. There is no empty state — the tab simply doesn't appear until the team is set up.

## CLI Commands

```bash
af team list              # List team members
af team message "text"    # Post a message to the team log
af team update            # Post hourly activity summary (usually via cron)
```
