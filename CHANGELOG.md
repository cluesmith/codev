# Changelog

All notable changes to the Codev project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For detailed release notes, see [docs/releases/](docs/releases/).

## [Unreleased]

## [2.0.6] - 2026-02-16 "Hagia Sophia"

Major stabilization release with project management rework, shellper reliability improvements, and multi-agent consultation metrics.

### Added
- **GitHub Issues as source of truth** (Spec 0126): Projects tracked via GitHub Issues instead of `projectlist.md`
- **Unified Work view**: Dashboard overview, builder status, and backlog in a single view
- **Shellper multi-client connections** (Spec 0118): Multiple clients can connect to the same session
- **`af attach` terminal mode**: Direct shellper socket connection
- **Codex SDK integration** (Spec 0120): Replaces CLI subprocess with OpenAI SDK
- **Rebuttal-based review** (Spec 0121): Consultation reviews support iterative rebuttals
- **Consultation metrics** (Spec 0115): SQLite-backed MetricsDB with `consult stats` subcommand
- **Messaging infrastructure** (Spec 0110): `af send` command with WebSocket message bus
- **Shellper debug logging** (Spec 0113): Stderr capture bridge and session event logging
- **Tower async handlers** (Spec 0127): Workspace creation/adoption and git status converted to async

### Changed
- **`af spawn` CLI reworked**: Positional arg + `--protocol` flag replaces old `-p`/`--issue` syntax

