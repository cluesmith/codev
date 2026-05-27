# bugfix-840 thread

## Investigate (2026-05-26)

Issue #840 asks to remove the dead `codev.telemetry` setting from
`packages/vscode/package.json`. Setting has zero code consumers (verified by
grep across `packages/`).

Found 2 references in `packages/vscode/`:
- `package.json:534` — the declaration itself
- `README.md:218` — table row documenting the setting

Both must go; the issue's acceptance criterion is "no remaining reference to
`codev.telemetry` anywhere in `packages/vscode/`".

## Fix (2026-05-26)

- Removed entry from `packages/vscode/package.json`
- Removed row from `packages/vscode/README.md`
- Added regression test at `packages/vscode/src/__tests__/codev-telemetry-removed.test.ts`
  asserting `contributes.configuration.properties` doesn't carry the key
- `pnpm test:unit` → 35/35 pass (5 files, includes the new regression test)
- `pnpm check-types` → passes (after building core+types deps in the worktree)
- Diff size: 23 additions, 6 deletions, 3 files — well under 300 LOC
- Commit: `fb6bd5c4` — `Fix #840: Remove dead codev.telemetry setting`

The local analytics surface in `packages/codev/src/agent-farm/servers/analytics.ts`
is untouched per the issue's "out of scope" note — it is local-only and not
gated by this setting.

## PR (2026-05-26)

- PR #865 created: https://github.com/cluesmith/codev/pull/865
- CMAP 3-way verdicts (`consult --protocol bugfix --type pr --issue 840`):
  - gemini: **APPROVE** (HIGH confidence, no key issues)
  - codex: **APPROVE** (HIGH confidence, no key issues)
  - claude: **APPROVE** (HIGH confidence, no key issues)
- Notified architect with PR link + all three verdicts via `afx send architect`

Note: first CMAP attempt failed with "Multiple projects found" — auto-project
detection inside the worktree didn't disambiguate. Retried with `--issue 840`
which worked. Likely worth tracking as a follow-up if reproducible (would
affect any builder spawned in a workspace that lists many projects).
