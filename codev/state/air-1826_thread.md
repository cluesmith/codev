# air-1826 thread — ship the owner decisions process with the Decisions tab

## 2026-10-18 — implement

- Source: Shannon's `codev/decision-protocol.md` (read by absolute path per the architect).
  Brought over sections 3 (intake + item), 4 incl. 4b/4c (what the hub does), 5 (file
  skeleton), renumbered 1–4 for a standalone doc. Left out 0/0b/0c/1/2/6 (Shannon's scope,
  jargon table, what-needs-a-word list) except one rule from 6 that bears on the file: write
  it as little as possible, re-read before each write, every time carries its zone.
- Placement: `resources/decision-protocol.md` in BOTH trees (byte-identical), next to
  `risk-triage.md`. Not `protocols/`: it is a working agreement, not a porch protocol, and a
  `protocols/<name>/` dir would read as a spawnable protocol.
- Format section is derived from `servers/decisions/parse.ts`, `grammar.ts`, `stamp.ts`:
  `###` items under one `## Open`, id · stamp · question, one `**Your word:**` line,
  bare words described from the body's `**Options:**`, You asked / answer pairs, and "text
  after the word line = the ruling, card read-only". Time zones: the doc lists exactly what
  `stamp.ts` accepts; nothing assumes PT.
- Source inconsistencies resolved toward the latest practice (#1819 issue body, source §6):
  a ruled item moves to `## Ruled` at once (no interim `**Ruling:**` line under the word line).
  Dropped HTML-comment / `<!-- REVIEW -->` mentions (annotation-viewer artifacts) and the
  file-watch implementation details; added Tower's `RULED`/`QUESTION` notice (#1828) as how
  tab rulings reach the hub.
- Gap noticed, not fixed (out of scope): skeleton `resources/*.md` (risk-triage.md, now this
  doc) is not materialized into adopter repos; the architect role names it by path, following
  the risk-triage precedent.
- Test: `decision-protocol-doc.test.ts` runs the doc's own markdown examples through the
  parser, splice and notice, plus twin/link checks across both trees.

## 2026-10-18 — PR #1832, CMAP round 1 (codex REQUEST_CHANGES, claude APPROVE)

- Fixed (codex): the file skeleton's header said to rule "on" the `**Your word:**` line, but
  the tab reads only the lines under it, so a word typed on the line leaves the card open.
  Header now says "on the line under"; §3 says the hub scans "the lines under". A new test
  pins both behaviours.
- Fixed (codex): the `## Ruled` one-liner carried `<what happened>` before DONE supplies it.
  Now `- **<id>** · <time> <zone> · <question> → `<word>``, and DONE appends
  ` → DONE <time> <zone>: <what happened>`.
- Rebutted (codex): over AIR's 300 LOC. There is no runtime code; the length is the doc the
  issue asks for (~180 lines), its mirror (two-trees rule) and its test. Flagged to the
  architect rather than trimmed silently.
- Applied (claude, non-blocking): test pins every zone the doc names to `stamp.ts`; §4 says
  creating the file is what makes the tab appear; §3 says the Tower notice reaches only an
  architect named `main`.
- Porch's first `tests` check failed with truncated output; three later full runs on the same
  commit passed. Unidentified; recorded under Flaky Tests in the PR body.

## 2026-10-18 — architect integration review on PR #1832

- The owner's comment now survives the hub's `RULING` relay (verbatim, on the lines after it)
  and the `## Ruled` record (quoted after the word). Before, a conditional ruling lost its
  condition everywhere but Tower's notice. The doc test asserts both forms.
- `roles/architect.md` section trimmed to three lines (what the file is, `main` is the hub,
  pointer to the doc); the intake command and `RULED` format live only in the doc (Spec 1280
  direction: keep the always-loaded role small).
- Filed #1834 (area/scaffold): skeleton `resources/*.md` reference docs never reach adopter
  repos; one generic fix, not per-file.
- pr gate stays pending; the architect takes the merge word to the owner once CI is green.
