# Claude vs Codev: Comparative Evaluation Task

> A repeatable process for comparing plain Claude ("vibe coding") against Codev's SPIR protocol. Both builders receive the same application prompt. The resulting codebases are reviewed independently by three AI models (Claude, Codex, Gemini) across seven quality dimensions.

## The Prompt

Both builders receive this **identical base prompt**:

```
I want to build a Todo Manager application.

Requirements:
- Use Next.js 14+ with TypeScript and App Router
- Deploy-ready for Railway
- Store todos locally in the browser (localStorage or IndexedDB, no backend database)
- Features: Create, read, update, delete todos with priority levels (low/medium/high),
  due dates, and status (pending/completed)
- Include filtering by status and priority
- Include a fully powered natural language interface — users should be able to interact
  with their todos conversationally (e.g., "show me all high priority todos due this week",
  "mark the grocery shopping todo as done"). Use Gemini 3.0 Flash as the NL backend —
  do NOT use a simple grammar/regex parser. The NL interface should understand arbitrary
  phrasing, handle ambiguity, and support complex queries naturally.

Build this application completely. Create all files, install dependencies, and make sure
it compiles and tests pass.
```

The SPIR builder receives the same prompt **plus this addendum**:

```
CRITICAL: Use the SPIR protocol in STRICT MODE driven by porch. Start by running:
  porch init spir 0001 "todo-manager"
Then use `porch next 0001` to get your next task at every step. Follow porch's instructions
exactly. Use `consult` for 3-way multi-agent consultation at every checkpoint. Use
`porch done 0001` when implementation is complete. Do NOT skip any porch steps or gates.
```

## Phase 1: Setup

### 1.1 Create Two Empty GitHub Repos

```bash
gh repo create <org>/todo-vibe-2026 --public --clone
gh repo create <org>/todo-spir-2026 --public --clone
```

### 1.2 Initialize the SPIR Repo with Codev

```bash
cd /tmp/todo-spir-2026
codev init
```

This creates the `codev/` directory with protocols, templates, and skeleton files needed by porch.

### 1.3 Configure Both Repos for Autonomous AI

Create `.claude/settings.json` in both repos to allow all tool usage:

```json
{
  "permissions": {
    "allow": [
      "Bash(*)", "Read(*)", "Write(*)", "Edit(*)",
      "Glob(*)", "Grep(*)", "WebFetch(*)", "WebSearch(*)"
    ],
    "deny": []
  }
}
```

Commit the settings in both repos:

```bash
cd /tmp/todo-vibe-2026 && git add .claude/settings.json && git commit -m "Initial" && git push
cd /tmp/todo-spir-2026 && git add .claude/settings.json af-config.json codev/ CLAUDE.md AGENTS.md && git commit -m "Initial" && git push
```

### 1.4 Write Prompt Files

Save the base prompt and SPIR prompt to files:

```bash
# /tmp/vibe-prompt.txt — the base prompt exactly as above
# /tmp/spir-prompt.txt — the base prompt + SPIR addendum
```

### 1.5 Create Launcher Scripts

Claude sessions inside tmux inherit the `CLAUDECODE` environment variable, which causes a nesting error. The launcher scripts unset it:

```bash
cat > /tmp/start-vibe.sh << 'EOF'
#!/bin/bash
unset CLAUDECODE
exec claude --dangerously-skip-permissions
EOF

cat > /tmp/start-spir.sh << 'EOF'
#!/bin/bash
unset CLAUDECODE
exec claude --dangerously-skip-permissions
EOF

chmod +x /tmp/start-vibe.sh /tmp/start-spir.sh
```

**Important**: Do NOT embed the prompt in the launcher script. The prompt is sent separately via tmux paste-buffer. Embedding it causes double-sending.

## Phase 2: Run Both Builders

### 2.1 Launch tmux Sessions

```bash
tmux new-session -d -s vibe -c /tmp/todo-vibe-2026 '/tmp/start-vibe.sh'
tmux new-session -d -s spir -c /tmp/todo-spir-2026 '/tmp/start-spir.sh'
```

### 2.2 Send Prompts via Paste Buffer

```bash
# Send vibe prompt
tmux load-buffer /tmp/vibe-prompt.txt
tmux paste-buffer -t vibe

# Send SPIR prompt
tmux load-buffer /tmp/spir-prompt.txt
tmux paste-buffer -t spir
```

### 2.3 Monitor Progress

```bash
tmux attach -t vibe   # Watch vibe builder (Ctrl-B D to detach)
tmux attach -t spir   # Watch SPIR builder (Ctrl-B D to detach)
```

### 2.4 Wait for Completion

