# air-1985 thread

Issue #1985: `codev update` should replace a CLAUDE.md / AGENTS.md an older release wrote
and the adopter never edited, the way it already replaces unedited skills (#1811).

## 2026-11-25: pre-build survey (sent to the architect, accepted)

- History: 31 distinct versions of each template, from 2025-12-08 (cd0700ac8, first tagged
  v1.1.0) to the current one. Three paths over time: `packages/codev/templates/X`, then
  `codev-skeleton/X.template`, then `codev-skeleton/templates/X`. 17 of the 31 shipped in a
  release tag; all 31 are listed, between-release commits included, as the skill list does.
- `{{PROJECT_NAME}}` appears exactly once in all 62 versions: on line 1, the H1. That heading
  has never changed. This is what makes a hash possible: the name is read from line 1
  against the current heading and put back to the placeholder. It is never searched for
  anywhere else.
- 21 of the 31 versions predate the managed block (Spec 987, 2026-06-29). `withEmptyHotBlock`
  inserts the empty block right after the H1, which is where update put the real block, so
  those versions normalise too. Proof from history: v3.1.5 (the last pre-block version) and
  Spec 987's commit that added the block have the same normalised form. That gives 30
  distinct forms per doc, 60 hashes in all.
- Architect decisions: the replacement uses the name the doc's heading carries (as #1984's
  up-to-date path keeps it); list all 31; a leftover `.codev-new` whose hash is listed is
  removed beside a replaced or up-to-date doc.

## Build notes

- The generator also checks each version against a live block put in with
  `upsertHotContextBlock`, and lists a version only if both forms agree, so the pre-block
  claim is checked for every version on every regeneration. No version is left out today.
- Replacement is `codev update` only (`replaceShipped`). Adopt's comment says it never
  modifies an existing root doc, and it refuses to run where `codev/` exists anyway.
- Dry run: `syncHotContextBlock` now takes `pendingRootDocs`. Without it, a dry run on a
  pre-block doc printed a block refresh the real run did not. A mutation check confirmed the
  dry-run tests catch that.
- Adjacent fix: the `{{PROJECT_NAME}}` substitution used `String.replace` with a string, so
  a `$&` in a directory name was expanded. It now uses split/join (init too).
- Fixtures are the v1.1.0 / v3.1.5 / v3.3.4 templates copied from git, named
  `*.template` so no agent loads them as nested CLAUDE.md / AGENTS.md.
