# Requirements: Bounded-patience send

Source of truth: GitHub issue #1481 and its architect preflight comments (2026-09-06).

Add an opt-in `afx send --interrupt-after <seconds>` policy that starts ordinary gated delivery immediately, holds while busy, and interrupts only after a bounded wait if the row is still undelivered. Keep ordinary send, force-now `--interrupt`, and delayed eligibility `--delay` distinct. Time-sensitive messages should prefer the new option; urgent messages use `--interrupt`.

Reuse the settled #1365 serialized write edge and address its second-queued-operator starvation corner. Suppress premature starvation alarms for self-resolving rows without hiding other mail. Cover durable state, cancellation, restart/offline/session changes, races and real running terminal behavior.

The issue uses both “force-deliver” and delayed Ctrl+C-with-gated-body language. These are not equivalent. The companion plan proposes the latter and explicitly reserves the decision for human plan approval; no implementation or approval is implied by this document.
