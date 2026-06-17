# PIR Review: Support `codex` and `gemini` CLIs as architects

Fixes #929

## Summary

Brings the OpenAI `codex` and Google `gemini` CLIs to parity with `claude` as Codev **architects**, selectable via `.codev/config.json` (`shell.architect` / `shell.architectHarness`). The core fix routes session-discovery + `--resume` argument construction behind a new optional `HarnessProvider.buildResume` capability, eliminating a latent crash-loop where a non-Claude architect (or resumed builder) with any stale Claude `.jsonl` built an invalid `<cmd> --resume <claude-uuid>` invocation and shellper restart-looped to death. Gemini additionally gets a write-if-absent `.gemini/settings.json` so it launches with project context (`AGENTS.md`), and `doctor` now affirms codex/gemini architect support.

## Files Changed

Resume seam + gemini context (initial implementation):
- `packages/codev/src/agent-farm/utils/harness.ts` — `buildResume?` + `getArchitectFiles?` on the interface; `CLAUDE_HARNESS.buildResume` (delegates to `findLatestSessionId`); `GEMINI_HARNESS.getArchitectFiles` (`.gemini/settings.json`)
- `packages/codev/src/agent-farm/servers/tower-instances.ts` — architect resume gated on `getArchitectHarness(...).buildResume?.()`; fresh path delegates context-file writing to `buildArchitectArgs`
- `packages/codev/src/agent-farm/commands/spawn.ts` — `discoverResumeSession` takes the builder harness, returns the bundled resume object; both call sites pass `getBuilderHarness(...)`; distinct "harness does not support resume" log (nit 2)
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts` — `startBuilderSession`'s `resumeSessionId?: string` → `resume?: { sessionId, scriptFragment }`; script emits the pre-escaped fragment
- `packages/codev/src/commands/doctor.ts` — affirm codex/gemini architect support; single resolved-harness check

Integration-review fixes (architect punch list — 2 blockers + 3 nits):
- `packages/codev/src/agent-farm/utils/config.ts` — **BLOCKER B**: `getArchitectHarness`/`getBuilderHarness` now auto-detect from the *override-aware* command (`getResolvedCommands`); `getResolvedCommands.architect` honors `TOWER_ARCHITECT_CMD`
- `packages/codev/src/agent-farm/servers/tower-utils.ts` — **BLOCKER A**: exported `writeArchitectContextFiles`, called from the shared `buildArchitectArgs` so every launch path writes gemini's manifest; **nit 1**: (see tower-instances) WARN gated on resume support
- `packages/codev/src/agent-farm/commands/architect.ts` — **BLOCKER A**: no-Tower path refactored to call `buildArchitectArgs` (was duplicating injection)
- `.gitignore`, `packages/codev/src/lib/gitignore.ts` — **nit 3**: ignore `.gemini/settings.json` (repo + managed adopter list)

Tests:
- `packages/codev/src/agent-farm/__tests__/tower-instances.test.ts` — architect resume-skip regression guard + gemini `getArchitectFiles` write-if-missing/no-clobber
- `packages/codev/src/agent-farm/__tests__/spawn-worktree.test.ts` — builder resume script uses escaped `scriptFragment`; codex/gemini → fresh script
- `packages/codev/src/agent-farm/__tests__/discover-resume-session.test.ts` — harness-arg threading; codex/gemini null-return + claude bundled-object cases
- `packages/codev/src/agent-farm/__tests__/config.test.ts` — **BLOCKER B regression**: override-aware harness resolution (TOWER_ARCHITECT_CMD / --architect-cmd / --builder-cmd → non-claude harness, no `buildResume`)
- `packages/codev/src/agent-farm/__tests__/tower-utils.test.ts` — **BLOCKER A regression**: `writeArchitectContextFiles` gemini write + no-clobber + claude no-op
- `packages/codev/src/agent-farm/__tests__/af-architect.test.ts` — updated mocks for the `buildArchitectArgs` delegation
- `packages/codev/src/__tests__/gitignore.test.ts`, `update.test.ts` — managed-entry expectations include `.gemini/settings.json`

Docs / artifacts:
- `codev/resources/arch.md` — supported-architect-harnesses + Claude-only-resume + override-aware resolution + `getArchitectFiles` centralization
- `codev/plans/...`, `codev/reviews/...`, `codev/state/pir-929_thread.md`, `codev/resources/lessons-learned.md`, `codev/projects/929-*/status.yaml`

## Commits

- `69cf20de` [PIR 929][Phase: implement] feat: harness-gated session resume for codex/gemini architects
- `53374f30` [PIR #929] Plan revised — address architect feedback (5 issues)
- `fdddc7e2` [PIR #929] Plan draft

## Test Results

- `pnpm build`: ✓ pass (clean TS types)
- `pnpm vitest run` (full suite): ✓ 3338 passed, 48 skipped, 0 failures
- Manual verification: empirical codex/gemini lifecycle validation (clean + stale-jsonl launch, add-architect, `afx send` multiline/interrupt/streaming, reconnect, affinity, builder `--resume`, dashboard scrollback) was exercised by the human at the `dev-approval` gate against the running worktree — the reason PIR was chosen over AIR/BUGFIX. The architect's subsequent **integration review** caught the two override/path-dependency blockers below (fixed + regression-tested in this PR).

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
- **Override-aware harness resolution precedence (BLOCKER B fix)**: `getResolvedCommands.architect` is now `cliOverrides.architect || TOWER_ARCHITECT_CMD || config`. Within the Tower process `cliOverrides` is empty (it's set in the spawning `afx` process, not the long-lived server), so this matches the launch site's `TOWER_ARCHITECT_CMD || config`. An explicit `shell.architectHarness` / `shell.builderHarness` still wins over auto-detection by design — so a *deliberately* contradictory `architectHarness: claude` + gemini command is the user's call, not auto-resolved. Worth a sanity check that this precedence reads as intended.
- **`getArchitectFiles` centralization (BLOCKER A fix)**: moved the inline write out of `launchInstance` into the shared `buildArchitectArgs` (`writeArchitectContextFiles`), and refactored the no-Tower `architect.ts` to call `buildArchitectArgs` instead of duplicating role injection. Confirm the no-Tower path's arg shape is unchanged (covered by `af-architect.test.ts`) and that the claude resume path — the one path that does *not* call `buildArchitectArgs` — correctly needs no context files (claude has no `getArchitectFiles`).
- **Known caveat — unrecognized override commands still default to the claude harness (follow-up: cluesmith/codev#1062).** Surfaced by codex in the 3-way re-review and verified by the architect. The BLOCKER B fix makes *recognized* override commands (claude/codex/gemini/opencode) resolve the right harness, but `resolveHarness` (`harness.ts`) still falls through to `CLAUDE_HARNESS` for an **unrecognized** override command (e.g. `TOWER_ARCHITECT_CMD=bash` or a wrapper script) when no explicit `shell.architectHarness` / `shell.builderHarness` is set — so it can still attempt `<cmd> --resume <uuid>` against a stale Claude `.jsonl`. This is **pre-existing, narrow, and separable** (not a #929 regression — #929 strictly improved the recognized cases), dispositioned as document + follow-up. Mitigation: set an explicit harness for unrecognized launcher commands. Documented in `arch.md`'s #929 subsection; tracked in cluesmith/codev#1062.

## Consultation Findings & Dispositions

The PR diff was reviewed by a 2-way advisory CMAP pass after the integration-review fixes landed:

- **gemini: APPROVE** (HIGH confidence) — no issues.
- **codex: REQUEST_CHANGES** (MEDIUM) — *"`codev/plans/929-...md` has no YAML approval frontmatter (`approved:` / `validated:`)."*
  - **Disposition: REBUTTED (false positive).** The repo's frontmatter convention applies to artifacts the *architect pre-creates and pre-approves before spawning a builder* (CLAUDE.md: "When the architect creates and approves a spec or plan before spawning a builder, it must have YAML frontmatter…"). This plan was **builder-authored during the PIR plan phase and approved through porch's `plan-approval` gate** (recorded in `codev/projects/929-*/status.yaml`: `plan-approval: approved 2026-05-31`) — the gate *is* the approval record for builder-authored plans. None of the existing merged plans in `codev/plans/` carry that frontmatter either (verified: `0001`–`0009` start with a `#` heading / `## Metadata`, no `approved:` key). Adding a self-authored `approved:`/`validated:` block would *fabricate* an approval record that porch already holds authoritatively. No code change warranted. **Escalated to the human at the `pr` gate per PIR single-pass policy.**

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
