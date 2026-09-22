# air-1724 thread — /arch-save next task: resolved gloss

## 2026-09-22 — implement

- Implemented as prescribed in #1724. arch-save step 3 gains "resolve its referents — resolve,
  don't plan" (every referent / resolution only / no referents → no gloss / cannot resolve →
  stop before step 4); template shows the optional `[resolved at save: …]` suffix.
- arch-init step 3 reports `<verbatim>  → resolved: <gloss>`; step 4 adds "the gloss carries the
  word — for the items it names, and only them", placed *after* the #1709 pre-spent-approval rule
  it narrows (verb never widens; unnamed items still need the word live; gates still relayed;
  CI/verification still apply). Pickup log records verbatim + gloss.
- Edited the canonical .claude copy and copied to the other three trees; skeleton under
  packages/codev/skeleton untouched (build-generated).
- Two #1709 assertions pinned the old `<text>` placeholders; updated to `<verbatim>`. New
  sibling test air-1724-next-task-gloss.test.ts.
- Surprise: fresh worktree needed `pnpm install` + `pnpm build` before the agent-farm suite
  could resolve @cluesmith/codev-sdk / codev-types — not related to this change.

## 2026-09-22 — PR #1725 + CMAP

- CMAP: codex=COMMENT, claude=COMMENT (agy skipped — `--type` lane known broken). Note: `consult
  --type pr` from a builder needs `--issue 1724`, else it fails on "Multiple projects found".
- Fixed in-scope: pickup log omits `→ resolved` with no gloss (codex); paused save tells the owner
  monitors are already down and resumes from the gloss (claude #2); "no gloss pre-approves
  nothing" stated (claude #3).
- Raised to architect, not changed: a preserved (never picked up) NEXT TASK line now carries a
  standing approval across cycles (claude #1); the gloss narrows the CLAUDE.md gate rule without
  that doc saying so (claude #4). Both are design rulings beyond the issue's prescription.
