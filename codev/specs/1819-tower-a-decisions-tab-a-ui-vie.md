---
approved: 2026-10-17
validated: [codex, claude]
---

# Specification: Tower Decisions tab — a UI view of the pending-decisions file

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

## Problem Statement

In a multi-architect workspace, one architect (`main`) is the hub for owner decisions. Every
other architect sends it a decision; `main` rewrites it in plain words and posts it into one
file, `codev/state/pending-decisions.md`, under `## Open`. The owner rules by opening that file
in a Tower file tab and typing a word (and often a sentence) under the item's `**Your word:**`
line.

That works, but the owner is ruling on several decisions at once, often late at night, often
from a phone through the Tower tunnel, in a raw-markdown editor. Each ruling means: find the
item, find its `**Your word:**` line, put the cursor in the right place, type the word exactly as
offered, save. It is easy to put the text in the wrong item, mistype an option, or save while
`main` is rewriting the file. The owner asked for "just a view of the dec doc": a card per open
item, the options as click boxes with the recommended one marked, a comment box, and the
owner's choice written back into the file exactly where they would have typed it.

Affected: the workspace owner (rules decisions), the hub architect `main` (reads rulings out of
the file; must see no difference between a tab-written ruling and a hand-typed one), and the
other architects (receive the relayed rulings; unaffected directly).

## Current State

- **The decision process** (from the issue). Architects send `afx send architect:main "DECISION
  <name>-<n>: <title> …"`. `main` posts the item under `## Open`, newest first. The owner opens
  the file with `afx open codev/state/pending-decisions.md`, types a word on/after the item's
  `**Your word:**` line (or a sentence anywhere under the item, or in chat), and says `ddu` in
  `main`'s terminal — or a Tower cron notices the file changed. `main` scans every open item
  (a regex over the text after `**Your word:**`), relays `RULING <id>: <word>` to the
  originating architect, moves the item to `## Ruled` as a one-line record, and later appends
  the architect's `DONE <id>: …` to that record. Only `main` and the owner write the file.
