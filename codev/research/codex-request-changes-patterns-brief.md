# Research Brief: Universal Codex REQUEST_CHANGES Patterns + Targeted False-Alarm Prompt

**Source issue**: [#753](https://github.com/cluesmith/codev/issues/753)
**Protocol**: RESEARCH (3-way investigate → synthesize → critique)
**Working dir**: `.builders/research-753/`
**Output dir**: `codev/research/`

---

## The two questions (this is the entire research goal)

When we run CMAP consultations, Codex frequently responds with `REQUEST_CHANGES`. Each one costs us at minimum one iteration of builder rework. The architect wants to convert that cost into two pieces of leverage:

1. **Universal patterns Codex flags correctly** — recurring objections that generalize across protocols and subsystems, so we can write tighter specs/plans *up front* and skip the iteration. We are NOT cataloguing project-specific catches (e.g., "Codex was right that the `pty-session.test.ts` mock was missing"). We want the underlying *category* (e.g., "Codex consistently flags missing test infrastructure when the plan names new files but no test setup").

2. **Universal patterns Codex consistently false-alarms on** — categories where Codex is reliably wrong because of a structural limitation (sandbox can't run tests, can't see runtime state, misreads protocol semantics, etc.). For these we will add a targeted "you tend to over-flag X" check to the Codex consult system prompt so it self-corrects before issuing REQUEST_CHANGES.

If we get this right, future CMAP cycles tighten: fewer false-alarm REQUEST_CHANGES (cheaper), fewer correctly-flagged-but-avoidable REQUEST_CHANGES (faster).

---

## Deliverables (two files)

### Deliverable 1: `codev/research/codex-request-changes-patterns.md`

Data-derived universal tips for architects + builders to follow when drafting specs/plans, ordered by **frequency × generalizability**.

Structure (suggested):
- **TL;DR** — top 5–8 tips, each one line
- **Detailed patterns** — full pattern per heading, with:
  - The pattern phrased actionably (`"When X, do Y because Codex flags Z"`)
  - ≥3 distinct projects as evidence (cite project IDs + the specific rebuttal file path)
  - Why it generalizes (what makes this universal, not local)
- **Codex false alarms** — the source data feeding deliverable 2 (a flat list of false-alarm patterns with frequency + project citations)

**Each tip MUST satisfy all of:**
- Phrased actionably (imperative voice, testable as a checklist item)
- Backed by **≥3 distinct projects** (different project IDs — not three iterations of the same project, not three phases of one project)
- Universal — applies regardless of subsystem (a tip that only applies to UI work is fine if it generalizes across multiple UI projects, but a tip that only applies to *this specific tower endpoint* is not)
- Specific enough to be testable in a draft spec/plan ("did I do this?")

### Deliverable 2: `codev/research/codex-false-alarm-prompt.md`

A drop-in prompt fragment to append to the Codex consult system prompt(s). When CMAP fires `consult -m codex`, this fragment is included so Codex self-checks before issuing REQUEST_CHANGES.

**Hard constraints:**
- ≤500 words total
- Written in second person ("Before issuing REQUEST_CHANGES, verify…")
- Each known false-alarm pattern is one check item (concise, scannable)
- Drop-in ready — no project-specific references, no "see this file" links that would rot
- Format must work whether appended to `consult-types/integration-review.md` or to per-protocol consult-type files

**Known false-alarm modes** (from the architect's prior pass — investigators should validate, refine, add to, or remove from this list based on actual rebuttal evidence):
- Flagging missing Playwright tests in repos with no Playwright infrastructure
- Flagging "tests don't exercise the actual handler" when handlers are thin orchestrators over already-tested primitives
- Misreading porch's pending-gate semantics as "incomplete"
- Treating intentional dual-mode phases as in-progress migrations
- Flagging tests Codex literally cannot run (EPERM in its sandbox)

These are starting hypotheses, NOT givens. Investigators must verify each one against the actual rebuttal corpus.

---

## The corpus (required reading)

**73 rebuttal files** under `codev/projects/*/`. The architect's prior count of 71 counts only those with Codex content; 2 files (`671-hermes-consult-optional-backend/671-specify-iter1-rebuttals.md` and `671-plan-iter1-rebuttals.md`) contain no Codex section and can be skipped.

Full list at `find codev/projects -name "*rebuttal*" -type f`. Across **23 distinct projects** spanning bugfixes (4xx, 5xx, 6xx, 7xx IDs) and TICK/SPIR/ASPIR projects (0104–0126 range).

### Required method: context-aware reading

**Investigators MUST NOT just read the rebuttal text.** That was the failure mode of the prior background-agent pass (234s, 12 patterns, ~24% false-positive estimate — but no real grounding because it didn't read the underlying artifacts).

For each rebuttal file at `codev/projects/<id>-<slug>/<id>-<phase>-iter<n>-rebuttals.md`, an investigator should also pull:

1. **The spec** — `codev/specs/<id>-*.md`
2. **The plan** — `codev/plans/<id>-*.md`
3. **The merged PR diff** — find the PR number via:
   - `codev/projects/<id>-*/status.yaml` → `pr_history` or `pr_number` field
   - Or `git log --all --grep "<id>" --oneline` and then `gh pr list --search "<id>"` / `gh pr diff <pr>`
   - If the PR cannot be found, the investigator notes that explicitly and proceeds on spec/plan alone

For each Codex objection in each rebuttal, the investigator classifies it as:

- **(a) Genuinely actionable** — Codex caught a real problem; the builder agreed and fixed it
- **(b) Pre-addressed** — the spec/plan already covered this, but the builder failed to defend; Codex was right to flag the ambiguity (counts as a *spec/plan clarity* issue, not a Codex error)
- **(c) Hallucinated / out-of-context** — Codex flagged something the codebase contradicts, or invoked infrastructure that doesn't exist, or misread the protocol; the builder correctly rebutted

Tally drives the deliverable: (a)+(b) patterns feed tips file; (c) patterns feed false-alarm prompt.

### Required deliverable: per-investigator coverage table

Each investigator's report must include a table of all 71 rebuttal files with classification counts (`a / b / c`) so the synthesis can verify coverage breadth. A report that draws conclusions from <50 of the 71 files should say so explicitly and the synthesis will weight it accordingly.

---

## Scope boundaries

**In scope:**
- All 71 Codex-containing rebuttal files under `codev/projects/*/`
- Underlying spec, plan, and PR diff for each as context
- The two consult-type prompt files Codex receives: `codev/consult-types/integration-review.md` and per-protocol consult-types under `codev/protocols/*/consult-types/` (and skeleton copies). Investigators should read these to understand what Codex already knows.

**Out of scope:**
- PR review comments on Amr's direct-merge PRs (those bypassed CMAP, no rebuttals exist)
- Rebuttals filed since `bugfix-742` that were never committed to main (those project dirs got cleaned up; gone)
- Gemini and Claude REQUEST_CHANGES patterns (separate research)
- Recommending CMAP/consult architecture changes (that's a SPIR, not this research)

---

## Acceptance criteria

From the source issue:

- [ ] Both deliverable files written, committed to `codev/research/`, and reviewed
- [ ] Tips list cites ≥3 distinct projects per tip
- [ ] False-alarm prompt is ≤500 words, drop-in ready (no project-specific refs)
- [ ] Critique-phase verdicts from all 3 models documented in the final report's "Changes from critique" section
- [ ] At least one tip overturned, refined, or merged based on critique feedback (proof that critique was substantive, not rubber-stamp)

---

## What a useful answer looks like

A good report:
- Reads like a checklist a sleep-deprived architect can scan in 90 seconds before approving a spec
- Names the pattern, not the symptom (the symptom is project-specific; the pattern is universal)
- Distinguishes (a) "spec/plan was unclear" vs (b) "builder rebuttal was weak" vs (c) "Codex hallucinated" — these have different fixes
- Quantifies: "appears in N of 71 rebuttals (M distinct projects)" beats "common pattern"
- The false-alarm prompt is short enough that we can paste it into the system prompt without regret

A bad report:
- Cites only well-known software-engineering tropes ("write good tests", "specify edge cases") — these aren't Codex-derived insights
- Confuses "Codex was wrong here" with "Codex always wrong about this" — anecdote ≠ pattern
- Recommends rewriting how CMAP works (out of scope; this research is about *what to feed Codex*, not *whether to ask Codex*)
- Quotes rebuttal text without the spec/plan/PR context the brief mandated

---

## Suggested sources / angles

- The `codev/consult-types/` and `codev/protocols/*/consult-types/` directories define what Codex already gets. Patterns Codex already has guidance on but still flags suggest the guidance isn't sticking.
- Look at `iter1` vs `iter2`/`iter3` rebuttals (project 0104 has up to iter7, project 0118 to iter3) — repeated REQUEST_CHANGES on the same phase often expose Codex's stubbornness on a specific blind spot
- Compare similar protocols: bugfix rebuttals (numeric IDs like 467, 468) vs ASPIR phase rebuttals (0104, 0118, 0124) — does Codex behave differently?
- The architect's prior pass surfaced ~24% false-positive rate; investigators should validate or revise this number with their fuller reading
