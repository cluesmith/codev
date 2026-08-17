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

## Review round 1 (CMAP + architect integration review)

CMAP: **gemini APPROVE** (HIGH, no issues — independently confirmed the routing-safety
reasoning), **codex COMMENT** (HIGH, no functional or security defects; flagged the 263-line
standalone route-test file as a duplicated harness), **claude COMMENT** (HIGH, verified green
itself, four items). The architect's integration review (REQUEST_CHANGES) independently landed on
the same two defects claude found — good signal that they were real.

Fixed, all four:

1. **`BUILDER architect:main`** — `formatMessageForTarget`'s architect-target branch fed my
   corrected sender into `formatBuilderMessage`'s hardcoded `BUILDER ` prefix. New
   `senderHeaderLabel()` derives the label from the sender's *shape*: `ARCHITECT[:<name>]` for an
   architect (including the bare `architect`/`arch`, which also read as BUILDER before), else
   `BUILDER <id>`. My original design already said "attribution follows the sender's shape, not
   the branch" — I applied it to one branch and not the other.
2. **Header framing injection** — `from` comes from a POST body. `architectHeaderLabel` now
   validates against `ARCHITECT_NAME_PATTERN` rather than trimming. Note `validateArchitectName`
   is unusable here: it rejects the reserved `main`, the most common real sender.
3. **The fallback decision reversed.** I had `architect:main` when `CODEV_ARCHITECT_NAME` is
   absent. Evidence changed my mind: Tower injects the var into *every* architect terminal it
   starts, `main` included (`tower-instances.ts:584`, and `tower-terminals.ts:692` re-injects
   `role_id || 'main'` on shellper restart). So absent ≠ "main", it means "not an architect
   terminal". Asserting `main` there converts honest ambiguity into a specific false attribution —
   exactly #1094's laundering rule. Bare `architect` for those; every real terminal keeps its name.
4. **`interrupt.ts` / `reset.ts`** folded in after all. Their own file comments claim sender
   identity is "reused verbatim from `afx send`", so leaving them on the literal made that claim
   false and put one architect under two identities in the surface this PR exists to fix. Both
   comments now name the shared functions so the claim is checkable.

Also took codex's consolidation: the four route-level tests moved into `tower-routes.test.ts`'s
existing `POST /api/send` block (real in-memory `global.db`, `message-format` unmocked), which
deleted ~90 lines of duplicated mock preamble. Net −152 lines, same coverage.

## Review round 2

CMAP: **gemini APPROVE** (no issues), **codex COMMENT** (two items), **claude APPROVE** (four
non-blocking items). All six addressed:

- codex was right that my PR body understated the framing-injection hole: it is *not* limited to
  crafted builder ids. A sender that only *looks* architect-shaped (`architect:x] ###…`) fails name
  validation and lands in `senderHeaderLabel`'s builder branch, which interpolated verbatim. Closed
  at the chokepoint (`SAFE_SENDER_ID`, degrading to `BUILDER <unknown>`) — the hole predates the PR
  on the builder → architect path, but the chokepoint is where it belongs.
- claude caught that my `interrupt`/`reset` change was **unasserted** — both suites mock
  `architectSenderId`, so a revert would have stayed green. Now pinned in both (end-to-end `from`
  for interrupt; the helper call for reset, whose `from` reaches a port the mocked `runReset` never
  invokes).
- Case-insensitive prefix match, to follow `parseAddress`; the name stays lowercase-validated.
- Doc clause on the `FROM → TO` row, mirrored in both trees.
- Recorded in the PR the *symmetric* limit of my own fallback argument: "env present" doesn't prove
  an architect terminal either (a Tower-spawned process can inherit Tower's own var), so a builder
  shell outside its worktree now sends a *named* false architect instead of an anonymous one.
  Display-only, no worse in kind — but honest to state rather than let the reasoning look airtight.

## Verification notes worth carrying forward

- **The AIR protocol's `e2e_tests` check is a no-op**: `npm run test:e2e … || echo 'e2e tests
  skipped (not configured)'` cannot fail, and from the repo root there is no `test:e2e` script, so
  it passed in 0.1s having run nothing. Don't read a green `porch check` as e2e coverage.
- I ran the e2e test that actually covers this change instead — `send-integration.e2e.test.ts`
  (POST /api/send → `/ws/messages`), which spawns its **own** Tower on port 14600: 7 passed. I did
  NOT run the full e2e suite: its harness defaults to port 4100, the live Tower hosting this
  workspace's architect and builders, and stopping that needs human permission.
- One full-suite run showed a single failure I could not name (that run's stderr was discarded);
  three consecutive full runs before and after are green at 4884. Reported as an unidentified
  transient, not as a clean sweep. Nothing in the files this PR touches failed in any targeted run.

## Outcome

Protocol complete. PR **#1486** is open and **deliberately unmerged** — we are not cluesmith/codev
maintainers on this project, so the merge is the maintainer's, not the architect's or mine. The pr
gate was approved by the human (relayed via the architect) after two CMAP rounds and one architect
integration review.

The `e2e_tests` no-op I hit during verification is now tracked as **issue #1488** — it affects AIR,
SPIR and ASPIR in both trees, so any builder reading a green `porch check` as e2e coverage is being
misled until that lands.

## Environment note

The worktree had no `node_modules` and no `.codev/`. Needed `pnpm install --frozen-lockfile` plus
`pnpm --filter "@cluesmith/codev^..." build` (the `@cluesmith/codev-sdk/*` subpath exports resolve
to built `dist/`, so tests importing `utils/architect-name.ts` fail until the sdk is built).
