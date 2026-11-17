# air-1828 thread — tell the hub architect when the owner rules from the Decisions tab

## 2026-10-18 — implement

- Hook point: `handleDecisionsRule` (`servers/decisions/routes.ts`), after the write queue
  returns success (the atomic rename has happened) and AFTER the 200 response is sent, so
  the notice can never change or delay what the tab sees. The route takes a `notify` port;
  a throw from it is logged at WARN and swallowed.
- Message text lives in `servers/decisions/notice.ts` (`rulingNotice`): `RULED <id>: <word>`
  then the trimmed comment on following lines; comment-only → `QUESTION <id>:` then the text
  on the following lines (read the issue's `QUESTION <id>:` with nothing after the colon as
  "text on the next lines", matching RULED's comment placement). Line breaks normalized to
  `\n` so no stray `\r` reaches a PTY.
- Delivery: `notifyHubOfRuling` in `tower-routes.ts`, beside `deliverCronMessage` and
  `handleSend`. `enqueueMailbox` → `deliverAgentMailSerialized` → `noteOutcome` — the same
  persist-then-gate sequence as `handleSend`'s normal path. No supersede key: two rulings must
  be two rows.
- Frame: added `formatUserViaDecisionsTabMessage` → `### [USER via Decisions tab → main | ts] ###`,
  modelled on the #1494 VS Code relay. Reusing a pseudo-sender through `formatBuilderMessage`
  (cron's way) would label the owner's word `BUILDER decisions-tab`, the wrong-role defect
  message-format.ts guards against. Row `from_agent` = `decisions-tab`.
- Not touched: the hub's `ddu` scan / file watch (that lives in the hub architect's own
  workflow, not in Tower code).

## 2026-10-18 — PR #1829, CMAP

- codex REQUEST_CHANGES, both real, both fixed:
  - First cut resolved the hub LIVE-first (as `afx send architect` / cron do). With `main`
    registered but offline and a sibling live, the notice went to the sibling. Now the hub is
    chosen from the registry only (`resolveAgentInRegistry('architect')` = `main`, else first
    registered by insertion order) and the mailbox finds its live session by name; an offline
    hub holds `no-live-pty`. Test: offline main + live sibling → one held row for main, sibling
    untouched.
  - Item id and option word come from the file unbounded, so the notice could pass the 48 KB
    send limit. Now refused via `messageLimitError` before anything is persisted (logged).
- claude APPROVE; took two minors: a comment tying `rulingNotice`'s trim/split to
  `spliceRuling`, and WARN (cron's level for an unresolved target) instead of ERROR when the
  hub is not told. Left for the architect: a follow-up for the hub-side half of the owner's
  ruling (stop watching the file) — it lives outside this repo.

## 2026-10-18 — architect integration review, round 1

- (1) codex: `resolveAgentInRegistry`'s "first registered" is alphabetical by id (#1633;
  `getArchitects` is `ORDER BY id`), and my tests mocked the resolver so could not see it.
  Architect decision: NO fallback. `notifyHubOfRuling` now requires `getArchitectByName(ws,
  'main')`; absent → throw → route logs WARN naming the workspace, response untouched. The
  tower-routes test DB mock now aliases `getDb` too (as #1118 does in production), so the hub
  tests seed the REAL registry via `setArchitectByName`. Regression: zeta then alpha registered
  and both live → zero rows, neither written. Mutation with a `getArchitects()[0]` fallback
  fails it.
- (2) INFO log of the outcome: `Decisions notice delivered|held (<reason>) → main @ <ws>`.
- (3) `DECISIONS_TAB_SENDER` moved to codev-types beside `VSCODE_USER_SENDER`;
  `formatMessageForTarget` maps it to `[USER via Decisions tab]` (so an `/api/send` with that
  `from` is never a BUILDER frame), and the notice is framed through `formatMessageForTarget`.
- (4) `handleRequest`'s catch returns once `res.headersSent` — the Decisions route is the first
  to keep awaiting after `res.end()`. Test drives a real post-response throw (a log sink that
  throws on the WARN); mutation without the guard fails it.
