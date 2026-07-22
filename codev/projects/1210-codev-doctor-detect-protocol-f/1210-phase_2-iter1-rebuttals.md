# Phase 2 (implement) iteration 1 — Rebuttals

**Verdicts**: gemini APPROVE · claude APPROVE · codex REQUEST_CHANGES

Both Codex points are valid and trace directly to the spec. Accepted and fixed.

## Codex — Issue 1 (blocking): differs warning omits the skeleton package version

> The `differs` warning does not include the installed skeleton/package version. The spec's success
> criteria explicitly require the adjudication warning to name the file **and** the skeleton package
> version, but current output only says "differs from installed skeleton."

**Accepted — fixed.** `formatDriftFinding(f, skeletonVersion?)` now takes an optional version and
renders it: `... — differs from installed skeleton v3.2.3; customized or stale? — adjudicate ...`.
doctor passes `staleness.installed` (the skeleton version IS the installed package version — the
skeleton ships inside the package, and staleness already resolved it, so no extra lookup). The
`warningDetails` entry now includes `v${skeletonVersion}` too. Verified in a real run against this
repo's overrides.

## Codex — Issue 2 (blocking): misleading header in the staleness-only path

> When there are no shadows but the package is behind, the section still opens with
> "Framework Drift (local copies shadowing the installed skeleton)". That parenthetical is false in
> the staleness-only path and will mislead users.

**Accepted — fixed.** The header subtitle is now computed from what's actually present:
- shadows present → `(local copies shadowing the installed skeleton)`
- staleness-only (no shadows, skeleton behind) → `(installed skeleton is behind npm latest)`

So the parenthetical is always accurate. (When both are true, the shadowing subtitle is correct and
the staleness warning is an additional line under it.)

`tsc --noEmit` clean; `npm run build` green after both changes.

## gemini / claude
Both APPROVE, no changes requested.
