# Phase 1 (Command vocabulary wire contracts) — Iteration 1 Rebuttals

Verdicts: gemini APPROVE · codex APPROVE · claude REQUEST_CHANGES.

One issue raised, accepted in full and fixed. It is a good catch of the kind that is easy to
miss precisely because everything looked green locally.

## Claude: the exhaustiveness guard never runs in CI

**Accepted and fixed.** Verified independently before acting rather than trusting the review:
`.github/workflows/test.yml` builds `packages/types` (the "Build types package" step) but no
job in any of the five workflows invokes `check-types:tests`, and there is no recursive
`pnpm -r check-types` or `pnpm -r test` anywhere. `check-types` appears only for
`apps/vscode`, `apps/streamdeck`, and in `sdk-canary.yml`.

The consequence is exactly as described, and it is worse than a missing test. The guard is
this phase's *entire* verification story: `@cluesmith/codev-types` ships no test runner, so
compile-time checking is all there is, and the guard's whole reason to exist is to fail a
build when someone adds a 15th command without classifying it as traversal or not. Living
outside `src/` is what keeps it from being published, and it is also what keeps `pnpm build`
from ever compiling it. Unwired, it would have protected nothing while looking like
protection, and since no later phase touches this package's CI, it would have stayed that way.

Fix applied in `.github/workflows/test.yml`, immediately after the types build:

```yaml
      - name: Type-check types package contracts
        working-directory: packages/types
        run: pnpm check-types:tests
```

with a comment recording why the step is needed (guards live outside `src/`, so the build does
not reach them, and the package has no test runner). Verified by running the exact command
from the exact working directory the step uses.

I treated this as in scope for phase 1 rather than deferring it: wiring the guard to run is
finishing the deliverable, not adding a new one. A guard that cannot fail a build is not a
guard.

## Claude's non-blocking notes

All three were correct, and none needs action in this phase:

- **`SSEEventType` does not list `canvas-command`.** Confirmed, and it does not list the
  existing `command` event either, so the omission is consistent with precedent. If event-name
  registration turns out to matter it belongs with the Tower work in phase 4, not here.
- **The heartbeat sub-route exists only in prose on `CanvasViewHeartbeat`.** Deliberate for a
  contracts phase; phase 4 pins the concrete path when it implements the route family.
- **`CanvasViewRegistrationResult` returns a canonicalized `file` but not a canonicalized
  `workspace`.** Harmless today, since hosts key off `viewId` after registering and Tower
  canonicalizes `workspace` on every command. Noted for phase 4 so it is a decision there
  rather than a surprise.

## Gemini, Codex (APPROVE)

No issues raised; no changes required.
