# RESEARCH Protocol

Scope → Investigate → Synthesize → Critique. Multiple models investigate the same question
independently, their findings are synthesized, and the synthesis is adversarially critiqued
before it is trusted. **The state machine below is authoritative on which models actually
run** — the set can be smaller than the ideal when a provider's consult lane is unavailable
(it is currently `["codex"]` for investigation, the agy/Gemini and hermes lanes being degraded).

Use it for competitive and technology analysis, "state of X" questions, and architectural
decision support in an unfamiliar domain — cases where a single model's confident answer is
exactly the failure mode.

## The state machine

```json
{{> protocols/research/protocol.json}}
```

## Output

`codev/research/<topic>.md` — the report, with its sources and its disagreements preserved.

## Phases

**Scope** — write the research brief: the question, why it matters, what would count as an
answer, and what is out of scope. Gated by `scope-approval`, because a badly framed question
wastes the investigation's compute and produces a confident answer to the wrong thing.

**Investigate** — the configured models (see the state machine) work the question
**independently**. Independence is the point: cross-contaminated investigations converge on a
shared error, so where more than one model is available each researches without seeing the others.

**Synthesize** — merge findings and, critically, **preserve disagreement**. Where models
diverge, say so and say why; a synthesis that smooths over conflict has destroyed the signal
that made a multi-model investigation worth running.

**Critique** — adversarial pass over the synthesis. What is asserted without a source? What
would change the conclusion? Reaching `research-complete` means the report survived this, not
that it was written.

## Reporting standard

Cite sources for factual claims and mark inference as inference. A research report that cannot
be checked is an opinion with footnotes.