- **Questions** (owner's protocol addition, 2026-10-17). Instead of a word, the owner may type a
  question under `**Your word:**`. `main` relays it to the owning architect and pastes the answer
  into the item, above the `**Your word:**` line, as two labelled list lines, clearing the
  question from under the line; the item stays open and the owner rules after reading:

  ```markdown
  - **You asked (6:07 am):** "why a new tool? Don't we have existing tools?"
  - **Onboarding's answer (6:09 am):** The Daybreak composer does not get the chat tool set. …
  ```

  A second question appends a second pair. Nothing else in the format changes.
- **The file format** (verbatim from the issue):

  ```markdown
  # Pending owner decisions — all architects (hub: main)

  Rule inline: a letter or one word on an item's **Your word:** line is enough. "approve" = approve AND merge.
  Newest first. Only main edits this file; architects send items with `afx send architect:main "DECISION …"`.

  _Status: N open — <ids>. Written h:mm pm (<what changed>)._

  ## Open

  ### <architect>-<n> · <YYYY-MM-DD h:mm am/pm PT> · <Question the owner answers, naming the artifact by what it does>

  - **Problem:** (or **Context:**) what is wrong or undecided, as the owner would see it.
  - **Root cause:** why (for a fix). For a choice: **Options:** (a) `word` = … (b) `word` = …
  - **Fix:** what the change does, in product terms.
  - **Testing:** the receipt.
  - **Cost:** dollars or minutes, only when money is involved.
  - **Recommendation (<architect>):** one line; may be followed by "Main's note: …".
  - **Links:** URLs and repo paths.

  **Your word:** `<first word, recommended>` = what it does / `<second word>` = what it does / `hold`

  ## Ruled

  - **<id>** · ruled `<word>` <time> · relayed <time>: <what happened> · DONE <time>: <architect's report>
  ```

- **What Tower offers today.** A file tab (`afx open`) renders the file in the annotator
  iframe (`open.html`): markdown preview, inline edit + save of the whole file, and a 1-second
  mtime poll that auto-reloads when the file changes on disk (suppressed while the user has
  unsaved edits). There is no structured view, no per-item affordance, and a save writes the
  whole buffer back — so an edit made from a stale buffer can overwrite `main`'s newer write.
- **Time zones.** Item headings carry a local-time stamp with a zone (`PT` in the requesting
  owner's file). Nothing in Tower interprets these stamps today.
- **Precedent for a conditional tab.** The dashboard's Team tab appears only when the workspace
  has `codev/team/`; the workspace `state` response carries a `teamEnabled` flag computed per
  request.

## Desired State

A **Decisions** tab in the Tower dashboard (desktop and mobile layouts) for any workspace that
has the decisions file at its configured path. Opening it shows:

1. **A card per `## Open` item, in file order** (the file is newest-first by convention; the
   tab is a view and does not re-sort). Each card shows the id, the heading's timestamp rendered
   in the viewer's local time zone (the original stamp available on hover), the question, and
   the item body rendered as markdown with URLs as clickable links (opening in a new browser
   tab, never navigating the dashboard away).
2. **The options from the `**Your word:**` line as radio buttons**, each with its description
   (the text after `=`), the first option visibly marked *Recommended*.
3. **One free-text comment box** per card, for anything the owner wants to say instead of, or
   in addition to, a word — including a **question** the owner wants answered before ruling.
4. **A Submit action** per card. It writes into the file, under that item, directly after the
   `**Your word:**` line, what the owner would have typed by hand: the chosen word on its own
   line, then the comment as a paragraph. Nothing else in the file changes.
5. **The current ruling.** Any text already present after the item's `**Your word:**` line
   (typed by hand or written by an earlier submit) is shown on the card as the current ruling,
   and that card is then read-only.
6. **A question-and-answer thread.** `- **You asked (time):**` / `- **<Name>'s answer (time):**`
   list-line pairs that `main` pastes into the item body show as a small thread on the card,
   newest at the bottom, so the owner reads the answer without opening the raw file.
7. **`## Ruled`** below the cards: a read-only list, collapsed by default.
8. **Live.** When the file changes on disk the tab re-renders from the new content. A
   half-written comment or a selected-but-unsubmitted option survives the re-render.
9. **Failures are loud.** A submit that cannot be applied cleanly is refused with a message on
   that card, and the owner's comment stays in the box.

For `main`, nothing changes in kind: a tab-written ruling is plain text on the lines directly
after the item's `**Your word:**` line — where a hand-typed ruling goes — so the existing scan
and the `ddu` / cron flow pick it up. The exact bytes are pinned under "Writing (the splice)".
`main`'s scan reads everything after that line to the end of the item (confirmed by the
adopter's hub architect; see Assumptions).

### Behavioural detail

**Structural grammar (what counts as structure).** The read model and every write check use one
grammar, a subset of CommonMark:
- A *fence line* has up to three leading spaces, then three or more backticks or tildes. A fence
  opened by a run of N characters closes at the next fence line of the same character with at
  least N characters; the lines between are fenced content. An unclosed fence runs to end of
  file.
- A *heading line* is an unfenced line with up to three leading spaces, then one to six `#`,
  then a space or end of line (ATX). Only ATX headings are structural; setext underlines are
  not.
- `## Open` and `## Ruled` are level-2 heading lines whose text is exactly `Open` / `Ruled`
  (trailing spaces and closing `#`s ignored).
- An *item* is a level-3 heading line inside `## Open`. Its text runs to the next heading line
  of level 1–3, or end of file; level-4+ headings are part of the item.
- A *Your-word line* is an unfenced line in an item that, after up to three leading spaces,
  begins with `**Your word:**`.

**Parsing (the read model).** The file is parsed fresh on every read; there is no cached copy.
- **Item id** = the heading's first whitespace-delimited token. The rest of the heading is split
  on ` · `: the first part is the timestamp, the remainder (re-joined) is the question. A heading
  without separators yields an id and a question with no timestamp.
- **Options** = the text after `**Your word:**`, split on ` / `; each segment that begins with a
  backticked word contributes one option: the word, plus the description after `=` if present.
  The first option is the recommended one. The file's preamble allows "a letter or one word";
  the tab offers and writes the word (letters are a hand-typing shorthand, not separate options).
- **Option descriptions** (owner's change at the PR gate, 2026-10-17). An option's description
  is the text after its `=` on the Your-word line when present. Otherwise, it is that word's
  entry in the item body's `**Options:**`, in any of these forms:
  - `(a) `word` = …` after the label, on its line (the label may follow other text on the line,
    as in "For a choice: **Options:** …");
  - `(a) `word`: …`;
  - a `- `word` = …` (or `- `word`: …`) list item under the label.

  The entries run from the label until a blank line (unless an entry follows it), a heading, a
  fence, or a line that is neither indented nor an entry. A wrapped entry's lines are joined.
  Fenced lines and Q&A entries are not read. Failing both sources, the option is the word
  alone. The body itself is shown unchanged. Each option reads inline as `word: description`,
  with the Recommended marker after it.
- **Body** = the item's lines between the heading and the Your-word line, less any
  question-and-answer entries (below), which render as the thread instead.
- **Current ruling** = the item's text after the Your-word line, trimmed; empty means unruled.
  It is shown verbatim as plain text, not rendered, so everything `main`'s scan would read is
  visible — including an annotator `<!-- REVIEW -->` comment, which a markdown render would hide.
- **Question-and-answer thread** = the body's list entries whose line begins (after up to three
  leading spaces) `- **You asked (<time>):**` or `- **<Name>'s answer (<time>):**` (straight or
  curly apostrophe; `<Name>` is any text). An entry is that line plus its indented continuation
  lines. Entries are shown in file order — `main` appends each new pair below the last, so the
  newest is at the bottom — each labelled *You asked* or *<Name>'s answer* with its time and its
  text rendered as markdown. A question with no answer after it yet shows as awaiting an answer;
  an answer with no question before it is still shown. The `(<time>)` stamps carry no date or
  zone, so they are displayed exactly as written and never converted or assigned a zone.
- **Fingerprint** = a digest of the item's full text, used by the write checks below.
- **`## Ruled`** = the section's content, shown as markdown, read-only.
- **Malformed input is reported, not guessed at.** A file with no `## Open` section shows an
  error naming the problem. An item with no Your-word line, or more than one, is shown with its
  body and a notice that the tab cannot write a ruling for it. Two or more items with the same
  id are all shown, flagged as duplicates, and are entirely read-only (no option buttons, no
  comment box, no draft).

**Items with text after the Your-word line are read-only.** An item whose current ruling is
non-empty — typed by hand, or written by an earlier submit from this or another browser — shows
that text and offers no option buttons or comment box. The note is neutral, because the tab
cannot tell a ruling from a question: it says the owner has written under this item and `main`
will act on it, and that a change of mind goes through `main` or a hand edit of the file. So the
file never carries two tab-written rulings for one item, and of two near-simultaneous submits the
second is refused rather than stacked.

**Asking a question.** A question is typed in the comment box and submitted like any comment —
no new write shape; with no word chosen it lands on the line after the Your-word line. `main`
reads it as the ruling text, recognises it as a question, relays it, and pastes the
*You asked* / *answer* pair into the item body above the Your-word line. **When it pastes the
pair, `main` removes the question text (and any `<!-- REVIEW -->` comment) from under the
Your-word line**, so nothing follows that line and the item is writable again on the tab's next
read; the owner then rules — or asks again — as usual. A second question produces a second pair
below the first. While a question is waiting for its answer, the item is read-only and shows the
question as its current ruling. The round-trip depends on that hub behaviour (see Assumptions):
the tab adds no rule of its own for questions.

**Timestamps (no assumed zone).** The stamp is `YYYY-MM-DD h:mm am|pm <ZONE>` (am/pm
case-insensitive) or `YYYY-MM-DD HH:mm <ZONE>`. It is resolved to an absolute instant using only
the zone written in the text; the tab then displays that instant in the viewer's local zone, with
the original stamp available on hover. Accepted zones:
- `UTC`, `GMT`, `Z` — offset 0.
- Numeric offsets `±HH:MM`, `±HHMM`, `±H`, optionally prefixed by `UTC` or `GMT` (`+05:30`,
  `UTC+5:30`, `GMT-7`).
- IANA names (`Europe/London`, `America/Los_Angeles`) known to the runtime's time-zone data.
- Generic North-American abbreviations, resolved through their IANA zone for the stamp's date
  (so DST follows the date): `PT` America/Los_Angeles, `MT` America/Denver, `CT` America/Chicago,
  `ET` America/New_York, `AKT` America/Anchorage, `HT` Pacific/Honolulu.
- Fixed-offset abbreviations: `PST` −8, `PDT` −7, `MST` −7, `MDT` −6, `CST` −6, `CDT` −5,
  `EST` −5, `EDT` −4, `AKST` −9, `AKDT` −8, `HST` −10, `WET` 0, `WEST` +1, `CET` +1, `CEST` +2,
  `EET` +2, `EEST` +3, `MSK` +3, `SGT` +8, `HKT` +8, `JST` +9, `KST` +9, `AEST` +10, `AEDT` +11,
  `NZST` +12, `NZDT` +13. (`CST` means North-American Central here; China Standard Time is
  written `+08:00` or `Asia/Shanghai`.)
- Everything else — including the deliberately excluded ambiguous `IST`, `BST`, `AST` — is shown
  verbatim and marked unconverted.
- For IANA and generic zones, a wall-clock time that does not exist on that date (spring-forward
  gap) or occurs twice (fall-back fold) is shown verbatim and marked unconverted; there is no
  tie-break rule.
- Resolution uses the runtime's built-in `Intl` time-zone data; no date library is added. Nothing
  defaults to, or special-cases, Pacific time.

**Writing (the splice).** A submit carries the item id, the chosen word (optional), the comment
(optional; at least one of the two is required; trimmed; internal newlines kept; at most 10,000
characters), and the item's fingerprint as the card last rendered it. Writes to the decisions
file are serialized inside Tower — at most one is in progress per file — and each re-reads the
file from disk once it has its turn. A write is refused, with an error naming the reason, if:
- the `### <id>` heading is missing from `## Open` or appears more than once (baked decision 3);
- the item has no Your-word line, or more than one;
- the item already has a current ruling;
- the chosen word is not one of the options on the item's *current* Your-word line;
- the item's fingerprint differs from the submitted one (the item was edited after the owner last
  saw it). Changes elsewhere in the file — the status line, other items, `## Ruled` — do not
  trigger this;
- the comment is empty when no word is chosen, or exceeds the length limit;
- the comment contains a heading line, a fence line, or a Your-word line (per the grammar above),
  any of which would change the structure that `main` and the tab parse;
- **the result does not verify**: the spliced text is re-parsed and must have the same sections,
  the same items in the same order with the same ids, the same options on this item, and this
  item's current ruling equal to exactly the inserted text. This catch-all refuses anything the
  explicit checks miss.

Otherwise the write inserts, directly after the Your-word line: the word on the very next line
(if given); then the comment (if given), preceded by a blank line when a word was written; then a
blank line if the line that follows is not already blank. Every pre-existing byte of the file is
preserved in order, the file's line-ending style (LF or CRLF) is used for inserted lines, a
missing final newline on the Your-word line is supplied, and nothing else is touched.

Example — before:

```markdown
**Your word:** `accept` = merge as is / `rework` = send back / `hold`

### main-11 · …
```

After choosing `accept` with a comment:

```markdown
**Your word:** `accept` = merge as is / `rework` = send back / `hold`
accept

accept but don't add the limit on additional tests. That could easily backfire.

### main-11 · …
```

After a comment with no word:

```markdown
**Your word:** `keep` = keep the skills / `drop` = drop them / `hold`
Wait. That means if someone after onboarding connects whatsapp they can't do the scan? Keep the skills…

### main-11 · …
```

- **Atomic replacement.** The new content is written to a temporary file in the same directory as
  the real target and renamed over it, keeping the file's permissions. A crash mid-write leaves
  the old or the new file, never a truncated one. If the configured path is a symlink (to a
  target inside the workspace), the target is replaced and the link left in place.
- **Response.** A successful write returns the re-parsed document (with new fingerprints), which
  the tab renders at once rather than waiting for the next change check. A refused write returns
  the error; the file is byte-identical, the card shows the error, and the draft is kept.
- **`main` writes out of process**, so Tower cannot lock against it. The exposure is the
  milliseconds between Tower's re-read and its rename; the fingerprint refuses item edits made
  before that, and `main`'s editor (Claude Code's Edit) refuses to write a file changed since it
  read it.

