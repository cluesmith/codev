# task-47B5 — finishing external PR #1618 (Atlas Cloud image provider)

## Context

PR #1618 by @binyangzhu000-sudo (first-time contributor) adds Atlas Cloud as an
optional provider for `codev generate-image`. `maintainerCanModify` is true, so
the architect's 2026-09-04 review is being applied by pushing commits onto the
contributor's branch (`binyangzhu000-sudo:feat/atlascloud-image-provider`)
rather than sending them a list. Their commit and authorship are preserved — no
rebase, no squash, maintainer commits on top.

## What the review asked for

Five MUSTs (skill-doc sync, per-request timeouts, unknown-status fail-fast,
refuse unrecognized download bytes, fast + hardened tests) and two SHOULDs
(`typeof url === 'string'` guard, `ATLASCLOUD_API_KEY` in cloud-instances.md).

## Decisions worth recording

- **Poll ordering left alone.** The obvious way to make the polling tests fast
  was to poll before the first sleep, which would also save users ~5s. Rejected:
  the contributor measured this endpoint and I cannot (no Atlas key). An
  immediate poll risks a 404 on a not-yet-visible prediction, and under the
  repo's fail-fast rule that would be a hard failure on a path with no test
  coverage against the real API. Instead the poll interval became a parameter
  (`generateViaAtlas(..., pollIntervalMs = ATLAS_POLL_INTERVAL_MS)`), which
  tests pass as 0. Nothing but tests passes it.
- **`atlasFetch` helper** wraps all three fetches with `AbortSignal.timeout`
  and turns a `TimeoutError` into the same shaped error message as an HTTP
  failure. The CDN download deliberately passes no init, so the Authorization
  header cannot reach a third-party origin — a test asserts exactly that.
- **`outputs` retyped `unknown[]`** so the `typeof url === 'string'` guard is
  load-bearing rather than decorative.
- **In-progress status allowlist** (`pending`/`queued`/`starting`/`processing`/
  `running`/`in_progress`); anything else, including a missing status, fails
  immediately naming the status.
- **Thread file committed separately** from the review-fix commit so the
  contributor's PR keeps a clean, reviewable diff.

## CMAP round (codex + claude, on the diff)

Both returned substantive findings. Verified each against the file rather than
taking the summary as ground truth; every accepted fix is now locked by a test
that fails when the fix is reverted (checked by mutation, not by assertion).

Accepted:

- **codex: the status allowlist was guessed.** It was. I fetched
  https://www.atlascloud.ai/docs/en/predictions, which documents exactly
  `processing`, `completed`, `failed`. Narrowed the set to `processing` and
  cited the URL in the comment — the repo's "never guess field names" rule cuts
  against my six invented in-progress words.
- **claude: `AbortSignal` protected the connect, not the body read.** The real
  bug, and the same class the fix-up exists to close: `.json()` on an HTML error
  page threw a raw `SyntaxError`, and an abort landing on `.arrayBuffer()` threw
  a raw `TimeoutError` — zero `console.error`, zero `process.exit`. `atlasFetch`
  became `atlasRequest`, which owns connect + stream + parse under one deadline.
  Two new tests cover both paths.
- **claude: bypassing `generateImage` lost dispatch coverage.** An `output`/
  `aspect` swap would have gone unnoticed. Added one test through `generateImage`
  under fake timers, so the real 5s cadence costs nothing.
- **claude: the credential test had a `Headers` blind spot** — a `Headers`
  instance serialises to `{}`, so both assertions would have passed while the
  key leaked. Now read via `new Headers(...).get('authorization')`.
- **codex: the abort-signal test was vacuous** — it passed for any
  `AbortSignal`, including a controller signal that never fires. Now spies on
  `AbortSignal.timeout` and asserts 30s/30s/120s.
- **codex: the prediction id trusted an unchecked cast.** Same `typeof` guard
  the architect asked for on `outputs[0]`.
- **codex: deadline checked before the sleep**, so a budget that expired
  mid-sleep still bought one more request. Moved after; the test asserts zero
  polls.
- **codex + claude: SKILL frontmatter** still said only GEMINI/GOOGLE were
  required. Fixed in all four, re-verified byte-identical.
- **claude: `--ref` rejection sat behind the key check**, so `-p atlas --ref x`
  without a key named the wrong problem. Reordered.
- **claude: `withDetectedExtension` no longer described what it does** now that
  it exits. Renamed `targetPathForImageBytes`.

Declined, and why:

- **codex: make `-r 2K/4K` a hard failure on the atlas path.** Defensible under
  fail-fast, but it changes behaviour the contributor designed deliberately and
  the architect reviewed and accepted, and it is in neither the MUSTs nor the
  SHOULDs. Not a maintainer's call to make silently on someone else's PR —
  flagged to the architect instead.
- **claude: require `https:` on the download URL.** The URL comes from an
  authenticated TLS response and the bytes are magic-byte validated before any
  write. Adds a failure mode on a path I cannot test for little gain.
- **codex: clamp each request's signal to the remaining overall budget.** Would
  abort legitimate in-flight requests near the deadline. Worst case is now
  deadline + one request timeout, which the comment states.

## Verification

- `pnpm --filter @cluesmith/codev build` — clean; `tsc --noEmit` — clean.
- generate-image file: 35 tests, 181ms (was 19 tests, ~10s).
- Full package suite: 278 files, 5571 passed, 0 failed.
- Note for anyone repeating this: `npx vitest run` at the *repo root* reports
  ~367 failures. That is the wrong invocation — it bypasses the package config
  and setup files. The real suite is `vitest run` from `packages/codev`.

## Status

See the PR for the final CI state; fork PRs need maintainer approval before
workflows run.
