# Review (PR #1806), iteration 1: responses

Verdicts: gemini APPROVE, claude APPROVE, codex REQUEST_CHANGES. Main's integration review (round 1, head 7fceed172) confirmed Codex's headline item and added two doc items. Everything below is fixed on this branch.

## Codex: `liveServerIsCurrent` never compares the server version (same-path upgrade invisible)
Accepted. `npm i -g @cluesmith/codev-ide` keeps the bin path, so an old live server was adopted with `restartRequired: false`. `liveServerIsCurrent` now returns false when the record's `serverVersion` is known and differs from the version this preflight checked. An unknown recorded version is not stale on its own; a legacy record is already flagged by its missing `extensionsDir`. The fixture that asserted the defect (a live 1.130.0 adopted against a 1.135.0 binary with no restart) now seeds a genuinely current record. New test: a same-path upgrade reports `restartRequired: true` on two consecutive starts, and the record keeps the live 1.130.0.

## Codex: adoption overwrote `serverPath` with the requested binary (hint consumed on first use)
Accepted. Adopt now keeps the prior record's `serverPath`, the same rule already applied to version, extensions dir and sidebar, so the record and `afx ide status` describe the live process. With no prior record on that port, the live binary is unknown: the requested path is recorded and a restart is flagged, as before. New test: a start from a different path twice reports `true` both times, records the live path and version, and spawns or kills nothing. One consequence: until the user restarts, an on-demand respawn uses the recorded (live) binary, which matches "the record describes what is running".

## Codex: `runIdeServerCommand` buffers stdout without limit
Accepted. Stdout is now capped at 64 KB (head kept; callers read only `--version` line 1), mirroring the stderr cap. New test: a server that prints a version and then 1 MB keeps a bounded head, and the version check still passes.

## Claude (non-blocking)
- Existing extensions dir not tightened to 0700: **N/A** here. It matches the spec ("creates ... 0700"; ownership and symlink refusal on every use). Main recorded it as a possible hardening follow-up.
- Preflight installs into a live server's extensions dir: **N/A**, by design (spec "Live server"). The restart hint covers it, and the release-note wording in the PR body says the sidebar is installed on start.
- One-shot restart hint / status mixing two binaries: **Addressed** (the serverPath item above).
- Build couples CI jobs to apps/vscode health: **N/A**, owner ruling in phase 1, recorded by main as a visible trade.

## Main's integration review: added items
- Tell #1668 users where extensions go now: **Addressed**. One paragraph in both `agent-farm.md` command references and the four afx skill copies says that only `~/.agent-farm/ide-extensions` is loaded, and how to install into it.
- Release-time guard for the floor coupling: **Addressed** in `codev/protocols/release/protocol.md` §Pre-flight Checks: before a release that raises `engines.vscode`, confirm `@cluesmith/codev-ide` has published a server at that VS Code base. `codev-skeleton/` carries no RELEASE protocol (it is this repo's own process), so there is no second tree to mirror.
