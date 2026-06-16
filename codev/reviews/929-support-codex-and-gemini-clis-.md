# PIR Review: Support `codex` and `gemini` CLIs as architects

Fixes #929

## Summary

Brings the OpenAI `codex` and Google `gemini` CLIs to parity with `claude` as Codev **architects**, selectable via `.codev/config.json` (`shell.architect` / `shell.architectHarness`). The core fix routes session-discovery + `--resume` argument construction behind a new optional `HarnessProvider.buildResume` capability, eliminating a latent crash-loop where a non-Claude architect (or resumed builder) with any stale Claude `.jsonl` built an invalid `<cmd> --resume <claude-uuid>` invocation and shellper restart-looped to death. Gemini additionally gets a write-if-absent `.gemini/settings.json` so it launches with project context (`AGENTS.md`), and `doctor` now affirms codex/gemini architect support.

## Files Changed

- `packages/codev/src/agent-farm/utils/harness.ts` (+46 / -0) — `buildResume?` + `getArchitectFiles?` on the interface; `CLAUDE_HARNESS.buildResume` (delegates to `findLatestSessionId`); `GEMINI_HARNESS.getArchitectFiles` (`.gemini/settings.json`)
- `packages/codev/src/agent-farm/servers/tower-instances.ts` (+34 / -7) — architect resume gated on `getArchitectHarness(...).buildResume?.()`; writes `getArchitectFiles?()` if-missing on launch
- `packages/codev/src/agent-farm/commands/spawn.ts` (+25 / -17) — `discoverResumeSession` takes the builder harness, returns the bundled resume object; both call sites pass `getBuilderHarness(...)`
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts` (+14 / -11) — `startBuilderSession`'s `resumeSessionId?: string` → `resume?: { sessionId, scriptFragment }`; script emits the pre-escaped fragment
- `packages/codev/src/commands/doctor.ts` (+9 / -2) — affirm codex/gemini architect support; single resolved-harness check
- `packages/codev/src/agent-farm/__tests__/tower-instances.test.ts` (+152 / -0) — architect resume-skip regression guard + gemini `getArchitectFiles` write-if-missing/no-clobber
- `packages/codev/src/agent-farm/__tests__/spawn-worktree.test.ts` (+74 / -1) — builder resume script uses escaped `scriptFragment`; codex/gemini → fresh script
- `packages/codev/src/agent-farm/__tests__/discover-resume-session.test.ts` (+44 / -1) — harness-arg threading; codex/gemini null-return + claude bundled-object cases
- `codev/resources/arch.md` (+7 / -1) — supported-architect-harnesses + Claude-only-resume documentation
- `codev/plans/929-support-codex-and-gemini-clis-.md`, `codev/state/pir-929_thread.md`, `codev/projects/929-*/status.yaml` — protocol artifacts

## Commits

- `69cf20de` [PIR 929][Phase: implement] feat: harness-gated session resume for codex/gemini architects
- `53374f30` [PIR #929] Plan revised — address architect feedback (5 issues)
- `fdddc7e2` [PIR #929] Plan draft

## Test Results

- `pnpm build`: ✓ pass (clean TS types for the new optional methods)
- `pnpm vitest run` (3 affected files): ✓ pass (146 tests)
- Manual verification: empirical codex/gemini lifecycle validation (clean + stale-jsonl launch, add-architect, `afx send` multiline/interrupt/streaming, reconnect, affinity, builder `--resume`, dashboard scrollback) was exercised by the human at the `dev-approval` gate against the running worktree — the reason PIR was chosen over AIR/BUGFIX.

## Architecture Updates

**COLD (`codev/resources/arch.md`)** — updated in the implementation commit. Added a "Supported Architect Harnesses & Conversation Resume (#929)" subsection documenting: (1) claude/codex/gemini are all supported architects selected via `.codev/config.json` (not `TOWER_ARCHITECT_CMD`/`--architect-cmd`); (2) gemini's `.gemini/settings.json` → `AGENTS.md` context manifest; (3) conversation resume is Claude-main-only via `HarnessProvider.buildResume`, and the crash-loop it fixes. Also updated the role-injection step to point at the `HarnessProvider` per-CLI flags rather than the claude-only `--append-system-prompt`.

No **HOT** (`arch-critical.md`) change: the harness abstraction and its provider-method-extension pattern are already implied by the existing "Forge concept commands abstract the VCS provider — add a dedicated concept" entry's spirit; this PR extends an existing abstraction (Spec 591) rather than introducing a new always-on invariant, so a cold-tier reference detail is the correct routing.

## Lessons Learned Updates

**COLD (`codev/resources/lessons-learned.md`, Architecture section)** — added one lesson: when abstracting per-CLI behavior behind a provider, every call site that builds a CLI invocation must route through the provider — including resume/restart paths, not just the obvious fresh-launch path. The resume seam was the one path Spec 591 left harness-blind, and it only crash-loops on the `--resume` branch (fresh launches were already correct), which is why "builders already prove the path" didn't cover it.

No **HOT** (`lessons-critical.md`) change: the existing "Single source of truth beats distributed state" and "Model permissions as roles/capabilities, not booleans" hot entries already carry the general displace-when-full discipline; this is a spec-narrow recipe (audit *all* invocation seams when extending a provider) better suited to the cold archive.

## Things to Look At During PR Review

- **The `buildResume` bundling decision** (`harness.ts`): one method returns both the Node-argv `args` (for the `spawn()` architect site) and a shell-escaped `scriptFragment` (for the builder bash generator), mirroring `buildRoleInjection`/`buildScriptRoleInjection`. This deliberately avoids a second independently-optional method (which would force a `!` non-null assertion) and avoids `.join(' ')`-ing a raw argv into bash (word-split/quoting bug). Session ids are bare UUIDs today, so the escaping is belt-and-suspenders — kept for correct-by-construction consistency with the existing script-injection methods.
- **The `safeToResume` interaction** (`tower-instances.ts`): the new harness gate composes with the pre-existing sibling-collision guard (`safeToResume`, #832) — resume happens only when *both* the harness implements `buildResume` *and* no persisted siblings exist. Confirm the ordering reads correctly.
- **`getArchitectFiles` write-if-absent** (`tower-instances.ts`): writes `.gemini/settings.json` only when the target path doesn't exist, so a user's existing file is never clobbered. Test covers both the write and the no-clobber path.
- **Two documented out-of-scope override caveats** (plan Risks): `TOWER_ARCHITECT_CMD`/`--architect-cmd` (and the `--builder-cmd` analog) set a non-Claude command without a matching `.codev/config.json` harness still resolve the claude harness → would still attempt resume. These are the issue's explicit *nice-to-have* ("command-aware harness resolution"); MVP fixes the config-driven path (all acceptance criteria target it) and documents the override caveat rather than expanding scope.

## How to Test Locally

For reviewers pulling the branch:

- **View diff**: VSCode sidebar → right-click builder `pir-929` → **Review Diff**
- **Run dev server**: `afx dev pir-929`
- **What to verify** (needs codex & gemini installed; set `shell.architect` accordingly):
  - `afx workspace start` main architect launches with a **stale Claude `.jsonl` present** in `~/.claude/projects/<encoded-cwd>/` — must NOT crash-loop, and no `--resume` in the launched command (primary regression target)
  - `afx architect` (no-Tower) + `afx workspace add-architect` launch with role injected
  - gemini: `.gemini/settings.json` written with `context.fileName: "AGENTS.md"` (pre-existing one untouched)
  - `afx send` single-line / multi-line (>3 lines) / `--interrupt` / while streaming
  - `afx spawn <id> --resume` on a non-Claude builder → fresh launch + resume notice, inspect `.builder-start.sh` for no `--resume <claude-id>`
