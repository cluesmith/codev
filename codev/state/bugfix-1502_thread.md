# bugfix-1502 — CI: Artifact-Canvas Browser Tests hangs indefinitely

## Investigate phase

### What the issue + architect direction establish (verified against artifacts)
- Stalling step is **`Install Playwright Chromium`** (`.github/workflows/test.yml:134-136`,
  `pnpm exec playwright install --with-deps chromium`). The `Run artifact-canvas browser tests`
  step never starts. Confirmed via job step state on two hung runs (issue comments).
- **Zero `timeout-minutes`** anywhere in `.github/workflows/` (grepped all 5 workflow files).
  GitHub's 6-hour default applies, which is why a stalled step reads as "running for hours".
- Intermittent: run `32095039750` (pir-1498) passed the same job in **3m58s** while
  `32093117702` (pir-1497) and `32085216485` (main #1493 merge) never finished.
- Healthy duration reaches at least **3m58s**; the old "~1m09s baseline" is wrong — do NOT
  size the timeout off it.
- **Ruled out** (architect): playwright.config.ts webServer / `--strictPort 5199`. Tests never
  start, so the webServer is never invoked.

### Actions taken
- Cancelled both hung runs (32093117702, 32085216485) — authorized by architect — to retrieve
  the partial `Install Playwright Chromium` log (in-progress jobs return BlobNotFound).
- Polling for both to conclude, then will fetch the job log.

### Required fix
- Add `timeout-minutes` to the `Artifact-Canvas Browser Tests` job, sized off healthy durations
  (~4 min) with headroom. Converts a silent multi-hour stall into a fast visible failure.
- Consider bounding the other jobs in test.yml too — argue either way in the PR.

### ROOT CAUSE — confirmed from cancelled-run logs
Both hung runs stalled at the **identical point** inside `Install Playwright Chromium`:
the `apt-get update` that `playwright install --with-deps` runs to install Chromium's
system libs.

- pir-1497 (95579121785): last line `Get:7 https://archive.ubuntu.com/ubuntu noble-security
  InRelease` at 02:50:02Z, then NOTHING until the cancel at 03:54:38Z (~64 min of silence).
- main (95556232101): last line `Get:7 https://archive.ubuntu.com/ubuntu noble-security
  InRelease` at 00:38:23Z, then NOTHING until cancel at 03:54:39Z (~3h of silence).

Signature: the runner's fast `azure.archive.ubuntu.com` mirror is `Ign`-ored (unreachable),
forcing fallback to public `archive.ubuntu.com`. The index fetch there stalls indefinitely.
apt has no default network timeout on this fetch, and there is no `timeout-minutes` on the
step/job/workflow, so GitHub's 6h default lets it pend for hours. Intermittent because it
depends on that transient mirror/network condition.

Narrowest supported claim: **the apt index-fetch phase of `--with-deps` stalls**. The tests
never start (webServer/strictPort ruled out, correctly).

### Fix decision (minimal, BUGFIX scope)
- **Required + guaranteed**: add `timeout-minutes` to the canvas-browser job (healthy job
  ~4min → bound 15, ~3.7x headroom). Converts silent multi-hour stall → fast visible failure.
- **Defense in depth**: add bounds to the other 4 jobs too (all healthy 1–3min → 10min).
  Argue in PR; a workflow with zero timeouts is one hiccup from the same stall.
- **NOT doing** (argue in PR): dropping `--with-deps` (risks browser-launch breakage; the
  intermittent hang can't be cheaply CI-verified away — trades a mitigated hang for a possible
  breakage); caching `~/.cache/ms-playwright` (does NOT skip the apt phase, so wouldn't fix
  THIS stall — it only removes the browser-binary download).

### Regression test
Parse `.github/workflows/test.yml` with `js-yaml` (already a codev dep) and assert each job
carries a numeric `timeout-minutes`. Fails on current main (zero timeouts), passes with fix.
Precedent: `packages/codev/src/__tests__/bugfix-566-dashboard-e2e-gh-token.test.ts`.

Scope: 1 YAML edit + 1 test file. Well under 300 LOC. Fits BUGFIX.

## PR phase
- PR #1507 opened. Fixes #1502.
- CMAP (3-way, --issue 1502 needed to disambiguate from builder context):
  - gemini = APPROVE (HIGH, no issues)
  - codex  = COMMENT (HIGH) — nit: PR body said "four node-only jobs = 10" but `unit` is 15.
             Fixed the PR body (description-only, no re-run needed).
  - claude = APPROVE (HIGH). Non-blocking: other workflows (dashboard-e2e, e2e,
             post-release-e2e, sdk-canary) remain unbounded — candidate follow-up issue to
             raise with the architect (not self-filing, per scope discipline).
- No REQUEST_CHANGES; the one actionable item (PR-body accuracy) is addressed.
- Handing off at the pr gate; waiting for architect approval before merge.

## Gate status
- Architect posted integration-review APPROVE on PR #1507 (verified claims against artifacts).
- Other-workflows unbounded gap filed by architect as #1509 (not folded into this PR).
- Architect explicit: the pr gate is the OWNER's, not the architect's. Integration APPROVE is
  NOT merge authorization. Holding at the pr gate; will not run `porch approve` or merge until
  the owner gives the word, then follow the merge task from `porch next`.
