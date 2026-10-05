# air-1727 — vscode: declare untrustedWorkspaces support (AIR, strict)

Issue #1727. Manifest-only change so Codev activates in Restricted Mode instead of
staying dark until the folder is trusted.

## Lane brief (architect:vscode)
- Restricted set is EXACTLY four: `codev.towerHost`, `codev.towerPort`,
  `codev.workspacePath`, `codev.autoStartTower`. Architect audited all 22 `codev.*`
  keys; I re-derived it (see PR audit table). The other 18 are UI toggles / intervals /
  thresholds / fonts — none resolves to a command, path or endpoint.
- `virtualWorkspaces: false` — extension shells out to afx/git and reads the local FS.
- #1722 interaction: an untrusted real-project window must NOT adopt $HOME. Not fixing
  #1722 here; added a guard test so the two fixes can't regress each other.
- Fences: stay out of views/tower*.ts, workspace-label.ts, fleet-order.ts,
  attention-format.ts, switch-workspace.ts, icons/tower.svg (pir-1566). package.json is
  shared with 1566 — my hunk is limited to the `capabilities` block + the 4 `restricted`
  flags.
- Changelog is architect's on the changelog branch after merge.

## What I changed
- `apps/vscode/package.json`: added top-level `capabilities` (virtualWorkspaces false;
  untrustedWorkspaces supported "limited" + description + 4 restrictedConfigurations);
  added `"restricted": true` on the four property definitions.
- New tests (vitest unit, `src/__tests__/`):
  - `contributes-untrusted-workspace.test.ts` — manifest parity: limited support,
    description, exact restricted list, virtualWorkspaces false, the 4 property flags,
    list↔flags sync, and the audit assertion that NO other codev.* key is restricted.
  - `untrusted-workspace-config.test.ts` — runtime: getTowerAddress reads the safe global
    endpoint while untrusted / the workspace one once trusted; detectWorkspacePath is
    trust-independent and never adopts $HOME (#1722 guard).

## Verification
- Full vscode vitest: 85 files / 1035 tests pass (after `pnpm --filter 'codev-vscode^...'
  build` to build codev-sdk subpath exports — build-prerequisite artifact, not my change).
- check-types clean; lint clean.

## Status
Implementation + tests done. Next: commit, open PR with review + audit table in the body,
notify architect, freeze branch at pr gate.