**Links.** URLs in item bodies and in `## Ruled` render as links (`MarkdownView` linkifies).
Within the Decisions view, `http(s)` links open in a new browser tab (`noopener`) and other links
are inert, so a click never navigates the dashboard away — important on mobile through the
tunnel. This is handled by the Decisions view's own container; the shared renderer, which VS Code
also consumes, is not changed.

**Drafts.** Each card's draft (selected option + comment text) is held in component state keyed
by item id, not DOM position, so re-renders, re-ordering and tab switches do not lose it. A
successful submit clears that card's draft. If an option a draft selected disappears from the
item's options, the selection is dropped and the card says so; the comment is kept. If a
non-empty draft's item stops being writable — it leaves `## Open` (for example `main` moved it
to `## Ruled`), becomes a duplicate, or gains text after its Your-word line from elsewhere — the draft is *held*: shown
read-only under a notice naming the reason, with the text selectable for copying and a Discard
action. An unsaved comment is never silently lost.

**Configuration.** The file path is a Tower setting in `.codev/config.json` (key
`dashboard.decisionsFile`), relative to the workspace root, default
`codev/state/pending-decisions.md`, read through the normal config layers (so
`.codev/config.local.json` can override it). At every read and write the path is resolved
against the workspace root and canonicalized (symlinks followed); if the canonical path is
outside the canonical workspace root, the request is refused with an error and nothing is read or
written. The client never supplies a file path.

