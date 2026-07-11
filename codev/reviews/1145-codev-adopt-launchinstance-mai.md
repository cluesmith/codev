# PIR Review: launchInstance no longer hijacks unrelated Claude sessions

Fixes #1145

## Summary

`codev adopt` (or Tower's first-touch `launchInstance`) on a machine where the user had ever chatted with Claude Code in that directory booted the "main architect" *inside the user's personal conversation* — with no architect role, since the resume path skips role injection. The cause was the #832 legacy-bridge fallback: gated on `getArchitects().length <= 1`, which a fresh workspace (zero rows) satisfies, it ran newest-jsonl-by-mtime discovery over `~/.claude/projects/<encoded-cwd>/` and resumed whatever it found. The fallback is now removed outright (not re-gated — mtime cannot distinguish the architect's last session from a newer personal one in the same cwd): architect resume comes exclusively from the session id stored on the workspace-scoped architect row, validated by a new harness-gated existence check (`session.verifyOwnership`) so a stale stored id degrades to a fresh spawn instead of a `--resume` crash-loop. Builder resume (mtime discovery in Agent-Farm-managed worktree cwds) is unchanged.

## Files Changed

- `codev/plans/1145-codev-adopt-launchinstance-mai.md` (+91 / -0)
- `codev/resources/arch.md` (+1 / -1)
- `codev/resources/lessons-learned.md` (+2 / -1)
- `codev/state/pir-1145_thread.md` (+35 / -0)
- `packages/codev/src/agent-farm/__tests__/claude-session-discovery.test.ts` (+76 / -38)
- `packages/codev/src/agent-farm/__tests__/tower-instances.test.ts` (+59 / -16)
- `packages/codev/src/agent-farm/__tests__/tower-utils.test.ts` (+70 / -11)
- `packages/codev/src/agent-farm/servers/tower-instances.ts` (+21 / -28)
- `packages/codev/src/agent-farm/servers/tower-utils.ts` (+42 / -7)
- `packages/codev/src/agent-farm/utils/claude-session-discovery.ts` (+47 / -4)
- `packages/codev/src/agent-farm/utils/harness.ts` (+17 / -4)

(plus porch-managed `codev/projects/1145-*/status.yaml`)

## Commits

- `f5910e67` [PIR #1145] Verify Claude session ownership before any resume
- `0ee53387` [PIR #1145] Remove architect jsonl-discovery fallback in launchInstance
- `b10e71d6` [PIR #1145] Update tests: ownership verification, fresh-boot regression
- `6fc3636c` [PIR #1145] Make the cwd scan streaming: semantic, not byte-offset-bound
- `00284f3f` [PIR #1145] Narrow ownership verification to file existence; drop content scanning
- `7515cbfe` [PIR #1145] Comment: point at sibling resumption via the reconcile loop

(`6fc3636c` and `00284f3f` reflect dev-approval-gate feedback; the streaming scanner introduced by the former was removed by the latter — see Things to Look At.)

## Test Results

- `pnpm build`: ✓ pass
- `pnpm test` (full `@cluesmith/codev` suite): ✓ 3451 passed, 48 skipped (pre-existing skips, none added)
- Touched test files: 109 tests, ~20 new/updated cases, including the #1145 regression ("fresh workspace + personal Claude session in the same cwd → boots fresh, no `--resume`") and the preserved #929 codex guard
- Manual verification: the reviewer worked the change over at the `dev-approval` gate through iterative design review (fallback scope, multi-architect resumption, verification necessity); the end-to-end fresh-adopt scenario is scripted below for the PR reviewer

## Architecture Updates

Routed to **COLD** `codev/resources/arch.md` (Agent Farm Internals): rewrote the stale "Conversation resume is Claude-main-only" paragraph as "Architect conversation resume is stored-id-only (#832 / #1145)" — documenting the new invariant (stored row id + existence verification, no discovery on any architect path, discovery is builder-only) and an explicit "do not reintroduce discovery on architect paths" warning with the reason. Not HOT-tier material: it's an agent-farm-internal invariant, not a cross-cutting fact that changes day-to-day implementation choices, and the hot file is at its cap.

## Lessons Learned Updates

Routed to **COLD** `codev/resources/lessons-learned.md`:

- **Architecture**: gate a legacy-bridge fallback on positive evidence of the legacy state it bridges, never on absence of conflict (`length <= 1` is satisfied by zero rows, turning the bridge into default behavior for fresh installs); and enumerate the concrete threat behind each protective layer before defending it — the cwd-content scan defended only path-encoding collisions that Agent-Farm's own path conventions preclude.
- **Testing**: never assert CLI flags via substring over a stringified spawn call — the injected role prompt legitimately contains flag strings like `--resume` in its CLI examples; assert on argv tokens.

Not HOT-tier: both are situation-specific recipes, not behavior-changing cross-cutting rules; the hot file is at its cap.

## Things to Look At During PR Review

- **Deviation from the approved plan.** The plan specified cwd-*content* ownership verification (reading the `cwd` recorded inside the session jsonl), per the issue's fix sketch. At the `dev-approval` gate the reviewer walked this back in three steps: content scanning defended only lossy-encoding collisions; the fixed scan window made resume content-dependent; and collisions are contrived for both architects (row-gated, ids minted by us) and builders (Agent-Farm-managed worktree paths). Final shape is existence-only verification. The intermediate streaming scanner (`6fc3636c`) was added and then removed (`00284f3f`) as part of that walk-back, so the net diff never contains it.
- **`verifySessionOwnership` checks two directory encodings** (logical and `realpath`'d) because Claude keys its store by process cwd, which the OS reports in physical form for symlinked paths (macOS `/tmp` → `/private/tmp`). Covered by a dedicated symlink test.
- **Degradation semantics**: a `global.db` read failure, a missing session file, or a throwing harness check all resolve to *fresh spawn* — the deliberate direction is "never resume on uncertainty". Fresh spawns mint and persist a new id, so the row self-heals.
- **Legacy pre-#832 rows** (row exists, no stored id) now spawn fresh once instead of discovery-resuming — a one-time context loss for workspaces dormant since #832, accepted in plan review.
- **The name `session.verifyOwnership`** slightly overstates what it now does (existence check). The reviewer was offered a rename (`isResumable`) and did not take it up; flagging in case the PR reviewer feels differently.

### Consultation Verdicts and Dispositions (single advisory pass — PIR does not re-review)

- **Codex: REQUEST_CHANGES** — (1) "implementation drops the approved cwd-based ownership verification; the collision vector remains for builder resume" and (2) "tests for the dropped ownership cases are missing". **Rebutted**: this is the deviation documented above, directed explicitly by the human reviewer at the `dev-approval` gate after a three-step design walk-back; the plan text was deliberately not rewritten to retro-fit the outcome (deviations belong in this review file). The collision vector requires two distinct absolute paths that encode identically AND host codev workspaces/worktrees with matching ids — contrived for Agent-Farm-managed paths, and the reviewer judged the content scan complexity not worth that threat. The dropped tests tested the dropped behavior. (3) "plan file missing approved-plan YAML frontmatter" — **fixed**: frontmatter plus a post-approval deviation note added to the plan file.
- **Claude: COMMENT** — implementation solid; one real finding: an editing error in `lessons-learned.md` merged the unrelated `[From 1144]` lesson into the new `[From #1145]` bullet. **Fixed**: split back into two bullets with the `[From 1144]` attribution restored.
- **Gemini: skipped** (non-blocking) — `agy` CLI not installed on this machine.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1145` → **View Diff**
- **Run locally**: `pnpm build && pnpm -w run local-install` (restarts Tower)
- **What to verify** (maps to the plan's Test Plan):
  1. Create a scratch project dir (no `codev/`), run `claude` in it briefly and exit — this plants the "personal session" jsonl for that cwd.
  2. From the scratch dir, run `codev adopt` and start the workspace (or open in VS Code with auto-adopt).
  3. The main architect terminal must open a **fresh** conversation (architect role active, no prior chat context); Tower's log must not print "Resuming architect 'main' …".
  4. `afx workspace stop` then `start`: the architect must now resume its **own** stored session ("Resuming architect 'main' session …" with the minted id).
  5. Optional multi-architect check: `afx workspace add-architect --name reviewer`, stop/start, confirm both `main` and `reviewer` resume their own conversations.
