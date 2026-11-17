# Review: Bootstrap the governance docs from an existing codebase

## Summary

A new, re-runnable `codev bootstrap-docs` command drafts the four governance docs (hot `arch-critical.md` / `lessons-critical.md`, cold `arch.md` / `lessons-learned.md`) from a codebase and its git history. It launches the configured agent interactively in a new **bootstrap mode** of the `update-arch-docs` skill: the project's installed copy when it matches the package, the packaged text inlined into the prompt otherwise. At the owner's request the PR also makes `codev update` refresh unedited shipped skills (#1811), so that installed copy is current. The CLI owns everything deterministic: per-file eligibility, change detection, mechanical validation, a 3-way review of the drafts, and the "review before commit" summary. `codev adopt` offers the pass after its conflict-merge session exits, and `codev update` prints a hint. The work shipped in six plan phases, all committed on this branch. The pass never commits or reverts anything.

## Spec Compliance

- [x] Real pre-existing repo yields four project-specific files with no slots, `_No … yet._` lines or `STARTER:` text: see **Real-repo verification** below (review phase)
- [x] Each hot file passes the section-scoped hot cap: validator `validateHotFile` (Phase 1), run by `bootstrap-docs` after every session (Phase 4)
- [x] Each hot map passes map validity (map → real cold `## ` section always; full coverage only when the cold doc has ≤12 sections) (Phase 1)
- [x] Cold `arch.md` describes the real system shape with no file enumeration, changelog, aspirational content or sensitive material: content contract in the skill's bootstrap mode plus the new all-modes sensitive-material rule (Phase 2), checked by the human in the real-repo run below
- [x] A curated governance file changing, HEAD/index changing, or any other path changing is named and exits non-zero; nothing is reverted (Phase 4, `lib/tree-snapshot.ts`)
- [x] Re-run on a populated result: no change, no agent, "nothing needs bootstrapping" (Phase 4; also in the real-repo run)
- [x] The pass never commits, stages or pushes; it ends with a "review before commit" summary listing files and validation result (Phase 4)
- [x] 3-way review of the drafts, outputs saved under `.consult/bootstrap-docs/`, each unavailable/failed reviewer named, `consult` missing degrades to a warning (Phase 5)
- [x] `adopt` on an empty repo leaves placeholders and offers nothing (Phase 6)
- [x] `adopt -y` never launches the bootstrap agent; it lists `codev bootstrap-docs` under Next steps (Phase 6; verified on a scratch repo)
- [x] `adopt` never runs two agent sessions at once: the offer appears only after the merge session exits (Phase 6)
- [x] The validator flags leftover slot/marker, over-cap section, map entry naming a missing cold section, an eligible file left unwritten (Phase 1/4). It also flags empty sections (a carry-forward from phase_1) and a dropped guidance comment (review phase)
- [x] Unsupported or missing harness: nothing launched, placeholders kept, prompt written to `.consult/bootstrap-docs/prompt.md`, manual instructions printed (Phase 3/4)
- [x] Both trees updated; the skill change is in all four shipped copies with parity tests green (Phase 2/6)
- [x] Unit tests cover the classifier (seeded lessons, half-edited starter), the non-empty-repo rule, the validator (cap counting, map direction, >12-section cold docs), the change report and the no-op re-run (Phases 1, 4)

### Real-repo verification (spec test scenario 18)

Run on 2026-10-13 against `sindresorhus/execa` (a real, pre-existing repo with 877 commits). The command was the branch build (`codev adopt -y`, then `codev bootstrap-docs`). Because `bootstrap-docs` awaits an interactive session and a builder has no human at a terminal, the run went through a pty (`script`), and the configured agent was a wrapper that runs `claude -p --dangerously-skip-permissions "$@"`. Everything else was the production path: eligibility, the confirm prompt, prompt rendering, the git digest, change detection, validation, the 3-way draft review and the summary.

- **Result:** all four files were written with execa-specific content. `arch.md` has 12 sections: method factory, async/sync spines, options normalization, Windows command resolution, stdio model, termination, IPC and more. `lessons-learned.md` has 12 sections, each traced to fix commits. Each hot file has 10 entries plus a 12-entry map that names every cold section, in 27 lines. No slot lines, `_No … yet._` lines or `STARTER:` text remained. The three seeded universal lessons were kept.
- **Validator and detection:** "validation passed" for all four files; "No changes outside the eligible files"; nothing was staged or committed.
- **Draft review:** Codex and Claude reviewed, and Gemini was named as skipped (agy produced no output). Both reviewers found real accuracy errors in the drafts. For example, `maxBuffer` was described as terminating the subprocess (it only destroys the stream), and Unix `killDescendants` was described as never signalling after exit. Codex also questioned the three seeded universal lessons taking hot slots; their survival is the architect's spec-gate ruling. Both reviewers confirmed no sensitive material. This is the intended division of labour: the agent drafts, the reviewers check claims against the code, and the human decides.
- **Re-run:** all four files classified as curated, "Nothing needs bootstrapping", exit 0, no agent launched, all four files byte-identical (shasum).
- **Finding, fixed in this phase:** both hot drafts dropped the starter's cap/displacement guidance comment entirely. The skill says to keep it (minus the `STARTER:` sentence), the spec's "hot-file shape" requires it, and neither reviewer noticed. The validator now reports `missing-guidance` when a draft lacks any line of the starter's comment other than the `STARTER:` sentence, and the session prompt states the rule next to "leave no starter text", which is what the agent appears to have over-applied. Re-validating the real execa drafts with the new check flags both hot files.
- **Not verified:** a real human-driven interactive session. The interactive Yes/No path is unit-tested only, and so is the `adopt` offer with a merge session.

Runs 1 and 2 used the CLI-built git digest, since removed (see Deviations).

**Run 2, on the code after integration review round 1.** Fresh clone of `sindresorhus/execa`, built at d42fc36b3 (the round-1 fixes; the later merge from `main` touched no file this feature uses). Same pty and headless driver as run 1.

- **Result:** all four files written, validation passed under the stricter checks (`missing-guidance` included), and "No changes outside the eligible files"; exit 0 (the post-review re-snapshot found nothing). This time both hot files kept the starter's guidance comment, with only the `STARTER:` sentence removed: arch-critical.md and lessons-critical.md are 32 lines each. `arch.md` and `lessons-learned.md` hold 12 sections each. The three seeded lessons were kept.
- **Draft review:** Codex and Claude reviewed, and Gemini was named as skipped. Both again found claims to tighten before commit: IPC `serialization: 'json'` limits, Windows `.com` handling and escaping, and sync `timeout`. Both found the drafts clean of sensitive material.
- **Re-run:** "Nothing needs bootstrapping", exit 0, no agent launched, all four files byte-identical (shasum).
- **Not verified, unchanged:** a human-driven interactive session. Main is asking the owner for one interactive launch from the branch build.

**Run 3, on the team-review code (skill refresh and the installed skill, no digest).** Fresh clone of `sindresorhus/execa` (891 commits), branch build of bc6331a12 plus the round-3 symlink fix (which touches no code this path runs). It was played as an older adopter: after `codev adopt -y`, `.claude/skills/update-arch-docs/SKILL.md` was replaced with `main`'s pre-branch version, which has no bootstrap mode. Same pty and headless driver as runs 1 and 2.

- **Before update:** `bootstrap-docs --dry-run` said it would inline the packaged skill "because the installed copy at `.claude/skills/update-arch-docs/` is an older version (`codev update` refreshes it)".
- **`codev update --agent`:** `updated: [".claude/skills/update-arch-docs/"]`, and no other skill touched. The CLAUDE.md/AGENTS.md `.codev-new` copies are the existing follow-up.
- **Bootstrap:** the launch statement said "It follows the installed skill at .claude/skills/update-arch-docs/", and the prompt named the skill instead of inlining it. The agent's transcript shows it called `Skill("update-arch-docs")`, then explored history with the skill's commands (`git log -n 100`, a scar-tissue grep that it widened with its own words, the churn hot-spot pipeline, `git show` on specific commits), then wrote the four files. All four passed validation, there were "No changes outside the eligible files", and the exit code was 0. `lessons-learned.md` holds 9 sections traced to fix commits, and both hot files kept the guidance comment (31 and 28 lines).
- **Draft review:** Codex and Claude reviewed, and Gemini was named as skipped. As before, they found claims to correct before commit (the method-factory description, an over-absolute PID rule, the sync `all` path). Claude checked for sensitive material first and found the drafts clean.
- **Re-run:** "Nothing needs bootstrapping", exit 0, all four files byte-identical.

**Run 4, on the deeper history guidance (c979579f6).** Fresh clone of `sindresorhus/execa`, branch build with the new survey step, `adopt -y` then `bootstrap-docs`, same pty and headless driver.

- **The agent followed the new guidance.** It loaded the installed skill, read the release tags, counted commits per year, sampled the 2024 and 2019 eras along the first-parent line, ran a scar-tissue grep with its own words (hang, leak, crash, unhandled, flaky, harden), searched for removals and renames, and used `git show` on the commits behind specific lessons (prototype pollution, cross-spawn). execa has no CHANGELOG, so there was none to read.
- **Result:** all four files passed validation, there were "No changes outside the eligible files", and the exit code was 0. `arch.md` has 12 sections and `lessons-learned.md` has 11. The hot files are 32 and 31 lines, with the guidance comment kept.
- **Draft review:** all three reviewers ran this time, Gemini included.
- **Re-run:** "Nothing needs bootstrapping", exit 0, all four files byte-identical.

**Run 5, on the trimmed survey step (2515db3b0).** Fresh clone of `sindresorhus/execa`, same driver. The skill named the sources and gave no commands.

- **The agent still covered every source, with commands it chose:** release tags and the commits between majors (v1 to v10), merge commits with their bodies, commits per year and the earliest commits, fix and revert searches plus its own vocabulary (windows, hang, leak, zombie, detach), deleted paths, churn since 2024, `git log -S` on removed APIs, and `git show` on about 15 commits behind specific lessons.
- **Result:** all four files passed validation, there were "No changes outside the eligible files", and the exit code was 0. All three reviewers ran. The hot files are 32 lines each.
- **Re-run:** "Nothing needs bootstrapping", all four files byte-identical.

## Deviations from Plan

- **Phase 1:** none of substance. `hot-tier.test.ts` now imports the shared cap/map helpers instead of keeping its own copies.
- **Phase 3:** prompt args are `['--', prompt]`, not the plan's literal `[prompt]`. CMAP showed that a variadic or optional-value flag in the user's configured command (`--add-dir`, `--resume`) swallows a bare trailing prompt. Both CLIs were verified to honour `--`. Per-harness launch blockers moved to a provider-level `interactiveLaunchBlocker?(flags)` hook, replacing a name-keyed if-chain. Codex blocks all its subcommands, `mcp-server` included.
- **Phase 4:**
  - A hot placeholder whose cold doc is **missing** is held back (its map would have nothing to point at) and reported with the `codev update` hint.
  - A 100 KB prompt-size guard falls back to the manual prompt file.
  - `lib/tree-snapshot.ts` handles cases the plan did not anticipate: re-keying paths for a project in a repo subdirectory, an unborn HEAD shown as `(no commits)`, and symlinks hashed by target.
  - The non-git walk honours the root `.gitignore`, following the plan after an iter1 detour.
  - The parent ignores SIGINT while the agent owns the terminal, so Ctrl-C inside the session cannot kill the CLI before it prints its report.
- **Phase 5:** the reviewer set is fixed at gemini/codex/claude (`REVIEW_MODELS`) and ignores `porch.consultation.models`. This was outside the plan; a follow-up item is listed below. The summary prints **before** the review, and reviewer edits to the drafts are detected by re-hashing.
- **Phase 6:**
  - Eligibility (classify, hold back, eligible, non-empty) moved into `lib/governance-bootstrap.ts` (`classifyProjectGovernance`, `bootstrapEligibleFiles`, `shouldOfferBootstrap`) so adopt, update and bootstrap-docs share one definition.
  - `adopt` briefly returned the bootstrap's exit code. Integration review reversed this (see the review phase below).
  - `adopt -y` does not await the merge session (there is nothing to sequence after it). The plan claimed `codev/resources/commands/` had no skeleton twin, but `codev-skeleton/resources/commands/codev.md` and `overview.md` exist, so both trees were updated.
  - `instructions.bootstrapDocs` in `update --agent` JSON is verified manually only, because `cli.ts`'s JSON builder is duplicated in `update.test.ts` (pre-existing).
- **Side fix, not phase work:** `agent-farm/__tests__/cloud-config.test.ts` set its 0644 precondition with an explicit `chmodSync`. Under a `umask 077` shell it failed deterministically and blocked porch's test check (d15693931).
- **Review phase, PR consultation and integration review round 1:**
  - Re-snapshot after the draft review. Anything the reviewers changed is named and fails the run: drafts, source, HEAD, the index (Codex). Before, it was only printed for governance files.
  - The git digest gets a fence it cannot close (`fenceFor`), and `missing-guidance` accepts the closing `-->` on the last kept line (Claude).
  - Symlinked or non-regular governance paths are classified with lstat as curated, never eligible, and named in the per-file status. Governance hashes now cover the resolved content as well as the link target, so a write through a symlink pointing outside the repo is caught (main, item 1).
  - The four shipped starter templates are pinned by hash. A change fails with "append the previous text to EARLIER_STARTERS" (main, item 2).
  - Main ruled that `adopt` exits 0 once adoption succeeds. A failing bootstrap pass is reported in a yellow line, not propagated; `codev bootstrap-docs` run directly keeps its non-zero exit (main, item 3).
  - `spawnAgentProcess` / `AgentExit` moved to `lib/agent-process.ts`, and `CONSULT_OWNED_PREFIXES` to `lib/tree-snapshot.ts` (consult re-exports it). `adopt` loads `bootstrap-docs` lazily, so `cli.ts`'s lazy import is effective again (main, item 4).
- **Review phase (real-repo run 1):** the validator gained a `missing-guidance` check, and the bootstrap prompt gained an explicit keep-the-guidance-comment rule. Both came from the real-repo run (above). Tests: `governance-bootstrap.test.ts` (4 new), fixtures in `bootstrap-docs.test.ts` updated.
- **Review phase, team review (waleedkadous), at the owner's direction:**
  - The CLI-built git digest is gone. The agent explores history itself with read-only git commands, guided by a new paragraph in the skill's bootstrap-mode survey step (recent log, a scar-tissue grep, churn hot spots, `git show` / `git log -S`). This deviates from the spec's "bounded window of the git log" in the prompt: the reviewer's experience is that tools plus guidance beat a pre-cooked digest, and the CLI's fixed regex and count could not fit every repo.
  - The prompt's session rules that restated the skill (write only listed files, no git writes, no secrets, guidance comment, map form, seeded lessons, finish clearly) are gone. The prompt now carries only the file lists, a one-paragraph session note and the skill source.
  - #1811, delivered here: `codev update` refreshes shipped skills (`lib/skill-refresh.ts`). A skill whose content hash matches a shipped version is replaced; an edited skill keeps its content and gets `<file>.codev-new` copies that join update's merge session on every update while it differs (owner ruling: the CLAUDE.md behaviour, no lock file). `--force` replaces edited skills; a symlinked skill directory is left alone. The shipped history is generated from git (`scripts/generate-shipped-skill-hashes.mts`, 124 versions of 21 skills) and pinned by a test.
  - `bootstrap-docs` then names the installed skill when the launching harness's copy (`.claude/` or `.codex/`) is identical to the package's version, and inlines the packaged text otherwise, saying why (missing, older, edited, not a directory, or a prompt saved for a manual run). The launch statement and `--dry-run` name the source.
- **Review phase, integration review round 3 (main, head 9dd499ad9):**
  - `codev update --dry-run` now previews skills: `refreshSkills` takes `dryRun`, classifies exactly as a real run and writes nothing. Added, updated, conflict and skipped are all reported, including under `--force`.
  - `--force` on an edited skill overwrites the package's files and keeps any file the package does not ship. It used to delete them; before this PR `--force` never touched skills. A skill that matches a shipped version is still replaced as a whole, since every file in it is shipped content.
  - The edited path now drops a `.codev-new` once its file matches the package again.
  - Other changes:
    - A test ties the skill's cap numbers to `HOT_CAP_ENTRIES` / `HOT_CAP_MAP_TOPICS` / `HOT_CAP_LINES`.
    - The inline fallback reads the launching harness's copy of the skill (`.claude/` when there is none).
    - The hash generator is `pnpm --filter @cluesmith/codev generate-skill-hashes`.
    - The codev skill's local-build section warns that `codev update` in this repository with an older installed package treats unpublished skill edits as local edits. It writes `.codev-new` copies of the older text, and `--force` overwrites the edits. Main's wording was "reverts"; it does that only under `--force`.
  - **Deliberate:** a file the package newly adds to an **edited** skill arrives only as `<file>.codev-new`, never as the file itself. Edited means the user owns the skill's shape, and a new file can change what the skill does (another reference loaded, another step). Whether it belongs is the merge's call, the same as a changed file. An unedited skill gets new files directly, because it is replaced as a whole. Tested.
- **Review phase, integration review round 4 (main's ruling, head 49d0403d6):** `codev update --dry-run` wrote `CLAUDE.md.codev-new` / `AGENTS.md.codev-new` (pre-existing), and `--dry-run --force` created a missing CLAUDE.md / AGENTS.md. `copyRootFiles` now takes `dryRun`, and update reports new / updated / conflict with "would be" wording and writes nothing. Tests cover the file contents and the absence of `.codev-new` after both kinds of dry run. Main's note said `--dry-run --force` overwrote CLAUDE.md outright. It did not: without `handleConflicts`, `copyRootFiles` skips existing files, so it could only create a missing one. That was still a write. An audit of the rest of `update` for unguarded writes under dry run found none: migration, hot and cold tiers, the managed block and the gitignore backfill each honour it, and the PR-gate audit only reads.
- **Review phase, owner direction (history depth):** the bootstrap-mode history guidance was too shallow. The last 100 raw commits cover about 9 days of this repository. It now also covers:
  - the project's own record first (CHANGELOG, release notes, ADRs, annotated tags);
  - recent direction one line per PR, using `--first-parent`, with merge-commit PR titles read from the commit bodies. Squash-merge repositories such as execa have almost no merge commits, so `--merges` alone would find nothing. On this repository, 100 first-parent PR merges span about two months;
  - a sample of older eras (commits per year, then a pivotal year, then the first commits);
  - removed areas, from deleted paths grouped by directory, plus the commit that removed one.

  Each command was tried on the execa clone and on this repository before it went into the skill.
- **Review phase, owner direction (history verbosity), head 2515db3b0:** the survey step then listed an exact command for each source. The owner asked whether the agent should get the tools and choose the commands itself, in line with the team review's "give the agent tools" point. Run 3, under the earlier short command list, showed the agent did not need the syntax: it already widened the grep with its own words. It did need the sources named, because it did not reach older eras, removals or the project's own record until they were. The step now names the sources and leaves the commands to the agent. The one mechanic kept is that PR titles live in merge bodies, since that is easy to miss. Run 5 checked the result. Main was merged in first (lessons-learned.md conflict resolved by keeping both sides' entries), and the shipped-skill hash table was regenerated for main's afx and porch skill changes.
- **Review phase, owner's manual adopt (empty skill folders):** the owner adopted a real project with the branch build. Every skill folder under `.claude/skills/` and `.codex/skills/` was empty, so git showed no skills. An earlier install's files had been removed and the folders were left behind. `adopt`'s `copySkills` with `skipExisting` skipped any existing folder, empty or not (pre-existing). This PR's `classifySkill` would have called an empty folder `edited`, so `update` would have offered `.codev-new` copies instead of filling it. Both now treat a real folder with no skill files (ignoring `.DS_Store` and `.codev-new`) as missing (`isEmptySkillDir`). Tests cover each, and a scratch repro filled all 20 folders through both commands. The bootstrap pass was unaffected: with no installed skill it inlined the packaged text.
- **Process:** porch force-advanced phase_4 at its iteration-3 ceiling, so commit `b87516dcd` (symlinks hashed by target) had no CMAP round of its own. The architect asked to review it explicitly at PR integration review.

## Consultation Feedback

### Specify Phase (Round 1)
#### Gemini (APPROVE)
- **Concern**: No rule against secrets, internal hostnames or tokens leaking from code/git log into the docs; also asked for a graceful consult fallback, keeping drafts on validation failure, and telling the user when to exit the session → **Addressed**: all four taken into the spec (rebuttal "Gemini recommendations: Taken")
#### Codex (REQUEST_CHANGES)
- **Concern**: The "only touches placeholder files" rule cannot be enforced against an interactive agent that has write access → **Addressed**: changed to detect-and-report: pre/post snapshot of the four files plus git state, non-zero exit, never auto-reverted
- **Concern**: The map rule is impossible when the cold doc has more than 12 sections → **Addressed**: map entries must point at real cold sections (always checked); full coverage is required only when the cold doc has 12 or fewer sections
- **Concern**: The placeholder classifier conflicts with the three seeded lessons in `lessons-critical.md` → **Addressed**: exact rule is verbatim subset of a shipped starter plus a marker still present; seeded lessons count as starter text
- **Concern**: Harness launch contract is underspecified → **Addressed**: launch is an optional harness capability; an unsupported harness gets a prompt file plus manual instructions
- **Concern**: "Non-empty repository" is undefined → **Addressed**: defined via `git ls-files --cached --others --exclude-standard` (filesystem walk outside git), minus Codev-generated files
- **Concern**: Consult availability, failure handling and output location are undefined → **Addressed**: each reviewer runs independently, output goes to `.consult/bootstrap-docs/` (exempt from detection), and a missing `consult` only warns
#### Claude (REQUEST_CHANGES)
- **Concern**: Map coverage cannot be checked deterministically (this repo's own arch.md has 19 sections against a 12-topic cap) → **Addressed**: same fix as Codex, plus scenario 12 against this repo's own files
- **Concern**: The 35-line cap does not say what it counts; a naive bullet count fails this repo's own file → **Addressed**: caps are counted per section and exclude HTML comment lines
- **Concern**: "Curated file byte-identical" can only be detected, not guaranteed → **Addressed**: reworded as detect-and-report
- **Concern**: adopt's merge session is never awaited, so two agents would fight over stdin; risk impact is not Low → **Addressed**: awaiting the merge session is now a success criterion; impact raised to High
- **Concern**: No rule against sensitive material, and the run silently inherits `--dangerously-skip-permissions` → **Addressed**: new bright-line rejection in every skill mode; permission mode is stated before launch and needs confirmation
- **Concern**: Minor (STARTER comment handling, cost notice, empty-repo rule, real-repo gate, partial writes) → **Addressed**: all taken (rebuttal "Non-blocking items also taken")

### Plan Phase (Round 1)
#### Gemini (APPROVE)
- **Concern**: Advisory items: `git log` with no commits, bare `- Section` map entries, command tokenisation, order of the Next-steps output → **Addressed**: `rev-parse --verify HEAD` guard, bare entry valid and tested, reuse of the architect.ts split, Next steps moved to the end of adopt
#### Codex (REQUEST_CHANGES)
- **Concern**: Missing governance files treated as eligible, against the spec → **Addressed**: `missing` is its own class and not eligible; the user is told to run `codev update`
- **Concern**: Non-git repos snapshot only the four files, so source edits go unseen → **Addressed**: filesystem-walk snapshot added in `lib/tree-snapshot.ts`
- **Concern**: Four-copy skill parity is not enforced → **Addressed**: `update-arch-docs` added to `TOUCHED_SKILLS`
- **Concern**: Classifier too broad (trims whitespace, mixes starter versions) → **Addressed**: verbatim match (CRLF to LF only) against a single starter version
#### Claude (REQUEST_CHANGES)
- **Concern**: The map-matching rule fails the plan's own fixture (`## Critical (Prevent Major Failures)` against `- Critical: …`) → **Addressed**: match on name part or short name, and it must resolve to exactly one section
- **Concern**: `change-snapshot.ts` reimplements `tree-tripwire.ts` → **Addressed**: core moved to `lib/tree-snapshot.ts`; consult re-exports it
- **Concern**: Parity not enforced; the unsupported-harness fallback is never reached because of the Claude default → **Addressed**: added to `TOUCHED_SKILLS`; launch requires positive identification of a built-in harness
- **Concern**: The adopt test mocks would hang or auto-accept the new prompt → **Addressed**: both mock edits named in the adopt/update phase
- **Concern**: `.claude/settings.local.json` would cause a false out-of-scope exit → **Addressed** (round 1) as informational, then reversed in round 2 after Codex objected
- **Concern**: Minor: `codev/templates/` is not a mirror; framework-ref check is manual; Phase 4 too heavy → **Addressed**: template is skeleton-only; check marked manual; consult split into its own phase

### Plan Phase (Round 2)
#### Gemini (APPROVE)
- **Concern**: A non-zero agent exit or spawn error should fail the command → **Addressed**: now reported and fails the command; drafts are kept
#### Codex (REQUEST_CHANGES)
- **Concern**: `.claude/settings.local.json` cannot be informational-only under the spec → **Addressed**: it fails the command again, annotated "harness-written, usually benign"
- **Concern**: Porcelain status plus hashes cannot see an index-only change → **Addressed**: SHA-256 of `git ls-files --stage -z` added, with a re-stage test
#### Claude (REQUEST_CHANGES)
- **Concern**: `validateHotFile` duplicates `hot-tier.test.ts`, and the two disagree on three rules → **Addressed**: helpers moved into the library and imported by the test; shipped topic/prefix rule kept, plus the exactly-one-section rule
- **Concern**: Third adopt mock breakage (`execFileSync` missing) → **Addressed**: named in phase 6
- **Concern**: Tests depend on the built `packages/codev/skeleton` → **Addressed**: tests read `codev-skeleton/` via a repo-root path
- **Concern**: The mixed-starter test cannot fail (the pre-#1012 starter is a subset of the current one) → **Addressed**: tested with a synthetic two-version set
- **Concern**: `claude -p` / `codex exec` would launch headless → **Addressed**: treated as unsupported, with a reason

### Plan Phase (Round 3)
#### Gemini (APPROVE)
- **Concern**: Cosmetic leftover in the risk table ("scratch paths informational") → **Addressed**: fixed (see Codex)
#### Codex (REQUEST_CHANGES)
- **Concern**: Git-backed snapshots ignore gitignored paths → **Rebutted**: the spec scopes detection to "the four files and the git state"; gitignored paths never reach a commit and hashing them is slow and noisy. The architect (main) ruled the detector stays git-scoped, and the owner approved the plan gate without overriding that
- **Concern**: `--grep` alternation without `-E` → **Addressed**: uses `-i -E`
- **Concern**: Contradictions in the executive summary and risk table → **Addressed**: both fixed
#### Claude (APPROVE)
- **Concern**: Minor: `cli.ts`/`UpdateResult` missing from phase 6; Codex flag-value read as a subcommand; retired-harness throw escapes; tripwire move understated as "pure"; unbounded non-git walk → **Addressed**: all five accepted (named subcommand list, `RetiredHarnessError` caught, signature change named, 50k-file bound)

### Phase 1 (Round 1)
#### Gemini (APPROVE)
- No concerns raised (APPROVE)
#### Codex (REQUEST_CHANGES)
- **Concern**: The implementation files were untracked, so they were missing from the PR scope → **Addressed**: committed in c4b0ac538 "feat: governance-doc classifier and validator library" (the review ran before the commit)
#### Claude (APPROVE)
- **Concern**: `nonCommentLineCount` leaves one blank line per comment block (effective cap 34) → **Addressed**: whole-line comments removed entirely, with a regression test
- **Concern**: Unguarded `git ls-files` call → **Addressed**: falls back to the filesystem walk on error
- **Concern**: The non-git ignore compiler skips `!` negations → **Rebutted**: kept and documented; it can only make the walk ignore more; noted as a carry-forward for phase 4

### Phase 1 (Round 2)
#### Gemini
- Skipped / CONSULT_ERROR: VERDICT COMMENT, "Gemini lane skipped: agy produced no review output"
#### Codex (REQUEST_CHANGES)
- **Concern**: Whitespace can hide a leftover marker from the validator → **Addressed**: `isStarterMarker` trims; fix commit 2423178be "whitespace-tolerant marker detection, starter guard, map separators"
#### Claude (APPROVE)
- **Concern**: An empty starter set silently classifies everything as curated; only the em dash is accepted as a map separator; unreadable dirs throw → **Addressed**: `knownStarterTexts` throws on a missing starter, en dash and hyphen accepted, unreadable dirs skipped (2423178be)
- **Concern**: Loose `Critical`/`Map` prefix lookup; deletion-only starters classify as placeholder → **Rebutted**: matches the shipped hot-tier semantics and the spec's subset predicate

### Phase 1 (Round 3)
#### Gemini (APPROVE)
- No concerns raised (APPROVE)
#### Codex (APPROVE)
- No concerns raised (APPROVE)
#### Claude (APPROVE)
- **Concern**: An empty draft (headings only, or a cold doc with no sections) passes validation → **Addressed** in phase 4: the validator now reports `empty-section` (thread log, phase_4)
- **Concern**: `globToRegex` over-matches `**`, so the non-git walk can over-ignore → **Addressed** (documented): the imprecision is now stated in the ignore compiler's doc comment (phase_4 iter1 rebuttal)
- **Concern**: Nits: `entriesHeading` hardcodes the filename; `SLOT_LINE` flags `- <url>` bullets → `SLOT_LINE` **Addressed** (URL/mailto bullets excluded by a lookahead); `entriesHeading` **N/A** (non-blocking nit at an approving round, left as is)

### Phase 2 (Round 1)
#### Gemini (APPROVE)
- No concerns raised (APPROVE)
#### Codex (REQUEST_CHANGES)
- **Concern**: Seeded-lesson demotion could edit a curated `lessons-learned.md` → **Addressed**: demotion happens only when that file is eligible; fix commit f9a8ac98d "map full-coverage rule, curated-cold displacement guard, prompt rules last"
#### Claude (REQUEST_CHANGES)
- **Concern**: The skill never states the full-coverage map rule that the validator enforces as a failure (the common case, cold doc with 12 or fewer sections) → **Addressed**: stated in step 4 and in the prompt (f9a8ac98d)
- **Concern**: Minor: rules block does not close the prompt; literal map headings left to inference; "has just adopted" wording is wrong for late adopters → **Addressed**: all fixed (f9a8ac98d)

### Phase 2 (Round 2)
#### Gemini (APPROVE)
- No concerns raised (APPROVE)
#### Codex (APPROVE)
- No concerns raised (APPROVE)
#### Claude (COMMENT)
- **Concern**: Cold section names that are prefixes of each other (`Security` / `Security Model`) cause an ambiguous-map violation; deleting the `STARTER:` line can drop the `-->` → **Addressed**: fix commit 93ef2b4ec "exact map heading wins over prefix, keep comment close when removing STARTER sentence"

### Phase 3 (Round 1)
#### Gemini (APPROVE)
- No concerns raised (APPROVE)
#### Codex (REQUEST_CHANGES)
- **Concern**: `CODEX_SUBCOMMANDS` omits `mcp-server` → **Addressed**: added with a regression test (it is absent from codex 0.162.1 but existed in earlier releases); fix commit 19396aae6 "provider-level interactive launch blockers; Claude subcommands, --bg, --resume; codex mcp-server"
#### Claude (APPROVE)
- **Concern**: The Claude guard covers only `-p/--print` (not subcommands, `--bg`, `--resume`); headless rules keyed by harness name → **Addressed**: `CLAUDE_SUBCOMMANDS`, `--bg/--background`, `-r/--resume` now block; rules moved to the provider-level `interactiveLaunchBlocker?(flags)` (19396aae6)
- **Concern**: Substring harness detection; unrelated cloud-config fix in scope → **Rebutted**: same detection semantics as role injection, and an explicit `architectHarness` is the precise override; the cloud-config fix is a separate, approved side commit

### Phase 3 (Round 2)
#### Gemini (APPROVE)
- No concerns raised (APPROVE)
#### Codex (APPROVE)
- No concerns raised (APPROVE)
#### Claude (COMMENT)
- **Concern**: Optional-value and variadic flags (`--add-dir`, `--mcp-config`, codex `-i`) swallow the appended prompt; the `--flag=value` form is unmatched → **Addressed**: the prompt is passed as `['--', prompt]` (both CLIs verified to honour `--`), and blockers match `--flag=value`; fix commit 5c8b9e88e "end option parsing before the prompt; match --flag=value blockers"

### Phase 4 (Round 1)
#### Gemini (APPROVE)
- No concerns raised (APPROVE)
#### Codex (REQUEST_CHANGES)
- **Concern**: The non-git snapshot ignores root `.gitignore`, against the plan → **Addressed**: now honoured; the ignore compiler moved into `lib/tree-snapshot.ts`; fix commit 7053a931f "honour root .gitignore outside git; prompt-size guard; permission wording"
- **Concern**: The unrelated flaky `session-manager` test is permanently skipped → **Rebutted**: the builder role's flaky-test rule says to skip it, annotate it and document it; it was already skipped under CI; later tracked as #1800
- **Concern**: The planned 100 KB prompt-size guard is missing → **Addressed**: `MAX_PROMPT_BYTES = 100_000` falls back to the manual prompt file (7053a931f)
#### Claude (COMMENT)
- **Concern**: Missing prompt-size guard (E2BIG with no pointer to the prompt file) → **Addressed**: guard added; a spawn error now prints where the prompt file is (7053a931f)
- **Concern**: `defaultDeps()` makes the tests need a build → **Addressed**: `skeletonDir` is resolved lazily
- **Concern**: `describePermissions` describes restrictive flags as a permission bypass → **Addressed**: only known bypass forms say "will NOT ask"
- **Concern**: Minor: non-git mode does not see an in-session `git init`; a declined run leaves the prompt file unmentioned; `.gitignore` deviation → **Addressed**: scope line states the `git init` gap; both decline paths name the prompt file; `.gitignore` now honoured

### Phase 4 (Round 2)
#### Gemini (APPROVE)
- No concerns raised (APPROVE)
#### Codex (REQUEST_CHANGES)
- **Concern**: The first commit in an unborn repo (HEAD going from none to a commit) is not detected → **Addressed**: unborn HEAD compared as `(no commits)`, with a regression test; fix commit 4d5c6c835 "project in a repo subdirectory; first commit in an unborn repo"
- **Concern**: The summary always says "nothing has been staged or committed" → **Addressed**: the message is conditional when HEAD, the branch or the index moved
#### Claude (REQUEST_CHANGES)
- **Concern**: The change detector mis-keys paths when the project is in a subdirectory of the repo (drafts reported out-of-scope, content hashes `<absent>`), reproduced → **Addressed**: `--show-prefix` re-keying, with hashing at the repo top level; new test (4d5c6c835)
- **Concern**: Minor: the "nothing needs bootstrapping" headline ignores missing files → **Addressed**: adds the `codev update` hint
- **Concern**: Minor: flaky test skipped in this PR; SIGINT ignored for the agent's whole lifetime → **Rebutted**: flaky-test rule (see Round 1); ignoring SIGINT is intended so the CLI can still report after Ctrl-C

### Phase 4 (Round 3)
#### Gemini (APPROVE)
- No concerns raised (APPROVE)
#### Codex (REQUEST_CHANGES)
- **Concern**: Symlinks are all hashed as `<special>`, so a retargeted link is invisible → **Addressed**: hashed as `<link:TARGET>`, with a test; fix commit b87516dcd "compare symlinks by target in tree snapshots". Porch force-advanced the phase at the iteration-3 ceiling, so this commit was not re-reviewed; main will review it at PR integration
#### Claude (APPROVE)
- **Concern**: `report.scope` contradicts `detectionLost` → **Addressed**: scope line omitted when detection is lost (b87516dcd)
- **Concern**: Cosmetic: a Ctrl-C exit counts as failure; prompt file written before confirm; an unwritten cold doc makes map validation noisy → **Rebutted**: all intended or accurate (the spec treats agent failure as a failure; the prompt file is kept so a declined run can point at it; map errors follow from the unwritten file)
- **Concern**: The flaky test needs a tracking issue → **Addressed**: tracked as #1800

### Phase 5 (Round 1)
#### Gemini (APPROVE)
- No concerns raised (APPROVE)
#### Codex (APPROVE)
- No concerns raised (APPROVE)
#### Claude (APPROVE)
- **Concern**: An error inside `reviewDrafts` loses the change report; the summary waits for the slow review; reviewer edits after validation go unseen → **Addressed**: fix commit 697d27039 "summary before the review; review errors never lose it" (review errors become a named warning; drafts re-hashed after the review)
- **Concern**: Minor: `REVIEW_MODELS` ignores `porch.consultation.models`; Gemini skip detection depends on a hardcoded string → `REVIEW_MODELS` not applied (outside the plan, noted for the review doc); skip-string coupling **N/A**: kept; if consult's skip wording changes, a skipped Gemini lane would be listed as reviewed, with the skip note as its feedback file (follow-up item)

### Phase 6 (Round 1)
#### Gemini
- Skipped / CONSULT_ERROR: VERDICT COMMENT, "Gemini lane skipped: agy produced no review output"
#### Codex (APPROVE)
- No concerns raised (APPROVE)
#### Claude (APPROVE)
- **Concern**: `shouldOfferBootstrap` can throw and abort adopt/update over a hint; `adopt -y` with a CLAUDE.md conflict now waits on an interactive session → **Addressed**: fix commit 510e32aaf "offer never throws; adopt -y does not wait on the merge"
- **Concern**: Minor: the instance `codev/resources/cheatsheet.md` lacks the new row → **Addressed**: row added (thread log)
- **Concern**: Minor: nothing tests that `instructions.bootstrapDocs` reaches the `--agent` JSON → Not applied: the duplicated JSON builder predates this work; wiring checked manually in a scratch repo only

### PR Review (Round 1)
#### Gemini
- Skipped / CONSULT_ERROR: VERDICT COMMENT, "Gemini lane skipped: agy produced no review output"
#### Codex (REQUEST_CHANGES)
- **Concern**: Change detection ends before the draft review. Reviewer edits to source, git state or drafts go unseen or do not affect the exit code → **Addressed**: 9e87ce164. The tree is re-snapshotted after the review against the post-session state, every change is named, and the exit is non-zero. Tests cover a draft edit, a source edit plus commit, and a clean review.
- **Concern**: Branch behind `main`; `d15693931` does not follow the `[Spec 1797][Phase: …]` format → **Addressed** (merge from `main`) / **Rebutted** (format): `d15693931` is a declared side fix unrelated to the spec, and rewriting pushed history is not allowed.
#### Claude (APPROVE)
- **Concern**: `missing-guidance` false positive when `-->` closes the last kept line → **Addressed**: 9e87ce164 (trailing `-->` ignored when comparing, plus a test)
- **Concern**: A commit subject containing a code fence can close the digest's fixed fence → **Addressed**: 9e87ce164 (the digest is wrapped with `fenceFor`, plus a test)
- **Concern**: Branch 11 commits behind `main` → **Addressed**: merged from `main`
- **Concern**: Minor: `adopt -y`'s `mergeConflicts()` is a floating promise → **N/A**: `spawnAgentProcess` never rejects, and the shape is the one it replaced
- Read `b87516dcd` in full: no concerns

### Integration Review (main, Round 1)
- **Concern**: A symlinked governance file is classified through the link while change detection hashes only the link target → **Addressed**: fd450a757 (lstat classification, curated and named, content hashed through the link, plus tests including a write through an out-of-repo link)
- **Concern**: The starter history is unpinned → **Addressed**: fd450a757 (hash pin test naming `EARLIER_STARTERS`)
- **Concern**: adopt's exit code (ruling) → **Addressed**: a7a469edc (adopt exits 0 after a successful adoption; the adopt path is tested)
- **Concern**: Layering → **Addressed**: d42fc36b3 (`lib/agent-process.ts`; `CONSULT_OWNED_PREFIXES` in `lib/tree-snapshot.ts`; lazy `bootstrap-docs` load)

### PR Review (Round 2, on the round-1 fixes)
#### Gemini (APPROVE)
- No concerns raised (APPROVE)
#### Codex (REQUEST_CHANGES)
- **Concern**: The command docs still said the review never changes the exit code → **Addressed**: both trees now describe reviewer-time changes failing the run, and adopt exiting `0`
- **Concern**: adopt's JSDoc still described returning the bootstrap exit code → **Addressed**
- **Concern**: The approved spec and plan lack `approved` / `validated` frontmatter → **Addressed**: added (both approved 2026-10-12 at their porch gates)
#### Claude (APPROVE)
- Verified all four round-1 items fixed with non-vacuous tests. Non-blocking: commit subjects in the digest are untrusted, instruction-shaped text (bounded by detect-and-report, eligible-only writes and human review); `.consult/` is a blanket detection exemption; a human-driven launch is still unexercised (owner-assigned) → **N/A**: recorded; the first two are listed under Follow-up Items

### PR Review (Round 3, on the team-review changes, head bc6331a12)
#### Gemini (APPROVE)
- No concerns raised (APPROVE)
#### Codex (REQUEST_CHANGES)
- **Concern**: An edited skill holding a symlinked subdirectory lets the `.codev-new` write land outside the project → **Addressed**: a skill directory that holds a symlink is classified `not-regular` and left alone, as is a symlinked skills root. Reproduced against bc6331a12 (the copy landed outside the project) and confirmed fixed; regression tests added
- **Concern**: #1811 and the digest removal are outside the approved spec and plan → **Escalated**: both are the owner's direct instruction on this PR, recorded under Deviations; whether the spec gets an amendment is main's and the owner's call
- **Concern**: Validation predates the head → **Addressed**: full suite on the final code (315 files, 6400 passed, `tsc` clean) and real-repo run 3, recorded above
#### Claude (REQUEST_CHANGES)
- **Concern**: The team-review commit had no CMAP round → **Addressed**: this round
- **Concern**: Real-repo verification only at d42fc36b3 → **Addressed**: run 3, recorded above
- **Concern**: The PR body is out of date (digest, missing #1811, `--force` replacing edited skills, test count) → **Addressed**: rewritten
- **Concern (minor)**: unused `directoriesCreated`; resolved `.codev-new` copies never cleaned; run-1 narrative reads as if the digest were current → **Addressed**: field removed; a `.codev-new` holding exactly the package's version is deleted once the skill has that version (a differing one is kept); runs 1 and 2 are marked as predating the digest's removal

### PR Review (Round 4, on main's round-3 integration fixes, head ef3312731)
#### Gemini (APPROVE)
- No concerns raised (APPROVE)
#### Codex (APPROVE)
- No concerns raised (APPROVE)
#### Claude (APPROVE)
- **Concern**: The symlink guard covered a symlinked skills root but not a symlinked `.claude` / `.codex` → **Addressed**: both are left alone, with a test; the command docs say so
- **Concern**: #1811 acts on every adopter's tree on their next `codev update`, with no opt-out for a deliberately customised skill → **N/A here**: owner-directed and disclosed; main is raising the opt-out with the owner
- **Concern**: the flaky `session-manager.test.ts` case is skipped without root cause → **N/A here**: tracked on #1800 (see Flaky Tests)
- **Concern**: the team's duplication question is still unanswered on the PR → **Deferred to the owner**, who asked that nothing be posted yet

### PR Review (Round 5, on the dry-run fix, head bc8bfb8f9)
#### Gemini (APPROVE)
- No concerns raised (APPROVE)
#### Codex (REQUEST_CHANGES)
- **Concern**: `validateHotFile` counted bullets under any `## Critical…` / `## Map…` heading, so an empty required section plus bullets under a similarly named one could pass → **Addressed**: counting is scoped to the exact required headings (`Critical facts` / `Critical lessons`, `Map of <cold doc>`), with a regression test that failed on the old code. Defaults are unchanged for `hot-tier.test.ts`
- **Concern**: The skill history records every commit, not released versions, so unpublished intermediate content could authorise a replace → **Rebutted**: a project's skill copy arrives from an installed package, which is either a release or a build from this repository. Content that exactly matches any commit's version of a skill is Codev's text, not the user's: an edit changes the hash. Limiting the history to release tags would misclassify a copy installed from a local or pre-release build as edited, and would make the generator depend on tags being present in the checkout. No user-written content can match, so nothing destructive follows from the wider set
- **Concern**: The full suite predates the final commits → **Addressed**: run on bc8bfb8f9 (315 files, 6409 passed, `tsc` clean) and on the final code with the round-5 fixes (315 files, 6410 passed, `tsc` clean)
- Codex also judged the bootstrap prompt not to be problematic duplication: it carries eligibility and the skill source, and the skill stays the content authority
#### Claude (APPROVE)
- **Concern (follow-up)**: hot cap numbers duplicated between the validator and the skill with no test → **N/A**: that test landed in ef3312731 ("states the validator's hot caps in the skill")
- **Concern (nit)**: an orphaned `defaultDeps` JSDoc above `runConsultProcess` → **Addressed**: moved onto `defaultDeps`
- **Concern (note)**: `.codev-new` files under `.claude/skills/` are not gitignored, so an edited skill leaves recurring untracked files → **N/A**: the same holds for CLAUDE.md today; listed under Follow-up Items
- **Concern (note)**: `.consult/` is exempt from change detection → **Addressed**: the command docs now say so
- **Concern (note)**: no human-driven interactive launch yet → **N/A**: owner-side, disclosed above

### PR Review (Round 6, on the history-guidance change, head c979579f6)
#### Gemini (APPROVE)
- No concerns raised (APPROVE)
#### Codex (REQUEST_CHANGES)
- **Concern**: `.codev-new` paths were excluded from the skill's symlink check, so an existing symlinked `<file>.codev-new` was written through → **Addressed**: a skill holding a pending copy that is not a regular file is `not-regular` and left alone, and a pending copy is now written with `wx` after removing a regular one. The same defect existed at the root-file site, where a symlinked `CLAUDE.md.codev-new` / `AGENTS.md.codev-new` was written through and a dangling root-file symlink was followed to create a file. `copyRootFiles` now skips either and reports it as skipped. A root file that is itself a symlink (`CLAUDE.md -> AGENTS.md`) still gets its regular `.codev-new` beside it. Tests cover each case
- **Concern**: required hot sections still matched by prefix, so `## Critical facts appendix` counted → **Addressed**: `isSectionHeading` accepts the exact name or the name followed by a parenthetical, for presence and for counting. Regression test added; `hot-tier.test.ts` keeps its prefix defaults
- **Concern**: final-head evidence → **Addressed**: full suite on the final code below, and real-repo run 4 on the history guidance
#### Claude (APPROVE)
- **Concern**: the history-guidance commit had no CMAP round or real-repo run → **Addressed**: this round, and run 4
- **Concern**: no opt-out and no gitignore for skill `.codev-new` copies → **N/A here**: both are under Follow-up Items, and main is raising the opt-out with the owner
- **Concern**: the duplication question is still unanswered on the PR → **Deferred to the owner**: a reply is drafted and waiting for the owner's go-ahead
- **Concern**: three or four rebuttal docs untracked → **Addressed**: committed

### PR Review (Round 7, on the trimmed history step and main merge, head fe9853366)
#### Gemini (APPROVE)
- No concerns raised (APPROVE)
#### Codex (REQUEST_CHANGES)
- **Concern**: `governancePathKind` checked only the final file, so starters behind a symlinked `codev/` or `codev/resources/` stayed eligible and the agent's writes would leave the project → **Addressed**: `irregularAncestor` checks each directory on the way; a linked or non-directory ancestor makes every file under it curated (`inside a symlinked codev/resources/`). Unit and end-to-end tests
- **Concern**: the prompt and review files under `.consult/bootstrap-docs/` were written with no symlink check → **Addressed**: `writeArtifact` refuses a linked or non-directory ancestor and a non-regular file, then writes with `wx`. A problem at the prompt path stops the run with exit 1 (`unsafe-path`) before anything launches. The reviewer output paths, which consult writes, are checked before the review; a problem there skips the review with the reason. Tests for a symlinked `.consult/`, prompt file and reviewer output, each leaving the outside target untouched
#### Claude (APPROVE)
- **Concern**: the pre-launch statement did not say the drafts go to three external models → **Addressed**: it now does
- **Concern**: `readSkillFiles` can throw on an unreadable skill directory and abort `codev update` → **Addressed**: an unreadable skill is `not-regular`, reported and skipped. Test added
- **Concern**: `validateDrafts` reads through a draft replaced by a symlink → **Addressed**: such a draft gets a `not-regular` violation and is not read
- **Concern**: `SKIP_SUMMARY` couples to consult's prose → **Follow-up**: already listed below
- **Concern**: the skill history pins every commit, not every release → **Rebutted**: as in round 5; release-only history would misclassify a copy installed from a local or pre-release build as edited. Size (134 hashes) is the only cost

### PR Review (Round 8, on the empty-skill-folder fix, head 7b3f9457d)
#### Gemini (APPROVE)
- No concerns raised (APPROVE)
#### Codex (REQUEST_CHANGES)
- **Concern**: branch 28 commits behind main → **Addressed**: merged, clean, no shipped-skill changes
- **Concern**: no final-head test run → **Addressed**: full suite after the merge: 324 files, 6726 passed; tsc clean
#### Claude (REQUEST_CHANGES)
- **Concern**: a draft replaced by a symlink was flagged but still read into the review prompt and sent to three providers → **Addressed**: drafts with a `not-regular` violation are left out of the review; the test asserts the prompt carries neither the heading nor the target's content
- **Concern**: no size bound on the review prompt → **Rebutted**: the embedded drafts are capped by the validator, and the CLI passes the prompt to consult as a file, not on argv
- **Concern**: `HARNESS_SCRATCH_PATHS` covers only Claude → **Rebutted**: no Codex run wrote a project-local scratch file; an unknown path is still reported
- **Concern**: the #1809 and #1802 lessons contradict on the cloud-config fix → **Addressed**: both now note that this PR made the `chmodSync` fix
- **Concern**: uncommitted `codev/team/messages.md` → **N/A**: Tower's log in this worktree, never staged

## Lessons Learned

### What Went Well

- Splitting the work as "skill owns content, CLI owns everything deterministic" kept the agent's job small and made every guarantee in the spec unit-testable without a model.
- Promoting the consult tree tripwire into `lib/tree-snapshot.ts` meant change detection started from code that had already been through review, instead of a new implementation.
- CMAP earned its cost here. Across phases 3 and 4 it found real defects that would have shipped: a variadic flag swallowing the prompt, a project in a repo subdirectory being mis-keyed, an unborn HEAD gaining a first commit unseen, and symlink retargets being invisible.

### Challenges Encountered

- **Change detection has many edge cases.** Each phase_4 round found another blind spot in the git snapshot. Each was reproduced on a scratch repo before fixing.
- **Environment leakage into tests.** A developer's global git excludes file hid harness scratch paths in test repos, and a `umask 077` shell broke an unrelated permission test. The fixes: pin `core.excludesFile=/dev/null` in scratch repos, and set permission preconditions explicitly.
- **Driving an interactive agent from automation.** The CLI awaits an interactive session by design, so the real-repo verification ran under a pty with a headless stand-in for the agent (details above).

### What Would Be Done Differently

- Run the real-repo verification at the end of phase 4, not in the review phase. The one shape defect it found (a dropped guidance comment) was invisible to every unit test and every CMAP round, because all fixtures were hand-written drafts that already had the right shape.

- Enumerate the git-repo shapes up front (subdirectory project, unborn HEAD, symlinks, no git) as a test matrix in the plan. In this project they were discovered one CMAP round at a time.
- Check the plan's "no skeleton twin" style claims with `ls` while writing the plan.

### Methodology Improvements

- A phase force-advanced at the iteration ceiling leaves its last fix unreviewed. Porch could emit a reminder in the review phase listing such commits, so the integration review covers them without someone remembering to.
- Boundary refresh tasks are emitted once. Twice in this project the task was not captured, and the refresh was skipped. Saving `porch next` output to a file worked around it; porch could re-emit the task until it is acknowledged.

## Architecture Updates

- Routed: cold: `codev/resources/arch.md` § Governance Docs (Hot/Cold Tiers), new paragraph "First population on an existing codebase (Spec 1797)". It covers the `bootstrap-docs` command, the shared eligibility/validator module `lib/governance-bootstrap.ts`, the detect-and-report guarantee via `lib/tree-snapshot.ts`, the `buildInteractiveTaskLaunch` harness capability and the prompt-file fallback.
- Hot tier unchanged: the fact is subsystem detail, not a cross-cutting rule every builder needs up front, and `arch-critical.md` is at its cap. The existing hot fact on two-tier governance docs still holds.

## Lessons Learned Updates

- Routed: cold: Architecture: when the CLI hands a task to an interactive agent, design for detect-and-report (git-state snapshot, name changes, non-zero exit, never auto-revert). Includes the three snapshot blind spots found in review.
- Routed: cold: Testing: scratch git repos in tests inherit the developer's global git config (pin `core.excludesFile=/dev/null`). A `umask 077` shell filters `writeFileSync` modes, so set permission preconditions explicitly.
- Hot tier unchanged: both lessons are narrow to their subsystem, and `lessons-critical.md` is at its cap.

## Flaky Tests

- `packages/codev/src/terminal/__tests__/session-manager.test.ts`, "no stderr tail logged for file-based stderr (Bugfix #324)": it timed out waiting for session-exit in 2 of 4 local full-suite runs (once when run alone). It was already skipped in CI. It is now `it.skip` with a FLAKY annotation citing #1800.
- A forge `pr-create` test failed once in a porch test check (`CODEV_PR_TITLE` / `CODEV_PR_BODY` required) and passed on immediate rerun. It was not touched by this branch and was noted on #1800.

## Follow-up Items

- `REVIEW_MODELS` in `bootstrap-docs.ts` should respect `porch.consultation.models` (or a project consult config) instead of fixed gemini/codex/claude.
- Gemini skip detection matches consult's `SUMMARY: … lane skipped` wording. If that wording changes, a skipped lane is reported as reviewed, with the skip note as its feedback file. A structured skip signal from `consult` would remove the coupling.
- Commit messages the agent reads while exploring history are untrusted text. The skill tells it to treat them as evidence, never instructions; detection and human review bound the impact. (The CLI no longer inlines them, so the fence-escape concern from round 1 is gone with the digest.)
- `.consult/` is exempt from change detection as a whole (consult owns it); a narrower exemption (`bootstrap-docs/`, `history.log`) would watch the rest.
- `cli.ts`'s `update --agent` JSON builder is duplicated in `update.test.ts`. Extracting it would let `instructions.bootstrapDocs` be unit-tested.
- Observed, pre-existing: running `codev update` right after a fresh `adopt` produces `CLAUDE.md` / `AGENTS.md` `.codev-new` files and launches update's own (unawaited) merge session.
- `adopt`'s Next steps still lists `consult plan  # Review the plan with an architect`, which reads oddly right after adoption (pre-existing).
- An opt-out for a skill the user customised on purpose, which otherwise gets `.codev-new` copies on every update (owner ruling). Main is raising it with the owner as a filing candidate.
- `codev update --dry-run`'s migration step is correctly guarded, but its log lines still say "(cleaned)" / "(removed)" rather than "would" (pre-existing, wording only).
- `codev update --force` reports a newly created CLAUDE.md / AGENTS.md as "updated" and never overwrites an existing one (`copyRootFiles` without `handleConflicts` skips existing files), so for root files `--force` only fills in missing ones (pre-existing).
- `.codev-new` copies (root files and now skills) are not gitignored, so a customised file or skill leaves untracked copies after every update until merged. A gitignore entry, or the opt-out above, would quiet it.
- Pre-existing, noticed in round 6: `syncHotContextBlock` writes the managed block through a CLAUDE.md / AGENTS.md symlink, wherever it points. When the user linked the file on purpose, writing to it may be what they want; it is not changed here.
- #1810: split the built-in harness providers out of `harness.ts`, one file per harness. As a first step on this PR, the interactive-launch blocker lists (`CLAUDE_SUBCOMMANDS`, `CLAUDE_INTERACTIVE_BLOCKING_FLAGS`, `CODEX_SUBCOMMANDS`) are no longer exported and sit beside the provider that uses them; tests go through the provider's blocker.
