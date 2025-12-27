# Implementation Plan: Architect-Builder Pattern

**Plan ID**: 0002
**Spec**: [0002-architect-builder.md](../specs/0002-architect-builder.md)
**Date**: 2025-12-02

## Overview

This plan implements Phase 1 of the Architect-Builder pattern: a minimal viable implementation using git worktrees, ttyd web terminals, and simple shell scripting.

## Prerequisites

- **ttyd** installed (`brew install ttyd` on macOS)
- **git** with worktree support (2.5+)
- **gh** CLI for GitHub operations (optional, for `--issue` support)

## Implementation Phases

### Phase 1: Directory Structure & .gitignore

**Goal**: Set up the builder directory structure.

**Tasks**:
1. Create `.builders/` directory (gitignored)
2. Add `.builders/` to `.gitignore`
3. Create `codev/builders.md` template
4. Create `codev/templates/` directory for templates

**Files**:
```
.gitignore                    # Add .builders/
codev/
├── builders.md               # Active builder tracking
└── templates/
    ├── builder-prompt.md     # Standard builder instructions
    └── dashboard.html        # Web dashboard
```

**Acceptance criteria**:
- [ ] `.builders/` is gitignored
- [ ] `builders.md` template exists with example format
- [ ] Templates directory exists

---

### Phase 2: Builder Prompt Template

**Goal**: Create the standard instructions given to each builder.

**Tasks**:
1. Write `builder-prompt.md` template
2. Include SPIDER protocol reference
3. Include "proceed autonomously" instructions
4. Include self-rebase and PR creation instructions

**Template content** (codev/templates/builder-prompt.md):
```markdown
# Builder Instructions for Spec {{SPEC_ID}}

You are implementing:
- **Spec**: codev/specs/{{SPEC_ID}}-{{SPEC_NAME}}.md
- **Plan**: codev/plans/{{SPEC_ID}}-{{SPEC_NAME}}.md
- **Branch**: builder/{{SPEC_ID}}-{{SPEC_NAME}}

## Protocol

Follow SPIDER: Implement → Defend → Evaluate for each phase in the plan.

## Rules

1. **Proceed autonomously** - Do NOT ask "should I continue?" Just continue.
2. **Stop only for true blockers**:
   - Missing information not in spec/plan
   - Ambiguous requirements needing clarification
   - Architectural decisions outside your scope
3. **When blocked**: State clearly what you need and WAIT. The architect will respond here.
4. **Self-rebase**: Before creating PR, rebase on main if it has moved.
5. **Create PR when complete**: Use `gh pr create` with summary.

## Start

Read the spec and plan, then begin Phase 1.
```

**Acceptance criteria**:
- [ ] Template includes all required sections
- [ ] Placeholder syntax ({{VAR}}) is consistent

---

### Phase 3: builders.md Template

**Goal**: Create the human-readable status tracking file.

**Tasks**:
1. Create `codev/builders.md` with example format
2. Document the status values
3. Include instructions for manual updates

**Template content** (codev/builders.md):
```markdown
# Active Builders

Track active builder agents here. Update manually or via `architect status`.

## Status Values

- **spawning**: Worktree being created, ttyd starting
- **implementing**: Builder is working
- **blocked**: Builder waiting for architect input
- **pr-ready**: Builder has created a PR
- **reviewing**: Architect is reviewing the PR
- **complete**: PR merged, ready for cleanup

---

## Builders

<!-- Add builders below as they are spawned -->

<!-- Example:
## Builder 0003: Feature Name
- **Branch**: builder/0003-feature-name
- **Port**: 7681
- **Status**: implementing
- **Phase**: 2/4
- **Started**: 2025-12-02 11:30
- **PR**: (none yet)
-->

(No active builders)
```

**Acceptance criteria**:
- [ ] Status values documented
- [ ] Example format included
- [ ] File is git-tracked

---

### Phase 4: Dashboard HTML

**Goal**: Create a simple web dashboard showing all builder terminals.

**Tasks**:
1. Create `dashboard.html` with grid layout
2. Add JavaScript to parse `builders.md` (or hardcode for Phase 1)
3. Embed ttyd iframes for each builder
4. Style for readability

