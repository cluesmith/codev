# Phase 1 iteration 1: rebuttals

Gemini: non-blocking skip (`agy` exited 3, not signed in on this machine). Codex:
REQUEST_CHANGES. Claude: APPROVE with four items. I verified every point against the code or
with a new Windows dispatch (run 39560462785) before acting.

## Codex (REQUEST_CHANGES)

1. **"The hang root cause is hypotheses only; extension-host and SSH survival are untested."**
   - *Root cause:* partly accepted. I acted on it and can't fully discharge it. Following Claude's
     suggestion, the probe now deliberately reproduces the leading candidate: start Tower, run the
     broken `afx tower stop` (daemon stays alive), then start again on the same port and state
     dir. Measured on x64 and ARM64, from the checkout and from published 3.3.5: the second
     start **does not hang** ("Tower already running", exit 0, ~2.3 s). The candidate is ruled
     out. The hang does not reproduce on the current release on CI (x64, ARM64) or on the owner's
     Windows 11 machine. The remaining candidates (the 2026-09-09 release, that machine's state)
     cannot be tested without them. `audit.md` §1.6 records this. Whether "not reproducible on the
     current release, leading candidate ruled out by direct test" discharges the spec criterion is
     an owner decision, put to the architect with this rebuttal. Inventing a cause would be worse
     than saying so.
   - *Extension host:* disagree that Phase 1 can measure it. The probe cannot launch from the VS
     Code extension host; only the extension can. Before Phase 6 the extension cannot start a
     Tower on Windows, so there is nothing to measure. It is scheduled for the PR-gate manual pass,
     which `audit.md` §1.4 now says explicitly.
   - *SSH:* the owner does not start Tower over SSH; it is documented as untested.
   - *Survival evidence so far:* every launcher measured keeps detached children: Windows
     Terminal, the VS Code terminal (whole window closed), and the CI runner.
2. **"Section failures still exit 0; ARM64 inferred from assets."** Both accepted and fixed.
   - The probe exits non-zero when any section fails, and the workflow's later steps use
     `!cancelled()` so one failure does not hide the rest.
   - ARM64 is now **measured** on `windows-11-arm` (Node 22 and 24): both native deps install
     from prebuilds with no source build, the published package installs, and Tower starts. The
     same run found that building the *repo* on ARM64 fails in the `artifact-canvas` bundler. That
     is contributor-only, so the checkout-build step is limited to x64; recorded in `audit.md`.
3. **"Inventory misses VS Code dev `/bin/sh` and bench `/bin/sh`/bare `consult`."** Accepted and
   verified: `apps/vscode/src/commands/dev-shared.ts:130`, `agent-farm/commands/bench.ts:51,71`,
   and `commands/bootstrap-docs.ts:300` (bare `consult` spawn). All were added to the inventory
   under Phase 6. Phase 6's completion grep now explicitly spans `apps/` as well as `packages/`,
   including `shell: '/bin/sh'`.

## Claude (APPROVE, four items)

1. **Add/add merge pending with `main` (#1849).** Done (merge `9c300aa11`). I verified that
   `main`'s two files were byte-identical to this branch's Phase 1 commit (same blob hashes), so
   the branch versions are pure descendants and the resolution took them.
2. **Hang criterion: reproduce deliberately.** Done; see Codex 1. Put to the architect.
3. **conhost row (default console host on Windows 10 22H2).** Accepted as a gap. The owner's
   machine is Windows 11, where Windows Terminal is the default host. The conhost row stays open,
   and I'm asking the owner for a one-off run via `conhost.exe powershell`. If none is available
   before Phase 4, it joins the PR-gate pass. It does not affect Phases 2 and 3.
4. **`setHostPlatformForTests` unguarded; override does not cross spawn boundaries.** Guard
   added: it throws unless `isUnderTestRunner()`, matching the repo pattern, with a test. The
   spawn-boundary limit is real and now documented on the function. Behavior of spawned
   processes (shellper, Tower daemon) on Windows is verified by the Windows workflow, not by
   forcing the seam.
