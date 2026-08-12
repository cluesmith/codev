# Phase 3 (Canvas remote command seam) — Iteration 2 Rebuttals

Verdicts: gemini APPROVE · codex REQUEST_CHANGES · claude REQUEST_CHANGES.

Both findings accepted and fixed. Nothing disputed. The first one is a process failure on my
part rather than a design disagreement, so it is worth naming plainly.

## 1. (Blocking, both reviewers) `check-types` fails on the new Playwright spec

Accepted. Verified immediately:

```
playwright/remote-commands.spec.ts(15,50): error TS2339:
  Property '__canvasCommand' does not exist on type 'Window & typeof globalThis'.
```

**Cause.** The dev page declares the global in `examples/main.tsx`, but this package's tsconfig
includes `src`, `playwright` and the config files — **not** `examples`. So the augmentation that
makes the dev page compile is invisible to the specs that use it.

**How it escaped me.** I ran `check-types` while wiring the seam, then added
`playwright/remote-commands.spec.ts` afterwards to close codex's browser-coverage gap, and
re-ran only the unit and browser suites. Both passed, because Playwright transpiles per-file
without project-wide type checking. So the phase's own acceptance criterion was failing while
every signal I was looking at stayed green. The lesson is narrow and mechanical: `check-types`
belongs *after* the last file is added, not after the last logic change. Recorded in the thread
log.

**Fix.** `playwright/window-command.d.ts` mirrors the augmentation for the compilation unit that
actually type-checks the specs, with a comment explaining why the declaration exists twice. The
`as never` cast in the spec is gone now that the type is real, and `send()` takes a
`CanvasCommand` instead of a bare string, so a typo in a command name is a compile error rather
than a silent no-op at runtime.

## 2. (Codex) The scrolled clean-state origin case is still untested

Accepted; the earlier coverage only exercised an unscrolled view, which tests the weaker half of
the rule. The origin rule has two halves and jsdom can only prove one, since it reports no
layout: "nothing focused, nothing scrolled → start at the top" is checkable there, but "scrolled
but never focused → start from what the reviewer is *looking at*" needs real geometry.

Added to the browser suite: scroll halfway into the columns fixture without touching focus,
assert the topmost visible block is genuinely not the document's first block (so the scroll
took effect and the test cannot pass vacuously), then send `block-next` and assert it stepped on
from the visible block rather than from the document start.

## Gemini (APPROVE)

No issues raised; no changes required.

## Verification after the fixes

- `pnpm --filter @cluesmith/codev-artifact-canvas check-types`: passes.
- Repo-wide `pnpm -r check-types`: clean.
- 173/173 unit tests.
- 39/39 Playwright, including the new scrolled-origin case.