**Visibility.** The workspace `state` response carries a flag indicating whether the decisions
file exists at the configured path; the Decisions tab appears only when it does (Team-tab
precedent). If the file disappears while the tab is open, the tab shows a not-found message (held
drafts stay visible).

## Success Criteria

- [ ] A workspace whose decisions file exists at the configured path shows a **Decisions** tab
      in the Tower dashboard, on desktop and in the mobile layout; a workspace without it shows
      no such tab.
- [ ] Each `## Open` item renders as a card in file order with id, local-time timestamp,
      question, and markdown body; `http(s)` links open in a new browser tab and no click
      navigates the dashboard away.
- [ ] Each writable card shows one radio per option on its Your-word line, in order, with
      descriptions; the first is visibly marked recommended.
- [ ] Each writable card has one comment box and a Submit action; Submit is disabled until an
      option is selected or a comment is non-empty, and while a submit is in flight.
- [ ] A submit inserts exactly the bytes defined in "Writing (the splice)" directly after that
      item's Your-word line (unit-tested byte-for-byte for word, comment, and word + comment); a
      before/after diff of the file shows only the inserted lines.
- [ ] Every refusal case in "Writing (the splice)" returns a specific error, leaves the file
      byte-identical, shows the error on the card, and keeps the draft.
- [ ] Writes are serialized per file and replace the file atomically; of two concurrent submits
      to one item, exactly one is applied and the other is refused as already ruled.
