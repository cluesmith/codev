# team - Team Coordination CLI

The `team` command manages team members and messages for your Codev project. Team data is stored in `codev/team/` and displayed in the Tower dashboard.

## Synopsis

```
team <command> [options]
```

## Commands

### team list

List all team members from `codev/team/people/`.

```bash
team list
```

Output is a formatted table:

```
Name              GitHub          Role
────────────────  ──────────────  ──────────────
M Waleed Kadous   waleedkadous    Lead Architect
Jane Doe          jdoe            Developer
```

Warns if fewer than 2 members (Team tab requires 2+).

### team message \<text\>

Post a message to `codev/team/messages.md`.

```bash
team message "Spec 42 is ready for review"
team message "Deployed to staging" -a deploy-bot
```

**Options:**

| Flag | Description |
|------|-------------|
| `-a, --author <name>` | Override author (default: auto-detect from `gh` CLI or `git config`) |

Creates `messages.md` with header if it doesn't exist. Messages are append-only.

### team update

Post an hourly activity summary. Usually called by cron.

```bash
team update
```

Collects notable events from the last hour:
- Builder spawns (from git log)
- Gate approvals (from status.yaml)
- PR merges (from `gh` CLI)
- Completed reviews (from codev/reviews/)

Posts a summary via `team message`. Exits silently if no events.

### team add \<github-handle\>

Scaffold a new team member file.

```bash
team add waleedkadous
team add jdoe --name "Jane Doe" --role "Developer"
```

**Options:**

| Flag | Description |
|------|-------------|
| `-n, --name <name>` | Full name (default: github handle) |
| `-r, --role <role>` | Role (default: "Team Member") |

Creates `codev/team/people/<handle>.md`. Handle is normalized to lowercase. Validates GitHub handle format. Fails if member already exists.

## Team Directory

```
codev/team/
├── people/           # One .md file per member
│   ├── waleedkadous.md
│   └── jdoe.md
└── messages.md       # Append-only message log
```

### Member File Format

```yaml
---
name: M Waleed Kadous
github: waleedkadous
role: Lead Architect
---

Optional freeform bio text.
```

### Message Format

```markdown
---
**waleedkadous** | 2026-03-09 14:30 UTC
Message body text here.
```

## Error Handling

| Condition | Error |
|-----------|-------|
| Outside a codev workspace | `Error: Not inside a Codev workspace. Run from a project that has a codev/ directory.` |
| Invalid GitHub handle | `Error: Invalid GitHub handle '<handle>'` |
| Member already exists | `Error: Team member '<handle>' already exists at codev/team/people/<handle>.md` |

All errors exit with code 1.

## Deprecation of af team

`af team` commands still work but print a deprecation warning on stderr:

```
⚠ `af team` is deprecated. Use `team list` instead.
```

Migrate to `team` directly:
- `af team list` → `team list`
- `af team message` → `team message`
- `af team update` → `team update`

## Cron Integration

Automatic hourly updates are configured in `.af-cron/team-update.yaml`:

```yaml
name: team-update
schedule: "0 * * * *"
enabled: true
command: "team update"
timeout: 30
```

## Related

- [Overview](overview.md) — All CLI tools
- [Agent Farm](agent-farm.md) — `af` commands (deprecated `af team`)
- [Architecture](../arch.md) — Team Tab architecture
