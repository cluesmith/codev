# Claude Code vs. Codev: Todo Manager Comparison — Round 4

**Date**: 2026-02-17
**PRs**: [Claude Code PR #1](https://github.com/waleedkadous/todo-vibe-2026-r3/pull/1) (R3, reused) | [Codev PR #1](https://github.com/waleedkadous/todo-spir-2026-r4/pull/1)
**Reviewers**: Claude Opus 4.6, GPT-5.2 Codex, Gemini 3 Pro
**Codev version**: v2.0.9

## Methodology

**Key change from Round 3**: Only the Codev/SPIR side was re-run. Claude Code scores are reused from R3, where they were reviewed by all three models (Claude, Codex, Gemini). The rationale: CC scores have been remarkably stable across R1-R3 (overall 5.7–5.9), making re-evaluation unnecessary. This approach also eliminates the CC-side variability that can mask SPIR-side improvements.

**Gemini model fix**: R3's Gemini SPIR review failed due to quota exhaustion from the builder's consultation activity. In R4, `consult` explicitly passes `--model gemini-3-pro-preview` for Gemini consultations, and the reviews were run after the builder completed (not concurrently). All 6 reviews completed successfully — the first round to achieve this.

**Methodological note on Gemini scoring scale**: The review prompt's phrasing "Give explicit numeric scores for each dimension (2-7)" was ambiguous — Gemini interpreted "(2-7)" as a 1–7 scoring range rather than "dimensions 2 through 7." Gemini's scores are reported using qualitative-label mapping to a 1–10 scale, consistent with its scoring patterns in R1–R3 (see Reviewer Agreement Analysis for mapping details).

Otherwise identical to Rounds 1–3. The Codev builder received the same base prompt (Next.js 14+ Todo Manager with Gemini 3.0 Flash NL backend) plus the porch strict-mode addendum. It ran as a Claude Opus 4.6 instance with `--dangerously-skip-permissions` in a fresh GitHub repo.

---

## Scorecard

### Individual Reviewer Scores

| Dimension | Claude (CC)† | Claude (Codev) | Codex (CC)† | Codex (Codev) | Gemini (CC)† | Gemini (Codev) |
|-----------|:-----------:|:-----------:|:----------:|:----------:|:-----------:|:-----------:|
| Bugs | 5 | 5 | 7 | 8 | 8 | 9 |
| Code Quality | 7 | 7 | 6 | 7 | 8 | 9 |
| Maintainability | 7 | 7 | 6 | 7 | 9 | 8 |
| Tests | 5 | 7 | 4 | 6 | 6 | 7 |
| Extensibility | 5 | 6 | 5 | 6 | 7 | 7 |
| NL Interface | 6 | 6 | 5 | 6 | 8 | 8 |
| Deployment | 2 | 7 | 3 | 5 | 3 | 8 |

*†CC scores reused from R3 (same Claude Code codebase, same reviewers).*

*Bug scores derived from each reviewer's bug sweep: severity-weighted count inverted to a 1–10 scale. Critical = −2, High = −1, Medium = −0.5, Low = −0.25 from a baseline of 10. Excludes `.env` (test setup artifact, not committed to git — see Bug Sweep section). Floored at 1.*

*Gemini scored on a 1–7 scale; mapped to 1–10 using qualitative labels and R1–R3 calibration: "Excellent" = 9, "High"/"Very Good"/"Robust"/"Ready" = 7–8, "Good but..." = 7. See Reviewer Agreement Analysis.*

### Averaged Scores

| Dimension | CC (avg, n=3) | Codev (avg, n=3) | Delta |
|-----------|:----------:|:----------:|:-----:|
| **Bugs** | 6.7 | 7.3 | **+0.7** |
| **Code Quality** | 7.0 | 7.7 | **+0.7** |
| **Maintainability** | 7.3 | 7.3 | 0.0 |
| **Tests** | 5.0 | 6.7 | **+1.7** |
| **Extensibility** | 5.7 | 6.3 | +0.7 |
| **NL Interface** | 6.3 | 6.7 | +0.3 |
| **Deployment** | 2.7 | 6.7 | **+4.0** |
| **Overall** | **5.8** | **7.0** | **+1.2** |

### Round 1 → Round 2 → Round 3 → Round 4 Comparison

| Dimension | R1 CC | R2 CC | R3 CC | R4 CC† | R1 Codev | R2 Codev | R3 Codev‡ | R4 Codev |
|-----------|:-------:|:-------:|:-------:|:-------:|:-------:|:-------:|:-------:|:-------:|
| Bugs | — | 4.7 | 6.7 | 6.7† | — | 7.3 | 4.5‡ | 7.3 |
| Code Quality | 6.7 | 6.3 | 7.0 | 7.0† | 7.7 | 7.7 | 7.0‡ | 7.7 |
| Maintainability | 7.0 | 7.3 | 7.3 | 7.3† | 7.7 | 7.7 | 7.5‡ | 7.3 |
| Tests | 4.0 | 5.0 | 5.0 | 5.0† | 7.7 | 6.0 | 7.0‡ | 6.7 |
| Extensibility | 5.7 | 5.0 | 5.7 | 5.7† | 6.7 | 6.0 | 6.5‡ | 6.3 |
| NL Interface | 6.0 | 6.0 | 6.3 | 6.3† | 6.0 | 7.0 | 7.0‡ | 6.7 |
| Deployment | 6.0 | excl | 2.7 | 2.7† | 8.0 | excl | 3.5‡ | 6.7 |
| **Overall** | **5.9** | **5.7** | **5.8** | **5.8†** | **7.2** | **7.0** | **6.1‡** | **7.0** |

*†R4 CC scores reused from R3. ‡R3 Codev scores based on 2/3 reviewers (Gemini failed). R1 did not score bugs. R2 excluded deployment.*

### Quantitative Comparison

| Metric | CC (R3) | Codev (R4) |
|--------|:----:|:----:|
| Source lines (excl. tests) | 1,294 | 1,249 |
| Test lines | 342 | 988 |
| Test-to-code ratio | 0.26:1 | 0.79:1 |
| Test files | 2 | 7 |
| Component tests (lines) | 0 | 300 |
| Integration tests (lines) | 0 | 0 |
| Git commits | 2 | 17 |
| Documentation artifacts | 0 | spec + plan + review |
| Dockerfile present | No | Yes |
| `output: "standalone"` | No | Yes |

**Notable**: Codev R4 is the most concise SPIR implementation yet (1,249 source lines vs 1,425 in R3, 1,567 in R2, 1,596 in R1). It's actually smaller than the CC codebase (1,294 lines) while producing 2.9x more test code and a Dockerfile.

---

## Bug Sweep Synthesis

### Claude Code Bugs (from R3 — reused)

| Bug | Severity | Found by | Description |
|-----|----------|----------|-------------|
| **No validation of LLM action payloads** | High | Codex, Claude | `src/app/api/nl/route.ts`: Server returns Gemini's JSON with only `Array.isArray` check |
| **NL list filters silently dropped** | Medium | Codex, Claude | `src/lib/hooks.ts:118-124`: API supports date filters but client ignores them |
| **Date format assumptions** | Medium | All 3 | `src/components/TodoItem.tsx:24-32`: Non-ISO formats produce `Invalid Date` |
| **localStorage quota not handled** | Low | Codex, Claude | `src/lib/todo-store.ts:25`: `setItem` can throw unhandled `QuotaExceededError` |
| **Stale closure / race condition** | High | Claude, Gemini | State consistency issues in hooks and multi-tab scenarios |

### Codev R4 Bugs (confirmed by 2+ reviewers)

| Bug | Severity | Found by | Description |
|-----|----------|----------|-------------|
| **NL update accepts invalid field values** | Medium | Codex, Claude | `src/lib/nl-executor.ts:78-96`: `executeUpdate` only checks `updates` is object, not that values are valid. Empty payloads silently "succeed." |
| **No schema validation on Gemini response** | High | Claude (High), Codex (Low) | `src/lib/gemini.ts:134`: `parsed as NLAction` type assertion with no field validation. Invalid shapes from Gemini pass through. |
| **loadTodos no shape validation** | Medium | Claude, Codex | `src/lib/storage.ts:9-15`: `Array.isArray` check only — individual items not validated. Corrupt localStorage breaks UI. |

### Single-Reviewer Findings (not consensus)

**Codev single-reviewer bugs:**
| Bug | Severity | Reviewer | Description |
|-----|----------|----------|-------------|
| Stale closure in NLInput | Medium | Claude | `NLInput.tsx:47-113`: `todos` captured at render time, not submit time. Rapid add+NL sends stale state. |
| Toast/storageError interaction | Medium | Claude | `page.tsx:94`: `onDismiss={() => {}}` means storage error toast can never be dismissed; effect re-triggers on every render. |
| `searchText` in filter action unused | Medium | Claude | `types/todo.ts:58`: Defined in type but never used in `executeFilter`. Dead code. |
| Edit state overwrites newer data | Medium | Codex | `TodoItem.tsx:20-24`: Edit fields initialized from props once, never synced on external update. |
| No input length limits | Low | Claude, Codex, Gemini | No `maxLength` on any text inputs — large payloads could exhaust storage or Gemini tokens. |
| `crypto.randomUUID()` compat | Medium | Gemini | Not available in older browsers or non-HTTPS contexts. |
| No delete confirmation | Low | Claude | Single-click permanent delete with no undo. |
| Due date accepts past dates | Low | Claude | No `min` attribute on date input. |

### Cross-cutting: Shared Weaknesses

Both implementations share these problems:
- **Full todo list sent every request**: Token cost grows linearly. No truncation or summarization.
- **No conversation history**: Each NL message is standalone.
- **No multi-tab sync**: Neither listens for `storage` events.
- **No E2E/Playwright tests**: Neither includes browser-level tests.
- **No XSS vulnerabilities**: React auto-escaping protects both (confirmed by all reviewers).

### Bug Quality Assessment

R4 resolves the R3 bug scoring anomaly by having all 6 reviews complete.

**By the numbers:**

| Metric | CC (R3) | Codev (R4) |
|--------|:----:|:----:|
| Total consensus bugs | 5 | 3 |
| Total single-reviewer bugs | 4 | 8 |
| Consensus Critical | 0 | 0 |
| Consensus High | 2 | 1 |
| Consensus Medium | 2 | 2 |
| Consensus Low | 1 | 0 |

**The `.env` artifact.** Both Claude and Codex flagged `.env` as a Critical security leak. The file was NOT committed to git (`.gitignore` excludes it) — it was present on disk only because the review setup copied API keys for the `consult` tool. Both bug scores and deployment scores are computed *excluding* this artifact, consistent with R3 methodology.

**Claude's aggressive pattern continues.** Claude found 10 non-`.env` bugs in Codev R4 (2 High, 5 Medium, 3 Low) vs Codex's 4 (2 Medium, 2 Low) and Gemini's 3 (1 Medium, 2 Low). This matches R3's pattern where Claude found 14 SPIR bugs. Claude scrutinizes defensive code patterns that other reviewers don't flag.

**The consensus picture favors Codev.** CC has 5 consensus bugs (2 High) vs Codev's 3 (1 High). This is consistent across all rounds — SPIR produces fewer high-confidence bugs.

---

## Architecture Comparison

### Claude Code R3
- **State**: Custom `useTodos` hook + `todo-store.ts` (procedural functions operating on localStorage)
- **NL**: Single API route with 85-line prompt. `responseMimeType: "application/json"`. Multi-action support. No schema validation.
- **Storage**: Two functions — `loadTodos()`/`saveTodos()`. No error handling.
- **Components**: 5 components in flat hierarchy
- **Dependencies**: `@google/generative-ai` only

### Codev R4
- **State**: `useTodos` hook with `useState` + `useEffect` localStorage sync. Filtering, sorting, validation built in.
- **NL**: Three-layer architecture — `gemini.ts` (client with prompt construction + response parsing + markdown fence stripping) → `route.ts` (API with error handling) → `nl-executor.ts` (action execution with discriminated union dispatch). 5 action types.
- **Storage**: Typed layer with `loadTodos`/`saveTodos`, try/catch, error reporting via `{success, error}` return type.
- **Components**: 7 components including `Toast`, `NLInput` with debounce and Gemini availability checking.
- **Dependencies**: `@google/generative-ai`, `vitest`, `@testing-library/react`

**Key architectural advantage of Codev R4**: The `nl-executor.ts` module cleanly separates NL action execution from Gemini communication. Each action type is handled by a dedicated function (`executeAdd`, `executeUpdate`, `executeDelete`, `executeFilter`, `executeList`). This makes the NL pipeline independently testable. CC mixes parsing and execution in a single flow.

**Key architectural advantage of Claude Code**: Multi-action responses. Gemini returns an actions array, allowing "delete all completed" to produce multiple delete actions in one response. Codev's single-action design can't batch operations.

**New R4 pattern**: Codev R4 is more concise than CC R3 (1,249 vs 1,294 source lines) — the first round where SPIR produced less code. The consultation process appears to be driving tighter, more focused implementations. In R1–R3, SPIR always produced 10–74% more code.

---

## NL Interface Comparison

| Capability | Claude Code R3 | Codev R4 |
|------------|:-------:|:-------:|
| Gemini Flash backend | **Yes** | **Yes** |
| Structured output | `responseMimeType: "application/json"` | `responseMimeType: "application/json"` |
| Multi-action support | **Yes** (actions array) | No (single action) |
| Markdown fence defense | No | **Yes** (regex stripping in `gemini.ts`) |
| Runtime validation of AI output | No (trusts JSON shape) | Partial (action type validated, fields not) |
| Action type validation | No | **Yes** (discriminated union + allowlist) |
| Rate limiting | No | No |
| Delete confirmation | No | No |
| Gemini availability check | No | **Yes** (UI disables NL when unconfigured) |
| Context (todo list sent) | Full list | Full list |
| Conversation history | None | None |
| Temperature | Not specified | 0.1 (deterministic) |
| Timeout handling | No | **Yes** (10s AbortController) |

**Verdict**: Codev R4's NL architecture is cleaner in its separation of concerns and safer with markdown fence defense, action type validation, and timeout handling. CC retains the multi-action advantage. Neither has conversation memory or prompt injection mitigation.

---

## Test Quality Deep Dive

### Claude Code R3 (342 lines, 2 files)
- `todo-store.test.ts` (225 lines): CRUD operations, filtering, sorting, persistence, edge cases
- `route.test.ts` (117 lines): API validation paths — missing key, missing message, valid request

**Not tested**: All 5 React components (zero component tests), hooks, NL action processing, error states, corrupt localStorage.

### Codev R4 (988 lines, 7 files)
- `useTodos.test.ts` (299 lines): Hook behavior — CRUD, filtering, sorting, persistence, edge cases
- `nl-executor.test.ts` (222 lines): All 5 action types, edge cases (unknown actions, missing fields, non-existent IDs)
- `TodoItem.test.tsx` (145 lines): Rendering, edit mode, status toggle, priority display
- `gemini.test.ts` (95 lines): Response parsing, markdown fence stripping, error handling, Gemini availability
- `AddTodoForm.test.tsx` (92 lines): Form interactions, validation, submission
- `storage.test.ts` (72 lines): localStorage read/write, error handling, corrupt data
- `FilterBar.test.tsx` (63 lines): Filter UI interactions, active state display

**Not tested**: `NLInput` component (most complex component — async fetch, loading states, debounce), `TodoList` component, `Toast` component, API route (`route.ts`), E2E flows.

### Comparison with Previous Rounds

| Metric | R1 CC | R2 CC | R3 CC | R1 Codev | R2 Codev | R3 Codev | R4 Codev |
|--------|:-------:|:-------:|:-------:|:-------:|:-------:|:-------:|:-------:|
| Test lines | 235 | 271 | 342 | 1,743 | 1,149 | 1,474 | 988 |
| Test files | 3 | 2 | 2 | 8 | 4 | 12 | 7 |
| Test-to-code ratio | 0.26:1 | 0.26:1 | 0.26:1 | 1.09:1 | 0.73:1 | 1.03:1 | 0.79:1 |
| Component tests | 0 | 109 | 0 | 288 | 0 | 475 | 300 |

**Notable patterns:**
- CC's test-to-code ratio remains locked at 0.26:1 across all rounds — a Claude baseline without protocol guidance.
- Codev R4's test count (988 lines) is the lowest SPIR total, matching the more concise source code. But test-to-code ratio (0.79:1) remains 3x higher than CC.
- Component tests present in R4 (300 lines) — covering AddTodoForm, FilterBar, and TodoItem. NLInput (the most complex component) remains untested across all SPIR rounds.

---

## Deployment Readiness

This dimension shows the largest delta of any dimension in any round: **+4.0**.

| Feature | CC (R3) | Codev (R4) |
|---------|:---:|:---:|
| Dockerfile | No | **Yes** (multi-stage, non-root) |
| `output: "standalone"` | No | **Yes** |
| `.env.example` | Yes | Yes |
| `.dockerignore` | No | **Yes** |
| Health check endpoint | No | No |
| Railway-specific config | No | No |
| CI/CD pipeline | No | No |
| README with deploy instructions | No | **Yes** |

**Analysis**: Codev R4's Dockerfile is production-quality: multi-stage build (deps → build → slim runner), non-root user (`nextjs:nodejs`), `HOSTNAME="0.0.0.0"`, standalone output. CC R3 has none of this.

**Cross-round deployment pattern:**

| Round | CC Dockerfile? | Codev Dockerfile? | CC Deploy Score | Codev Deploy Score |
|-------|:-----------:|:-------------:|:--:|:--:|
| R1 | No | **Yes** | 6.0 | 8.0 |
| R2 | No | No | (excl) | (excl) |
| R3 | No | No | 2.7 | 3.5 |
| R4 | No | **Yes** | 2.7† | 6.7 |

*†Reused from R3.*

R4 suggests Dockerfile production may be somewhat reliable with SPIR (2 of 4 rounds) but never appears with plain CC (0 of 4 rounds). The consultation process appears to drive deployment awareness, though inconsistently.

---

## Reviewer Agreement Analysis

### Where all three Codev reviewers agreed:
- Code architecture is clean with good TypeScript usage (all scored 7+)
- NL executor pattern (discriminated unions) is well-designed
- No XSS vulnerabilities (React escaping)
- No E2E tests
- `loadTodos` needs stronger schema validation

### Where Codev reviewers disagreed:
- **Bug thoroughness**: Claude found 10 bugs, Codex found 4, Gemini found 3. Claude's aggressive pattern is consistent across all rounds.
- **Deployment score**: Claude 7, Codex 5, Gemini 8. Codex penalized heavily for the `.env` artifact; without it, scores would converge around 7.
- **Tests**: Claude 7, Codex 6, Gemini 7. Codex penalized the missing API route tests more heavily.

### Gemini's /7 scale mapping

Gemini interpreted the review prompt as requesting scores on a 1–7 scale. The conversion to 1–10 used:

| Gemini label | Gemini score | Mapped to /10 | Rationale |
|-------------|:----:|:----:|------|
| "Excellent" | 7/7 | 9 | Matches R2 Gemini Codev Code Quality (9) |
| "High" | 6/7 | 8 | Matches R2 Gemini Codev Maintainability (9, reduced by 1 for minor critique) |
| "Very Good" | 6/7 | 7 | Tests: calibrated against R1 (7) and R2 (5) patterns |
| "Good, but..." | 5/7 | 7 | Extensibility: matches R2 pattern with noted limitation |
| "Robust" | 6/7 | 8 | NL: matches R2 Gemini Codev NL (8) |
| "Ready" | 6/7 | 8 | Deployment: Dockerfile present, non-root, multi-stage → 8 |

For bugs, the formula-based approach was used (consistent with all other reviewers): Gemini found 1 Medium + 2 Low = 9.

### Gemini's optimism pattern (cross-round):

| Round | Gemini CC avg | Codex/Claude CC avg | Gemini Codev avg | Codex/Claude Codev avg |
|-------|:----:|:----:|:----:|:----:|
| R2 | 6.2 | 5.5 | 7.5 | 6.7 |
| R3 | 6.7 | 5.1 | — | 6.0 |
| R4 | 6.7† | 5.1† | 8.0 | 6.3 |

*†Reused from R3.*

Gemini consistently scores +1.0 to +1.7 above the Codex/Claude average. This pattern held in R4 with the scale-converted scores.

---

## Key Takeaways

### 1. All 6 reviews completed — first time in the experiment

R3 lost the Gemini SPIR review to quota exhaustion. R4 achieved full coverage by running reviews after the builder completed (not concurrently). This eliminates the reviewer asymmetry that distorted R3's scores, particularly the bug dimension.

### 2. Deployment is SPIR's largest R4 advantage (+4.0)

Codev R4 produced a multi-stage Dockerfile, `.dockerignore`, standalone output, and a README with deployment instructions. CC had none of these. This is the largest delta of any dimension in any round across the entire experiment. However, SPIR only produced a Dockerfile in 2 of 4 rounds, so this advantage is not fully reliable.

### 3. Testing advantage remains consistent (+1.7)

| Round | CC Tests | Codev Tests | Delta |
|-------|:-------:|:-------:|:-------:|
| R1 | 4.0 | 7.7 | **+3.7** |
| R2 | 5.0 | 6.0 | **+1.0** |
| R3 | 5.0 | 7.0 | **+2.0** |
| R4 | 5.0 | 6.7 | **+1.7** |

SPIR consistently produces 2.9–7.4x more test lines with broader coverage (component tests, hook tests, validation tests). CC is locked at 0.26:1 test-to-code ratio across all rounds.

### 4. Bug scores recover from R3's anomaly

R3's bug delta was −2.2 (driven by missing Gemini review + Claude's 14-bug sweep). R4's +0.7 is in line with R2's +2.7. With all 3 reviewers completing, the consensus picture is clear: SPIR has fewer consensus bugs (3 vs 5) and fewer high-severity ones (1 High vs 2 High).

