# Builder pir-1536 — thread log

Issue #1536: extend the #1018 worktree write-guard to Bash (reads/executions, not just writes).

## PLAN phase (2026-08-22)

- Investigated the #1018 guard: single source of truth is
  `packages/codev/src/agent-farm/utils/worktree-write-guard.ts` — the emitted `.cjs`
  string (`WORKTREE_WRITE_GUARD_SCRIPT`) + `buildWorktreeGuardFiles()` (settings matcher
  `Write|Edit|MultiEdit`). Wired into spawn via `harness.ts:174` (`getWorktreeFiles`).
- Guard currently derives ONE root (worktree). Main checkout = worktree minus the trailing
  `/.builders/<id>` — cheap to derive in the hook.
- Architect pre-plan notes: (1) the ONLY open gate decision is the escape-hatch shape —
  present options + recommendation + failure modes; everything else in the fix sketch is
  settled. (2) Self-test by pipe-testing the emitted `.cjs` with synthetic JSON + extending
  the vitest suite; my own live hook came from the INSTALLED package, editing source won't
  change my session. (3) cwd-instability observation is out of scope.
- Wrote plan to `codev/plans/1536-builder-bash-commands-can-sile.md`. Escape-hatch
  recommendation: **Option B — per-command sentinel comment** (`# codev:allow-main-checkout`),
  non-sticky, loud, auditable. Rejected A (sticky env toggle — reintroduces the silent hole).
  C (no hatch) offered as a strict fallback.
- Files to change: guard source (`.cjs` + matcher + doc), its test, harness.test.ts matcher
  assertion, and the worktree-discipline prose in BOTH builder role docs.
- Irony noted: I am a builder subject to the exact trap I'm fixing; keeping verification
  commands relative / worktree-absolute.

## PLAN gate — Option D consultation (2026-08-25)

Owner floated Option D (warn-don't-block, no hatch) as a new option. Architect asked for
feedback + empirical mechanism verification before the owner rules.

VERIFIED (Claude Code 2.1.241, on-box): a warning DOES reach the model on an ALLOWED Bash
call. Behavioral proof — wired live PreToolUse(allow+additionalContext) and
PostToolUse(additionalContext) hooks with mandatory "append token X" advisories; the model's
final reply contained BOTH ACK_PRE and ACK_POST tokens. So D is viable.
- Use PreToolUse.additionalContext (documented + confirmed) — SAME hook the guard installs.
- PostToolUse.additionalContext also works empirically but is UNDOCUMENTED (version-fragile).
- permissionDecisionReason on allow does NOT reach the model; systemMessage = user/UI notice.
Test scaffolding in scratchpad/hooktest, hooktest2.

Recommendation to owner: B narrowly (~60/40), D a legitimate close second (now confirmed
viable, and less code than B). Decision frame: bound the failure (B — deny can't be
rationalized away, self-concealing class punishes ignorable advisories) vs reduce probability
at zero legit-block cost (D — graceful for deliberate main-reads, one-sentence false-positive
cost, but fails open). Full writeup sent to architect via afx --file (scratchpad/optionD_feedback.md).

Owner ruled OPTION B (banner-blindness + self-concealing-escalation-trigger args decisive).
plan-approval APPROVED.

## IMPLEMENT phase (2026-08-25)

Implemented Option B in the single source of truth (worktree-write-guard.ts):
- Emitted .cjs now branches: GUARDED_WRITE_TOOLS -> guardWrite (canonicalize-first, unchanged);
  Bash -> guardBash (lexical-first). New helpers: worktreeRootFor, mainCheckoutFor (strip
  /.builders/<id>), absoluteTokens (heuristic shell tokenizer, fail-open), emitDeny/denyBash.
- guardBash: per-command escape hatch (`codev:allow-main-checkout` sentinel, checked first);
  for each absolute token, LEXICAL worktree check first (allows worktree symlinks into main),
  then canonicalize + compare to worktree/main roots -> deny on main-but-outside-worktree.
  Deny message teaches (names both roots), does NOT advertise the sentinel.
- Matcher: Write|Edit|MultiEdit|Bash. Module doc updated. Both builder role docs updated (one
  bullet, mirrored codev/ + codev-skeleton/).
- Tests: 12 new Bash cases incl. the load-bearing symlink regression (Bash cat <worktree>/.env
  allows; Write to same denies). harness.test matcher assertion adds Bash. 87/87 pass.
- Verified: vitest 87 pass (the suite pipe-tests the exact emitted .cjs); full `pnpm --filter
  @cluesmith/codev build` green (standalone `tsc --noEmit` shows only unbuilt-dep errors in
  unrelated files, none in my diff).

D mechanism verification (reusable): PreToolUse.additionalContext on an ALLOW reaches the model
(documented + behaviorally confirmed on 2.1.241); PostToolUse.additionalContext works but is
undocumented; permissionDecisionReason on allow does NOT reach the model; systemMessage = UI
notice. -> capture in review artifact lessons (architect request).

Next: dev-approval gate.
