Here is the critique of Phase 4 (Synthesis), pressure-tested against the source brief and individual investigations.

### Coverage gaps
- **None.** The synthesis is excellent. It explicitly covers all deliverables, and correctly investigates and refutes the architect's starting hypothesis about Playwright (discovering that Playwright *does* exist, but builders simply can't execute it in worktrees). 

### Factual errors
- **Drop-in Prompt Item 4 violates a hard constraint:** The prompt includes a hardcoded path (`packages/codev/src/agent-farm/__tests__/e2e/`). The brief explicitly forbade "see this file" links that would rot. Even though it's a repo-level path, it violates the rot constraint.
- **Drop-in Prompt Item 1 hallucinates a tool:** Instructing the model to "Grep before claiming..." assumes Codex has a search tool in this context. In many CMAP review contexts (like PR diff reviews), Codex is purely reading a text prompt and does not have bash execution. Telling it to "Grep" will either cause it to hallucinate tool usage or ignore the rule entirely.
- **Pattern 9 Evidence Count:** The text claims "Evidence (≥5 distinct projects)", but the bulleted list only contains 4 distinct project IDs (653, 587, 468, 469). 4 still meets the brief's threshold, but the header claim is mathematically incorrect.

### Bias concerns
- **Handled excellently.** The synthesis explicitly notes the reflexivity risk of Codex investigating its own false alarms, and correctly defers to the cross-model consensus (Claude/Gemini) when classifications disagree. 
- The inclusion of single-source patterns (Patterns 9, 10, FA4, FA6) from Claude is appropriate and well-justified because they all meet the hard `≥3 distinct projects` evidence threshold required by the brief. The synthesis followed the data, not just model consensus.

### Suggested changes

1. **REFINE Pattern 8 (Documentation-reality alignment)**
   - *Why:* The TL;DR states these tips are for pre-empting issues at *spec/plan time*, but Pattern 8 gives *post-implementation* advice ("After implementation, re-read every..."). This breaks the premise.
   - *Change to:* "In the plan, explicitly list all specific documentation files (arch.md, CLAUDE.md) that will require updates as deliberate deliverables. When the plan lists them, the builder won't forget them, and Codex will review against the plan."

2. **REFINE Drop-in Prompt Item 4 (Playwright)**
   - *Why:* Remove the hardcoded path to prevent rot.
   - *Change to:* "Playwright presence ≠ obligation. This repo has Playwright configured, but builders work in isolated worktrees without Tower, so they cannot run E2E harnesses and cannot meaningfully author new E2E tests during implementation. Don't request new Playwright tests unless the plan explicitly lists them as a deliverable."

3. **REFINE Drop-in Prompt Item 1 (Outside-diff blindness)**
   - *Why:* Remove the "Grep" instruction.
   - *Change to:* "Outside-diff blindness. You see the diff, not the full codebase. Before claiming code or tests are missing, consider that they may exist in unmodified files outside your view. If a builder hasn't staged yet (review fired pre-commit), 'untracked' is expected."

4. **REFINE Drop-in Prompt Item 9 (Previous Iteration Context)**
   - *Why:* The current `impl-review.md` already tells Codex to read Previous Iteration Context, but it ignores it. Simply repeating the instruction won't work; you need a mechanical constraint.
   - *Change to:* "Read Previous Iteration Context. If prior-iteration context is provided, you MUST read it. If you overrule a builder's previous rebuttal, you MUST explicitly quote their rationale and explain exactly why the new diff renders it insufficient."

5. **REFINE Pattern 9 (Input validation)**
   - *Change:* Update the header text from "(≥5 distinct projects)" to "(4 distinct projects)".

### Verdicts
- `codev/research/codex-request-changes-patterns.md`: **REQUEST_CHANGES** (Fix Pattern 8 to be a plan-time action, correct Pattern 9's math).
- `codev/research/codex-false-alarm-prompt.md`: **REQUEST_CHANGES** (Remove the rotting file path in Item 4, remove the `grep` tool hallucination in Item 1, strengthen Item 9).

**Summary**: Must-fix: Remove the hardcoded rotting path in the drop-in prompt and align Pattern 8 with the "plan-time pre-emption" premise. Nice-to-have: Strengthen the "Previous Iteration" prompt check so it mechanically forces Codex to quote rebuttals before overruling them.