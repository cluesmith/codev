# Phase 6 (`check_worktree`) — iteration 3 rebuttal

Codex: REQUEST_CHANGES. Claude: APPROVE with four non-blocking notes.

## Codex: native Windows spawn makes hard links and copies (accepted, fixed)

> `worktree.ts` recognizes spawn-created links only when `lstatSync(...).isSymbolicLink()` is
> true. On native Windows, `createWorktreeLink()` commonly creates file hard links—or copies
> when hard links are unavailable … copied files require careful provenance/content handling
> because they can later diverge and become real data.

Correct. Where the account may not make a symlink, `createWorktreeLink` makes a hard link of
a file, and failing that a copy. Spawn reports all of these as links. Iteration 2 recognised
only the symlink shape, so on such a Windows host a clean `.env` (with `.env*` kept) or a
`worktree.symlinks` file read as data. That is the noise the architect's condition 1 was
meant to remove.

The fix, `isSpawnMade` in `worktree.ts`: the entry at P is spawn's when it is
- a symbolic link to P in the main checkout (as before);
- a hard link of that file: the same device and inode, from a `bigint` stat;
- a copy whose bytes still equal that file's, compared by size and then contents.

A copy that differs (including one of the same size) is data, as Codex asks: the comparison
is made at check time, so an edited copy is never discarded as scaffold. The rule is the same
on every platform. Spawn on POSIX makes only symlinks, but anywhere, an entry the main
checkout holds byte for byte at the same path loses nothing on removal. It applies in both
places a spawn link can show:
- in `uncommitted`, for an entry git does not ignore;
- in `ignored`, for a keep-list match.

A read that fails makes that check `not run`, which keeps the verdict conservative. No new
import: `statSync` and `readFileSync` are already in the audited read-only set.

Test (every platform, since a hard link and a copy need no privileges): `.env` as a hard link,
`.env.local` and `shared.json` (which git does not ignore) as unchanged copies, and `.env.test`
as a copy edited to the same size. The first three are scaffold; `.env.test` is a keep file.

## Claude's non-blocking notes

1. **The link list was the only list not truncated or wrapped.** Fixed. With more than one
   link, each goes on its own continuation line with its target, as Claude suggests. The
   architect asked for each link with its target, so the list is not cut short. Tested with
   two links, one whose target is missing.
2. **A link to an unkept path inside the worktree blocks removal**, though that content
   survives. Kept as is (conservative and visible), and it goes into the Phase 7 docs next
   to the two accepted approximations.
3. **Cleanup's dirty notice still counts a spawn link that git does not ignore.** True. It is
   the same class as main-36, but that notice is informational, and the plan scoped the
   cleanup edit to `isBuilderScaffold()`. Fixing it needs a read-only helper that cleanup can
   import as well (the check's helpers live on the check side). I have asked the architect
   whether they want it in this PR. Until they answer, it is a known gap for the REVIEW.
4. **The accepted approximations** go into the Phase 7 docs, as recorded in iteration 2.

## Not on the read-only core

The runner, allow-list, validation and roots are unchanged. The changes are in `worktree.ts`
and its tests.
