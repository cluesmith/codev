# Rebuttal — PR / Review, iteration 1

Verdicts: Gemini APPROVE, Codex REQUEST_CHANGES, Claude REQUEST_CHANGES.

## Blocking (both)
- **Branch 651 commits behind `main`, merge conflict** (Codex, Claude) → **Addressed**: merged `origin/main` (auto-merged extension.ts/package.json/arch.md; resolved the `lessons-learned.md` UI/UX conflict keeping both #1049 and main's Stream Deck entries). Verified my integration survived (provider registration, manifest webview view, placeholder retirement) and re-ran: check-types + eslint clean, esbuild builds, **80 files / 958 tests pass** (main added tests too).

## Claude
- **Stale `arch.md` bullet describing `panelContainerEmpty`/placeholder as live + "panel views are plain TreeDataProviders"** → **Addressed**: rewrote it — the panel now hosts `codev.dev` (tree) + `codev.contextualPanel` (webview-view, #1049); the placeholder + gate were retired by #1049; #813/#814/#815 rescoped to render into the panel.
- **Review claimed lessons routed to "UI/UX + Testing" but only UI/UX written** → **Addressed**: added the pure-core/host-adapter testing lesson to `lessons-learned.md` `## Testing`.
- **Nit: `void`-prefixed postMessage** → **Addressed**: bare call (matches preview-provider / backlog-search convention).
- **Nit: `pills.ts isModeKind` non-exhaustive** → **Addressed**: `MODE_LABELS` is the exhaustive `Record<ModeKind,string>`; `MODE_ORDER`/`isModeKind` derive from it (a 5th mode fails to compile), matching resolver.ts.
- **Nit: no `onDidDispose`** → **Addressed**: the provider clears `this.view` on `onDidDispose`.

## Codex
- **Dev/UI walkthrough pending** → **N/A here (human gate)**: the contextual "feel" is the dev-approval gate, verified live by the human; not evaluable from a diff. Flagged to the architect.
- **Spec/plan lack approval frontmatter** → **Addressed**: added `approved: 2026-08-24` / `validated: [gemini, codex, claude]` to both (reflects the human-approved gates + cmap validation).
- **Untracked project artifacts** → **Addressed**: committed the porch context/rebuttal files to the branch.
- **Unit exec blocked by sandbox EPERM** → **N/A**: environment sandbox on the reviewer's side; the suite passes here (958) and in CI (`test.yml` builds deps first).

## Result
check-types (both tsconfigs) + eslint + esbuild + 80 files / 958 tests all clean on the merged branch.
