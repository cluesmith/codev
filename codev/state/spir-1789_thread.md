# spir-1789 thread

## 2026-10-06 specify
- No spec existed; drafted codev/specs/1789-tower-managed-codev-ide-server.md from the issue + #1668 code (commands/ide.ts, servers/ide-server.ts, lib/ide-record.ts).
- Recommended: discovery in the CLI (user's PATH; Tower daemon PATH may lack npm global bin), version check + sidebar install inside Tower's single spawnIdeServer so start/reconcile/respawn all get --extensions-dir.
- Facts found: apps/vscode `package` script does not produce a vsix (`vsix` script does, via a globally-installed vsce, not a declared dep).
- Critical open question for architect: what `codev-ide-server --version` reports (VS Code base vs npm pkg version) and the initial floor.