**Template content** (codev/templates/dashboard.html):
```html
<!DOCTYPE html>
<html>
<head>
  <title>Architect Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; padding: 20px; background: #1a1a1a; color: #fff; }
    h1 { margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(600px, 1fr)); gap: 15px; }
    .builder { background: #2a2a2a; border-radius: 8px; overflow: hidden; }
    .builder-header { padding: 10px 15px; background: #333; display: flex; justify-content: space-between; }
    .builder-header h3 { font-size: 14px; }
    .builder-status { font-size: 12px; padding: 2px 8px; border-radius: 4px; }
    .status-implementing { background: #3b82f6; }
    .status-blocked { background: #ef4444; }
    .status-pr-ready { background: #22c55e; }
    iframe { width: 100%; height: 450px; border: none; }
    .no-builders { text-align: center; padding: 40px; color: #666; }
    .instructions { margin-top: 20px; padding: 15px; background: #2a2a2a; border-radius: 8px; font-size: 13px; }
    .instructions code { background: #333; padding: 2px 6px; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>🏗️ Architect Dashboard</h1>

  <div class="grid" id="builders">
    <!-- Builders will be inserted here -->
  </div>

  <div class="instructions">
    <strong>Commands:</strong>
    <code>architect spawn --project XXXX</code> ·
    <code>architect status</code> ·
    <code>architect cleanup XXXX</code>
  </div>

  <script>
    // Configuration - update this when spawning builders
    const builders = [
      // { id: '0003', name: 'User Auth', port: 7681, status: 'implementing', phase: '2/4' },
      // { id: '0004', name: 'API Routes', port: 7682, status: 'blocked', phase: '1/3' },
    ];

    const grid = document.getElementById('builders');

    if (builders.length === 0) {
      grid.innerHTML = '<div class="no-builders">No active builders. Run <code>architect spawn --project XXXX</code> to start.</div>';
    } else {
      builders.forEach(b => {
        grid.innerHTML += `
          <div class="builder">
            <div class="builder-header">
              <h3>Builder ${b.id}: ${b.name}</h3>
              <span class="builder-status status-${b.status}">${b.status} (${b.phase})</span>
            </div>
            <iframe src="http://localhost:${b.port}"></iframe>
          </div>
        `;
      });
    }
  </script>
</body>
</html>
```

**Acceptance criteria**:
- [ ] Dashboard renders correctly
- [ ] Grid layout adapts to number of builders
- [ ] Status badges are color-coded
- [ ] Instructions shown at bottom

---

### Phase 5: Annotation Viewer

**Goal**: Create a web-based file viewer for leaving inline `REVIEW:` comments.

**Tasks**:
1. Create `annotate.html` with Prism.js for syntax highlighting
2. Support both code (JS, TS, Python, etc.) and markdown highlighting
3. Render files with line numbers
4. Highlight existing `REVIEW:` comments distinctly
5. Click line → insert new `REVIEW:` comment
6. Click existing `REVIEW:` comment → edit or resolve (remove)
7. Save changes back to file via simple Node.js server (or Python)
8. Add `annotate` and `annotations` commands to CLI

