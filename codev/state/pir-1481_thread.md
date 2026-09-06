# pir-1481 builder thread

## 2026-09-06 — Plan draft

Started strict PIR for #1481 from `08ec15122` (plus porch init commit). Read builder role, porch/afx skills, hot context, current mailbox architecture, issue comments and #1365 closure. No implementation edits made.

Confirmed the key semantic decision: existing delayed interrupt writes only Ctrl+C and retains the gate; immediate interrupt claim-first writes an ungated body. Plan proposes durable one-shot Ctrl+C followed by gated body, and explicitly requires human selection before coding because this is not a bounded body-delivery guarantee. Separate deadline from `not_before`; independently schedule due actions so terminal contention does not block global alarms. Fix second-operator wait using actual operator completion separate from combined delivery tails.

Read (read-only) #1477 owner-wiring and cleanup-invocation test references. PRs #1625 and #1634 remain open; no sibling work imported. Plan reuses seeded-registry testing pattern independently and requires integration reruns after maintainer landing. Contributor constraint recorded: maintainers merge; builder does not merge, close issues, or clean worktrees. Live Tower 4100 must remain untouched; test only isolated harness-owned instances.

Artifacts share `1481-afx-send-add-interrupt-after-s.md`; plan is the current deliverable, requirements note preserves issue authority. Awaiting human plan review after commit/push and porch completion.
