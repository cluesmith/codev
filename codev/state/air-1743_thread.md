# Builder air-1743 — #1743 vscode: codev.buildersClickExpands

## Task
AIR. Add a boolean setting `codev.buildersClickExpands` (default `true`, behavior
unchanged) that gates whether a single click on a builder row expands the row (the
changed-files list) in addition to opening the terminal. When off, the click only
opens the terminal; the chevron still toggles expand/collapse.

## Lane brief (architect:vscode)
- Fence: pir-1566 (unmerged) owns views/tower*.ts, workspace-label.ts, fleet-order.ts,
  attention-format.ts, switch-workspace.ts, icons/tower.svg. My change touches none of
  those — confined to package.json, extension.ts, views/builders.ts.
- pr gate is the owner's. Freeze branch at pr time, report head SHA + test + CI, wait
  for relayed approval. Never infer approval from silence.

## What I did (implement phase)
- `apps/vscode/package.json`: new `codev.buildersClickExpands` boolean (default true),
  placed next to buildersAutoCollapse / buildersAutoReveal, same-voice description.
- `apps/vscode/src/extension.ts`: `codev.openBuilderRow` handler reads the setting at
  click time (like buildersAutoReveal) and delegates to the extracted decision core.
- `apps/vscode/src/views/builders.ts`: added `runBuilderRowClick(clickExpands, effects)`
  next to `AccordionGate` — the testable decision core (always open terminal; expand
  only when on; swallow benign reveal errors). Also updated the row `item.command`
  comment (issue's explicit ask) so it no longer claims the click always expands.
- Extracted the handler body into `runBuilderRowClick` so the on/off branch is
  unit-testable without activating the extension — same pattern as `AccordionGate` /
  `decideApprovalRelay`. The inline handler stays a thin wrapper.
- New test `apps/vscode/src/__tests__/builders-click-expands.test.ts`: on/off branch,
  terminal-first order, benign-error swallow, and accordion-orthogonality (the chevron
  → onDidExpandElement → AccordionGate path is independent of the click setting).

## Decisions / notes
- Effect types on `BuilderRowClickEffects` are `() => unknown` / `() => PromiseLike<unknown>`
  because `openBuilderByRoleOrId` returns `Promise<string|undefined>` and `reveal`
  returns `Thenable<void>`; `runBuilderRowClick` only awaits them.
- `codev.openBuilderById` (terminal-link clicks) left as-is — it never expanded.

## Verification (from worktree apps/vscode)
- `pnpm build` (workspace) — needed first: codev-sdk subpath imports fail in vitest
  otherwise (build-prerequisite artifact).
- check-types: clean. lint: clean.
- Full unit suite: 84 files, 1030 tests passed. New + accordion tests green.

## Status
Implementation + tests complete and green. Next: commit, porch done, open PR with
review in the PR body, request pr gate via architect:vscode.
