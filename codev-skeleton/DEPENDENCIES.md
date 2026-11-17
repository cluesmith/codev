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
| Minimum Version | 18.0.0 |
| Purpose | Runtime for Agent Farm server |

**Installation:**

```bash
# macOS
brew install node

# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v18.x or higher
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
| Consult lane | `consult -m claude` runs this CLI: version 2.1.141 or newer, logged in (`claude auth login`) |
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
| Node.js | 18.0.0 | Yes |
| git | 2.5.0 | Yes |
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
# Core dependencies
sudo apt install nodejs npm git

# gh requires adding GitHub's apt repository (see above)
```

### Windows

Codev is designed for Unix-like systems. On Windows, use WSL2:

```bash
# Install WSL2 with Ubuntu
wsl --install -d Ubuntu

# Then follow Ubuntu installation instructions inside WSL
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