**Template content** (codev/templates/annotate.html):
```html
<!DOCTYPE html>
<html>
<head>
  <title>Annotate: {{FILE}}</title>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #1a1a1a; color: #fff; }
    .header { padding: 15px 20px; background: #2a2a2a; border-bottom: 1px solid #333; }
    .header h1 { font-size: 16px; font-weight: 500; }
    .header .path { color: #888; font-size: 13px; margin-top: 4px; }
    .content { display: flex; }
    .line-numbers {
      padding: 15px 10px; background: #252525; color: #666;
      text-align: right; font-family: monospace; font-size: 13px;
      user-select: none; border-right: 1px solid #333;
    }
    .line-numbers div { padding: 2px 8px; cursor: pointer; }
    .line-numbers div:hover { background: #333; color: #fff; }
    .code-content { flex: 1; padding: 15px; overflow-x: auto; }
    pre { margin: 0; font-size: 13px; }
    .review-line { background: rgba(250, 204, 21, 0.15); border-left: 3px solid #facc15; }
    .review-badge {
      display: inline-block; background: #facc15; color: #000;
      font-size: 10px; padding: 1px 6px; border-radius: 3px; margin-right: 8px;
    }
    .comment-dialog {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: #2a2a2a; padding: 20px; border-radius: 8px; width: 500px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5); display: none;
    }
    .comment-dialog textarea {
      width: 100%; height: 100px; background: #1a1a1a; border: 1px solid #444;
      color: #fff; padding: 10px; border-radius: 4px; font-family: inherit;
    }
    .comment-dialog .actions { margin-top: 15px; text-align: right; }
    .btn { padding: 8px 16px; border-radius: 4px; border: none; cursor: pointer; margin-left: 8px; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .btn-danger { background: #ef4444; color: #fff; }
    .btn-secondary { background: #444; color: #fff; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Annotation Viewer</h1>
    <div class="path">{{BUILDER_ID}} / {{FILE_PATH}}</div>
  </div>
  <div class="content">
    <div class="line-numbers" id="lineNumbers"></div>
    <div class="code-content">
      <pre><code id="codeContent" class="language-{{LANG}}"></code></pre>
    </div>
  </div>
  <div class="comment-dialog" id="commentDialog">
    <h3>Add Review Comment</h3>
    <p style="color:#888;margin:10px 0;font-size:13px;">Line <span id="dialogLine"></span></p>
    <textarea id="commentText" placeholder="Enter your review comment..."></textarea>
    <div class="actions">
      <button class="btn btn-secondary" onclick="closeDialog()">Cancel</button>
      <button class="btn btn-danger" onclick="resolveComment()" id="resolveBtn" style="display:none">Resolve</button>
      <button class="btn btn-primary" onclick="saveComment()">Save</button>
    </div>
  </div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-typescript.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-python.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-markdown.min.js"></script>
  <script>
    // File content loaded from server
    let fileContent = [];
    let currentLine = null;

    // Initialize viewer (content injected by server)
    function init(content, lang) {
      fileContent = content.split('\n');
      renderFile();
    }

    function renderFile() {
      const lineNums = document.getElementById('lineNumbers');
      const codeEl = document.getElementById('codeContent');

      lineNums.innerHTML = fileContent.map((_, i) =>
        `<div onclick="openDialog(${i+1})">${i+1}</div>`
      ).join('');

      codeEl.innerHTML = Prism.highlight(
        fileContent.join('\n'),
        Prism.languages[document.body.dataset.lang] || Prism.languages.plaintext,
        document.body.dataset.lang
      );

      // Highlight REVIEW lines
      highlightReviewLines();
    }

    function highlightReviewLines() {
      // Implementation: find lines with REVIEW: and add .review-line class
    }

    function openDialog(line) { /* ... */ }
    function closeDialog() { /* ... */ }
    function saveComment() { /* POST to server, update file */ }
    function resolveComment() { /* Remove REVIEW line, POST to server */ }
  </script>
</body>
</html>
```

**Comment Detection Patterns**:
```javascript
const REVIEW_PATTERNS = {
  'js': /^(\s*)\/\/\s*REVIEW(\(@\w+\))?:\s*(.*)$/,
  'ts': /^(\s*)\/\/\s*REVIEW(\(@\w+\))?:\s*(.*)$/,
  'py': /^(\s*)#\s*REVIEW(\(@\w+\))?:\s*(.*)$/,
  'md': /^(\s*)<!--\s*REVIEW(\(@\w+\))?:\s*(.*)\s*-->$/,
  'html': /^(\s*)<!--\s*REVIEW(\(@\w+\))?:\s*(.*)\s*-->$/,
};
```

**Simple Server** (for saving changes):
```bash
# Option 1: Python one-liner
python -m http.server 8080 --directory .builders/0003

# Option 2: Node.js script with POST handler
node codev/bin/annotate-server.js --builder 0003 --port 8080
```