Both builders should:
1. Build the application
2. Run tests
3. Create a PR to the repo

**Expected duration**: Vibe ~15-30 min, SPIR ~45-90 min (consultation adds overhead at each checkpoint).

The SPIR builder will run 3-way multi-agent consultations (Gemini, Codex, Claude) at every porch checkpoint — this is where the quality advantage comes from, but it costs time and API quota.

## Phase 3: Review

### 3.1 Clone Repos for Review

```bash
git clone <vibe-repo-url> /tmp/todo-vibe-review
git clone <spir-repo-url> /tmp/todo-spir-review

# Checkout feature branches (check PR for branch name)
cd /tmp/todo-vibe-review && git checkout <feature-branch>
cd /tmp/todo-spir-review && git checkout <feature-branch>
```

### 3.2 Copy API Keys

```bash
cp /path/to/project/.env /tmp/todo-vibe-review/.env
cp /path/to/project/.env /tmp/todo-spir-review/.env
```

### 3.3 Run 6 Independent Reviews

Run `consult general` **from within each repo directory**. Never pass diffs — let reviewers read the files directly.

```bash
# All 6 can run in parallel (3 vibe + 3 SPIR)

# Vibe reviews
cd /tmp/todo-vibe-review && consult general --model gemini --output /tmp/gemini-vibe.txt "<PROMPT>"
cd /tmp/todo-vibe-review && consult general --model codex --output /tmp/codex-vibe.txt "<PROMPT>"
cd /tmp/todo-vibe-review && consult general --model claude --output /tmp/claude-vibe.txt "<PROMPT>"

# SPIR reviews
cd /tmp/todo-spir-review && consult general --model gemini --output /tmp/gemini-spir.txt "<PROMPT>"
cd /tmp/todo-spir-review && consult general --model codex --output /tmp/codex-spir.txt "<PROMPT>"
cd /tmp/todo-spir-review && consult general --model claude --output /tmp/claude-spir.txt "<PROMPT>"
```

### 3.4 Review Prompt Template

```
You are reviewing a Todo Manager application built with [plain Claude / the SPIR protocol].
Read all source files in this repo. Do a thorough review covering:

1) BUG SWEEP — identify all actual bugs, logic errors, edge cases,
   missing error handling, XSS risks, race conditions.
2) CODE QUALITY — architecture, separation of concerns, naming,
   type safety (rate 1-10).
3) MAINTAINABILITY — how easy to understand and modify (rate 1-10).
4) TESTS — extensiveness, usefulness, coverage gaps (rate 1-10).
5) EXTENSIBILITY — how easy to add auth, cloud sync, recurring todos,
   tags, undo/redo (rate 1-10).
6) NL INTERFACE — quality, edge cases, robustness (rate 1-10).
7) DEPLOYMENT READINESS — Railway config, Dockerfile (rate 1-10).

Be specific with file names and line numbers.
```

Adjust dimension 6 for the domain (NL interface in this case). For other apps, replace with the domain-specific quality dimension.

## Phase 4: Synthesize

### 4.1 Score Matrix

Collect all scores into a reviewer × dimension matrix:

| Dimension | Claude Vibe | Claude SPIR | Codex Vibe | Codex SPIR | Gemini Vibe | Gemini SPIR |
|-----------|:-----------:|:-----------:|:----------:|:----------:|:-----------:|:-----------:|

Average each dimension across the three reviewers.

### 4.2 Bug Consensus Analysis

Classify bugs by independent reviewer agreement:
- **High confidence**: Found by 2+ reviewers — these are real bugs
- **Single reviewer**: Found by only one — may be false positive or a unique catch
- **Cross-cutting**: Found in both codebases — shared weaknesses

### 4.3 Quantitative Metrics

| Metric | Vibe | SPIR |
|--------|:----:|:----:|
| Source lines (excl. tests) | | |
| Test lines | | |
| Test-to-code ratio | | |
| Test files | | |
| Component tests (lines) | | |
| Integration tests (lines) | | |
| Git commits | | |
| Documentation artifacts | | |
| Dockerfile present | | |

### 4.4 Write the Report

Create `codev/resources/<comparison-name>.md` covering:

1. **Methodology** — identical prompt, SPIR addendum, review process
2. **Scorecard** — individual scores, averages, deltas
3. **Bug sweep synthesis** — consensus bugs for each codebase
4. **Architecture comparison** — state management, NL approach, storage, components
5. **Test quality deep dive** — what's tested, what's not, test-to-code ratio
6. **Domain-specific comparison** — NL interface quality, feature coverage
7. **Deployment readiness** — Dockerfile, Railway config, CI/CD
8. **Reviewer agreement analysis** — where reviewers agreed/disagreed and why
9. **Key takeaways** — what SPIR bought, what it didn't, surprises

