# 1797 review iter7: rebuttals (head fe9853366)

Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES.

## Codex (REQUEST_CHANGES), both accepted and changed

1. **Symlinked `codev/` or `codev/resources/`.** `governancePathKind` checked only the final path, so starters reached through a linked ancestor stayed eligible and the agent's writes would land outside the project. A new `irregularAncestor` check walks each directory on the way. A linked or non-directory ancestor makes every file under it curated (`inside a symlinked codev/resources/`), so nothing is eligible. Tests: a symlinked `codev/` (unit) and a symlinked `codev/resources/` (end to end, nothing launched).
2. **This command's own files under `.consult/bootstrap-docs/`.** The prompt and the review prompt were written with `mkdirSync` and `writeFileSync` with no check. Now:
   - **The guard:** `writeArtifact` refuses a linked or non-directory ancestor and a non-regular file, then removes the old file and writes with `wx`.
   - **The prompt file:** a problem there stops the run with exit 1 (`unsafe-path`) before anything launches.
   - **The reviewer output paths** (written by consult itself) are checked before the review. A problem there skips the review with the reason, and nothing is written.

   Tests: a symlinked `.consult/`, a symlinked prompt file, and a symlinked reviewer output. Each leaves the outside target untouched.

## Claude (APPROVE), non-blocking items

- **Consent:** taken. The pre-launch statement now says the drafts go to gemini, codex and claude for review through `consult`.
- **`readSkillFiles` can throw on an unreadable directory:** taken. An unreadable skill now classifies as `not-regular` and is reported and skipped, without aborting `codev update`. Test added (skipped under root).
- **`validateDrafts` reads through a draft replaced by a symlink:** taken. Such a draft gets a `not-regular` violation and is never read.
- **`SKIP_SUMMARY` couples to consult's output prose:** not changed here. It matches the skip summary consult writes today, and a test pins it. A structured skip signal from consult is a consult change; listed as a follow-up.
- **`SHIPPED_SKILL_HASHES` pins every skeleton commit rather than every release:** not changed. Rebutted in round 5, and the reason still holds: an adopter can install from any published build, including local and pre-release builds, so release-only history would misclassify an unedited copy as edited. The cost is size, about 134 hashes today; listed as a follow-up to prune if it grows.
