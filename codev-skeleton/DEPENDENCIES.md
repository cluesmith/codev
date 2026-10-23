# Codev Dependencies

This document describes all dependencies required to run Codev and Agent Farm.

## Quick Check

Run the doctor command to verify your installation:

```bash
codev doctor
```

---

## Core Dependencies (Required)

These are required for Agent Farm to function.

### Node.js

| Requirement | Value |
|-------------|-------|
| Minimum Version | 20.0.0 (native Windows: 22 or 24) |
| Recommended | 22 |
| Purpose | Runtime for Agent Farm server |

Codev's native dependencies (node-pty, better-sqlite3) install from prebuilt binaries where one
exists for your platform and Node version. Where none exists, npm builds them from source, which
needs a C/C++ toolchain:

- **Linux and WSL:** node-pty compiles from source, so install `build-essential` and `python3`
  before `npm install -g @cluesmith/codev`.
- **Native Windows:** prebuilds exist for Node 22 and 24 (x64 and ARM64) only. On any other
  Node version the install stops and names the supported versions, rather than starting a
  source build.

**Installation:**

```bash
# macOS
brew install node

# Ubuntu/Debian (and WSL)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3

# Windows: the Node.js 22 or 24 installer from https://nodejs.org

# Verify
node --version  # Should show v20.x or higher (v22.x or v24.x on native Windows)
```

### git

| Requirement | Value |
|-------------|-------|
| Minimum Version | 2.5.0 |
| Purpose | Version control, worktree support for builders |

**Installation:**

```bash
# macOS (usually pre-installed with Xcode)
xcode-select --install

# Ubuntu/Debian
sudo apt install git

# Verify
git --version  # Should show 2.5.x or higher
```

### gh (GitHub CLI)

| Requirement | Value |
|-------------|-------|
| Minimum Version | Latest |
| Purpose | Creating PRs, managing issues, GitHub operations |

**Installation:**

```bash
# macOS
brew install gh

# Ubuntu/Debian
(type -p wget >/dev/null || sudo apt install wget -y) \
  && sudo mkdir -p -m 755 /etc/apt/keyrings \
  && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && sudo apt update \
  && sudo apt install gh -y

# After installation, authenticate:
gh auth login

# Verify
gh auth status  # Should show "Logged in to github.com"
```

---

## AI CLI Dependencies (At Least One Required)

You need at least one AI CLI installed to use Codev. Install more for multi-agent consultation.

### Claude Code (Recommended)

