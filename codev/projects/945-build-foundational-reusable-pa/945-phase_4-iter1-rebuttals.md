# Phase 4 — Rebuttal to implement consult iteration 1

**Verdicts:** Codex REQUEST_CHANGES (HIGH); Claude APPROVE (HIGH); Gemini COMMENT (lane skipped).
Codex's single item was **accepted and fixed** (commit pending below).

## Codex — REQUEST_CHANGES (accepted & fixed)

> "`README.md:12-21` tells consumers to `pnpm add @cluesmith/codev-artifact-canvas`, but the repo's
> release protocol explicitly says it is **not independently npm-published in v1** and is consumed
> via `workspace:*`/host bundling instead (`codev/protocols/release/protocol.md:56`)."

**Legitimate — accepted.** The README's Install section contradicted the locked v1 distribution
decision (plan iteration 3/4 + `release/protocol.md`: version-aligned but **not** in the
`pnpm publish` step; consumed via `workspace:*` and bundled by hosts, mirroring
`@cluesmith/codev-core`).

**Fixed:** the Install section now states the package is not independently npm-published in v1 and
shows adding it as a `"@cluesmith/codev-artifact-canvas": "workspace:*"` dependency of a host
package (peers `react`/`react-dom` supplied by the host). No `pnpm add` from npm. The import +
`default-theme.css` snippets are unchanged (correct once it's a workspace dep). Verified the README
no longer contains any `pnpm add`/npm-install guidance. Docs-only change — no code touched; build
33/33 + check-types remain green.

## Claude — APPROVE; Gemini — COMMENT (skipped). No further changes required.

Net: the only iter-1 item (incorrect install guidance) is corrected to match the locked
workspace-consumption / no-independent-publish decision.
