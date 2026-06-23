# PIR #1018 — Builder worktree write-guard

## Phase: plan (iteration 1)

### What this is
Deterministic PreToolUse guard so a builder's Write/Edit cannot silently land
files in the main checkout (outside its worktree). Root cause is model/CLI
path-synthesis drift, so only a runtime guard holds; instructions are a backstop.

### Investigation findings
- Builder sessions launch via `startBuilderSession()` (spawn-worktree.ts:724) which
  `cd`s into the worktree and runs the bare `claude` command — no `--settings` flag.
- The ONLY existing pattern for injecting per-worktree files is
  `HarnessProvider.getWorktreeFiles()` (harness.ts:44) + `writeWorktreeFiles()`
  (spawn-worktree.ts:679). OpenCode uses it for `opencode.json`.
- `getWorktreeFiles(roleContent, roleFilePath)` currently does NOT receive the
  worktree absolute path → plan extends the signature so the Claude harness can
  bake an absolute hook command path + worktree root.
- `writeWorktreeFiles` writes via `writeFileSync` (no mkdir) → must add mkdir -p
  because `.claude/hooks/` doesn't exist in a fresh worktree (only `.claude/skills/`).
- No committed `.claude/settings.json` in repo → use `.claude/settings.local.json`.
- `roles/builder.md` is byte-identical in `codev/roles/` and `codev-skeleton/roles/`
  (8623 bytes) → backstop edit must mirror both.
- Build is `tsc` only (no asset copy) → emit the guard as a TS string constant
  (single source), unit-tested by writing it to a tmp .cjs and spawning it.

### Key design decisions
- Guard authored as a self-contained Node `.cjs` (portable, no jq dep), emitted
  into `.claude/hooks/worktree-write-guard.cjs`.
- Worktree root baked in via env at spawn time (deterministic) with
  `git rev-parse --show-toplevel` as runtime fallback.
- Allowlist: temp dirs (`/tmp`, `/private/tmp`, `$TMPDIR`) + `$HOME/.claude`
  (so memory + claude config writes still work). realpath both sides (macOS
  `/tmp`→`/private/tmp`).
- Scope: Write/Edit only (reads unaffected → cross-checkout reads preserved);
  Claude harness only (PreToolUse is Claude-specific).
- #1092 (consult read surface) is a SIBLING issue — note the reuse seam, leave
  out of scope, surface to human at gate.

### Scope decision (at plan-approval gate)
Q: should the guard also protect architect terminals from modifying main?
A (human): keep #1018 builder-scoped.
Rationale to record in review Lessons Learned:
- The hook is generated only into builder worktrees (builder-spawn path);
  architect sessions launch via buildRoleInjection in the main checkout and
  never receive it → zero impact on architects.
- The guard enforces "writes stay inside the worktree"; an architect's tree IS
  main, and modifying main is its job (Pre-Spawn Rule, committed→integrated gate).
  Same hook on an architect = structural no-op (root resolves to main checkout).
- Architects are LESS prone to the path-synthesis bug (no .builders/ segment to
  drop). The only analog (architect writing INTO .builders/*) is lower severity
  and a separate concern, not folded in here.

### Status
Plan drafted → awaiting plan-approval gate. (architect-scope question resolved: builder-only)

## Phase: implement (iteration 1) — complete, awaiting dev-approval

Implemented as planned:
- `packages/codev/src/agent-farm/utils/worktree-write-guard.ts` (new) — single
  source of truth: `WORKTREE_WRITE_GUARD_SCRIPT` (self-contained Node `.cjs`) +
  `buildWorktreeGuardFiles(worktreePath)`. Baked-in `CODEV_WORKTREE_ROOT` env,
  `git rev-parse` fallback, fail-open on error. Allowlist: /tmp, /private/tmp,
  $TMPDIR, $HOME/.claude.
- `harness.ts` — extended `getWorktreeFiles` signature with `worktreePath`;
  `CLAUDE_HARNESS` now emits the guard files.
- `spawn-worktree.ts` — `writeWorktreeFiles` now `mkdir -p`s the target dir
  (needed for `.claude/hooks/`); both call sites pass `worktreePath`.
- Both `builder.md` (codev/ + skeleton, mirrored) — path-discipline backstop.

Tests: new `worktree-write-guard.test.ts` (14 cases incl. git fallback, deny
shape, allowlist, non-existent nested path) + updated `harness.test.ts` contract
(CLAUDE_HARNESS now HAS getWorktreeFiles).

Checks: `npm run build` ✓ (exit 0), `npm test` ✓ (3358 passed, 0 failed).
Note: full `npm run build` must run before `npm test` — the terminal
session-manager *integration* tests need the built shellper binary; without the
build they fail to connect (environmental, not related to this change).

## Phase: review (iteration 1)

dev-approval approved by human. Wrote review retrospective; routed COLD governance
updates (arch.md write-guard subsection + 3 lessons-learned entries). HOT tiers
untouched (capped/full). Opening PR next; porch verify runs single-pass 3-way
consult (advisory). Then wait at pr gate for human merge.

### PR #1098 + consultation outcome
3-way (single pass): gemini=APPROVE, claude=APPROVE, codex=REQUEST_CHANGES.
Codex caught a real gap: guard only emitted in role-bearing spawn branches, so
no-role Claude builders bypassed it. FIXED — role-independent
`installHarnessWorktreeFiles` helper wired into all 4 fresh-spawn branches
(startBuilderSession + buildWorktreeLaunchScript, role + no-role) + 2 regression
tests in spawn-worktree.test.ts (no-role test fails pre-fix). resume path
intentionally excluded (existing worktree already guarded). Claude's shallow-merge
note deferred (near-zero risk). Build+test green (3360 passed). Dispositions in
codev/projects/1018-*/1018-review-iter1-rebuttals.md.

### Status: pr gate PENDING (iter1)
Architect notified (led with REQUEST_CHANGES + fix). Waiting for human to merge +
approve pr gate. Will NOT merge until porch reports gate_status: approved.

### Linux CI failure + fix (architect-flagged)
CI red on Linux: 3 deny-tests in worktree-write-guard.test.ts allowed-as-pass.
Root cause = TEST FIXTURE, not the guard: fixtures lived under os.tmpdir(), which
is /tmp on Linux, and the guard correctly allowlists /tmp → the fake
"outside-worktree" path was allowlisted. Guard already realpaths both sides;
verified the compiled guard DENIES a literal non-/tmp path (Linux-equivalent).
Production worktrees never live under /tmp → guard always correct in prod.
Fix: anchor fixtures under packages/codev/node_modules/.cguard-fixtures
(gitignored, never allowlisted, literal path). Kept /tmp allow-tests.
Re-verified: build ✓, test ✓ (3360), CI GREEN on dfd0f264 (Tests + CLI).
CMAP-3 re-run (iter2, architect-directed): codex=APPROVE, claude=APPROVE,
gemini=skipped (agy timeout, non-blocking). No REQUEST_CHANGES remaining.

### Status: pr gate PENDING (iter2) — CI green, CMAP-3 clear
Waiting for human to review PR #1098 + approve pr gate. Will NOT merge until
porch reports gate_status: approved.
