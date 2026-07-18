# PIR Review: Ship Codex Skills Through the Scaffold Lifecycle

Fixes #1196

## Summary

Codev now ships a Codex-native skill tree alongside its Claude skill tree and
materializes both during init, adopt, and update. Existing skill directories
remain user-owned, while recursive parity tests prevent the two provider trees
from silently drifting.

## Files Changed

GitHub's canonical PR scope contains 59 files. The large root
`.codex/skills/**` addition came from the contributor commit that preceded PIR
initialization; it is part of the upstream PR because that commit is not on
`cluesmith/codev:main`.

- `.codex/skills/**` (+6,558 / -0) — self-hosted Codex mirror.
- `codev-skeleton/.codex/skills/**` (+611 / -0) — seven shipped Codex skills.
- `.claude/skills/codev/SKILL.md` and
  `codev-skeleton/.claude/skills/codev/SKILL.md` (+4 / -4) — lifecycle and
  preservation documentation mirrored into the new Codex trees above.
- `packages/codev/src/lib/scaffold.ts` (+35 / -28) — provider-qualified skill
  copy results and per-skill preservation.
- `packages/codev/src/commands/{init,adopt,update}.ts` (+17 / -19) — install,
  backfill, and report both provider paths.
- `packages/codev/src/__tests__/{skill-parity,scaffold,init,adopt,update}.test.ts`
  (+178 / -20) — fresh install, preservation, backfill, structured output, and
  recursive parity coverage.
- `AGENTS.md` and `CLAUDE.md` (+8 / -2) — self-hosted directory map.
- `codev/plans/1196-ship-codex-skills-in-the-skele.md`,
  `codev/state/pir-1196_thread.md`, and porch state — protocol artifacts.
- `codev/resources/arch.md` and `codev/resources/lessons-learned.md` — current
  materialization architecture and durable parity/preservation guidance.
- `codev/reviews/1196-ship-codex-skills-in-the-skele.md` (+109 / -0) — this
  retrospective and PR body.

Per dev-gate feedback, `codev-skeleton/templates/AGENTS.md` and
`codev-skeleton/templates/CLAUDE.md` are unchanged from upstream.

## Commits

- `25e1a000` add `.codex/skills/`
- `6bb0f58a` [PIR #1196] Plan draft
- `743a30e3` [PIR #1196] Scaffold Codex skills across lifecycle
- `e854fcf2` [PIR #1196] Guard provider skill parity and preservation
- `007d7f46` [PIR #1196] Record implementation verification
- `e2e18dfb` [PIR #1196] Keep skeleton instruction templates unchanged

Porch-generated phase and gate commits are also retained in branch history.

## Test Results

- Codev dependency/core/types/artifact/package build chain: ✓ pass
- Targeted lifecycle and parity tests: ✓ 58 tests
- Full default unit suite: ✓ 3,525 executed tests; 48 existing skips
- Porch implement checks: ✓ build and tests
- Built-CLI smoke test: ✓ fresh init installs both trees; adopt and update
  preserve customized Codex bytes while restoring a missing Codex skill
- Human dev approval: ✓ approved after reviewing the worktree

The full suite was run with isolated `HOME` and `TMPDIR` because the host's
global Codex configuration and `/tmp/.git` otherwise alter unrelated harness
and workspace-root tests.

## Architecture Updates

Updated the COLD `codev/resources/arch.md` Installation Architecture section.
It now records that provider-native skills are the deliberate exception to
runtime-only framework resolution, describes independent per-provider
materialization/preservation, and names the recursive parity guard. No HOT
change was needed because the existing hot facts already establish the
runtime-resolution and dual-tree rules.

## Lessons Learned Updates

Added a COLD documentation lesson to
`codev/resources/lessons-learned.md`: when provider discovery requires physical
duplicates, compare inventories, paths, and bytes in CI through one explicit
exception allowlist, and preserve customizations at the complete-skill
directory boundary for each provider independently. This is useful reference
guidance but does not displace a HOT lesson.

## Things to Look At During PR Review

- `copySkills()` now returns provider-qualified relative paths. Verify init,
  adopt, and update all consume those paths consistently.
- The init/adopt module headers now distinguish materialized integration and
  governance files from framework files that continue to resolve at runtime.
- `skipExisting` protects the complete skill directory independently in each
  provider tree; it intentionally does not merge individual files.
- `PROVIDER_SPECIFIC_SKILL_EXCEPTIONS` starts empty and exempts a complete
  top-level skill only when a future provider-specific implementation is
  reviewed.
- The self-hosted root has ten skills, while the shipped skeleton has seven.
  Parity is enforced between providers within each context, not between the
  self-hosted and shipped inventories.
- The Codex consultation reported a 27-file scope because its local-main
  baseline already contained contributor commit `25e1a000`; GitHub's actual
  upstream PR file list contains 59 files, including that root Codex mirror.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1196` → **Review
  Diff**.
- **Build**:
  `pnpm --filter @cluesmith/codev-types build && pnpm --filter @cluesmith/codev-core build && pnpm --filter @cluesmith/codev-artifact-canvas build && pnpm --filter @cluesmith/codev build`
- **Targeted tests**:
  `pnpm --filter @cluesmith/codev exec vitest run src/__tests__/skill-parity.test.ts src/__tests__/scaffold.test.ts src/__tests__/adopt.test.ts src/__tests__/update.test.ts`
- **Verify preservation**: customize
  `.codex/skills/arch-init/SKILL.md` in a temporary adopted project, remove a
  different Codex skill, run the built `codev update --agent`, and confirm the
  customized bytes remain while the missing skill is restored and reported in
  `newFiles`.
