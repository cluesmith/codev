# spir-1789 thread

## 2026-10-06 specify
- No spec existed; drafted codev/specs/1789-tower-managed-codev-ide-server.md from the issue + #1668 code (commands/ide.ts, servers/ide-server.ts, lib/ide-record.ts).
- Recommended: discovery in the CLI (user's PATH; Tower daemon PATH may lack npm global bin), version check + sidebar install inside Tower's single spawnIdeServer so start/reconcile/respawn all get --extensions-dir.
- Facts found: apps/vscode `package` script does not produce a vsix (`vsix` script does, via a globally-installed vsce, not a declared dep).
- Critical open question for architect: what `codev-ide-server --version` reports (VS Code base vs npm pkg version) and the initial floor.

## 2026-10-06 specify iter1 CMAP (gemini APPROVE, codex REQUEST_CHANGES, claude COMMENT)
- Verified against a local codev-ide server build (scratch clone, 1.135.0): --version = VS Code base version;
  --install-extension into external --extensions-dir works (~2.2s cold, 0.2s same-version); downgrade NEEDS --force;
  other extensions survive. SURPRISE: if the server tree bundles extensions/codev-vscode as a built-in, install is
  refused ("built-in ... not allowed to be updated"). The pre-npm local build does bundle it -> requirement on IDE repo.
- Resolved in spec: floor = Tower constant test-tied to sidebar engines.vscode min (1.128.0); install failure refuses spawn;
  missing vsix warns; live server never killed (hint restart); afx ide install in scope; transactional preflight;
  serialized spawns; optional record fields; 0700/non-symlink ext dir; Tower adds dirname(process.execPath) to spawn PATH.

## 2026-10-06 spec questions answered by IDE side (via main)
- Floor 1.128.0 accepted; published server excludes built-in codev-vscode (pr43 is the counter-example); first published server reports 1.138.0; parse --version line 1 only, ignore npm package suffix (e.g. 1.138.0-codev.1). Folded into spec.
