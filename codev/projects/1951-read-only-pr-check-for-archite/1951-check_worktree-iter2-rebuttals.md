# Phase 6 (`check_worktree`) — iteration 2 rebuttal

Codex: REQUEST_CHANGES. Claude: APPROVE with five non-blocking notes.

## Codex: keep-list symlinks must block removal (accepted and fixed, with the architect's conditions)

> `worktree.ts:381-400` excludes matching symlinks from both kept data and the attention
> verdict … a worktree containing only an ignored keep-list symlink [is] `REMOVABLE` with exit
> 0, even though cleanup deletes that symlink.

Correct. The spec (line 577) says an ignored path that matches `cleanup.keepIgnored` is data.
My iteration-1 fix treated a link as holding no data of its own, which the spec does not say.
`afx cleanup --keep-ignored` deletes such a link, so `REMOVABLE` promised more than cleanup
does. I told the architect before reversing that part of the iteration-1 fix. They agreed
and set two conditions, both now built and tested.

The fix:

- A keep-list link is data that `--keep-ignored` cannot keep. `ignored` is ATTN, the verdict
  is NOT REMOVABLE, and the verdict line names `N keep-list symlinks`. The hint no longer
  offers `--keep-ignored` for them:
  - links only: `→ copy them out first (`afx cleanup --keep-ignored` never copies a link)`;
  - links and keep files: `→ copy the symlinks out first (… keeps the files, never a link)`.
- **Architect condition 1: links spawn makes are scaffold, never data.** Spawn links the
  root `.env` and `.codev/config.json`, and every `worktree.symlinks` entry, from a path in
  the worktree to the same path in the main checkout (`symlinkConfigFiles`).
  `builder-scaffold.ts` now defines that shape (`spawnLinkTarget`) beside the scaffold files.
  A link at P whose target is P in the main checkout counts as scaffold:
  - in `ignored`, where it shows as `[N scaffold links not counted]`;
  - in `uncommitted`, for a link git does not ignore, where it joins the
    `[N scaffold files not counted]` count.

  The tie-to-spawn test runs spawn's own `symlinkConfigFiles`. Its config has a file glob
  (`packages/*/.env`), a literal file and a directory entry, and the test asserts that every
  link spawn made has that shape. The shape is what each entry produces, so spawn's
  node-glob patterns never need matching here. That matching would need the `glob` package,
  which does I/O, or `path.matchesGlob`, which the `>=20.0.0` engine range does not
  guarantee. A link spawn made from an entry since removed from config still counts, and
  removing such a link loses nothing, since what it points at stays in the main checkout.
- **Architect condition 2: each remaining link is printed with its target**, as
  `tmp/link -> /…/elsewhere`, or `tmp/env -> /…/outside-secret (target missing)`. The JSON
  gives `links: [{ path, target, missing }]`. A link whose target resolves to a keep-list
  file inside the worktree is judged as that file, which is kept, so it is not listed.
- `readlinkSync` joins the audited read-only `node:fs` names. `builder-scaffold.ts` now
  imports `node:path`, and the pure-module audit lists that.

Tests: removability with links, with and without keep files; a link to a kept file next to one
whose target is missing, with the agreement with `listKeepCandidates()` kept; links alone; spawn's
links (ignored and not) leave a clean worktree REMOVABLE, exit 0; a link at `.env` pointing
anywhere else is data. The symlink tests are POSIX (a link needs privileges on Windows).

## Claude's non-blocking notes

1. **A project that gitignores `.builder-*` would see scaffold as keep-list data.** Accepted
   for the Phase 7 docs, as Claude suggests. `--keep-ignored` would copy those files, and the
   priority is that the check and cleanup agree.
2. **`details.links` is additive.** It goes into the Phase 7 schema docs, with its new shape
   `{ path, target, missing }` and the new `ignored.details.scaffold`.
3. **`allowedForms()` omits this phase's forms.** Fixed: `ls-files … --directory -z` (with
   `-C`), `rev-list <tip> --not <base>` and `rev-list <tip> --not <base> <remote>` are in the
   catalogue. The allow-list test and the stub self-test both run them.
4. **Wording drift from the spec sample.** Not changed:
   - `all 31 commits are on origin/main` cannot be said truthfully. The check counts commits
     not on the base, and the number of commits "on" it has no defined start.
     `every commit is on origin/main` says what was checked.
   - `ignored paths`, not `files`: a collapsed entry such as `node_modules/` is a directory.
   - `(#1950)`: an issue number in this repository means nothing in an adopter's output.
5. **The two accepted approximations** (`regenerable` within collapsed directories, and
   nested-repo `dir/` entries left unexpanded) go into the Phase 7 docs. The `regenerable`
   line will say what the number counts.

## Not on the read-only core

The runner, allow-list, validation and roots are unchanged. The changes are in `worktree.ts`,
`builder-scaffold.ts` (a pure definition), the imports audit's lists, and tests.
