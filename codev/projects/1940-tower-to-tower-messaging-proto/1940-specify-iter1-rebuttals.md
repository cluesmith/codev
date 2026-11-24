# Spec 1940 — responses to iteration 1 reviews

Both reviewers asked for changes. Every point was accepted and the spec was revised in commit
`f1fee90e2`; nothing is rebutted. One point (scope) is answered by structure rather than by a
decision, because the decision is the owner's.

## codex

| Point | Response |
|---|---|
| Implementation scope undecided | Changed. Success Criteria now opens by stating which criteria belong to project 1940: under the recommended answer to Open Question 4, the stage 1 criteria are this project's and are sufficient to plan from; stages 2 and 3 are recorded for the follow-up issues. The choice itself stays an open question because the issue says the design is the deliverable and the owner has not said what follows it. It is put to the owner at the spec-approval gate. |
| Builder replies lack a contract | Changed. Decision 4 defines a reply: the builder's own Tower's mailbox holds a message from that sender to that builder. Identity-keyed, not used up, survives restart, lapses with mailbox retention. Tests added. |
| Grant withdrawal semantics conflict | Changed. Decision 4 lists three effects: new mail refused; accepted-but-undelivered mail becomes held for release and the owner may still release or dismiss it (a grant governs what a peer may put in the mailbox, not what the owner does with what is there); mail the peer still holds is refused on its next attempt and ends as refused there. The success criterion was reworded to match. |
| Exactly-once underspecified for never-expiring retries | Changed. Decision 5: each message carries an id and a send time fixed across retries; the dedupe record is the mailbox row and lives as long as it; a duplicate is answered with the first message's current state; the receiver refuses anything older than the retention window as expired, so a retry cannot outlive the record. A sender-held row ends as accepted, refused or dismissed. |
| Human-release boundary not enforceable under local trust | Changed. Decision 4 now says exactly what hold for release protects (the agent, from the remote sender) and what it does not (a local process that already holds the Tower key). Criteria no longer call release a "human act"; they say nothing in Tower releases mail automatically. |
| Body framing too vague | Changed. Decision 7 specifies normalisation (valid UTF-8 or refused; line endings; the exact character classes removed; frame-marker lines altered) and the invariant the tests assert for arbitrary input. |
| Workspace address-name rules incomplete | Changed. Decision 2 gives the rules: effective name, uniqueness, reserved words, explicit outranks basename, ambiguity, change and removal. Tests added. |
| Limits deferred to the plan | Changed. Decision 3 has a limits table: default, who enforces, and the fixed outcome when exceeded, including invitation lifetime and message age. |

## claude

| Point | Response |
|---|---|
| Grammar drops shell addressing | Accepted; verified in the resolver. The grammar's second alternative is now a local id, resolved as today (builders, then shells). Shells are never reachable from another Tower, including my own, because text sent to a shell prompt is a command with no agent in between. This is stricter than the reviewer's suggestion (own Towers only). Tests added. |
| Sender-held mail collides with Spec 1313's drainer and escalation | Accepted. Outbound held mail is its own kind: not attempted by the local drainer, no starved-agent escalation, shown apart in `afx inbox` and the indicator. New stage 2 criterion and test. |
| Transport sentence wrong for the outbound leg | Accepted. Constraints and Decision 3 now describe the two legs: outbound HTTPS from the sending Tower, then the receiving Tower's tunnel. |
| Decision 7 lists three headers where there are four | Accepted. Four cases, with same-workspace explicitly unchanged. |
| Header growth vs the write-path threshold | Accepted as a new constraint and a test. |
| Ordering unspecified | Accepted. In-order per sending Tower and recipient; no order between senders. |
| Current State row 4 says `main` only | Corrected to main, else first registered. |
| Address charset vs architect-name validation | Added: the component rule does not loosen agent naming. |
| Tower-qualified address on a connected Tower before stage 2 | Criterion and test now cover it. |
| Open Question 4's alternative ships nothing | Said so in the question. |

## Process note

The claude review's output carries a "working tree changed" warning. The writer was the builder:
the codex lane finished first and its points were being applied while the claude lane was still
reading. The claude review therefore read the first draft, and its points were checked against the
revised text before being applied.