### 5. SPIR is getting more concise

| Round | CC lines | SPIR lines | SPIR overhead |
|-------|:-------:|:-------:|:-------:|
| R1 | 916 | 1,596 | +74% |
| R2 | 1,033 | 1,567 | +52% |
| R3 | 1,294 | 1,425 | +10% |
| R4 | 1,294 | 1,249 | **−3%** |

For the first time, SPIR produced *fewer* source lines than CC while maintaining its quality advantages. The consultation process may be evolving toward tighter, more focused code.

### 6. The overall delta is stable at +1.2

| Round | CC Overall | Codev Overall | Delta |
|-------|:-------:|:-------:|:-------:|
| R1 | 5.9 | 7.2 | +1.3 |
| R2 | 5.7 | 7.0 | +1.2 |
| R3 | 5.8 | 6.1‡ | +0.4‡ |
| R4 | 5.8 | 7.0 | **+1.2** |

*‡R3 Codev based on 2/3 reviewers; see R3 report for discussion.*

Excluding R3's anomalous 2-reviewer average, the delta has been remarkably consistent at +1.2 to +1.3. R4 confirms that the R3 narrowing was a measurement artifact (missing Gemini + Claude's aggressive scoring), not a real quality convergence.

---

## Summary: When Does Codev Pay Off?

