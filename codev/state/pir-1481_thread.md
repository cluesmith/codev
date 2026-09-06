# pir-1481 builder thread

## 2026-09-06 — Plan draft

Started strict PIR for #1481 from `08ec15122` (plus porch init commit). Read builder role, porch/afx skills, hot context, current mailbox architecture, issue comments and #1365 closure. No implementation edits made.

Confirmed the key semantic decision: existing delayed interrupt writes only Ctrl+C and retains the gate; immediate interrupt claim-first writes an ungated body. Plan proposes durable one-shot Ctrl+C followed by gated body, and explicitly requires human selection before coding because this is not a bounded body-delivery guarantee. Separate deadline from `not_before`; independently schedule due actions so terminal contention does not block global alarms. Fix second-operator wait using actual operator completion separate from combined delivery tails.

Read (read-only) #1477 owner-wiring and cleanup-invocation test references. PRs #1625 and #1634 remain open; no sibling work imported. Plan reuses seeded-registry testing pattern independently and requires integration reruns after maintainer landing. Contributor constraint recorded: maintainers merge; builder does not merge, close issues, or clean worktrees. Live Tower 4100 must remain untouched; test only isolated harness-owned instances.

Artifacts share `1481-afx-send-add-interrupt-after-s.md`; plan is the current deliverable, requirements note preserves issue authority. Awaiting human plan review after commit/push and porch completion.

## 2026-09-06 — Human-directed plan revision (no approval)

Architect relayed issue comment 5561508091: human selected existing immediate interrupt behavior after the patience budget (Ctrl+C + fixed settle + ungated body), and authorized PLAN REVISION ONLY. Supersedes the earlier gated-body recommendation. No code changes or gate transitions.

Revised plan shares the immediate writer, arms exact-deadline timers before initial-delivery awaits, and arbitrates same-row ownership inside the terminal write edge. Normal writes retain ownership through DB outcome; successful in-flight delivery cancels force, uncertain partial writes skip force to avoid a second timeout body. Force conditionally claims the original row before bytes, accepting existing loss-over-duplicate crash semantics; logs/inbox/notifications must not imply receipt.

Remaining lifecycle proposal, explicitly unapproved: body/deadline audit durable, force authority current-Tower-lifetime only; restart disarms, offline/unwritable at deadline skips, session replacement while waiting skips rather than late retargeting. Replacement before deadline follows current agent-addressed routing. No indefinite late-force retry. This minimizes surprise but sacrifices force across restart even before deadline; human can choose future-only rearm through another revision.

Will commit/push revised plan + requirements snapshot + this thread and report SHA/path, then remain at existing plan-approval. Maintainer-only merge/no closure/no worktree cleanup constraints unchanged.
