# Spec 0046: CLI Command Reference Documentation

**Status:** specified
**Protocol:** TICK
**Priority:** Medium
**Dependencies:** 0039 (Codev CLI)

---

## Problem Statement

Codev provides three CLI tools (`codev`, `afx`, `consult`) but lacks comprehensive user-facing documentation. Users must read source code or CLAUDE.md to understand available commands and options.

---

## Requirements

Create reference documentation in `codev/docs/commands/`:

1. **overview.md** - Brief descriptions of all 3 tools with quick examples
2. **codev.md** - In-depth reference for the `codev` command (init, adopt, doctor, update, tower)
3. **agent-farm.md** - In-depth reference for the `afx` command (start, stop, spawn, status, cleanup, send, open, util)
4. **consult.md** - In-depth reference for the `consult` command (pr, spec, plan, general subcommands)

---

## Technical Approach

Document actual CLI behavior by examining:
- `packages/codev/src/cli.ts` - Main codev entry point
- `packages/codev/src/agent-farm/cli.ts` - Agent-farm commands
- `packages/codev/src/commands/consult/index.ts` - Consult implementation
- Existing usage in CLAUDE.md

---

## Success Criteria

- [ ] `codev/docs/commands/overview.md` exists with brief descriptions
- [ ] `codev/docs/commands/codev.md` documents all codev subcommands
- [ ] `codev/docs/commands/agent-farm.md` documents all afx subcommands
- [ ] `codev/docs/commands/consult.md` documents all consult subcommands
- [ ] Each command includes: synopsis, description, options, examples
- [ ] Documentation matches actual CLI behavior
