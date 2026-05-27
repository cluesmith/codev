# bugfix-839 thread

## Investigate

Issue #839: two `contributes.commands` entries in `packages/vscode/package.json` are missing the `Codev:` prefix that every other command uses.

Located the two entries at `packages/vscode/package.json:213-220`:

- `codev.submitReviewComment` → `"Submit review comment"`
- `codev.deleteReviewComment` → `"Delete review comment"`

Grep for these strings across `packages/vscode/` finds them only in `package.json` — no other code/docs reference the title text, so renaming is safe (commands are referenced by their internal id, not the title).

Fix: title-case to match the rest of the command set:
- `Codev: Submit Review Comment`
- `Codev: Delete Review Comment`

Net diff: 2 lines.

No regression test possible/needed — this is a static `package.json` manifest entry surfaced by VS Code's marketplace UI. There is no runtime path to assert against; the only "test" is reading the JSON. Will note this in the review.

## PR

PR #864 opened. Build + tests green via porch checks.

## CMAP (iter 1)

- gemini: APPROVE — HIGH confidence
- codex:  APPROVE — "Scoped manifest fix matches the issue and leaves all 40 contributed command titles consistently prefixed with `Codev:`."
- claude: APPROVE — "Minimal, correct fix — two command titles prefixed to match convention; all 40 commands verified consistent; no test needed for static manifest entries."

3/3 APPROVE. Notifying architect.