| Requirement | Value |
|-------------|-------|
| Purpose | Primary AI agent for development |
| Required For | `codev import` command (spawns interactive Claude session) |
| Documentation | [docs.anthropic.com](https://docs.anthropic.com/en/docs/claude-code) |

**Installation:**

```bash
npm install -g @anthropic-ai/claude-code

# Verify
claude --version
```

### Antigravity CLI (`agy`) — the `gemini` consult lane

Replaces the retired Gemini CLI (Google stopped serving Gemini CLI for Pro/Ultra/free tiers on
2026-06-18). The `gemini` consult lane now dispatches to the Antigravity CLI (`agy`).

| Requirement | Value |
|-------------|-------|
| Purpose | Multi-agent consultation (the `gemini` lane), alternative perspectives |
| Documentation | [antigravity.google/docs/cli-using](https://antigravity.google/docs/cli-using) |
| Auth | OAuth / Google subscription (no API key) — run `agy` once and sign in |

**Installation:**

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash   # installs to ~/.local/bin/agy

# Sign in (one-time, interactive)
agy            # complete the OAuth flow

# Verify
agy --version
```

> Note: the `agy` on the IDE's PATH (`~/.antigravity/.../bin/agy`) is a symlink to the Antigravity
> IDE, not the headless CLI — Codev resolves the real CLI itself. If `agy` is missing or
> unauthenticated, the `gemini` consult lane skips non-blockingly (the run proceeds without it).

### Codex CLI

| Requirement | Value |
|-------------|-------|
| Purpose | Multi-agent consultation, code-focused analysis |
| Documentation | [github.com/openai/codex](https://github.com/openai/codex) |

**Installation:**

```bash
npm install -g @openai/codex

# Verify
codex --version
```

---

## Version Requirements Summary

| Dependency | Minimum Version | Required? |
|------------|-----------------|-----------|
| Node.js | 20.0.0 (native Windows: 22 or 24) | Yes |
| git | 2.5.0 (native Windows: Git for Windows) | Yes |
| jq | any | Native Windows only |
| gh | latest | Yes |
| Claude Code | latest | At least one AI CLI |
| Antigravity CLI (`agy`) | latest | At least one AI CLI |
| Codex CLI | latest | At least one AI CLI |

---

## Platform-Specific Notes

### macOS

All dependencies are available via Homebrew:

```bash
# Install all core dependencies at once
brew install node gh

# Git is included with Xcode command line tools
xcode-select --install
```

### Ubuntu/Debian

Most dependencies are available via apt:

```bash
# Core dependencies (build-essential and python3 build node-pty)
sudo apt install nodejs npm git build-essential python3

# gh requires adding GitHub's apt repository (see above)
```

### Windows

Codev supports two paths on Windows: native, with Git for Windows, and WSL 2.

#### Native Windows (Git for Windows)

Codev runs directly on Windows 10 22H2 or Windows 11, x64 or ARM64, with no admin rights.

| Prerequisite | Notes |
|--------------|-------|
| Node.js 22 or 24 | Node 20 is not supported on native Windows: better-sqlite3 has no Windows prebuild for it |
| [Git for Windows](https://git-scm.com/download/win) | Provides `git` and Git Bash, the shell Codev uses for its scripts |
| jq | `winget install jqlang.jq`; the forge scripts need it |
| gh | `winget install GitHub.cli`, then `gh auth login` |

```powershell
# After installing Node.js 22 or 24 from https://nodejs.org
winget install Git.Git jqlang.jq GitHub.cli
npm install -g @cluesmith/codev
codev doctor
```

How it works and what to know:

- **Shells.** Architect and shell terminals open Windows PowerShell 5.1 by default (set
  `shell.shell` to `"pwsh"` in `.codev/config.json` to use PowerShell 7). Codev's own scripts
  (forge concepts, the builder launch script, `postSpawn`) run under Git Bash. Codev never runs
  bare `bash`, because `C:\Windows\System32\bash.exe` starts WSL. It finds Git Bash from
  `windows.gitBashPath` in `.codev/config.json` or `CLAUDE_CODE_GIT_BASH_PATH`, else the standard
  Git for Windows install paths, else `PATH`. An override that points at a bash other than Git
  Bash is an error.
- **Long paths.** Builder worktrees nest under `.builders/<id>/`, and dependency trees inside them
  can pass Windows' 260-character path limit. Keep the workspace root short (for example
  `C:\src\<repo>`) and enable long paths in git for your user (no admin needed):
  `git config --global core.longpaths true`. `codev doctor` checks both.
- **Developer Mode is optional.** Runnable-worktree links (`worktree.symlinks`) are real symlinks
  when Developer Mode is on. When it is off, a directory link becomes a junction and a file link
  becomes a hard link, or a copy when no hard link can be made. A copy does not write through to
  the original, and `afx spawn` warns when it makes one.
- **Privacy.** Codev's state (`%USERPROFILE%\.agent-farm`, `%USERPROFILE%\.codev`) relies on
  your user folder being private to you, which is the Windows default. Codev sets no ACLs of its
  own. Terminal sessions use named pipes that require a per-session secret, so other users on
  the machine cannot read or drive them.
- **Line endings.** Scripts Codev ships are pinned to LF. A `postSpawn` or `devCommand` script you
  write must use LF line endings to run under Git Bash; `codev doctor` warns about CRLF ones.
- **PowerShell.** Tower uses the built-in `powershell.exe` (CIM) to list and stop the processes
  each session starts. A machine policy that blocks it, or Constrained Language Mode, is not
  supported; `codev doctor` and Tower's log report it.
- **Known limitations.** Doctor cannot show Tower's environment on Windows (the process table does
  not expose it). Building this repository from source on ARM64 fails in one bundler; installing
  the published package on ARM64 works.

#### WSL 2

Codev also runs inside WSL 2 as on Linux. Install a distribution, then follow the Ubuntu
instructions above inside it, including `build-essential` and `python3`:

```bash
wsl --install -d Ubuntu
```

---

## Troubleshooting

### "command not found" errors

Ensure the installed binaries are in your PATH:

```bash
# Check PATH
echo $PATH

# Common fix: add npm global bin to PATH
export PATH="$PATH:$(npm config get prefix)/bin"
```

On native Windows, npm's global bin directory is `npm config get prefix` itself (for example
`%APPDATA%\npm`), with no `bin` subdirectory; the Node.js installer adds it to `PATH`.

### Install fails on native Windows with "supported Node versions"

Your Node version has no prebuilt better-sqlite3 for Windows. Install Node 22 or 24 and run the
install again.

### Terminal connection issues

Ensure no firewall is blocking the ports (default: 4200-4299):

```bash
# Check if port is in use
lsof -i :4200

# Clean up stale port allocations
afx ports cleanup
```

### gh authentication issues

```bash
# Re-authenticate
gh auth logout
gh auth login

# Verify
gh auth status
```

---

## See Also

- [INSTALL.md](INSTALL.md) - Installation guide
- [MIGRATION-1.0.md](../MIGRATION-1.0.md) - Migration guide for existing projects
- `codev doctor` - Automated dependency checker