- [ ] A successful submit's response re-renders the card at once, showing the new ruling.
- [ ] An item with existing text after its Your-word line shows it as the current ruling and is
      read-only; duplicate-id items and items without exactly one Your-word line are read-only
      with a notice.
- [ ] Question-and-answer pairs in an item's body render as a thread on the card in file order
      (newest at the bottom), not duplicated in the body; their `(time)` stamps are shown as
      written.
- [ ] A question round-trip works end to end: a comment-only question is written after the
      Your-word line and the card goes read-only; once the file shows the pair above the
      Your-word line and nothing after it, the card is writable again and shows the thread.
- [ ] `## Ruled` shows below the cards, read-only, collapsed by default.
- [ ] An external write to the file is reflected in the open tab within a few seconds, without
      a manual refresh; a draft comment and a selected option survive that re-render.
- [ ] A draft whose item stops being writable is held, visible and copyable, until discarded.
- [ ] Timestamps convert from the zone written in the stamp to the viewer's local zone for every
      accepted zone form; unrecognized zones and DST gap/fold times are shown verbatim and marked
      unconverted. Tests cover PT in both DST states, every fixed abbreviation, a non-US offset,
      UTC, an IANA name, an unknown zone, a gap and a fold; no code path assumes PT.
- [ ] The path is configurable via `dashboard.decisionsFile`; the default is
      `codev/state/pending-decisions.md`; a path — including one reached through a symlink —
      whose canonical location is outside the workspace is refused for both read and write.
- [ ] The parser and the splice are pure functions with their own unit tests against the
      format in this spec, including malformed-input and edge cases.
- [ ] The tab is exercised in a real browser via Playwright (render, choose + comment + submit,
      file updated on disk, external change re-renders with the draft intact) before the PR is
      called done.
- [ ] The new routes are covered by the same request authentication as every other workspace
      API route.

## Constraints

### Baked Decisions (architect, issue #1819 triage comment — verbatim, fixed)

1. **Tower serves it, nothing new runs.** The tab is a new tab type in the existing Tower
   dashboard, backed by workspace-scoped Tower API routes next to the `afx open` annotate route
   in `tower-routes.ts`. Markdown rendering reuses what the dashboard already has
   (`artifact-canvas` MarkdownView), not a second renderer.
2. **The file is the only state.** Read on open, re-read on file change, no cache that can
   disagree with disk. The configurable path lives in `.codev/config.json` with the default
   `codev/state/pending-decisions.md`, consistent with where every other Tower setting lives.
3. **Writes are a splice, and they fail loudly.** The write endpoint locates the item by its
   `### <id>` heading, inserts the word line and the comment paragraph directly after the
   `**Your word:**` line, and writes nothing else. If the heading is missing or appears twice at
   write time, the write is refused with a clear error and the owner's text stays in the comment
   box. No reformatting, no merge heuristics, no fallback.
4. **The parser is a pure function with its own tests** against the format in the issue body:
   ids from the heading's first token, options from the backticked words on the
   `**Your word:**` line, first option recommended, existing owner text after that line shown as
   the current ruling. Per the owner's comment, the heading's time zone is parsed from the text
   and rendered in the viewer's local zone. Nothing may assume PT.
5. **Unsaved comment survives re-render.** Keyed by item id in component state, not by DOM
   position.
6. **`## Ruled` is read-only** and collapsed by default.

Out of scope, as the issue says: notifications, a store, per-architect files. Moving
`decision-protocol.md` into the skeleton is a follow-up once the tab ships.

Note on decision 1: the web dashboard does not yet depend on `@cluesmith/codev-artifact-canvas`
(only the VS Code extension does); reusing `MarkdownView` means adding that dependency, which
is the intended reading of the decision, not a new renderer.

Note on decision 3: this spec adds further refusals (missing/duplicate `**Your word:**` line,
item already ruled, word not among current options, item changed since rendered,
structure-breaking comment, failed re-parse verification) and requires writes to be serialized
and atomic. Each is a stricter fail-loud guarantee in the same spirit; none reformats, merges, or
falls back.

### Other constraints

- **Owner time-zone rule** (issue comment, 12:11 am): the tab parses whatever zone the file
  states and renders in the viewer's zone; nothing may assume PT.
