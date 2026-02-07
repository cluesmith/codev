# Spec 0052: Agent Farm Internals Documentation

**Status:** implementing
**Protocol:** SPIR
**Priority:** High

---

## Overview

Add comprehensive documentation to `codev/resources/arch.md` explaining how agent-farm (af) works internally. This is the most complex part of Codev and needs thorough "How It Works" documentation.

---

## Requirements

Document the following in arch.md under a new "## Agent Farm Internals" section:

### 1. Architecture Overview
- High-level diagram of components
- How architect and builders relate
- The worktree isolation model

### 2. Port System
- Port allocation strategy (4200-4299 per project, 4600-4699, etc.)
- `~/.agent-farm/ports.json` global registry
- How ports are assigned to dashboard, builders, ttyd instances
- Multi-project support

### 3. tmux Integration
- Session naming convention (`architect-{hash}`, `builder-{id}`)
- How ttyd exposes tmux sessions via HTTP
- Terminal multiplexing for parallel builders

### 4. State Management
- `.agent-farm/state.json` structure
- SQLite database (`.agent-farm/state.db`)
- Builder lifecycle states (spawning, working, blocked, complete)

### 5. Worktree Management
- Git worktree creation for each builder
- Branch naming (`builder/{id}-{name}`)
- `.builders/` directory structure
- Cleanup process

### 6. Dashboard Server
- Express server architecture
- WebSocket for real-time updates
- Template rendering (dashboard-split.html)
- API endpoints

### 7. Key Files
Document each key file with its purpose:
- `src/agent-farm/cli.ts`
- `src/agent-farm/commands/*.ts`
- `src/agent-farm/servers/dashboard-server.ts`
- `src/agent-farm/state.ts`
- `src/agent-farm/utils/config.ts`

---

## Success Criteria

- [ ] arch.md has comprehensive "Agent Farm Internals" section
- [ ] Port system fully explained with examples
- [ ] tmux integration documented
- [ ] State management (JSON + SQLite) explained
- [ ] Worktree lifecycle documented
- [ ] Key files listed with purposes
- [ ] Follows MAINTAIN protocol's "How It Works" requirement
