# PIR #1189 — codev-sdk package split (prompt-bearing doc touches)

Not a Spec 1280 phase: this branch is the codev-sdk server/client package split
(issue #1189). It touches three prompt-bearing files with mechanical accuracy
updates (the new `@cluesmith/codev-sdk` package joins the pack/publish/bump
sets), so T16 requires the rows here for the architect's diff review. No
prompt-surface-reduction principles were applied; the deltas add the minimum
words needed to keep the docs factually correct.

| File | Old | New | Principles | Rationale |
|---|---:|---:|---|---|
| `CLAUDE.md` | 5815 | 5820 | none | Local Build Testing: pack/install set grows from two tarballs to three (codev-sdk added); stale build-order line corrected (consult finding) |
| `AGENTS.md` | 5815 | 5820 | none | Byte-identical mirror of the CLAUDE.md edits |
| `codev/protocols/release/protocol.md` | 1626 | 1637 | none | codev-sdk joins the lockstep bump list, the pnpm publish filter sets (3 sites), and the release git-add command (consult finding) |