**Acceptance criteria**:
- [ ] Viewer renders code with syntax highlighting
- [ ] Viewer renders markdown with syntax highlighting
- [ ] Line numbers are clickable
- [ ] `REVIEW:` lines highlighted distinctly
- [ ] Can add new comment (inserts into file)
- [ ] Can resolve comment (removes from file)
- [ ] Changes saved to builder's worktree
- [ ] `architect annotate` opens viewer in browser
- [ ] `architect annotations` lists files with REVIEW comments

---

### Phase 6: Architect CLI Script

**Goal**: Create the main `architect` shell script with all commands.

**Tasks**:
1. Create `codev/bin/architect` script
2. Implement `spawn` command (worktree + ttyd)
3. Implement `status` command (show builders.md)
4. Implement `dashboard` command (open browser)
5. Implement file review commands (`files`, `diff`, `cat`, `review`)
6. Implement annotation commands (`annotate`, `annotations`)
7. Implement `cleanup` command (remove worktree + kill ttyd)
8. Make script executable

**Script structure** (codev/bin/architect):
```bash
#!/bin/bash
set -e

CODEV_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ROOT="$(cd "$CODEV_DIR/.." && pwd)"
BUILDERS_DIR="$PROJECT_ROOT/.builders"
BUILDERS_MD="$CODEV_DIR/builders.md"
DASHBOARD_HTML="$CODEV_DIR/templates/dashboard.html"
PROMPT_TEMPLATE="$CODEV_DIR/templates/builder-prompt.md"
BASE_PORT=7681

# ... implementation of commands
```

**Commands**:

| Command | Description |
|---------|-------------|
| `spawn --project XXXX` | Create worktree, start ttyd, update builders.md |
| `spawn --issue NN` | Same but fetch spec from GitHub issue |
| `status` | Display builders.md |
| `dashboard` | Open dashboard.html in browser |
| `files XXXX` | List files changed by builder (vs main) |
| `diff XXXX` | Show unified diff of builder's changes |
| `cat XXXX FILE` | View specific file in builder's worktree |
| `review XXXX` | Summary: file list, lines added/removed, branch info |
| `annotate XXXX FILE` | Open annotation viewer for file in browser |
| `annotations XXXX` | List files with unresolved REVIEW comments |
| `cleanup XXXX` | Kill ttyd, remove worktree, update builders.md |

**Acceptance criteria**:
- [ ] All commands work
- [ ] Port allocation finds next available port
- [ ] Worktrees created correctly
- [ ] ttyd processes tracked (PID file or port scanning)
- [ ] File review commands show correct output
- [ ] Cleanup removes all artifacts

---

### Phase 7: Integration & Documentation

**Goal**: Integrate into codev-skeleton and document usage.

**Tasks**:
1. Add architect-builder to codev-skeleton
2. Update CLAUDE.md/AGENTS.md with architect-builder reference
3. Create usage documentation
4. Test full workflow

**Files to update**:
- `codev-skeleton/builders.md` (template)
- `codev-skeleton/templates/builder-prompt.md`
- `codev-skeleton/templates/dashboard.html`
- `codev-skeleton/templates/annotate.html`
- `codev-skeleton/bin/architect`
- `codev-skeleton/bin/annotate-server.js` (or Python equivalent)
- `CLAUDE.md` - add architect-builder section
- `AGENTS.md` - add architect-builder section

**Acceptance criteria**:
- [ ] Fresh codev install includes architect-builder
- [ ] Documentation explains full workflow
- [ ] End-to-end test: spawn → implement → annotate → PR → cleanup

---

## Testing Plan

### Manual Testing Checklist

1. **Spawn test**:
   ```bash
   architect spawn --project 0003
   # Verify: worktree exists, ttyd running, builders.md updated
   ```

2. **Dashboard test**:
   ```bash
   architect dashboard
   # Verify: browser opens, terminal visible, can type commands
   ```

3. **Multiple builders test**:
   ```bash
   architect spawn --project 0003
   architect spawn --project 0004
   architect spawn --project 0005
   # Verify: all on different ports, all visible in dashboard
   ```

4. **Cleanup test**:
   ```bash
   architect cleanup 0003
   # Verify: ttyd stopped, worktree removed, builders.md updated
   ```

