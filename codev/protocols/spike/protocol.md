# SPIKE Protocol

A time-boxed feasibility investigation that answers one question: **can this be done, and at
what cost?** The deliverable is findings, not shipped code.

Use it before committing to a SPIR project whose feasibility is genuinely unknown — an unfamiliar
library, an unproven integration, a performance question that argument cannot settle.

## The state machine

```json
{{> protocols/spike/protocol.json}}
```

## Proof-of-concept code

Throwaway by design. It exists to answer the question, and it is not held to production
standards — but it must not be quietly promoted into production later either. If the answer is
"feasible", a SPIR project builds the real thing.

## Outcomes

| Verdict | What the findings must contain |
|---|---|
| **Feasible** | Recommended approach and rough cost, enough for the architect to decide on a SPIR project |
| **Not feasible** | Why, what was tried, and what alternatives exist — this is what stops the investigation being repeated in six months |
| **Feasible with caveats** | The conditions, risks and trade-offs that make it conditional |

A negative result is a successful spike. The failure mode is an inconclusive one: time spent,
nothing recorded, question still open.

Notify the architect with the verdict when done.

## Findings

Write findings using this structure:

{{> protocols/spike/templates/findings.md}}

## Git

```
[Spike 462] Research: WebSocket library comparison
[Spike 462] Findings: WebSockets feasible for real-time updates
```