- **Server/client isolation (#1189)**: server code and the SDK never import each other; the web
  dashboard talks to Tower over HTTP only.
- **Request authentication (GHSA-xvjp-7748-v88v)**: every new route sits behind the existing
  Tower key check; there is no unauthenticated read or write.
- **UI verification**: Tower UI changes are verified in a browser via Playwright before being
  called done (project testing rule; the architect's triage also requires a Playwright run and
  a 3-way integration review before merge).
- **Single source of truth**: the file. No database rows, no localStorage copy of decisions.

## Assumptions

- The issue's format section is authoritative; the adopter's `decision-protocol.md` (sections 3
  and 5) matches it.
- `main` keeps the file newest-first; the tab does not re-sort.
- The owner's word is a single token from the offered options; anything else goes in the
  comment.
- **`main`'s scan contract** (confirmed by the adopter's hub architect, relayed by the architect
  2026-10-17): the scan takes *everything* after the `**Your word:**` line to the end of the item
  as the ruling. A word on the next line, a blank line then a comment, and a comment-only
  sentence all read. Text on the **same line** after the options is *not* read — so the tab must
  keep writing on the following line, never appending to the `**Your word:**` line itself. The
  scan appends no `**Ruling:**` line under the item; on a ruling, `main` moves the item out of
  `## Open` and records a one-liner under `## Ruled`. (Consequence for the tab: a ruled item
  normally disappears from `## Open` shortly after a submit, which the held-draft and
  read-only-when-ruled behaviour already cover.)
- **Hub behaviour for questions** (owner's protocol addition, issue comment 2026-10-17 6:15 am;
  confirmed by the adopter's hub architect, relayed by the architect): when `main` pastes a
  *You asked* / *answer* pair above the `**Your word:**` line, it **removes the question text and
  any `<!-- REVIEW -->` comment from under that line**, leaving nothing after it, so the item is
  unruled again. The tab's read-only rule (text after the Your-word line ⇒ read-only) relies on
  this to make a question round-trip leave the item writable. If a hub did not clear the
  question, the item would stay read-only after the answer and the owner would rule through
  `main` or a hand edit — a hub-side defect, not something the tab works around.
- The *You asked* / *<Name>'s answer* labels and their list-line shape are as the owner's
  addition shows; `main` appends each new pair below the previous one.
- Anyone with access to the workspace's Tower dashboard is acting as the owner, exactly as with
  the existing file tab's edit + save. No per-user identity is recorded.
- The file is small (tens of KB at most), so reading and parsing it on every request and poll
  is cheap.

## Solution Approaches

### Approach 1: Server parses and splices; client renders JSON; client polls (recommended)

The server owns one parser used by both the read route and the write route. The read route
returns the parsed document (items with id, raw stamp, resolved instant, question, body
markdown, options, current ruling, fingerprint, problems; the ruled markdown; a document
version). The write route takes its turn on the file, re-reads, re-parses, validates, splices,
verifies, and replaces the file atomically. The client renders cards, formats the resolved
instant in local time, and while the tab is visible checks the read route every couple of
seconds, re-rendering only when the version changes.

- **Pros:** one parser for read and write, so what the owner sees and what the write validates
  can never disagree; the client stays a thin view; time-zone resolution happens once, on the
  server, with the runtime's built-in `Intl` data (offset probing; no new dependency); polling
  matches the existing annotator's mtime poll, needs no new watcher lifecycle in Tower, and works
  unchanged through the tunnel and on mobile.
- **Cons:** up to a poll interval of lag for external changes (the tab's own writes render at
  once from the write response); a request every few seconds while the tab is visible
  (negligible for a small file, and suspended when hidden). Wall-clock → instant conversion for
  IANA zones has to be built on `Intl` offset probing, since the monorepo has no date library and
  the supported Node versions have no `Temporal`.
- **Risk/complexity:** low.

### Approach 2: Client parses raw text; server only splices

The read route returns the raw file; the client parses it. The write route still has to locate
the item and validate, so it needs its own parse.

- **Pros:** minimal read route.
- **Cons:** two parsers (or a parser shared across the client/server boundary, which the
  isolation rule makes awkward) that must agree on item boundaries; a disagreement writes into
  the wrong place or refuses spuriously. Time-zone resolution would run in every viewer's
  browser.
- **Risk/complexity:** medium; violates "single source of truth" in spirit.

### Approach 3: Server push (file watcher + SSE) instead of polling

Tower watches the decisions file per workspace and pushes a change event over the existing SSE
stream; the tab refetches on that event.

- **Pros:** near-instant updates, no polling traffic.
- **Cons:** a watcher per workspace with its own start/stop lifecycle across workspace
  activation, file creation/deletion and editors that replace files by rename (as this tab's own
  atomic write does); the dashboard's SSE consumer currently refetches on any event, so a new
  event type needs plumbing in the shared SSE hook. More moving parts for a file written a few
  times an hour.
- **Risk/complexity:** medium. Worth revisiting only if polling proves inadequate.

**Recommendation: Approach 1.** It keeps one parser, keeps Tower free of new long-lived
watchers, and mirrors how the existing file tab already detects change.

## Open Questions

**Critical** — none open.
1. *`main`'s scan contract* — **resolved** (see Assumptions): the scan reads everything after the
   `**Your word:**` line to the end of the item, so the shape in "Writing" is read as written;
   same-line text is not read, so the tab never writes on the `**Your word:**` line itself.

**Important** (shape the design; the spec takes a position — confirm at the spec gate):
2. *Explicit Submit vs write-on-click.* The issue says "on choose / submit". This spec uses an
   explicit Submit per card so a misclick never writes and word + comment land in one splice.
3. *Already-ruled items are read-only.* A change of mind goes through `main` or a hand edit.
   The alternative — allowing a second tab ruling inserted above the first — leaves two words
   after the Your-word line and makes the file ambiguous.
4. *Item fingerprint check.* Refusing when the item changed since it was rendered is stricter
   than baked decision 3 requires. It guards against ruling on text `main` has since rewritten;
   the cost is an occasional resubmit.
5. *Config key name.* `dashboard.decisionsFile`, next to the existing `dashboard.frontend`.

**Nice-to-know:**
6. Repo paths in **Links:** could open as Tower file tabs; this spec makes `http(s)` URLs
   clickable and leaves repo paths as rendered text. Follow-up if wanted.
7. An open-count badge on the tab label (`Decisions (3)`) would need the state route to parse
   the file on every state poll; left out.
8. Persisting drafts across a page reload (localStorage) is not required; drafts survive
   re-render and tab switches only.

## Test Scenarios

**Grammar and parser (unit, pure):**
- The issue's format example parses to the expected items, options (order, descriptions,
  recommended = first), body, empty current ruling, fingerprint, and ruled content.
