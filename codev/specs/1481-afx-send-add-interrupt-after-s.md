# Requirements: Bounded-patience send

Source of truth: GitHub issue #1481 and its architect preflight comments (2026-09-06).

Add an opt-in `afx send --interrupt-after <seconds>` policy that starts ordinary gated delivery immediately, holds while busy, and interrupts only after a bounded wait if the row is still undelivered. Keep ordinary send, force-now `--interrupt`, and delayed eligibility `--delay` distinct. Time-sensitive messages should prefer the new option; urgent messages use `--interrupt`.

Reuse the settled #1365 serialized write edge and address its second-queued-operator starvation corner. Suppress premature starvation alarms for self-resolving rows without hiding other mail. Cover durable state, cancellation, restart/offline/session changes, races and real running terminal behavior.

Human clarification (issue comment 5561508091, 2026-09-06) settles the body contract: after the patience budget, use existing immediate `--interrupt` semantics for the same still-held row—Ctrl+C, existing fixed settle, UNGATED formatted body and Enter unless no-enter. Delivery/dismissal/supersession before the actual force ownership transition cancels escalation. An already-running normal body write must not race a second forced copy. The deadline initiates escalation; it does not guarantee receipt, exact scheduler/lock timing, or exactly-once PTY effects.

The revised plan proposes skipping late force after restart or unavailable/replaced deadline target while preserving the durable ordinary mailbox body. That lifecycle choice remains subject to human plan approval; indefinite durable late interruption is not approved. The human authorized plan revision only, not implementation or a gate transition.

Plan refinement after architect dispositions on Claude review (comment 5561637175): propose waiting for active same-row ownership and its recorded outcome, rather than permanently disarming timeout because of any prior partial write. A still-held uncertain attempt may receive one sequential forced retry; a completed successful normal delivery cancels force. Prior emission uncertainty and possible duplicate effects must be visible. This F3 tradeoff, like lifecycle choices, is proposed for plan approval only. Submission-ceiling expiry alone is not degradation; actual unfinished predecessor work and byte-writing at the edge determine it. Preserve rejection-neutral/no-op operator ordering, nonblocking gated delivery, existing 48-KiB body cap, and exact-once event fanout per transition.
