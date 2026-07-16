# PIR #855 — Rebuttal to iteration-1 consultation

**Verdicts:** Claude = APPROVE (HIGH, no issues). Codex = REQUEST_CHANGES (HIGH, 3 findings).

All three Codex findings were **legitimate and accepted**. None were rebutted. Dispositions below.

---

## Codex #1 — `apps/vscode` compile/typecheck path was never verified (ACCEPTED, fixed)

**Finding:** CI runs only `pnpm test:unit` for `apps/vscode`; that Vitest config uses
esbuild and mocks `vscode`, so it does not run the tsconfig project chain. Root
`pnpm build` excludes vscode entirely. So the `extends → ../../packages/config/tsconfig.base.json`
fix — the exact risk the plan flagged — was never actually proven from the new location.

**Assessment:** Correct, and the most important finding. My earlier "vscode 643 tests pass"
did **not** prove the tsconfig extends fix, because vitest transpiles with esbuild and does
not typecheck via the tsconfig `extends` chain.

**Disposition — verified + guarded (no code fix needed):**
- Ran `pnpm --filter codev-vscode check-types` → `tsc --noEmit && tsc --noEmit -p tsconfig.webview.json`, **exit 0**. This directly exercises the `extends` chain from `apps/vscode`.
- Ran `pnpm --filter codev-vscode compile` (check-types + lint + esbuild bundle) → green; both esbuild entry points build from the new location.
- The code was therefore correct; the gap was purely *verification*. To prevent regression, added a **`check-types` step to the vscode CI job** (`.github/workflows/test.yml`) — CI now typechecks the extension, which it previously never did.

## Codex #2 — Review's "How to Test Locally" gave misleading commands (ACCEPTED, fixed)

**Finding:** The review told the human to run `pnpm install && pnpm build && pnpm test`,
but root `pnpm test` runs only `--filter @cluesmith/codev`, and `pnpm build` doesn't build
`apps/vscode` — so those commands skip the moved suites and the vscode compile path.

**Assessment:** Correct.

**Disposition — fixed:** The review's "How to Test Locally" now lists per-package commands
(`--filter @cluesmith/codev-web test`, `--filter codev-vscode check-types && test:unit`,
`--filter @cluesmith/codev test`) and explicitly calls out `check-types` as the real proof
of the tsconfig fix, with a note that root `pnpm test`/`build` don't cover the apps.

## Codex #3 — `arch.md` vscode Marketplace name inaccurate (ACCEPTED, fixed)

**Finding:** `arch.md` table cell read `` `codev` (Marketplace) `` but the actual package/
extension identifiers are `codev-vscode` / `cluesmith.codev-vscode`.

**Assessment:** Correct — a pre-existing inaccuracy, but this PR edits that exact row and
the tree elsewhere already says `cluesmith.codev-vscode`, so the table was internally
inconsistent.

**Disposition — fixed:** Corrected the cell to `` `codev-vscode` (Marketplace: `cluesmith.codev-vscode`) ``.

---

## Note on PIR single-pass

Per PIR's `max_iterations: 1`, these fixes are **not** independently re-reviewed by the
consultation. The human at the `pr` gate is the remaining check. All fixes are in commit
`4aaa2f68` (pushed to the PR). Nothing was rebutted-without-change.
