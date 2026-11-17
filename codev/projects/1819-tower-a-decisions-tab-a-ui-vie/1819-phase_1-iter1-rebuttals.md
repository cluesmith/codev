# Phase 1 — iteration 1 rebuttal

Both reviewers requested changes. Every point was accepted and fixed in commit `f8b7f082b`;
117 decisions tests pass (up from 107), and `tsc` is clean.

## Codex (REQUEST_CHANGES)

1. **Q&A continuation swallowed unindented prose and `####` headings.** Accepted. Continuation
   is now exactly what the spec says: the following *indented* lines (2+ spaces or a tab) that
   are non-blank, unfenced, not headings, and not themselves a Q&A entry. New tests show that
   unindented prose and a `####` heading after an entry stay in `bodyMarkdown`, and that an
   indented line which is itself an entry starts a new entry.
2. **`parseOptions` diverged from the segment rules.** Accepted, both halves. The early return is
   gone, so later `` / `word` `` segments are read even when the first segment is not an option
   (the first option *found* is recommended). A description is now only the text after `=`;
   text after a span without `=` is not read. The test that encoded the old behaviour is
   replaced.
3. **`splitHeading` with one separator.** Accepted. With any separator, the first part after the
   id is the stamp and the rest is the question, as the spec says. `### a-2 · Only a question`
   now yields stamp `Only a question` (shown unconverted, `unrecognized-format`) and an empty
   question. Test updated.

## Claude (REQUEST_CHANGES)

1. **Blocking: `in` on the zone tables let `toString`, `__proto__` and similar names through,
   and `resolveStamp` threw.** Accepted. The lookups use `Object.hasOwn`, and `toString`,
   `__proto__`, `constructor`, `hasOwnProperty` and `valueOf` are added to the unknown-zone
   test table.
2. **Mixed option line returned no options.** The same as codex 2 — fixed.
3. **`####` heading swallowed into a Q&A entry.** The same as codex 1 — fixed.
4. **CRLF trap for Phase 2.** Acknowledged. `joinTrimmed`'s doc comment now says its result is
   LF-normalized; Phase 2's verification will compare LF-normalized text.
5. **Fingerprint included the blank lines after the item.** Accepted as an improvement. The
   fingerprint now covers the heading through the item's last non-blank line, so re-spacing
   between items is not an edit of this one. Test added; the wire-type doc comment is updated.
   `ParsedItem.end` still spans the full region, which the splice needs.
6. **`process.env.TZ = undefined` in teardown.** Fixed: `delete process.env.TZ` when it was
   unset, in both files.
7. **`detectLineEnding` comment said "predominantly".** Fixed to describe what the code does (the
   file's first terminator).