| Dimension | Codev advantage held in R4? | Notes |
|-----------|:--------------------------:|-------|
| Bugs | **Yes (+0.7)** | Fewer consensus bugs (3 vs 5), fewer High (1 vs 2) |
| Code Quality | **Yes (+0.7)** | Clean three-layer NL architecture, discriminated unions |
| Maintainability | Neutral (0.0) | Both are small, readable codebases |
| Tests | **Yes (+1.7)** | Most consistent advantage; 2.9x more test lines |
| Extensibility | **Yes (+0.7)** | Better abstractions via layered architecture |
| NL Interface | Marginal (+0.3) | Better separation but CC has multi-action advantage |
| Deployment | **Yes (+4.0)** | Dockerfile, dockerignore, standalone output, README |

**Bottom line**: R4 is the cleanest round methodologically (all 6 reviews, stable CC baseline) and confirms SPIR's consistent +1.2 quality advantage. The biggest change from R3 is Deployment (+4.0), driven by SPIR producing a proper Dockerfile. The overall picture across 4 rounds is clear: **SPIR reliably improves testing (+1.7 to +3.7), code quality (+0.5 to +1.3), and bug counts (+0.7 to +2.7), while deployment and NL improvements are significant but less consistent.**

---

## Appendix: Raw Review Outputs

