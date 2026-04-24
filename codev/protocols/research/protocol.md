# RESEARCH Protocol

## Overview

Multi-agent research with 3-way investigation, synthesis, and critique. Three AI models independently investigate a question, their findings are synthesized into a single report, and then all three models critique the synthesis for gaps, errors, and bias.

**Core Principle**: Triangulate. No single model's knowledge is authoritative. Consensus across models is more reliable than any individual output.

## When to Use

**Use for**: Competitive analysis, technology evaluation, market research, architectural decision support, "what's the state of X?" questions, exploring unfamiliar domains.

**Skip for**: Implementation work (use SPIR/ASPIR), quick questions (just ask), experiments (use EXPERIMENT), known-answer lookups (just search).

## Output

All research artifacts go to `codev/research/`. The final deliverable is a single synthesis report at `codev/research/<topic>.md`.

## Phases

### Phase 1: Scope

**Purpose**: Make sure we're asking the right question before spending 3 models' worth of compute on answering it.

The builder:
1. Reads the architect's research request
2. Clarifies the question — what specifically are we trying to learn?
3. Defines the scope — what's in, what's out, what depth is needed
4. Defines acceptance criteria — what does a good answer look like?
5. Writes a **research brief** (`codev/research/<topic>-brief.md`) with:
   - The precise question(s)
   - Scope boundaries
   - **Required targets** (when applicable — not all research questions have them). When the user names specific projects, products, or systems, those are exemplars of a CLASS, not an exhaustive list. The brief should:
     - List the named targets as required coverage (each gets a dedicated section)
     - Identify the CLASS they represent (e.g., "open-source always-on agent frameworks")
     - Instruct investigators to find OTHER members of that class the user didn't name — discovering what the user SHOULD be thinking about is often the most valuable part of the research
     - If an investigator cannot find information about a required target, they must say so explicitly — not silently skip it
   - **Optional context** — additional sources that may be useful but are not required
   - What a useful answer looks like
   - Suggested sources or angles for the investigators
6. Sends the brief to the architect for approval

**Gate**: `scope-approval` — the architect confirms the question is correctly scoped before the 3-way investigation begins. This prevents wasting compute on a badly-framed question.

### Phase 2: Investigate (3-way parallel)

**Purpose**: Get three independent perspectives on the question.

The builder dispatches the research brief to three models (Gemini, Codex, Claude) via `consult`. Each model:
1. Receives the scoped research brief
2. Independently investigates using web search, its training knowledge, and reasoning
3. Produces a standalone investigation report with:
   - **A dedicated section for each required target** from the brief. Every required target gets its own heading with specific findings — not mentioned in passing, not substituted with an easier target. If a required target yields no findings, the section must say "No information found" rather than being omitted.
   - Findings (with sources where possible)
   - Confidence levels on key claims
   - Gaps it couldn't fill
   - Surprises or things that contradicted expectations

The investigations run in **parallel** — each model works independently without seeing the others' output. This prevents anchoring bias.

Investigation reports are saved to:
- `codev/research/<topic>-gemini.md`
- `codev/research/<topic>-codex.md`
- `codev/research/<topic>-claude.md`

### Phase 3: Synthesize

**Purpose**: Merge three independent reports into one coherent document.

The builder:
1. Reads all three investigation reports
2. Identifies **consensus** — what all three agree on (highest confidence)
3. Identifies **disagreements** — where models contradict each other
4. Resolves conflicts — picks the best-supported position, notes the disagreement
5. Identifies **unique contributions** — things only one model found that the others missed
6. Writes the **synthesis report** (`codev/research/<topic>.md`) with:
   - **Scope summary** — a short section (before the executive summary) restating the research question, required targets, and scope boundaries from the brief. A reader should understand what was asked without needing to read the brief separately.
   - Executive summary
   - Findings (organized by topic, not by model)
   - Confidence annotations (consensus vs. single-source)
   - Gaps and limitations
   - Recommendations (if the research brief asked for them)

The synthesis is written as a **standalone document** — a reader should never need to reference the individual investigation reports. Those are kept as appendices for traceability.

### Phase 4: Critique (3-way review)

**Purpose**: Pressure-test the synthesis for gaps, errors, and bias.

The builder dispatches the synthesis report back to all three models for critique. Each model:
1. Reads the synthesis
2. **Checks coverage against the brief** — does every required target from the research brief have dedicated coverage in the synthesis? Lists any required targets that were named in the brief but have zero or minimal coverage. This is the #1 critique check.
3. Checks for factual errors or unsupported claims
4. Identifies gaps — important aspects the synthesis missed
5. Flags potential bias — did the synthesis over-weight one model's perspective?
6. Suggests specific improvements

The builder then:
1. Incorporates valid critique
2. Documents rejected critique with rationale
3. Finalizes the report
4. Commits to `codev/research/<topic>.md`

## File Structure

Only the brief and final report are checked in. Individual investigation reports and full critique outputs are working artifacts — useful during the process but not committed to the repo.

```
codev/research/
├── <topic>-brief.md              # Phase 1: scoped research question (checked in)
└── <topic>.md                    # Phase 3+4: final synthesis (the deliverable, checked in)
```

The final report includes:
- A **"Disagreements and resolution"** section documenting where the three investigators disagreed and how the synthesis resolved each disagreement
- A **"Changes from critique"** section summarizing what the critique phase changed (not the full critique — just what was added, removed, or corrected and why)

Individual investigation reports (`<topic>-gemini.md`, `<topic>-codex.md`, `<topic>-claude.md`) and raw critique outputs are kept locally during the research process but NOT committed. The final report is the deliverable; the process artifacts are disposable.

## Best Practices

### Scoping
- A good research question is specific enough to answer in 1500-3000 words per model
- "What's the state of X?" is too broad — "What are the top 5 players in X, their strengths/weaknesses, and the structural gaps?" is better
- Include the "so what" — why are we researching this? What decision does it inform?

### Investigation
- Tell each model to cite sources where possible
- Tell each model to be candid about uncertainty — "I don't know" is better than confabulation
- Tell each model to note surprises — the most valuable findings are often the unexpected ones

### Synthesis
- Organize by topic, not by model ("here's what we found about X" not "here's what Gemini said")
- Weight consensus over single-model claims
- Don't smooth over disagreements — note them explicitly
- Keep the synthesis shorter than the sum of the investigations

### Critique
- Critiquers should focus on gaps and errors, not style
- A critique that says "add more about X" is useful; "rewrite the intro" is not
- The builder should reject critique that's outside the original scope

## Integration with Other Protocols

### Research → SPIR
When research informs a feature decision:
1. Reference the research report in the spec
2. Link specific findings as evidence for design choices

### Research → EXPERIMENT
When research identifies something worth testing:
1. Create an experiment to validate the research finding
2. Reference the research report as motivation

## Git Workflow

### Commits
```
[Research: topic] Scoped research brief
[Research: topic] 3-way investigation complete
[Research: topic] Synthesis report
[Research: topic] Final report (post-critique)
```

### What to Commit
- All investigation reports (for traceability)
- The final synthesis (the deliverable)
- The critique rebuttals (for process transparency)
- Do NOT commit raw web search results or intermediate notes
