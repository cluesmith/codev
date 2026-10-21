# bugfix-1836 — Decisions tab: time-only or missing stamps flagged "not converted"

## Investigate (2026-10-19)

Reproduced with the tab's own parser (`parseDecisions`) on the heading shapes the issue names:

- `### main-3 · 6:30 pm · Should we ship?` → stamp `{raw: '6:30 pm', instant: null, unconvertedReason: 'unrecognized-format'}` → the card shows "Not converted: the date or time is not in a recognized format".
- `### main-4 · Should we file the bug?` → the question becomes the stamp (`raw: 'Should we file the bug?'`), the question is `''`, and the card warns.
- `### main-6 · 2026-10-18 6:30 pm PT · Full stamp` → converts (unchanged).

Root cause, three places:

1. `servers/decisions/stamp.ts` — `STAMP_RE` requires a date and a zone; `resolveStamp` takes no context, so any stamp without both is `unrecognized-format`. Nothing reads a file-level zone.
2. `servers/decisions/parse.ts` `splitHeading` — the first ` · ` part is always the stamp, so a stampless heading's question is fed to `resolveStamp`.
3. `apps/web/src/components/DecisionsView.tsx` `Stamp` — any null instant renders the "Not converted" flag.

Scope: well under 300 LOC (stamp.ts, parse.ts, the view, the type union, the doc in both trees, tests).

Open question sent to the architect: what "unless a `## Ruled` line for it says otherwise" means for an open item's date. Real hub files (codev, shannon) carry no dated Ruled lines for open items.

## Architect ruling (2026-10-19)

Option (a): a time-only stamp is today in the file's zone at read time; the `## Ruled` clause is dropped. Refinement: a time-only stamp shows only the converted time, never a date; full stamps keep their date. The doc says a bare time means "as written, converted to your clock".

## Fix (2026-10-19)

- `stamp.ts`: date and zone are both optional in a stamp. `resolveStamp(raw, fileZone)` returns `null` for text that is not a stamp; a stamp with no zone and no file zone comes back unconverted with **no** reason; a time-only stamp gets today's date in its zone (so today's offset) and `timeOnly: true`. The zone token is now one word (`\S+`), so a question that starts with a time (`10:30 standup moved…`) is not read as a stamp with zone "standup moved…".
- `parse.ts`: the one `_Zone: <zone>_` line above the first `##` is the file zone (none, or more than one, gives none; a trailing period is tolerated). A first heading part that is not a stamp stays in the question, as written.
- Type: `unrecognized-format` removed from `unconvertedReason` (it can no longer reach the wire); `timeOnly?: true` added.
- View: a time-only instant renders with `STAMP_TIME_FORMAT` (time + viewer zone, no date); an unconverted stamp with no reason is plain text with no flag. The flag remains for unknown/ambiguous zones and skipped/repeated times.
- Doc (both trees, byte-identical): heading rule, full form still recommended, new "A file may name its zone once" bullet, and a file-zone example the doc test parses.
- Side effect worth knowing: the item template's `<YYYY-MM-DD h:mm am/pm ZONE>` placeholder is not a stamp, so it now reads as part of the template's question; the doc test says so.

Tests: 25 new/changed server tests and 2 web tests fail on HEAD's source and pass with the fix. Full codev unit suite green (6511). Playwright Decisions suite 11/11 on a throwaway Tower, including two new cases (zoned file: `6:30 PM PDT`, no stamp keeps its question, full stamp dated, no "Not converted"; unzoned file: `6:30 pm` as written, only the IST card warns). Screenshots checked by eye.

Not from this change: 74 web tests (Terminal*, VirtualKeyboard, architect-toolbar) fail locally on Node v26.3.1 because `localStorage` is undefined in jsdom there (Node's own experimental global shadows it); they do not touch the Decisions code.

## PR #1837, CMAP round 1 (2026-10-19)

- gemini APPROVE.
- codex and claude REQUEST_CHANGES, same finding: `### main-4 · 10:30 standup?` read `standup?` as an unknown zone, so the card warned and the question came out empty. Fixed: when a time-only stamp names a zone the tab cannot resolve, it warns only if the word is shaped like a zone (`ZONE_LIKE_RE`: an all-caps abbreviation, an `Area/Location` name, or an offset); otherwise the text is not a stamp and stays in the question. Dated stamps keep warning for any unknown zone. Tests: `10:30 standup?` and `6:30 pm tonight` are not stamps; `IST`, `XYZ`, `Not/AZone`, `+15:00` after a bare time still warn.
- Claude's non-blocking notes, left for the architect: an unparseable `_Zone:` line (`_Zone: Pacific Time_`) is silently no zone, and `_Zone: XYZ_` warns on each card with nothing pointing at the header line (a `DecisionsFileProblem` would be the home; follow-up); an as-written stamp renders in the normal stamp font, not monospace.
- Re-review: codex APPROVE, claude APPROVE (gemini APPROVE in round 1). Claude cleared two risks: `splice.ts` never re-serializes a heading, and item fingerprints hash raw text, so a daily-changing time-only instant can't make submits fail.

## Integration review (architect, 2026-10-19)

- §4 file template now carries `_Zone: <zone>_` with a one-line note to replace it; §3 step 1 says the hub keeps that line naming the zone its clock reads. Doc test: the template carries the line; filled in (`ET`), a bare-time item converts; left as `<zone>`, the card warns unknown-zone.
- `parse.ts` header no longer claims a pure function of the text: the clock enters through time-only stamps. Noted that `version` (the client's cache key) hashes the text only, so a client keeps the instants it has until the file changes, and that `verify()` in `splice.ts` is safe only because it compares no stamps.
- Follow-up filed: #1838 (an unusable `_Zone:` header line reported once as a `DecisionsFileProblem`).

## Owner ruling: everything in UTC (relayed by the architect, 2026-10-19)

- §4 file template ships `_Zone: UTC_`, and the note says the line stays UTC (a person typing a time in another zone writes the zone after it).
- Stamp guidance: agents write `YYYY-MM-DD HH:mm UTC` (24-hour, `date -u '+%Y-%m-%d %H:%M UTC'`); §2's template heading and the worked example (`web-4 · 2026-10-18 01:40 UTC`, the same instant as before) use it; the file-zone example is `_Zone: UTC_` + `01:40`. Other zones stay documented as accepted for anything a person types. §3 step 1: the stamp is in UTC and the `_Zone: UTC_` line stays UTC.
- Doc test: every dated example stamp must be `YYYY-MM-DD HH:mm UTC`; the template line converts a bare time in UTC; a human-typed `4:40 pm ET` in the same file keeps its own zone. The unfilled-`<zone>` case moved to a parser test on a literal.
- Left as written, flagged to the architect: the Q&A example times (`10:05 pm ET`) and §3's "every time it writes carries its zone, read from the clock (`date`)". These are times the hub writes, not stamps, and the tab shows them as written, not converted.
- Architect follow-up ruling: every time the hub writes goes UTC, not only stamps. §3's `<time> <zone>` placeholders are now `<time> UTC`; the closing guidance says every time the hub writes, in the file or a message, is UTC on the 24-hour clock (`date -u '+%H:%M UTC'`), with stamps adding the date; the 3c Q&A example reads `(02:05 UTC)` / `(02:12 UTC)`. The doc test pins all of it. The tab showing Q&A and Ruled times as written (unconverted) is follow-up #1839, which the architect is widening to cover the Q&A lines.