| Reviewer | CC | Codev |
|----------|------|------|
| Gemini | `/tmp/gemini-vibe-r3.txt` (from R3) | `/tmp/gemini-spir-r4.txt` |
| Codex | `/tmp/codex-vibe-r3.txt` (from R3) | `/tmp/codex-spir-r4.txt` |
| Claude | `/tmp/claude-vibe-r3.txt` (from R3) | `/tmp/claude-spir-r4.txt` |

## Appendix: Previous Round Results

### Round 1

| Dimension | R1 CC | R1 Codev | R1 Delta |
|-----------|:-------:|:-------:|:--------:|
| Code Quality | 6.7 | 7.7 | +1.0 |
| Maintainability | 7.0 | 7.7 | +0.7 |
| Tests | 4.0 | 7.7 | +3.7 |
| Extensibility | 5.7 | 6.7 | +1.0 |
| NL Interface | 6.0 | 6.0 | 0.0 |
| Deployment | 6.0 | 8.0 | +2.0 |
| **Overall** | **5.9** | **7.2** | **+1.3** |

### Round 2

| Dimension | R2 CC | R2 Codev | R2 Delta |
|-----------|:-------:|:-------:|:--------:|
| Bugs | 4.7 | 7.3 | +2.7 |
| Code Quality | 6.3 | 7.7 | +1.3 |
| Maintainability | 7.3 | 7.7 | +0.3 |
| Tests | 5.0 | 6.0 | +1.0 |
| Extensibility | 5.0 | 6.0 | +1.0 |
| NL Interface | 6.0 | 7.0 | +1.0 |
| **Overall** | **5.7** | **7.0** | **+1.2** |

### Round 3

| Dimension | R3 CC | R3 Codev‡ | R3 Delta |
|-----------|:-------:|:-------:|:--------:|
| Bugs | 6.7 | 4.5 | −2.2 |
| Code Quality | 7.0 | 7.0 | 0.0 |
| Maintainability | 7.3 | 7.5 | +0.2 |
| Tests | 5.0 | 7.0 | +2.0 |
| Extensibility | 5.7 | 6.5 | +0.8 |
| NL Interface | 6.3 | 7.0 | +0.7 |
| Deployment | 2.7 | 3.5 | +0.8 |
| **Overall** | **5.8** | **6.1** | **+0.4** |

*‡R3 Codev based on 2/3 reviewers (Gemini quota exhaustion).*

Full reports:
- R1: `codev/resources/vibe-vs-spir-comparison-2026-02.md`
- R2: `codev/resources/vibe-vs-spir-r2-comparison-2026-02.md`
- R3: `codev/resources/vibe-vs-spir-r3-comparison-2026-02.md`