5. **File review test**:
   ```bash
   # After builder has made some changes
   architect files 0003
   # Verify: shows list of modified files with status (M/A/D)

   architect diff 0003
   # Verify: shows unified diff of all changes vs main

   architect cat 0003 src/some/file.ts
   # Verify: displays file contents with line numbers

   architect review 0003
   # Verify: shows summary with file list and line stats
   ```

6. **Annotation viewer test**:
   ```bash
   architect annotate 0003 src/auth/login.ts
   # Verify: browser opens, file displayed with syntax highlighting
   # Verify: can click line to add REVIEW comment
   # Verify: comment inserted into file with correct format

   architect annotate 0003 codev/specs/0003-feature.md
   # Verify: markdown file renders with syntax highlighting
   # Verify: can add <!-- REVIEW: --> comments

   architect annotations 0003
   # Verify: lists all files containing REVIEW: comments
   ```

7. **Full workflow test**:
   - Spawn builder for a real spec
   - Watch builder implement (or simulate)
   - Create PR
   - Review and merge
   - Cleanup

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| ttyd not installed | Check on `spawn`, show install instructions |
| Port already in use | Scan for available port starting from BASE_PORT |
| Worktree already exists | Error with clear message |
| Orphaned ttyd processes | `cleanup` scans for processes matching pattern |
| Dashboard can't reach ttyd | Check ttyd is running, show troubleshooting |

---

## Estimated Effort

| Phase | Effort |
|-------|--------|
| Phase 1: Directory structure | 15 min |
| Phase 2: Builder prompt | 15 min |
| Phase 3: builders.md | 10 min |
| Phase 4: Dashboard HTML | 30 min |
| Phase 5: Annotation Viewer | 1-2 hours |
| Phase 6: Architect CLI | 1-2 hours |
| Phase 7: Integration & docs | 30 min |
| **Total** | ~4-6 hours |

---

## Dependencies

```
Phase 1 ─┬─► Phase 2
         ├─► Phase 3
         ├─► Phase 4
         └─► Phase 5
              │
              ▼
         Phase 6 (needs 1-5)
              │
              ▼
         Phase 7 (needs 6)
```

Phases 2, 3, 4, 5 can be done in parallel after Phase 1.

---

### Phase 8: Direct CLI Access (TICK-001)

**Goal**: Add `af architect` command for terminal-first access to the architect role.

**Tasks**:
1. Add `architect` subcommand to `src/agent-farm/cli.ts`
2. Implement `src/agent-farm/commands/architect.ts`:
   - Check if `af-architect` tmux session exists
   - If exists → attach to it (`tmux attach-session -t af-architect`)
   - If not → create new session with architect role, then attach
   - Load role from `codev/roles/architect.md`
   - Pass through additional arguments to claude
3. Handle edge cases:
   - Role file doesn't exist → clear error message
   - tmux not installed → show install instructions
4. Update help text and documentation

**Implementation**:
```typescript
// src/agent-farm/commands/architect.ts
export async function architect(args: string[]): Promise<void> {
  const sessionName = 'af-architect';

  // Check if session exists
  const sessionExists = await tmuxSessionExists(sessionName);

  if (sessionExists) {
    // Attach to existing session
    await attachToSession(sessionName);
  } else {
    // Create new session with architect role
    const roleFile = resolve(config.codevDir, 'roles', 'architect.md');
    if (!existsSync(roleFile)) {
      fatal('Architect role not found: codev/roles/architect.md');
    }

    const cmd = `claude --append-system-prompt "$(cat '${roleFile}')" ${args.join(' ')}`;
    await run(`tmux new-session -s ${sessionName} '${cmd}'`);
  }
}
```

**Acceptance criteria**:
- [ ] `af architect` starts or attaches to tmux session
- [ ] Session persists after detach (Ctrl+B, D)
- [ ] Architect role is loaded correctly
- [ ] Additional arguments passed to claude
- [ ] Clear error if role file missing
- [ ] Clear error if tmux not installed

---

## Amendment History

### TICK-001: Direct CLI Access (2025-12-27)

**Changes**:
- Added Phase 8: Direct CLI Access implementation
- New command: `af architect` for terminal-first architect access

**Review**: See `reviews/0002-architect-builder-tick-001.md`
