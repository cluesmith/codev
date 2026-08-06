**Consultant Review (Gemini): Research Brief #753**

I have reviewed the Research Brief and verified its assumptions directly against the project workspace (`.builders/research-753/`). Claude's assessment regarding context-window hostility and Codex reflexivity bias is spot-on. However, there are critical execution blind spots regarding **tool capabilities** and **corpus structure** that will cause this research task to crash or produce distorted data if not corrected.

Here is my perspective on what needs to change before dispatching the investigators:

### 1. CRITICAL: Agents Cannot Execute `gh` Commands
The brief mandates: *"pull the merged PR diff... find the PR number via... gh pr list / gh pr diff"*. 
**The Blind Spot:** In this framework, investigators (`codebase_investigator`, `generalist`) are equipped strictly with read-only filesystem tools (`read_file`, `grep_search`, `glob`). They **do not** have arbitrary shell execution capabilities. Instructing them to run `gh` will result in loops of hallucinated tool calls or immediate task failure.
**Recommendation:** Drop the PR diff requirement entirely. It is an unnecessary stumbling block because the rebuttal files are already highly contextual (builders routinely quote the disputed code and file paths inline). Restrict the "required reading" to the rebuttal, the spec, and the plan.

### 2. Iteration Exhaustion Will Distort Frequency Counts
The brief asks investigators to read "all 71 rebuttal files."
**The Blind Spot:** These files are not evenly distributed. Project `0104-custom-session-manager` alone accounts for 12 files because it contains up to 7 iterations of a single phase (`0104-phase_2-iter1` through `iter7`). If an investigator reads all 7, they will encounter the *exact same* unresolved Codex objection 7 times as the builder stubbornly disputes it. This will artificially inflate the frequency count of that specific objection and drown out patterns from other projects.
**Recommendation:** Instruct investigators to process only the *latest* iteration of any given phase (e.g., `iter7`), which contains the final resolution of the dispute. Alternatively, explicitly instruct them to deduplicate recurring objections within the same project/phase.

### 3. Missing Classification Heuristics
The brief asks investigators to classify objections into (a) Genuine, (b) Pre-addressed, or (c) Hallucinated.
**The Blind Spot:** Builders do not use these terms. My scan of the rebuttals shows they use highly varied terminology: *"Status: Fixed"*, *"Status: Rebutted"*, *"Action taken"*, or just inline defensive paragraphs.
**Recommendation:** Provide explicit mapping heuristics in the brief so investigators don't get paralyzed trying to classify:
- "Fixed", "Accepted", "Action taken" → (a) Genuine or (b) Pre-addressed (depending on whether the builder points to the spec).
- "Rebutted", "Disputed", "Intentional deviation" → (c) Hallucinated / Out-of-context.

### 4. Leverage the Existing Consult-Type Boundaries
Building on Claude's note about `integration-review.md`: I read the actual file from disk. It explicitly tells Codex: *"The implementation has already been reviewed - don't re-review code quality."*
**The Blind Spot:** When Codex flags "missing tests" or "code quality" during an integration review (which it does frequently in this corpus), it is not just hallucinating context—it is actively ignoring its own system prompt. 
**Recommendation:** Deliverable 2 (the false-alarm prompt) shouldn't just be a generic checklist; it should explicitly reinforce the boundaries already present in the consult-types. For example: *"If you are performing an integration review, do NOT flag missing tests (this violates your instruction to skip code quality reviews)."*

### 5. The Top False-Alarm Pattern is Already Visible
Having `grep`ped through the corpus, the most common structural false alarm is Codex mistaking **phased migrations for incomplete work**. Builders frequently leave legacy fallback code (like `tmux` fallback paths in project `0104` or old env vars in project `468`) intact during early phases of a plan, intending to remove it later. Codex reliably flags this temporary redundancy as a regression. The false-alarm prompt must explicitly warn Codex to respect "dual-mode" or staged rollout architectures.

***

**Bottom line:** The strategy is excellent, but you must remove the `gh` shell dependency and mitigate the iteration duplication. Update the brief with these technical constraints, and the investigators will actually be able to execute it.