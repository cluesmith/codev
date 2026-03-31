# Specification: Document OS Dependencies

## Metadata
- **ID**: 0013-document-os-dependencies
- **Protocol**: TICK
- **Status**: specified
- **Created**: 2025-12-03
- **Priority**: medium

## Problem Statement

Codev requires several OS-level dependencies that aren't clearly documented:
- tmux (terminal multiplexer)
- ttyd (web terminal)
- Node.js (runtime)
- git (worktrees)
- gh (GitHub CLI for PRs, issues)
- Python 3 (consult tool, scripts)
- Claude Code CLI (primary AI agent)
- Gemini CLI (consultation)
- Codex CLI (consultation)

Users often encounter cryptic errors when dependencies are missing.

## Current State

- README mentions some dependencies casually
- No installation instructions
- No version requirements
- Errors like "ttyd not found" without guidance

## Desired State

1. **Clear documentation** of all dependencies
2. **Installation instructions** per platform (macOS, Linux, Windows WSL)
3. **Version requirements** where applicable
4. **Startup checks** that verify dependencies with helpful errors

## Success Criteria

- [ ] README has "Prerequisites" section with all dependencies for full codev environment
- [ ] Installation commands for macOS (brew) and Linux (apt/dnf)
- [ ] Version requirements documented
- [ ] `afx start` checks core dependencies (tmux, ttyd, node, git)
- [ ] `codev doctor` command to verify full installation (afx + consult + AI CLIs)
- [ ] INSTALL.md uses `codev doctor` for verification step
- [ ] Clear guidance on optional vs required dependencies (e.g., only need one AI CLI to start)

## Technical Approach

### Documentation (README.md)

```markdown
## Prerequisites

Codev requires the following:

### Core Dependencies (required)

| Dependency | Version | macOS | Ubuntu/Debian | Purpose |
|------------|---------|-------|---------------|---------|
| Node.js | >= 18 | `brew install node` | `apt install nodejs` | Runtime |
| tmux | >= 3.0 | `brew install tmux` | `apt install tmux` | Terminal sessions |
| ttyd | >= 1.7 | `brew install ttyd` | See below | Web terminal |
| git | >= 2.5 | (pre-installed) | `apt install git` | Worktrees |
| gh | latest | `brew install gh` | `apt install gh` | GitHub CLI for PRs |
| Python | >= 3.10 | `brew install python` | `apt install python3` | Consult tool |

### AI CLI Dependencies (at least one required)

| Dependency | Installation | Docs | Purpose |
|------------|--------------|------|---------|
| Claude Code | `npm install -g @anthropic-ai/claude-code` | [docs](https://docs.anthropic.com/en/docs/claude-code) | Primary AI agent |
| Gemini CLI | `npm install -g @anthropic-ai/gemini-cli` | [github](https://github.com/anthropics/gemini-cli) | Consultation |
| Codex CLI | `npm install -g @openai/codex` | [github](https://github.com/openai/codex) | Consultation |

**Note**: After installing gh, authenticate with `gh auth login`.

### Installing ttyd on Linux

```bash
# Ubuntu/Debian
sudo apt install build-essential cmake git libjson-c-dev libwebsockets-dev
git clone https://github.com/tsl0922/ttyd.git
cd ttyd && mkdir build && cd build
cmake .. && make && sudo make install
```
```

### Dependency Checks (in start.ts)

```typescript
async function checkDependencies(): Promise<void> {
  const deps = [
    { name: 'node', minVersion: '18.0.0', check: 'node --version' },
    { name: 'tmux', minVersion: '3.0', check: 'tmux -V' },
    { name: 'ttyd', minVersion: '1.7', check: 'ttyd --version' },
    { name: 'git', minVersion: '2.5', check: 'git --version' },
  ];

  for (const dep of deps) {
    if (!(await commandExists(dep.name))) {
      fatal(`${dep.name} not found. Install with: brew install ${dep.name} (macOS)`);
    }
  }
}
```

## Scope

### In Scope
- README documentation for full codev environment
- Dependency checks in `afx start` (core deps)
- `codev doctor` command for full environment verification
- INSTALL.md update to use `codev doctor` for verification

### Out of Scope
- Automated install script (AI agents guide users through installation)
- Docker container (see project 0025)
- Windows native support (WSL documented instead)

## Test Scenarios

1. Fresh machine without ttyd - `afx start` shows install instructions
2. Old tmux version - warning shown (if version check implemented)
3. All deps present - normal startup

## Expert Consultation
**Date**: 2025-12-03
**Models Consulted**: GPT-5 Codex, Gemini 3 Pro
**Feedback Incorporated**:
- Add explicit minimum version constraints (tmux/ttyd have protocol changes between versions)
- Consider `check-env` script for programmatic validation (not just docs)
- Risk of documentation drift - keep README and actual checks in sync

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
