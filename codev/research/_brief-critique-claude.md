Let me verify the key claims in this brief against the actual codebase before giving you my assessment.Now let me sample a few rebuttal files to understand the actual format and content — this will inform whether the brief's methodology is realistic.Let me check the RESEARCH protocol to understand the execution model, and sample one more rebuttal to see the classification challenge.Good. Now I have a thorough understanding of the brief and the corpus. Here's my assessment:

---

## Consultant Review: Research Brief #753

**Overall verdict: This is a strong brief.** The two-question framing, the (a)/(b)/(c) classification scheme, and the "what a bad report looks like" section are all disciplined choices that directly address the prior attempt's failure mode. Five things to tighten before dispatching investigators:

### 1. The workload is context-window hostile — partition the corpus

You're asking each investigator to read 71 rebuttal files + their specs + their plans + PR diffs. That's easily 300+ file reads per investigator, and the total token count will blow past any model's effective context window. The prior attempt took 234s and produced shallow patterns precisely because it couldn't hold the full picture.

**Recommendation:** Split the 23 projects into 3 roughly equal tranches (8/8/7 projects) and assign each investigator a primary tranche for deep reading + the full corpus for spot-checking. Each investigator produces a coverage table for their primary tranche (guaranteed deep) and a sampling note for the rest. The synthesis phase reconciles across tranches. This turns the "≥3 distinct projects" requirement into a cross-investigator claim rather than a per-investigator claim, which is actually *stronger* — if Gemini and Claude both find the same pattern in their disjoint tranches, that's more convincing than one model finding it across 3 similar projects.

### 2. Codex investigating itself creates reflexivity bias

Codex is one of the three investigators, and the research question is "what does Codex get wrong?" Codex has a known tendency to be defensive about its own outputs. It may undercount its false alarms or rationalize them as "the rebuttal was weak, not my flag."

**Recommendation:** Acknowledge this in the brief explicitly. Tell the synthesis phase to weight Gemini and Claude's assessment of Codex false-alarm patterns more heavily than Codex's self-assessment. Don't exclude Codex — its unique contribution is that it may recall *why* it flagged things the other models can't infer — but flag the asymmetry for the synthesizer.

### 3. The "single 500-word prompt fragment for all consult-types" constraint may be too rigid

I read the actual consult-type files. `integration-review.md` (system-level fit) and `impl-review.md` (spec adherence + code quality) have very different focus areas. A false-alarm pattern like "flagging missing Playwright tests" is relevant in impl-review but irrelevant in spec-review. A single 500-word fragment appended to all of them will either be too generic or include checks that confuse Codex in certain review types.

**Recommendation:** The primary deliverable should still be a single fragment (keeps it simple), but add a secondary recommendation section in Deliverable 1: "If a pattern is phase-specific, note which consult-type(s) it applies to." This gives you the option to split the fragment later without requiring it now.

### 4. The ≥3-project threshold should have a "near-miss" section

23 projects is a small universe. With the (a)/(b)/(c) classification adding noise, some real patterns will land at exactly 2 projects. A pattern that appears in project 0104 (iter2, iter4, iter6 — Codex was stubborn about the same thing across 3 iterations) and project 0118 (iter1, iter2, iter3 — same thing) is clearly real but technically fails the "≥3 distinct projects" threshold.

**Recommendation:** Add a "Near-miss patterns (2 projects)" appendix section in Deliverable 1. These don't make the main tips list but are tracked for future validation as the corpus grows. The brief already says "if <50 files covered, say so" — apply the same honesty principle to pattern thresholds.

### 5. Temporal dimension is unaddressed

Projects 0104–0126 used older model versions of Codex. Projects 4xx–7xx are more recent. If OpenAI updated Codex between these eras, some false-alarm patterns from the 01xx range may no longer apply, and patterns from the 7xx range may be more predictive of future behavior.

**Recommendation:** Ask investigators to note, for each pattern, whether it appears only in old projects, only in new projects, or across both. The synthesis should weight cross-era patterns higher. A pattern that only appears in 0104/0118/0120 may already be self-corrected; a pattern that spans 0118 and 723 is more durable.

### 6. Two factual claims verified

- **"73 rebuttal files"**: ✅ Confirmed. `find` returns exactly 73.
- **"71 with Codex content, 2 without"**: ✅ Confirmed. The two 671-hermes files are both 0 bytes. All other 71 files contain "Codex."
- **"23 distinct projects"**: ✅ Confirmed.

### 7. Minor: the brief's "known false-alarm modes" list is good but should be labeled as hypotheses more aggressively

The brief says "these are starting hypotheses, NOT givens" at the end of the list, but the list itself is formatted identically to the rest of the brief's instructions. Investigators will anchor on it. Consider prefixing each bullet with `[HYPOTHESIS]` or moving the disclaimer *above* the list rather than below it.

---

**Bottom line:** The brief is ready to dispatch with these adjustments. The biggest risk is #1 (context window overflow producing the same shallow results as the prior attempt). If you only change one thing, partition the corpus.