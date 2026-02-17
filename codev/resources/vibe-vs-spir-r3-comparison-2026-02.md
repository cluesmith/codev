# Claude Code vs. Codev: Todo Manager Comparison — Round 3

**Date**: 2026-02-17
**PRs**: [Claude Code PR #1](https://github.com/waleedkadous/todo-vibe-2026-r3/pull/1) | [Codev PR #1](https://github.com/waleedkadous/todo-spir-2026-r3/pull/1)
**Reviewers**: Claude Opus 4.6, GPT-5.3 Codex (Gemini 3 Pro attempted but quota-exhausted for SPIR)

## Methodology

Identical to Round 2, with one key change: **Deployment Readiness is reinstated as a scored dimension** (it was excluded in R2 because Dockerfile presence flipped randomly between rounds). All 7 dimensions are now scored: Bugs, Code Quality, Maintainability, Tests, Extensibility, NL Interface, and Deployment Readiness.

Both builders received the same base prompt (identical to R2, requiring Gemini 3.0 Flash as the NL backend). The Codev builder received the additional porch strict-mode addendum. Both ran as Claude instances with `--dangerously-skip-permissions` in fresh GitHub repos. Codev CLI version: v2.0.8+ (post-rebuttal mechanism).

**Reviewer limitation**: Gemini 3 Pro completed the Vibe review but failed the SPIR review due to persistent `MODEL_CAPACITY_EXHAUSTED` (429) errors after 3 retry attempts. The SPIR builder's heavy 3-way consultation activity during implementation consumed the Gemini quota. To maintain an apples-to-apples comparison, **averaged scores use only Codex + Claude** (the two reviewers that completed both reviews). Gemini's Vibe scores are reported individually but excluded from averages.

---

## Scorecard

### Individual Reviewer Scores

| Dimension | Codex (CC) | Claude (CC) | Gemini (CC) | Codex (Codev) | Claude (Codev) | Gemini (Codev) |
|-----------|:-----------:|:-----------:|:-----------:|:-----------:|:-----------:|:-----------:|
| Bugs | 7 | 6 | 8 | 8 | 3 | — |
| Code Quality | 6 | 7 | 8 | 7 | 7 | — |
| Maintainability | 6 | 7 | 9 | 7 | 8 | — |
| Tests | 4 | 5 | 6 | 7 | 7 | — |
| Extensibility | 5 | 5 | 7 | 6 | 7 | — |
| NL Interface | 5 | 6 | 8 | 6 | 8 | — |
| Deployment | 3 | 2 | 3 | 4 | 3 | — |

*Bug scores derived from each reviewer's bug sweep: severity-weighted count inverted to a 1-10 scale. Critical = -2, High = -1, Medium = -0.5, Low = -0.25 from a baseline of 10. Excludes .env (test setup artifact), accessibility observations, and items reviewers explicitly noted as "mitigated" or "safe in practice."*

### Averaged Scores (Codex + Claude only)

| Dimension | CC (avg) | Codev (avg) | Delta |
|-----------|:----------:|:----------:|:-----:|
| **Bugs** | 6.5 | 5.5 | **-1.0** |
| **Code Quality** | 6.5 | 7.0 | **+0.5** |
| **Maintainability** | 6.5 | 7.5 | **+1.0** |
| **Tests** | 4.5 | 7.0 | **+2.5** |
| **Extensibility** | 5.0 | 6.5 | **+1.5** |
| **NL Interface** | 5.5 | 7.0 | **+1.5** |
| **Deployment** | 2.5 | 3.5 | **+1.0** |
| **Overall** | **5.3** | **6.3** | **+1.0** |

### Round 1 vs Round 2 vs Round 3 Comparison

| Dimension | R1 CC | R2 CC | R3 CC | R1 Codev | R2 Codev | R3 Codev |
|-----------|:-------:|:-------:|:-------:|:-------:|:-------:|:-------:|
| Bugs | — | 4.7 | 6.5 | — | 7.3 | 5.5 |
| Code Quality | 6.7 | 6.3 | 6.5 | 7.7 | 7.7 | 7.0 |
| Maintainability | 7.0 | 7.3 | 6.5 | 7.7 | 7.7 | 7.5 |
| Tests | 4.0 | 5.0 | 4.5 | 7.7 | 6.0 | 7.0 |
| Extensibility | 5.7 | 5.0 | 5.0 | 6.7 | 6.0 | 6.5 |
| NL Interface | 6.0 | 6.0 | 5.5 | 6.0 | 7.0 | 7.0 |
| Deployment | 6.0 | (excl.) | 2.5 | 8.0 | (excl.) | 3.5 |

*R1 used all 3 reviewers for averages. R2 used all 3 reviewers. R3 uses Codex + Claude only (Gemini SPIR unavailable). R1 did not score bugs. R2 excluded deployment. R3 scores all 7 dimensions.*

### Quantitative Comparison

| Metric | CC | Codev |
|--------|:----:|:----:|
| Source lines (excl. tests) | 1,294 | 1,425 |
| Test lines | 342 | 1,474 |
| Test-to-code ratio | 0.26:1 | 1.03:1 |
| Test files | 2 | 16 |
| Test suites | 2 | 12 |
| Component tests | 0 | 3 files (362 lines) |
| Integration tests | 0 | 0 |
| Git commits | 2 | 18 |
| Documentation artifacts | 0 | spec + plan + review + 6 consultation files |
| `output: "standalone"` | No | Yes |
| Dockerfile | No | No |

---

## Bug Sweep Synthesis

### Claude Code Bugs (confirmed by 2+ reviewers)

| Bug | Severity | Found by | Description |
|-----|----------|----------|-------------|
| **No LLM action validation** | High | Codex, Claude | `route.ts:171-186`, `hooks.ts:88-136`: Gemini's JSON response checked only for `Array.isArray(actions)`. No schema validation of action payloads. Hallucinated or prompt-injected responses can inject arbitrary data into state. |
| **Stale todos closure / race condition** | High | Claude, Gemini | `hooks.ts:138-173`, `todo-store.ts`: `sendMessage` captures `todos` from render cycle. If user sends a chat message right after a manual mutation, Gemini operates on stale data. Gemini flagged the broader "read-modify-write" cycle with no multi-tab sync. |
| **NL list filters silently dropped** | Medium | Codex, Claude | `hooks.ts:118-124`, `todo-store.ts:95`: API schema supports `dueBefore`, `dueAfter`, `searchText` in list actions but the handler only applies `status` and `priority`. Date/text queries are silently ignored. |
| **Date format handling fragile** | Medium | All 3 | `TodoItem.tsx:24-39`: `new Date(dateStr + "T00:00:00")` breaks on non-`YYYY-MM-DD` formats. No guard for `Invalid Date`. LLM could return formats like `March 1` or ISO strings with timezone. |
| **localStorage quota not handled** | Low | Codex, Claude | `todo-store.ts:23-25`: `localStorage.setItem` can throw `QuotaExceededError`. Not caught. |

### Codev Bugs (confirmed by 2+ reviewers)

| Bug | Severity | Found by | Description |
|-----|----------|----------|-------------|
| **`loadTodos()` no schema validation** | High | Codex, Claude | `storage.ts:17-28`: Only checks `Array.isArray()`, trusts each element is valid `Todo`. Corrupt data propagates through the entire app. |
| **Rate limiter memory leak** | Medium-High | Codex, Claude | `rate-limit.ts:8-18`: `store` Map grows unboundedly per unique IP. No TTL-based cleanup. In production deployment, memory grows without limit. |

### Single-reviewer findings (notable)

| Bug | Severity | Reviewer | Codebase | Description |
|-----|----------|----------|----------|-------------|
| **`useTodos` stale return values** | Critical | Claude | Codev | `useTodos.ts:44-98`: `updateTodo`/`toggleTodo`/`deleteTodo` return values from inside the `setTodos` updater callback, but `setTodos` is asynchronous. Return values may be stale when called from async contexts (like the NL fetch callback). |
| **NL validation allows empty titles** | Medium | Codex | Codev | `nl-validation.ts:100-113`: Only checks `typeof title === "string"`, not non-empty. AI could create blank-titled todos. |
| **NL time context mismatch** | Medium | Codex | Codev | `NLInput.tsx:45-47`: Sends `timezone` as local TZ but `currentTime` as UTC. Relative date resolution ("tomorrow") could be off. |
| **No input length limits on NL API** | Medium | Claude | CC | `route.ts:96-112`: No max length on message or todos array. Cost amplification vector. |

### Cross-cutting: Shared Weaknesses

Both implementations share these problems:
- **Full todo list sent every request**: Token cost and latency grow linearly with todos. No truncation or summarization.
- **No conversation history**: Each NL request is standalone — "also make it high priority" doesn't work.
- **No multi-tab sync**: Neither listens for `storage` events.
- **No Dockerfile or Railway config**: Neither builder produced deployment infrastructure.
- **No E2E/Playwright tests**: Neither includes browser-level tests.
- **No XSS vulnerabilities**: React's auto-escaping protects both (unanimously confirmed).

### Bug Quality Assessment

R3 produced a reversal from R2: **Claude Code has a better bug profile than Codev** this round.

**By the numbers (consensus bugs only, excluding .env):**

| Metric | CC | Codev |
|--------|:----:|:----:|
| Total consensus bugs | 5 | 2 |
| High | 2 | 1 |
| Medium | 2 | 1 |
| Low | 1 | 0 |
| Critical (single-reviewer) | 0 | 1 |

**The Critical bug is the story.** Claude found a design-level flaw in SPIR's `useTodos` hook: the pattern of returning values from inside async `setTodos` updater callbacks creates a race condition. This is a fundamental React anti-pattern that manifests when mutations are called from async contexts (like the NL fetch handler). Vibe's simpler architecture — pure functions reading/writing localStorage directly, with React state as a derived view — avoids this class of bug entirely.

**Why did SPIR produce this bug while R2 didn't?** R2's Codev builder used a different state management approach (custom `useTodos` with filtering + `useChat` with separate state). R3's builder chose `useState` with updater callbacks and return values, a pattern that looks correct in synchronous React event handlers but breaks in async contexts. The 3-way consultation didn't catch this because it's a behavioral bug that only manifests during runtime — the same class of bug that survived consultation in R2.

**Codev has fewer consensus bugs (2 vs 5)** but the single-reviewer Critical finding is more architecturally significant than any individual CC bug. With only 2 reviewers completing the SPIR review (vs 3 for Vibe), the consensus threshold is harder to cross — some SPIR bugs that might have been consensus with 3 reviewers appear as single-reviewer findings.

**The shared blind spot persists**: Neither builder addresses scalability, conversation context, or rate limiting. This is consistent across all 3 rounds.

---

## Architecture Comparison

### Claude Code R3
- **State**: Pure functions in `todo-store.ts` — `loadTodos()`/`saveTodos()` operate on localStorage directly. `useTodos` hook is a thin wrapper with filtering/sorting. `useNLInterface` handles Gemini interaction separately. Simple, procedural, low abstraction.
- **NL**: Single API route sends user message + full todo list to Gemini, receives structured JSON actions via `responseMimeType: "application/json"`. Multi-action support (array of actions).
- **Storage**: Two bare functions — no error handling, no validation, no write-error recovery.
- **Components**: 5 UI components + `NLChat`, flat hierarchy.
- **Dependencies**: `@google/genai` only (minimal).

### Codev R3
- **State**: `useTodos` hook with `useState` + `useEffect`-based persistence. Centralized state management with filtering, sorting, CRUD. Return values from updater callbacks (source of the Critical bug).
- **NL**: Multi-layer architecture — `gemini.ts` (API call) → `nl-validation.ts` (request/response validation) → `nl-prompt.ts` (prompt construction) → `NLInput.tsx` (orchestration). 7-action discriminated union type with per-action validation. Includes `CLARIFY` action type.
- **Storage**: Typed storage layer (`storage.ts`) with `loadTodos`/`saveTodos`, but still no per-item validation.
- **Components**: 8 components including `ConfirmDialog`, `NLResponse`, `TodoFilters`, `EmptyState`.
- **Dependencies**: `@google/genai` + `vitest` + `@testing-library/*`.

**Key architectural advantage of Codev**: The NL validation pipeline. Request validation (`validateNLRequest`) checks message length, todos array structure, and timezone. Response validation (`validateNLResponse`) validates per-action with field-level checks and key stripping of unknown fields. The `CLARIFY` action type handles ambiguity gracefully. This is significantly more robust than CC's "check if it's an array" approach.

**Key architectural advantage of Claude Code**: Simpler state management that avoids async pitfalls. The pure-function storage layer with React state as a derived view is easier to reason about and doesn't suffer from the stale-return-value race condition. Also, multi-action responses allow "delete all completed" in a single LLM call.

---

## Test Quality Deep Dive

### Claude Code R3 (342 lines, 2 files)
- `todo-store.test.ts` (225 lines): CRUD operations, filtering, searching, sorting, error cases, persistence — thorough coverage of the data layer.
- `route.test.ts` (117 lines): Basic API validation (missing key, missing message, valid request). Gemini mocked.

**Not tested**: All 5 React components, hooks (`useTodos`, `useNLInterface`), NL action processing, edge cases (malformed LLM responses, JSON parse failures, Gemini API errors).

### Codev R3 (1,474 lines, 16 files, 12 suites)
- `nl-validation.test.ts` (330 lines): 25+ test cases for request and response validation, edge cases, key stripping, per-action-type validation.
- `useTodos.test.ts` (279 lines): Full CRUD, filtering, sorting, clear completed, toggle, persistence.
- `NLInput.test.tsx` (207 lines): Form interaction, API call mocking, response handling, error states.
- `nl.test.ts` (198 lines): API route covering all 7 response types, error scenarios, rate limiting, configuration errors.
- `TodoList.test.ts` (106 lines): Rendering, empty states, filtering display.
- `storage.test.ts` (94 lines): CRUD, localStorage failures, quota errors, corrupted data.
- `TodoForm.test.tsx` (77 lines): Form submission, validation, editing mode.
- `TodoFilters.test.tsx` (57 lines): Filter selection, clear filters.
- `nl-prompt.test.ts` (54 lines): Prompt construction, date injection, todo context.
- `rate-limit.test.ts` (34 lines): Rate limiting behavior.
- `polish.test.tsx` (28 lines): UI polish/smoke tests.
- `setup.test.ts` (10 lines): Environment verification.

**Not tested**: `page.tsx` (main composition), `NLResponse` component, `ConfirmDialog` component, `gemini.ts` client module, E2E flows.

### Test Comparison Across Rounds

| Metric | R1 CC | R2 CC | R3 CC | R1 Codev | R2 Codev | R3 Codev |
|--------|:-------:|:-------:|:-------:|:-------:|:-------:|:-------:|
| Test lines | 235 | 271 | 342 | 1,743 | 1,149 | 1,474 |
| Test files | 3 | 2 | 2 | 8 | 4 | 16 |
| Test-to-code ratio | 0.26:1 | 0.26:1 | 0.26:1 | 1.09:1 | 0.73:1 | 1.03:1 |
| Component tests | 0 | 109 lines | 0 | 288 lines | 0 | 362 lines |

CC's test-to-code ratio is strikingly consistent at 0.26:1 across all three rounds. Codev's ratio varies (1.09 → 0.73 → 1.03) but always significantly higher. R3 Codev restored component tests (absent in R2) and expanded to 12 test suites covering validation, components, hooks, API, and storage.

---

## NL Interface Comparison

| Capability | Claude Code R3 | Codev R3 |
|------------|:-------:|:-------:|
| Gemini Flash backend | **Yes** | **Yes** |
| Structured output format | **Yes** (`responseMimeType: json`) | **Yes** (`responseMimeType: json`) |
| Multi-action support | **Yes** (actions array) | No (single action) |
| Runtime validation of AI output | No (array check only) | **Yes** (per-action field validation + key stripping) |
| Request validation | No | **Yes** (message length, todos structure, timezone) |
| Ambiguity resolution | No (first match) | **Yes** (`CLARIFY` action type) |
| Rate limiting | No | **Yes** (in-memory, IP-based) |
| Delete confirmation | No (immediate delete) | **Yes** (ConfirmDialog) |
| Context (todo list sent) | Full list | Full list |
| Conversation history | None | None |
| Markdown fence defense | No | **Yes** (fence stripping in API route) |

**Verdict**: Codev's NL architecture is substantially more robust. The validation pipeline (request → prompt → response → per-action validation) provides defense-in-depth against malformed LLM output. CC's pipeline (request → Gemini → trust the JSON) has no validation layer. Codev's `CLARIFY` action type and delete confirmation add safety. CC's multi-action support remains a useful capability Codev lacks.

---

## Deployment Readiness

| Aspect | CC | Codev |
|--------|:---:|:---:|
| `output: "standalone"` | No | **Yes** |
| Dockerfile | No | No |
| `railway.toml` | No | No |
| Health check endpoint | No | No |
| `PORT` env handling | Implicit (Next.js default) | Implicit |
| `.env.example` | **Yes** | **Yes** |
| Graceful missing API key | **Yes** | **Yes** |
| CI/CD pipeline | No | No |

Both codebases are equally undeployable. Neither builder produced a Dockerfile, Railway config, or health check endpoint despite the prompt mentioning deployment. Codev's `output: "standalone"` in `next.config.mjs` is the only deployment-relevant difference — it's necessary for containerized Next.js deployment but insufficient without a Dockerfile.

**Deployment Readiness remains consistently low across all 3 rounds.** R1 SPIR got 8.0 (it happened to produce a Dockerfile), R1 CC got 6.0. R2 excluded it as noise. R3 reinstates it and confirms: unless the prompt explicitly demands a Dockerfile and Railway config as acceptance criteria, builders don't produce them. A general "deployment readiness" requirement is insufficient to drive builder behavior.

---

## Reviewer Agreement Analysis

### Where both reviewers agreed:
- Codev has better NL validation architecture (validation pipeline praised by both)
- Codev has significantly more thorough testing (4.3x more test lines)
- Both lack deployment infrastructure (Dockerfile, health checks)
- Neither has XSS vulnerabilities
- Both send full todo list every request (scalability concern)
- Both lack conversation history
- CC's NL list filters are partially unimplemented (date/search ignored)
- Codev's `loadTodos` performs no per-item schema validation

### Where reviewers disagreed:
- **Codex gave Codev Bugs 8/10** while Claude gave **3/10**. Claude found a Critical `useTodos` hook design flaw (stale async returns) plus 4 High-severity findings. Codex found no High or Critical bugs (excluding .env). Claude's review was significantly more thorough (181s, 15 bugs vs. 96s, 7 bugs).
- **Claude rated Codev Maintainability 8/10** vs Codex at **7/10**. Claude credited the spec/plan documentation trail; Codex focused on coupling concerns in the NL flow.
- **Claude rated Codev NL Interface 8/10** vs Codex at **6/10**. Claude praised the 7-action discriminated union and delete confirmation; Codex penalized the timezone mismatch and empty-title validation gap.

### Gemini's optimism pattern (Vibe only):
Gemini's Vibe scores (8, 9, 6, 7, 8, 3) are consistently higher than Codex/Claude on every dimension except Deployment and Tests. This continues the R1/R2 pattern: Gemini weights "what exists and works well" while Codex/Claude weight "what's missing." Had Gemini completed the SPIR review, the averaged scores would likely shift both baselines up without significantly affecting the delta.

### Claude's thoroughness asymmetry:
Claude found 12 bugs in CC and 15 bugs in SPIR (including 1 Critical and 4 High). Codex found 8 in CC and 7 in SPIR (no Critical, no High excluding .env). Claude's thorough review of SPIR penalizes the derived Bug score heavily, creating the -1.0 delta on Bugs. This is a genuine finding (the `useTodos` race condition is real), but the magnitude is amplified by Claude finding many more borderline issues in SPIR than CC.

---

## Key Takeaways

### 1. SPIR's testing advantage is consistent and large
Tests Delta: +2.5 (largest positive delta). Across all 3 rounds: R1 +3.7, R2 +1.0, R3 +2.5. The consultation process and phased implementation consistently produce more thorough test suites. R3 Codev has 4.3x more test lines, 8x more test files, and covers validation, components, hooks, API routes, and storage — while CC only tests the storage layer and basic API validation.

### 2. SPIR can introduce bugs that simpler code avoids
For the first time, SPIR has a worse Bug score (-1.0). The Critical finding — `useTodos` returning stale values from async `setTodos` callbacks — is a real React anti-pattern that CC's simpler pure-function architecture avoids entirely. This suggests that SPIR's consultation process catches *structural* bugs (wrong API usage, missing validation) but not *design-level* bugs in the patterns the builder chooses. The hook-with-return-value pattern looks correct to a static reviewer — it only fails at runtime in specific async contexts.

### 3. NL validation is SPIR's most consistent advantage
NL Interface Delta: +1.5 (second-largest positive delta). The validation pipeline, `CLARIFY` action type, and delete confirmation are features that only emerge from a structured specification process. CC consistently produces a "call Gemini, trust the JSON" approach with no validation layer.

### 4. Deployment Readiness is noise unless explicitly specified
R3 confirms the R2 hypothesis. Both builders scored 2-4/10 on deployment. Neither produced a Dockerfile despite the prompt mentioning Railway. Deployment readiness requires explicit acceptance criteria ("you MUST produce a Dockerfile with multi-stage build and a railway.toml"), not a general quality aspiration.

### 5. SPIR's overall advantage is remarkably stable
| Round | SPIR Delta |
|-------|:----------:|
| R1 | +1.4 |
| R2 | +1.2 |
| R3 | +1.0 |

The overall delta narrows slightly each round (potentially as Claude Code improves or as the prompt gets more refined) but remains consistently positive. SPIR leads on 6 of 7 dimensions in R3, losing only on Bugs. The investment in specification, planning, and consultation reliably produces better code quality, maintainability, extensibility, testing, and NL robustness.

### 6. Gemini quota exhaustion is a real operational concern
SPIR's consultation-heavy process (spec review × 3 models, plan review × 3 models, phase reviews) consumed enough Gemini quota to prevent the independent Gemini review from completing. This is a practical cost of the 3-way consultation model that should be factored into experiment design. Future rounds should either use API keys with higher quotas or stagger SPIR consultations and reviews.

---

## Summary: When Does Codev Pay Off?

| Dimension | Codev advantage held in R3? | Delta | Notes |
|-----------|:--------------------------:|:-----:|-------|
| Bugs | **No** (-1.0) | ⬇️ | Critical hook design bug in SPIR; simpler CC code avoided this |
| Code Quality | Marginal (+0.5) | ➡️ | Both produced clean TypeScript; SPIR's extra layers add slight quality |
| Maintainability | **Yes** (+1.0) | ⬆️ | Spec/plan docs, more modular architecture |
| Tests | **Yes** (+2.5) | ⬆️ | 4.3x more test lines, 8x more test files, much broader coverage |
| Extensibility | **Yes** (+1.5) | ⬆️ | Better abstractions, typed validation layer |
| NL Interface | **Yes** (+1.5) | ⬆️ | Validation pipeline, CLARIFY action, delete confirmation |
| Deployment | Marginal (+1.0) | ➡️ | `standalone` output only; both lack Dockerfile/health checks |

Codev leads on 6 of 7 scored dimensions. The +1.0 overall delta (6.3 vs 5.3) represents a consistent quality advantage that has held across 3 independent rounds. The R3 surprise — SPIR's worse bug profile due to a design-level hook bug — highlights that consultation catches structural bugs but not behavioral/async bugs, and that more complex architectures have more surface area for subtle design flaws.

---

## Appendix: Raw Review Outputs

| Reviewer | CC | Codev |
|----------|------|------|
| Gemini | `/tmp/gemini-vibe-r3.txt` | N/A (429 quota exhaustion) |
| Codex | `/tmp/codex-vibe-r3.txt` | `/tmp/codex-spir-r3.txt` |
| Claude | `/tmp/claude-vibe-r3.txt` | `/tmp/claude-spir-r3.txt` |

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
| **Overall** | **5.9** | **7.3** | **+1.4** |

Full Round 1 report: `codev/resources/vibe-vs-spir-comparison-2026-02.md`

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

*R2 excluded Deployment as noise. R2 overall includes Bugs.*

Full Round 2 report: `codev/resources/vibe-vs-spir-r2-comparison-2026-02.md`

### Cross-Round Delta Summary

| Dimension | R1 Delta | R2 Delta | R3 Delta | 3-Round Avg |
|-----------|:--------:|:--------:|:--------:|:-----------:|
| Bugs | — | +2.7 | -1.0 | +0.8 |
| Code Quality | +1.0 | +1.3 | +0.5 | +0.9 |
| Maintainability | +0.7 | +0.3 | +1.0 | +0.7 |
| Tests | +3.7 | +1.0 | +2.5 | +2.4 |
| Extensibility | +1.0 | +1.0 | +1.5 | +1.2 |
| NL Interface | 0.0 | +1.0 | +1.5 | +0.8 |
| Deployment | +2.0 | (excl.) | +1.0 | +1.5 |
| **Overall** | **+1.4** | **+1.2** | **+1.0** | **+1.2** |

*Positive delta = Codev advantage. 3-round averages use only dimensions scored in that round.*
