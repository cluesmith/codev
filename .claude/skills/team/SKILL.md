---
name: team
description: Team CLI — manage team members, post messages, and run activity updates. ALWAYS check this skill before running any `team` command. Use when listing members, adding members, posting messages, or running team activity updates. Note - `afx team` is deprecated; use `team` directly.
---

# team - Team Coordination CLI

Manage team members and messages for your Codev project. Team data is stored in `codev/team/` and displayed in the Tower dashboard.

## Synopsis

```
team list
team message <text> [-a <author>]
team update
team add <github-handle> [-n <name>] [-r <role>]
```

## Commands

### team list

List all team members from `codev/team/people/`.

```bash
team list
```

Displays a formatted table with Name, GitHub handle, and Role columns.

### team message \<text\>

Post a message to the team message log (`codev/team/messages.md`).

```bash
team message "Spec 42 is ready for review"
team message "Deployed to staging" -a deploy-bot
```

**Options:**
- `-a, --author <name>` — Override author (default: auto-detected from `gh` CLI or `git config`)

### team update

Post an hourly activity summary. Called automatically by cron (`.af-cron/team-update.yaml`) or manually.

```bash
team update
```

Collects notable events from the last hour (builder spawns, gate approvals, PR merges, completed reviews) and posts a summary. Exits silently if no events occurred.

### team add \<github-handle\>

Scaffold a new team member file.

```bash
team add waleedkadous
team add jdoe --name "Jane Doe" --role "Developer"
```

**Options:**
- `-n, --name <name>` — Full name (default: github handle)
- `-r, --role <role>` — Role (default: "Team Member")

Creates `codev/team/people/<handle>.md` with YAML frontmatter. Handle is normalized to lowercase. Fails if the member already exists.

## Team Directory Structure

```
codev/team/
├── people/
│   ├── waleedkadous.md     # YAML frontmatter + optional bio
│   └── jdoe.md
└── messages.md             # Append-only message log
```

## Team Member File Format

```yaml
---
name: M Waleed Kadous
github: waleedkadous
role: Lead Architect
---

Optional freeform bio or notes (not displayed in Tower).
```

**Required frontmatter fields:**
- `name` — Display name
- `github` — GitHub handle (used for API data enrichment)
- `role` — Team role (displayed in Tower)

## Message Log Format

```markdown
# Team Messages

<!-- Append new messages below. Do not edit or delete existing entries. -->

---
**waleedkadous** | 2026-03-09 14:30 UTC
Spec 42 is ready for review.

---
**tower-cron** | 2026-03-09 15:00 UTC
Hourly update: Merged PR #123: Add user auth. Gate approved for #42.
```

Messages are append-only. Each entry has an author, UTC timestamp, and body text.

## Deprecation Note

`afx team` commands still work but print a deprecation warning. Use `team` directly:
- `afx team list` → `team list`
- `afx team message` → `team message`
- `afx team update` → `team update`

## Setup

To set up a team directory for a new project:

```bash
team add first-member --name "First Member" --role "Architect"
team add second-member --name "Second Member" --role "Developer"
```

The Team tab appears in Tower when 2+ valid members exist.
