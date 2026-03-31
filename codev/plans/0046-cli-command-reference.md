# Plan 0046: CLI Command Reference Documentation

**Spec:** codev/specs/0046-cli-command-reference.md
**Protocol:** TICK

---

## Implementation Steps

### Step 1: Research CLI implementations

Read the source files to understand actual command behavior:
- `packages/codev/src/cli.ts`
- `packages/codev/src/commands/*.ts`
- `packages/codev/src/agent-farm/cli.ts`
- `packages/codev/src/agent-farm/commands/*.ts`
- `packages/codev/src/commands/consult/index.ts`

Also run `--help` for each command to capture actual output.

### Step 2: Create overview.md

Create `codev/docs/commands/overview.md` with:
- Brief intro to Codev CLI tools
- Table of all 3 tools with one-line descriptions
- Quick start examples for each
- Links to detailed docs

### Step 3: Create codev.md

Create `codev/docs/commands/codev.md` documenting:
- `codev init <project-name>` - Create new codev project
- `codev adopt` - Add codev to existing project
- `codev doctor` - Check system dependencies
- `codev update` - Update codev templates
- `codev tower` - Cross-project dashboard

For each: synopsis, description, options, examples.

### Step 4: Create agent-farm.md

Create `codev/docs/commands/agent-farm.md` documenting:
- `afx start` - Start architect dashboard
- `afx stop` - Stop all agent-farm processes
- `afx spawn` - Spawn a builder
- `afx status` - Check status
- `afx cleanup` - Remove completed builders
- `afx send` - Send message to builder
- `afx open` - Open file in annotation viewer
- `afx util` - Open utility shell

For each: synopsis, description, options, examples.

### Step 5: Create consult.md

Create `codev/docs/commands/consult.md` documenting:
- `consult pr <number>` - Review a PR
- `consult spec <number>` - Review a spec
- `consult plan <number>` - Review a plan
- `consult general "<query>"` - General consultation
- Model options: gemini, codex, claude (and aliases)
- Review types: spec-review, plan-review, impl-review, pr-ready, integration-review

For each: synopsis, description, options, examples.

### Step 6: Create PR

Commit all documentation and create PR.

---

## Files to Create

```
codev/docs/commands/
├── overview.md
├── codev.md
├── agent-farm.md
└── consult.md
```

---

## Testing

- Verify each documented command works as described
- Ensure examples are copy-pasteable
- Cross-reference with actual --help output
