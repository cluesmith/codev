# Codev Tips & Tricks

Practical tips for getting the most out of Codev and Agent Farm.

## Skip Permission Prompts

Add `--dangerously-skip-permissions` to your `codev/config.json` to reduce permission prompts:

```json
{
  "shell": {
    "architect": "claude --dangerously-skip-permissions",
    "builder": "claude --dangerously-skip-permissions"
  }
}
```

**Warning**: Only use this in development environments where you trust the AI's actions.

## Resume After a Crash

If the Architect or a Builder crashes, you can pick up where you left off using Claude Code's `/resume` command:

```
/resume
```

This restores the previous conversation context so you don't lose progress.

## Run Consultations in Parallel

When running 3-way reviews, launch all consultations in parallel:

```bash
consult -m gemini --protocol spir --type pr &
consult -m codex --protocol spir --type pr &
consult -m claude --protocol spir --type pr &
wait
```

This runs all three in the background simultaneously, saving significant time.

## Watch Consultations in Real-Time

By default, the `consult` command runs in the background. If you want to watch a consultation happen in the dashboard terminal:

```
af consult -m gemini --protocol spir --type spec
```

Instead of:
```
consult -m gemini --protocol spir --type spec
```

The `af consult` variant runs in a visible dashboard terminal so you can observe the model's analysis.

## Quick Builder Spawning

Spawn a builder directly from a spec number:

```bash
af spawn -p 0042
```

The builder gets its own isolated git worktree, automatically receives the spec and plan context, and starts implementing immediately.

## Stage-Specific Reviews

Use the `--type` flag to get focused review prompts for each stage:

```bash
consult -m gemini --protocol spir --type spec           # Specification review
consult -m codex --protocol spir --type plan            # Plan review
consult -m claude --type integration                    # PR integration review
```

Available types: `spec`, `plan`, `impl`, `pr`, `phase`, `integration`

## Mediated Reviews (Faster 3-Way)

For large PRs, prepare context upfront and pass it to consultants:

```bash
# Prepare a summary of changes
cat > /tmp/overview.md << 'EOF'
## PR Summary
- Added user authentication
- Modified 5 files
- Key changes: JWT tokens, middleware
EOF

# Run parallel mediated reviews (~30-60s vs 2-4min)
consult -m gemini --protocol spir --type pr --context /tmp/overview.md &
consult -m codex --protocol spir --type pr --context /tmp/overview.md &
consult -m claude --protocol spir --type pr --context /tmp/overview.md &
wait
```

## Custom Templates

Codev templates (protocols, roles, etc.) can be customized by editing files in your local `codev/` directory. Local files always take precedence over the embedded skeleton.

For example, to customize the consultant role:
```bash
# Edit directly - the file already exists in your project
vim codev/roles/consultant.md
```

## Safe Branch Management

Builders work in isolated git worktrees. Their changes don't affect your main branch until they create a PR and you merge it.

## Troubleshooting

### Dashboard Won't Start

```bash
af dash stop    # Kill any orphaned processes
af dash start   # Fresh start
```

### Orphaned Sessions

Nuclear option if things are really stuck:

```bash
tmux kill-server  # Kills ALL tmux sessions
```

### Port Conflicts

If you're having port issues across multiple projects:

```bash
af ports list     # See all port allocations
af ports cleanup  # Remove stale entries
```

### Database Inspection

View the Agent Farm database state:

```bash
af db dump           # Dump local project database
af db dump --global  # Dump global port registry
af db stats          # Show database statistics
```

### Advanced: Architect Knows the Internals

The Architect agent has detailed knowledge of the Agent Farm UI internals, including tmux and ttyd. You can ask it to do interesting things like:
- Rearrange terminal layouts
- Send commands to specific panes
- Create custom dashboard configurations
- Debug terminal rendering issues
