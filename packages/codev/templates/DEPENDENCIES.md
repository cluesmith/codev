# Codev Dependencies

This document describes all dependencies required to run Codev and Agent Farm.

## Quick Check

Run the doctor script to verify your installation:

```bash
./codev/bin/codev-doctor
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

### tmux

| Requirement | Value |
|-------------|-------|
| Minimum Version | 3.0 |
| Purpose | Terminal multiplexer for managing builder sessions |

**Installation:**

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt install tmux

# Verify
tmux -V  # Should show tmux 3.x or higher
```

### ttyd

| Requirement | Value |
|-------------|-------|
| Minimum Version | 1.7.0 |
| Purpose | Web-based terminal for dashboard access |

**Installation:**

```bash
# macOS
brew install ttyd

# Ubuntu/Debian (build from source)
sudo apt install build-essential cmake git libjson-c-dev libwebsockets-dev
git clone https://github.com/tsl0922/ttyd.git
cd ttyd && mkdir build && cd build
cmake .. && make && sudo make install

# Verify
ttyd --version  # Should show 1.7.x or higher
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
| Documentation | [docs.anthropic.com](https://docs.anthropic.com/en/docs/claude-code) |

**Installation:**

```bash
npm install -g @anthropic-ai/claude-code

# Verify
claude --version
```

### Gemini CLI

| Requirement | Value |
|-------------|-------|
| Purpose | Multi-agent consultation, alternative perspectives |
| Documentation | [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) |

**Installation:**

```bash
npm install -g @anthropic-ai/gemini-cli

# Verify
gemini --version
```

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
| tmux | 3.0 | Yes |
| ttyd | 1.7.0 | Yes |
| git | 2.5.0 | Yes |
| gh | latest | Yes |
| Claude Code | latest | At least one AI CLI |
| Gemini CLI | latest | At least one AI CLI |
| Codex CLI | latest | At least one AI CLI |

---

## Platform-Specific Notes

### macOS

All dependencies are available via Homebrew:

```bash
# Install all core dependencies at once
brew install node tmux ttyd gh

# Git is included with Xcode command line tools
xcode-select --install
```

### Ubuntu/Debian

Most dependencies are available via apt, except ttyd which must be built from source:

```bash
# Core dependencies
sudo apt install nodejs npm tmux git

# gh requires adding GitHub's apt repository (see above)

# ttyd must be built from source (see above)
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

### tmux version too old

Ubuntu LTS versions often have older tmux. Install from source or use a PPA:

```bash
# Add tmux PPA for newer versions
sudo add-apt-repository ppa:pi-rho/dev
sudo apt update
sudo apt install tmux
```

### ttyd connection issues

Ensure no firewall is blocking the ports (default: 4200-4299):

```bash
# Check if port is in use
lsof -i :4200

# Clean up stale port allocations
./codev/bin/agent-farm ports cleanup
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
- [codev/bin/codev-doctor](codev/bin/codev-doctor) - Automated dependency checker
