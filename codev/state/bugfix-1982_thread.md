# bugfix-1982 thread

## 2026-11-24 — investigate

Reproduced with a build of this branch (`packages/codev/bin/codev.js`) in the session
scratchpad, outside any repository: `codev init fresh --yes && cd fresh && codev update
--dry-run` prints the issue's output exactly (2 root-doc conflicts, plus unconditional
hot-tier / cold-tier / managed-block lines). A real `codev update --agent` on a freshly
initialized project writes `CLAUDE.md.codev-new` and `AGENTS.md.codev-new`, and `cmp`
reports both byte-identical to the files beside them.

Root cause:

1. **False conflicts.** `copyRootFiles` (`packages/codev/src/lib/scaffold.ts`), which
   update calls with `handleConflicts: true`, makes no comparison at all: any existing
   CLAUDE.md / AGENTS.md is a conflict, and the template is written beside it. The
   identical-content check update.ts had at first (3cb623203, Dec 2025) was lost when
   Spec 618 (e66a014f6, Mar 2026) moved update onto `copyRootFiles`, a helper written for
   adopt. The issue's guess (comparison made before the block is rendered) is wrong: the
   templates already carry the rendered managed block, which is why the `.codev-new` is
   byte-identical. The "second update" test only checks `result.conflicts` (skills), never
   `rootConflicts`, so it never caught this.
2. **Dry run disagrees.** `update.ts` prints the hot-tier, cold-tier and managed-block
   lines unconditionally under `--dry-run`; the real run prints only what
   `copyHotTierDefaults` / `copyColdTierDefaults` copied and what `syncHotContextBlock`
   changed.

Decision on edits INSIDE the managed block: not adopter content. The block is regenerated
from the hot files on every update (`syncHotContextBlock` already replaces it; the BEGIN
marker says do not edit), so such an edit is neither a conflict nor kept; update reports it
as a block refresh. Hot context is changed in `codev/resources/{arch,lessons}-critical.md`.

Known limit, left as is: a doc an adopter never edited, written by an older release whose
template has since changed outside the block, is still a conflict. There is no record of the
installed version for root docs (skills have `SHIPPED_SKILL_HASHES`). Flagged to the architect.

## 2026-11-24 — fix

Architect accepted the root cause and decisions; asked that the known limit be pinned by a
test (done) and given its own PR paragraph, and that the dry-run test compare dry and real
reports on the same project (done, three scenarios).

- `sameOutsideHotBlock` (managed-block.ts) compares two docs as the block refresh leaves
  them (both upserted with the same empty block), so content inside the block, or a
  missing block, never counts as an edit.
- `copyRootFiles` uses it: up to date → no conflict, and a `.codev-new` holding exactly the
  template is removed (the skills' `removeResolvedCodevNew` precedent; cleans up leftovers
  this bug wrote in adopters' projects).
- Hot-tier, cold-tier and block steps take `dryRun` and run one code path; a dry run counts
  the hot files it would create as present when rendering the block. Real-run block line
  is now `~ (hot-tier block refreshed)` so the two modes differ only by "would be".
- Regression test `bugfix-1982-update-root-docs.test.ts` (real `init()` then `update()`,
  execSync stubbed for git init / codev doctor): 10/10 fail on the pre-fix source, 10/10
  pass with the fix.
- Verified on an installed build: packed the four tarballs and `npm install -g --prefix`
  into the scratchpad (no global install, no Tower restart). The issue's three commands
  give "Already up to date!" in both modes and no `.codev-new`; edits outside the block and
  to a skill are kept as conflicts; an in-block edit is a block refresh; missing
  governance files print identical per-file lines in dry and real runs.

## 2026-11-24 — pr (PR #1984)

CMAP round 1: codex REQUEST_CHANGES (only porch's own `chore(porch)` commit subjects;
rebutted: 78 of the last 200 main commits are porch's, merged unchanged); claude APPROVE
with notes. Folded in: `{{PROJECT_NAME}}` matched as any name (a clone under another
directory name was a false conflict); the leftover-`.codev-new` removal is logged in both
modes and in adopt. Round 2: codex same objection plus a stale name in the PR body (fixed);
claude COMMENT. Folded in: CRLF normalisation (skills already do it), and a leftover is
judged with the same match as the doc so a renamed checkout's leftover is resolved.
Not taken: an unreadable root doc fails loudly (fail-fast), not treated as a conflict.

Full suite green after each round; installed build (scratch prefix) re-verified on the final
code: issue's commands up to date in both modes; edits kept as conflicts; in-block edit is a
block refresh; renamed checkout plus a CRLF doc is up to date.
