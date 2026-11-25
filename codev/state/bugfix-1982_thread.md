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
