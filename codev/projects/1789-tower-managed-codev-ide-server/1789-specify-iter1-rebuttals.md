# Spec 1789: iteration 1 rebuttals

All points accepted; the spec was revised (commit "[Spec 1789] Specification with multi-agent review").
Several were settled by direct verification against a local codev-ide server build (VS Code base 1.135.0),
recorded in the spec's Current State.

## Codex (REQUEST_CHANGES)
- **Resolve OQ1 (version meaning / floor):** verified `--version` prints the VS Code base version. Floor is a single
  Tower constant, test-tied to the sidebar's `engines.vscode` minimum (1.128.0). Initial value demoted to an Important
  (non-blocking) question for the owner.
- **Decide live-server / install-failure / afx ide install:** all decided in "Decided sub-points" and Success Criteria:
  live server never killed (install + restart hint); install failure refuses spawn; missing vsix warns; `afx ide install` in scope.
- **Artifact identity:** relaxed to same commit, command, version; byte identity explicitly not required (vsce zips are
  not reproducible). Single-artifact reuse listed as nice-to-know.
- **Transactional failure:** new criterion: preflight (version + install) runs before any stop/replace; failed preflight
  leaves a healthy server and its record untouched. Test 19.
- **Coverage for replacement failure, legacy record, timeouts, concurrent starts:** tests 15, 19, 20, 22, 23 and timeout criteria added.
- **Extensions dir security:** 0700, refuse symlink / foreign-owned directory. Test 17.

## Claude (COMMENT)
- **`--install-extension` unverified:** verified (install, idempotent re-install, upgrade, downgrade needs `--force`,
  other extensions survive). Found that a server bundling `codev-vscode` as a built-in refuses the install; recorded as
  a requirement on the IDE repo and Important OQ2.
- **PATH risks inconsistent:** merged into one High risk with two mitigations; `dirname(process.execPath)` on the spawn
  PATH is now a success criterion.
- **"byte-for-byte artifact class":** fixed (see Codex point).
- **Record backward compat:** new fields optional; legacy-record criterion and tests 22/23.
- **Bounded timeouts:** now success criteria for `--version` and install.
- **Doc scope:** criterion covers new afx-ide docs in four skill copies + agent-farm.md, and arch.md §IDE prefix forward update.
- **Bin link is a symlink, not necessarily a Node script:** Assumptions reworded.
- **OQ5 conditional criteria:** `afx ide install` decided in scope; criteria unconditional.

## Gemini (APPROVE)
- `--force` for replacement: adopted (verified required for downgrade).
- Timeouts, metadata-read idempotency (no subprocess), 0700 dir: adopted.