- Multiple items; ids from the first heading token; question containing ` · `; heading with no
  separators; headings with up to three leading spaces; a level-4 heading inside an item.
- Option descriptions containing backticks, `=` and ` / `; a `hold` option with no description.
- Bare words on the Your-word line take their descriptions from the body's `**Options:**` in
  each form: `(a) `w` = …`, `(a) `w`: …`, and a `- `w` = …` list. The Your-word line's own `= …`
  wins over the body. A word with neither stays bare. Fenced Options, Options inside a Q&A
  entry, and text after the Your-word line are not read.
- Existing owner text after the Your-word line (word only; word + sentence; multiple paragraphs)
  appears as the current ruling and makes the item read-only.
- `###`, `## Ruled` and `**Your word:**` inside a fenced code block are content, not structure;
  backtick and tilde fences; a longer closing fence; an unclosed fence.
- Question-and-answer entries: one pair; two pairs (file order kept); a question awaiting its
  answer; an answer with no question; curly apostrophe; a multi-word `<Name>`; an indented
  continuation line; entries removed from the rendered body; time text kept verbatim.
- A current ruling that is only an `<!-- REVIEW -->` comment is non-empty and shown verbatim.
- Malformed: no `## Open`; item without a Your-word line; two Your-word lines; duplicate ids;
  empty `## Open`; no `## Ruled`; CRLF file; file without trailing newline.

**Timestamps (unit):**
- `2026-07-01 3:05 pm PT` → the PDT instant; `2026-12-01 3:05 pm PT` → the PST instant.
- Every fixed abbreviation in the table; each generic zone; `UTC`, `GMT`, `Z`; `+05:30`,
  `+0530`, `UTC+5:30`, `GMT-7`; `Europe/London`; 24-hour `15:05`; `AM`/`pm` casing.
- `IST`, `BST`, `AST`, `XYZ`, missing zone, malformed time → unconverted, raw text preserved.
- Spring-forward gap (`2026-03-08 2:30 am PT`) and fall-back fold (`2026-11-01 1:30 am PT`) →
  unconverted.
- No path yields a PT interpretation for a stamp that does not say PT.

**Splice (unit, pure):**
- Word only; comment only; word + comment; multi-line comment — output equals the expected bytes,
  and every original byte is preserved in order.
- Your-word line as the last line with and without a trailing newline; a heading directly after
  the Your-word line (no blank); CRLF file uses CRLF.
- Each refusal: heading missing, heading duplicated, no/two Your-word lines, already ruled,
  unknown word, fingerprint mismatch, empty word and comment, over-length comment, comment with a
  `#` heading line (including indented by up to three spaces), comment with a fence line,
  comment containing `**Your word:**`, and a structure change caught only by the re-parse
  verification. Each returns a specific error and no output text.
- An unrelated change elsewhere in the file (status line, another item, `## Ruled`) does not
  refuse.

**Routes (integration):**
- Read returns the parsed document for the configured path; not-found response when absent;
  refused when the configured path, or a symlink it passes through, resolves outside the
  workspace.
- Write applies a valid splice to disk and returns the re-parsed document; refused writes leave
  the file byte-identical and return the error; the config override of the path is honoured;
  requests without the Tower key are rejected.
- Two concurrent writes to the same item: exactly one applies, the other is refused as already
  ruled; the file contains one ruling.
- The write replaces the file by rename (old content intact if the write is interrupted before
  the rename); a symlinked decisions file keeps its link and has its in-workspace target updated;
  file permissions are kept.