### Fixed
- Shellper resource leakage with periodic cleanup (Spec 0116)
- Shellper reconnect on Tower restart (Spec 0122)
- Test suite consolidation: removed ~285 redundant tests (Spec 0124)
- Terminal size defaults (200x50 → 80x24)
- Orphaned shellper/consult process cleanup (#341)
- Builder discovery filtering (#326), notification timing (#335)
- Dashboard mobile fixes: tab bar scrolling (#285), annotator positioning (#286)
- Fullscreen shells (#296), terminal responsiveness (#313)
- Duplicate gate notifications (#319, #315)

## [2.0.3] - 2026-02-15 "Hagia Sophia"

### Added
- **Porch gate notifications** (Spec 0108): Push-based `af send` from porch replaces poll-based gate watcher
- **Tunnel keepalive** (Spec 0109): WebSocket ping/pong heartbeat for silent connection drop recovery

### Changed
- **Workspace rename** (Spec 0112): "project" → "workspace" across Tower, CLI, dashboard, and database

### Removed
- Dead vanilla dashboard templates (Spec 0111): -4,614 lines
- codev-hq package, hq-connector, unused utilities (#277): -2,928 lines

### Fixed
- `codev init`/`codev adopt` role file copying (#266)
- PrismJS/marked/DOMPurify bundled locally to avoid CSP blocks (#269)
- Architect terminal lost on Tower restart (#274)

## [2.0.2] - 2026-02-14 "Hagia Sophia"

### Changed
- Always show cloud connect dialog for preference review before connecting

## [2.0.1] - 2026-02-14 "Hagia Sophia"

### Fixed
- Cloud tunnel disconnect after initial registration

## [2.0.0] - 2026-02-14 "Hagia Sophia"

Complete rearchitecture: custom terminal manager, Tower decomposition, cloud connectivity, and mobile dashboard.

### Added
- **Shellper session manager**: Custom PTY manager replaces tmux — no external dependencies
- **Tower Cloud Connect**: Register Tower with codevos.ai from web UI
- **Mobile-ready dashboard**: Full terminal access from phone and tablet with touch support
- **Porch protocol orchestrator**: State-machine-driven protocol execution with gates and multi-agent consultation
- **EXPERIMENT protocol**: Disciplined experimentation with hypothesis-driven development
- **MAINTAIN protocol**: Codebase maintenance with soft-delete and documentation sync
- **Consult v2 CLI**: `consult --prompt` for general queries, `--protocol` for reviews, `stats` subcommand

### Changed
- **Tower server decomposition**: Monolithic handler split into focused modules (routes, instances, terminals, tunnel, utils, websocket)
- **Single daemon architecture**: One Tower process manages all projects
- **SQLite state management**: Replaced JSON files (`state.json`, `ports.json`) with SQLite databases

### Removed
- tmux dependency (replaced by Shellper)
- ttyd dependency (replaced by xterm.js + WebSocket)
- JSON state files (replaced by SQLite)

## [1.6.0] - 2026-01-07 "Gothic"

### Added
- **BUGFIX protocol**: GitHub issue-driven bug fixes with `af spawn --issue 42`
- **Release candidate workflow**: RC tags published to `@next` npm tag
- **Tower subcommands**: `af tower start/stop/status`
- **Create File button** in dashboard with path traversal protection

### Changed
- Smart close confirmation for already-exited shells
- Enhanced skeleton completeness in `codev adopt`

### Fixed
- Symlink path traversal vulnerability in create file API
- config.json overwritten during `codev update`
- Orphan cleanup only killing architect sessions with dead PIDs

## [1.5.8] - 2025-12-28

### Fixed
- Session rename timing with proper tmux send-keys
- "Already running" case showing correct dashboard port
- Missing projectId in builder tabs (remote mode)
- SSH error messages showing actual error details

## [1.5.4] - 2025-12-28 "Florence"

### Fixed
- Login shell for remote commands (bash -l for PATH sourcing)
- Passwordless SSH detection with setup instructions
- `--port` flag correctly controls dashboard port
- Version mismatch warnings for remote CLI

## [1.5.3] - 2025-12-28 "Florence"

### Fixed
- Remote port detection using `net.createServer()` for reliability

## [1.5.2] - 2025-12-28 "Florence"

### Added
- **Secure remote access** via SSH tunneling with `af start --remote user@host`
- Reverse proxy for terminal traffic routing

### Changed
- `af stop` detects and kills orphaned processes

### Deprecated
- `--allow-insecure-remote` flag (use `af start --remote` instead)

## [1.4.3] - 2025-12-17

### Fixed
- Port 5000 blocklist for macOS AirPlay Receiver conflict
- Port gap recycling for efficient port reuse
- Clipboard test paths after dashboard modularization

## [1.4.0] - 2025-12-15 "Eichler"

### Added
- **Dashboard tab overhaul**: Three-column layout (project status, tabs, file browser)
- **Tips & Tricks** documentation page
- **Consult types refactor**: Dedicated prompts for each review stage

### Changed
- Dynamic version from package.json instead of hardcoded

### Removed
- `codev eject` command

## [1.3.0] - 2025-12-13 "Doric"

### Added
- `codev generate-image` command for AI image generation
- **File browser** in dashboard with tree navigation
- Image/video viewing support in `af open`
- **RELEASE protocol** for standardized release process

### Removed
- `af tower` command (use `codev tower` instead; later reversed in v1.6.0)
- Legacy `agent-farm/` directory

## [1.2.0] - 2025-12-11 "Cordoba"

### Added
- **Cheatsheet**: Comprehensive quick-reference guide
- **Context hierarchy** conceptual model
- `codev import` command for AI-assisted protocol imports

### Changed
- Dashboard UX polish (clickable title, TICK badges, projectlist polling)

### Removed
- codev-updater agent
- spider-protocol-updater agent

## [1.1.0] - 2025-12-08 "Bauhaus"

### Added
- **Unified CLI package** (`@cluesmith/codev`) with three commands: `codev`, `af`, `consult`
- New `codev` subcommands: `init`, `adopt`, `doctor`, `update`, `tower`
- **TICK protocol**: Amendment workflow for lightweight spec modifications
- Architect-mediated PR reviews with improved consultation efficiency

### Changed
- All tools unified into single npm package

## [1.0.0] - 2025-12-05 "Alhambra"

First stable release with full architect-builder workflow.

### Added
- **Tower Dashboard** (`af tower`): Centralized view of all agent-farm instances
- **Consult Tool**: Unified CLI for multi-agent consultation (Gemini, Codex, Claude)
- **Flexible builder spawning** (`af spawn`): Five spawn modes
- **Send instructions to builder** (`af send`): Architect-to-builder communication
- **Annotation editor**: Edit files inline from dashboard
- **Tab bar status indicators**: Color dots showing working/idle/error states
- **Multi-instance support**: Directory-aware dashboard titles
- **Tutorial mode** (`af tutorial`): Interactive onboarding
- **Cleanup protocol**: Four phases (AUDIT → PRUNE → VALIDATE → SYNC)

### Changed
- Single TypeScript implementation replaces bash scripts
- Templates read from `codev/templates/` at runtime

### Removed
- Bash architect scripts
- `npx agent-farm` command
- `codev/builders.md` state tracking

## [0.2.0] - 2025-12-03 "Foundation"

Initial release establishing core infrastructure.

### Added
- BATS-based test framework
- Architect-builder pattern with git worktrees
- TypeScript CLI (`agent-farm`)
- Split-pane dashboard
- Terminal file click to open annotation viewer

---

[Unreleased]: https://github.com/cluesmith/codev/compare/v2.0.6...HEAD
[2.0.6]: https://github.com/cluesmith/codev/compare/v2.0.3...v2.0.6
[2.0.3]: https://github.com/cluesmith/codev/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/cluesmith/codev/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/cluesmith/codev/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/cluesmith/codev/compare/v1.6.0...v2.0.0
[1.6.0]: https://github.com/cluesmith/codev/compare/v1.5.8...v1.6.0
[1.5.8]: https://github.com/cluesmith/codev/compare/v1.5.4...v1.5.8
[1.5.4]: https://github.com/cluesmith/codev/compare/v1.5.3...v1.5.4
[1.5.3]: https://github.com/cluesmith/codev/compare/v1.5.2...v1.5.3
[1.5.2]: https://github.com/cluesmith/codev/compare/v1.4.3...v1.5.2
[1.4.3]: https://github.com/cluesmith/codev/compare/v1.4.0...v1.4.3
[1.4.0]: https://github.com/cluesmith/codev/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/cluesmith/codev/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/cluesmith/codev/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/cluesmith/codev/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/cluesmith/codev/compare/v0.2.0...v1.0.0
[0.2.0]: https://github.com/cluesmith/codev/releases/tag/v0.2.0
