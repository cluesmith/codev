# bugfix-1935 thread

## Investigate (2026-11-20)
- Reproduced from CI logs: run 44264876229 (2026-11-18) ran on `Image: ubuntu-24.04`; run 44485513618 (2026-11-19) ran on `Image: ubuntu-26.04` (20261111.196.1). Install step: `Error: ERROR: Playwright does not support chromium on ubuntu26.04-x64`, exit 1.
- Lockfile resolves playwright/playwright-core 1.59.1. Checked playwright-core tarballs: 1.60.0 has no ubuntu26.04 entry; 1.61.0+ (through latest 1.65.1) do. So a Playwright bump is a real alternative, but it is a dependency + browser-revision jump; pinning the runner is the minimal, deterministic fix.
- Correction to the issue text: the install step DID fail its own step (bash -e, exit 1), and "Run Playwright tests" was skipped. The launch-error noise came from "Run Decisions tab tests", whose `if: ${{ !cancelled() }}` (meant to run it even if the main suite fails) also runs it after the browser install failed. Fix: gate it on the install step's outcome too.
- Other ubuntu-latest workflows (e2e, post-release-e2e, sdk-canary) do not use Playwright: out of scope.

## Fix (2026-11-20)
- Pinned dashboard-e2e `playwright`, test.yml `canvas-browser` and `web-browser` to `ubuntu-24.04` with a #1935 comment; Decisions tab step now also requires `steps.install-browsers.outcome == 'success'`.
- Regression test `bugfix-1935-playwright-runner-pin.test.ts` scans every workflow for jobs that run `playwright install`; 4 assertions fail on HEAD's workflows, pass with the fix.
- Adjacent fix: `protocol-drift-audit.test.ts` offline-lookup test failed deterministically on this machine because a user `~/.npmrc` `@cluesmith:registry=` outranks `npm_config_registry`; the test now overrides the scoped key too.

## PR (2026-11-20)
- PR #1936. Dashboard E2E dispatched on the branch (run 44718205786): all steps green on ubuntu-24.04. canvas-browser + web-browser green on the PR.
- CMAP: gemini skipped (agy exit 1); codex REQUEST_CHANGES only over porch-authored `chore(porch):` commit prefixes (not rewritten, porch owns those); claude APPROVE (test-header escape-hatch nit addressed).
- Suggested follow-up for the architect: bump Playwright >=1.61 and unpin before ubuntu-24.04 retires.
