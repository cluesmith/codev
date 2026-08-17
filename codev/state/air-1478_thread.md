# air-1478 — afx send: carry `architect:<name>` through to inbox + composer attribution

Protocol: AIR (strict). Issue #1478 (consolidates #1479). Branch `builder/air-1478`.

## Constraint from the architect (received mid-implement)

We are NOT cluesmith/codev maintainers. Open the PR, address review feedback, then park it for
the maintainer — do **not** merge it myself, even after architect review.

## What the defect actually was

One root cause, three edits:

1. `commands/send.ts:317` — `from = detectCurrentBuilderId() ?? 'architect'` discarded the
   specific architect name at send time, so every architect landed in the mailbox as the
   generic string `architect`.
2. `servers/tower-routes.ts` `formatMessageForTarget` — the `any → builder` branch called
   `formatArchitectMessage(message, undefined, raw)` and dropped `from` entirely. A second,
   independent collapse: even a corrected `from` could not have surfaced in the composer header.
3. `commands/inbox.ts:139` — `fromTo.slice(0, 22)` against a fixed 22-wide column cut long
   builder ids and `architect:<name>` senders mid-name.

## Decisions

- **Carrier is the address form `architect:<name>`**, not a bare name. It is what Tower already
  accepts as an architect address, it stores straight into `mailbox.from_agent`, and it sits
  outside `looksLikeBuilderId`'s heuristic (it early-returns false on anything starting with
  `architect`), so Spec 755 sender-affinity routing and the #1094 anti-spoofing warning behave
  exactly as they did with the generic string. Verified by reading `tower-messages.ts`
  (`resolveAgentInWorkspace`, `resolveArchitectByName`): a non-builder sender yields
  `lookupBuilderSpawningArchitect → undefined`, so no spoofing branch is entered.
- **Header attribution derives from the sender shape, not from the branch.** Only an
  `architect:<name>` sender produces `ARCHITECT:<name>`; a builder → builder send, cron, or an
  unattributed call keeps the historical bare `ARCHITECT` label. Blind interpolation would have
  produced `### [ARCHITECT:builder-spir-109 …]` on builder → builder sends.
- **Raw mode stays unattributed** and the inbox list stays metadata-only (issue's notes,
  Spec 1313 Redaction) — this change is identity + formatting, not body display.
- **Scope held to `send.ts`.** `commands/interrupt.ts:40` and `commands/reset.ts:56` carry the
  same `?? 'architect'` line. The issue says to fix the collapse "once in `send.ts`", so those
  two are deliberately untouched and flagged in the PR body as a possible follow-up rather than
  silently widened.
- Column sized to content (`max(header, widest cell) + 2`) rather than widened to a bigger fixed
  number — a fixed cap is the defect, just further out.

## Verification

- New `__tests__/air-1478-architect-attribution.test.ts`: pure header-label cases plus the REAL
  `/api/send` route driven through the registry hold path (known builder, no live PTY), asserting
  the mailbox row carries both `from_agent = architect:<name>` and the attributed
  `formatted_message`. That path exercises `formatMessageForTarget` without needing a live PTY.
- `send.test.ts`: `getExpectedFrom()` → `architect:main`; new cases for a named architect
  (`CODEV_ARCHITECT_NAME=feedback`) on single-target and `--all`. `beforeEach` now clears
  `CODEV_ARCHITECT_NAME` so the suite is deterministic when the runner inherits a Tower-injected
  env (the builder terminal does).
- `inbox-cli.test.ts`: long FROM → TO rendered in full, one shared width across header/separator/
  rows, never narrower than the header, `?` for a missing sender.

## Environment note

The worktree had no `node_modules` and no `.codev/`. Needed `pnpm install --frozen-lockfile` plus
`pnpm --filter "@cluesmith/codev^..." build` (the `@cluesmith/codev-sdk/*` subpath exports resolve
to built `dist/`, so tests importing `utils/architect-name.ts` fail until the sdk is built).
