# Phase 7 iteration 1 — rebuttals

Reviews: codex REQUEST_CHANGES, claude COMMENT. Every point accepted; nothing disputed.

## codex 1 — the global setup activates the repository workspace (accepted, fixed)

Right, and worse than "touches the workspace". With only `CODEV_AGENT_FARM_DIR` isolated (the
minimum a test Tower needs while the live Tower runs: the global.db owner lock refuses
otherwise), the default config's global setup activates the repo workspace on the test Tower and
starts an architect shell whose socket goes into `~/.codev/run`, the live Tower's socket dir — an
orphan beside live sessions.

Fix:
- `packages/codev/playwright.decisions.config.ts`: the base config with `testMatch` set to the
  suite and **no global setup**. The suite's workspaces are `mkdtemp` dirs that need no
  activation, so nothing is activated and no shell is started.
- `playwright.config.ts`: `testIgnore` the suite (one exported constant, `DECISIONS_SUITE`, used
  by both configs), so a plain `playwright test` never runs it under the global setup.
- `.github/workflows/dashboard-e2e.yml`: a separate step runs the suite through its config, with
  its own `CODEV_AGENT_FARM_DIR` under `runner.temp` and `if: !cancelled()` so a failure in the
  main suite does not hide it.
- The test header's run command is now the dedicated config plus an isolated
  `CODEV_AGENT_FARM_DIR`.

Evidence: 8/8 through the dedicated config, and the run started **0** shellpers (previously 1,
the global setup's). Collect-only (no webServer, no global setup): the default config lists 71
tests in 11 files with no Decisions test; the dedicated config lists exactly the 8.
`git status --ignored codev/state/` unchanged.

## codex 2 / claude 3 — screenshots not durably recorded (accepted, fixed)

The two screenshots from the dedicated-config run (desktop 1280×720, phone 390×844; 85 KB and
73 KB) are committed at `codev/reviews/1819-tower-a-decisions-tab-a-ui-vie/`, where the review
document (written in the review phase, per the plan) embeds them. Checked by eye.

## claude 1 — uncommitted config and CI changes (accepted)

They were mid-edit for the codex fix while the review ran (the #1649 warning lists my edits). All
of it lands in one commit: config split, `testIgnore`, CI step, header, screenshots.

## claude 2 — the "no tab" title wait assumes no Tower cloud name (accepted, fixed)

The title is `<workspace> on <tower name> overview` on a Tower registered with a cloud name. The
wait is now `^<workspace>( on .+)? overview$`. It still waits on `/api/state`, so the mutation
check from iteration 1 (file created before the page load → Expected 0, Received 1) still holds.

## claude 4 — dashboard-e2e does not run on PRs (informational, acted on)

Correct: it runs on a schedule and on dispatch. I will dispatch it on this branch once it is
pushed and record the result in the review, which is also the plan's acceptance criterion
("passes … in the dashboard-e2e workflow").