- The workspace state flag is true/false with the file present/absent.

**Component (unit, jsdom):**
- Cards, radios, recommended marker, comment box, current ruling, read-only states, collapsed
  ruled list render from a parsed document.
- A draft (option + comment) survives a re-render with new content, including re-ordering.
- An option disappearing drops the selection with a notice and keeps the comment.
- A draft whose item leaves `## Open`, becomes a duplicate, or is ruled from elsewhere is held
  with the reason; Discard removes it.
- A refused submit shows the error and keeps the draft; a successful one clears it and renders
  the returned document.
- Clicking an `http(s)` link opens a new browser tab; clicking another link does nothing; neither
  navigates the dashboard.
- Question round-trip: a submitted question makes the card read-only with the neutral note; a
  re-render with the pair above the Your-word line and nothing after it makes the card writable
  and shows the thread.

**End-to-end (Playwright, real Tower + browser):**
- Workspace with a fixture decisions file: the tab appears; choose an option, type a comment,
  submit; the file on disk contains exactly the inserted lines; the card shows the ruling.
- An external write to the file re-renders the tab within a few seconds while a typed draft in
  another card is preserved.
- Question round-trip: submit a question, then (as `main` would) paste the pair above the
  Your-word line and remove the question below it; the card shows the thread and accepts a word.
- Mobile viewport: the tab is reachable and a submit works.
- Workspace without the file: no Decisions tab.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `main`'s scan does not read the tab's output | Low | High | Scan contract confirmed (everything after the `**Your word:**` line to the end of the item; same-line text not read); the tab writes only on following lines; the bytes are pinned and unit-tested, so a future change of shape is one place. |
| Two submits race inside Tower and one is lost | Low | High | Writes are serialized per file and re-read after taking their turn; an already-ruled item refuses, so the second submit fails loudly instead of stacking or vanishing. |
| `main` rewrites the file while Tower is writing | Low | High | Tower re-reads immediately before an atomic rename; the fingerprint refuses item edits made earlier; `main`'s editor refuses to write a file changed since it read it, so a Tower write between `main`'s read and write forces `main` to re-read. |
| A crash mid-write truncates the decisions file | Low | High | Write to a temporary file in the target's directory, then rename over the target. |
| The annotator file tab is in edit mode with an older buffer and saves over a tab-written ruling | Low | Medium | Pre-existing behaviour of the annotator's whole-file save; documented. The Decisions tab is the intended ruling surface. |
| Tab and `main` disagree on where an item ends | Low | High | One server-side grammar for read and write, tested against the issue's format; malformed items are flagged and read-only. |
| A comment injects structure (heading, fence, `**Your word:**`) and corrupts the file | Low | High | Explicit refusals for each, plus the re-parse verification that refuses any structural change. |
| Ambiguous time-zone abbreviations (`IST`, `BST`, `CST`) are misread | Medium | Low | Only the enumerated table is accepted (`CST` documented as North-American Central); anything else, and DST gap/fold times, are shown verbatim as unconverted. |
| Rendering untrusted markdown in the dashboard | Low | Medium | `MarkdownView` sanitizes with DOMPurify (scripts, event handlers, `javascript:` URLs stripped); option labels and descriptions render as React text. |
| A config path, or a symlink on it, aims reads/writes outside the workspace | Low | High | The canonical (symlink-resolved) path must lie inside the canonical workspace root at every read and write; the client never sends a path. |
| A link click navigates the dashboard away (worst on mobile) | Medium | Low | The Decisions view opens `http(s)` links in a new tab and makes other links inert, without changing the shared renderer. |
| Polling cost | Low | Low | Poll only while the tab and the browser tab are visible; small file. |
| Adding `artifact-canvas` to the web build breaks build ordering | Medium | Low | Covered in the plan (workspace dependency + build order); CI build check. |

## References

- Issue #1819 (body: process and format; comments: owner time-zone rule, architect baked
  decisions, owner's question-and-answer protocol addition of 2026-10-17 6:15 am).
- `packages/codev/src/agent-farm/servers/tower-routes.ts` — workspace routes, the annotate
  route, file tab save.
- `packages/codev/templates/open.html` — annotator's 1s mtime auto-reload (polling precedent).
- `packages/artifact-canvas/src/renderer/MarkdownView.tsx`, `renderer.ts` — sanitized
  markdown-it renderer (`linkify: true`).
- `apps/web/src/hooks/useTabs.ts`, `apps/web/src/components/App.tsx`, `TeamView.tsx` — tab
  model and the conditional Team tab precedent (`teamEnabled`).
- `packages/codev/src/lib/config.ts` — config layers and the existing `dashboard` block.
- `packages/codev/src/agent-farm/__tests__/e2e/team-tab.test.ts` — Playwright tab test
  precedent.
- `codev/resources/testing-guide.md` — UI verification requirement.