## Evaluation Criteria Reference

### 1. Bug Sweep
Identify actual defects: logic errors, missing error handling, silent failures, XSS/injection risks, race conditions, data corruption paths. Rate by severity (Critical / High / Medium / Low).

### 2. Code Quality (1-10)
Architecture, separation of concerns, naming conventions, type safety, module organization, dependency choices. Does the code follow the framework's idioms?

### 3. Maintainability (1-10)
Could a new developer understand and modify this codebase? Are there abstractions? Is the code DRY? Is there a documentation trail (specs, plans, reviews)?

### 4. Tests (1-10)
Coverage breadth (unit, component, integration, E2E), test quality (behavior vs implementation testing), test-to-code ratio, ability to catch regressions.

### 5. Extensibility (1-10)
How easy to add: authentication, cloud sync, recurring items, tags/categories, undo/redo? Does the architecture support these without major refactoring?

### 6. NL Interface (1-10)
Quality of natural language understanding, edge case handling, ambiguity resolution, date parsing, error messages. Does it use a proper NL backend (Gemini Flash) or fall back to regex/grammar parsing?

### 7. Deployment Readiness (1-10)
Dockerfile quality (multi-stage, non-root), platform config (Railway/Vercel), health checks, environment variable handling, CI/CD pipeline.

## Common Pitfalls

| Pitfall | Prevention |
|---------|------------|
| `CLAUDECODE` nesting error in tmux | `unset CLAUDECODE` in launcher scripts |
| Double-sending prompts | Use `tmux load-buffer` + `paste-buffer`, never embed prompt in launcher |
| Prompts differ beyond SPIR addendum | Write base prompt once, append SPIR instructions separately |
| SPIR builder ignores porch | Explicitly tell it `porch init`/`porch next`/`porch done` |
| Reviewers crash on large diffs | Run `consult` from within the repo directory — never pass diffs |
| `.env` not found by consult | Copy `.env` to each review directory |
| Gemini quota exhaustion | SPIR consultations burn quota fast; use API key, not free tier |
| Reviewers apply stale framework knowledge | Note version-specific false positives in report |
| NL falls back to regex | Prompt must explicitly require Gemini Flash, not grammar parser |

## Feb 2026 Results

The first run of this experiment produced:

| Dimension | Vibe (avg) | SPIR (avg) | Delta |
|-----------|:----------:|:----------:|:-----:|
| Code Quality | 6.7 | 7.7 | +1.0 |
| Maintainability | 7.0 | 7.7 | +0.7 |
| Tests | 4.0 | 7.7 | **+3.7** |
| Extensibility | 5.7 | 6.7 | +1.0 |
| NL Interface | 6.0 | 6.0 | 0.0 |
| Deployment | 6.0 | 8.0 | **+2.0** |
| **Overall** | **5.9** | **7.3** | **+1.4** |

Note: Both implementations used regex-based NL parsing despite the prompt requesting a conversational interface. Round 2 addressed this by explicitly requiring Gemini 3.0 Flash as the NL backend.

Full results: `codev/resources/vibe-vs-spir-comparison-2026-02.md`

## Feb 2026 Results — Round 2

The second run used an updated prompt explicitly requiring Gemini Flash (not regex). Also used codev v2.0.0-rc.69 with the stateful review/rebuttal mechanism (Issue #245).

Deployment excluded from scoring — it flipped randomly between rounds (SPIR had Dockerfile in R1, Vibe had it in R2), making it noise rather than signal.

| Dimension | Vibe (avg) | SPIR (avg) | Delta |
|-----------|:----------:|:----------:|:-----:|
| Bugs | 4.7 | 7.3 | **+2.7** |
| Code Quality | 6.3 | 7.7 | +1.3 |
| Maintainability | 7.3 | 7.7 | +0.3 |
| Tests | 5.0 | 6.0 | +1.0 |
| Extensibility | 5.0 | 6.0 | +1.0 |
| NL Interface | 6.0 | 7.0 | +1.0 |
| **Overall** | **5.7** | **7.0** | **+1.2** |

Key findings:
- Bugs is the largest delta (+2.7) — SPIR has fewer, less severe bugs (0 Critical vs 1 Critical)
- Both implementations successfully used Gemini Flash (the explicit prompt worked)
- SPIR's NL architecture (action executor + discriminated unions) rated higher
- SPIR leads on every scored dimension, overall delta +1.2
- The rebuttal mechanism (PR #246) was critical — without it, SPIR got stuck in a 5-iteration spec review loop

Full results: `codev/resources/vibe-vs-spir-r2-comparison-2026-02.md`
