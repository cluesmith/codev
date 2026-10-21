# Owner decisions: one file, one hub

How a workspace's owner and its architects make decisions through one markdown file,
`codev/state/pending-decisions.md`. The dashboard's **Decisions** tab is a view of that file:
see the Decisions tab section of [`commands/agent-farm.md`](commands/agent-farm.md). This is a
working agreement between people and agents, not a porch protocol; nothing is spawned from it.

- **The owner** is the human whose word clears a gate, a merge, a spend or a product choice.
- **The hub** is one architect, named `main`. It is the only agent that edits the file.
- **Every other architect** sends its asks to the hub and acts on the ruling the hub relays.

Anything that needs the owner's word goes through the file, one item per question. Status
reports and FYIs do not.

## 1. The intake message (architect → hub)

An architect sends the item as one message:

```bash
afx send architect:main 'DECISION <name>-<n>: <question>
<the item, exactly as it should appear>'
```

The first line is `DECISION <name>-<n>: <question>`; append ` [urgent]` only when a live user
or running work is blocked. Single-quote the message, because inside double quotes the shell
runs the item's backticks; write an apostrophe inside it as `'\''`. Ids are
`<architect name>-<running number>` (`web-4`, `main-12`): each architect keeps its own counter
and never reuses a number.

## 2. The item

```markdown
### <name>-<n> · <YYYY-MM-DD HH:mm UTC> · <The question the owner answers, naming the thing by what it does>

- **Problem:** (or **Context:**) what is wrong or undecided, as the owner would see it. One to three sentences.
- **Root cause:** why, for a fix.
- **Options:** for a choice, (a) `<word>` = what it does (b) `<word>` = what it does.
- **Fix:** what the change does, in product terms.
- **Testing:** the receipt: tests before and after, a live check, checks green on the exact head.
- **Cost:** money or time, only when a budget is involved.
- **Recommendation (<name>):** one line, owned by the architect.
- **Links:** pull request and issue URLs; spec, plan and receipt paths.

**Your word:** `<first word, recommended>` / `<second word>` / `hold`
```

The stamp is when the item was written, in UTC on the 24-hour clock, as
`date -u '+%Y-%m-%d %H:%M UTC'` prints it; the tab shows it in each viewer's own time. Delete
labels that do not apply; never rename them. The hub bounces a malformed item back, naming
what is missing, and does not post it.

### What the tab reads

The Decisions tab parses the file by these rules. An item that follows them gets a click box
per option and a comment box.

- **Items are the `###` headings under `## Open`.** An item runs to the next `#`, `##` or `###`
  heading, so inside an item use `####` or bold labels, never a higher heading. The file has
  exactly one `## Open`.
- **The heading is id · stamp · question.** The first word is the id; ` · ` (space, middle dot,
  space) separates the id, the stamp and the question. A heading without a stamp is id ·
  question, and a first part the tab cannot read as a stamp stays in the question, shown as
  written. Open items that share an id are read-only until the ids differ.
- **The stamp carries its zone; nothing assumes one.** Agents write it as `YYYY-MM-DD HH:mm UTC`,
  24-hour and in UTC (section 2). The tab converts the stamp using only the zone written in it
  and shows its date and time in the viewer's local time. For anything a person types it also
  reads `YYYY-MM-DD h:mm am` (or `pm`), or 24-hour `YYYY-MM-DD HH:mm`, then the zone the time
  was read in: the North-American generic zones `PT`, `MT`, `CT`, `ET`, `AKT` and `HT`
  (daylight saving follows the stamp's date), fixed abbreviations such as `UTC`, `GMT`,
  `EST`/`EDT`, `CET`/`CEST`, `JST` and `AEST`/`AEDT` (`CST` is North-American Central), offsets
  such as `+05:30`, `UTC+5:30` or `GMT-3`, and IANA names such as `Europe/Berlin`. Any other
  zone, including ambiguous abbreviations such as `IST`, `BST` and `AST`, is shown as written
  and marked not converted, as is a time the clocks skipped or repeated that day.
- **A file may name its zone once.** A line `_Zone: <zone>_` above `## Open`, from the same
  list of zones, is the zone of every stamp that names none; the file template's is
  `_Zone: UTC_` (section 4). A bare time, `h:mm am` or `HH:mm`, is read as today in that zone
  when the tab reads the file, and shown as the time alone: as written, converted to your
  clock, with no date because none was written. Without a file zone, a stamp that names no
  zone is shown as written. A bare time is always read as today, so one written before
  midnight and read after it lands on the wrong day: the full form stays the one to write.
- **Exactly one `**Your word:**` line**, starting a line, outside a code block. The options are
  the backticked words on it, separated by ` / `. The first is the recommended one, and the tab
  marks it. A description follows a word after ` = ` and runs to the next ` / ` before a
  backtick: `` `retry` = keep the page / `signout` = sign out / `hold` ``. Other text on the
  line is ignored.
- **A bare word takes its description from `**Options:**`.** A word written without ` = …` on
  the word line is described by the body's `**Options:**` entry for the same word: ``(a) `word` = …``
  or ``(a) `word`: …`` after the label, or ``- `word` = …`` list items under it. A
  description on the word line wins; a word with neither (`hold`) shows bare.
- **Questions and answers** are body lines above the word line, `- **You asked (<time>):** …`
  and `- **<Name>'s answer (<time>):** …`, continued on lines indented two spaces. The tab shows
  them on the card as a thread (section 3c).
- **Whatever follows the `**Your word:**` line is the ruling.** While nothing follows it, the
  card takes a submit, which writes the chosen word on the next line and then the comment after
  a blank line, exactly as the owner would type them. Once any text follows the line, typed by
  hand or written by the tab, the card shows it as the current ruling and takes no new submit.
- **`## Ruled`** is shown read-only, as written.

In a file that names its zone, a bare time converts, and a heading without a stamp is an id
and a question (the item bodies are left out here):

```markdown
_Zone: UTC_

## Open

### web-6 · 01:40 · Should the export keep the old column names?

### web-5 · Should the nightly report move to the morning?
```

A worked example, a choice with bare words on the word line:

```markdown
### web-4 · 2026-10-18 01:40 UTC · When a session expires mid-edit, should the login fix keep the page or sign the user out?

- **Context:** users whose session expires while they edit lose their draft when the page reloads.
- **Options:** (a) `retry` = refresh the sign-in in the background and keep the page (b) `signout` = sign the user out and keep the draft on this device
- **Testing:** unit tests cover both paths; a live check with a forced expiry kept the draft.
- **Recommendation (web):** `retry`, the smaller change for the user.
- **Links:** https://github.com/example/app/pull/412 (the login fix), `codev/specs/412-session-expiry.md`

**Your word:** `retry` / `signout` / `hold`
```

## 3. What the hub does

1. **Post.** The hub puts the item at the top of `## Open`, updates the status line
   (`N open — <ids>`), and tells the owner in one chat line:
   `New decision from <name>: <id> — <question>`, plus `[urgent]` if marked. The item's
   stamp is in UTC (section 2), and the file's `_Zone: UTC_` line stays UTC (section 4).
2. **Learn of rulings.** The owner rules in the tab, by typing in the file, or in chat. A ruling
   made in the tab reaches the hub as a message from Tower: `RULED <id>: <word>`, or
   `QUESTION <id>:` when no word was chosen, with the comment on the lines after it. The notice
   goes only to an architect named `main`, and waits for it to come back if it is not running;
   a workspace without one gets no notice, so its hub must scan the file. A ruling typed
   into the file reaches the hub when the owner says so in chat (a short agreed word, such as
   `ddu` for "decisions doc updated") or when the hub's own watch on the file sees the change.
   Either way the hub scans every open item for text on the lines under its `**Your word:**`
   line and replies with one line per ruling found. A word in chat counts the same.
3. **Relay and record.** For each ruling the hub relays at once,
   `afx send architect:<name> 'RULING <id>: <word> (owner, <time> UTC)'`, with the owner's
   comment verbatim on the lines after it when there is one, and moves the item out of
   `## Open` into `## Ruled` as one line, the comment quoted after the word when there is one:
   ``- **<id>** · <time> UTC · <question> → `<word>` — "<comment>"``.
   A ruling that carries a question goes through 3b first.
4. **Done.** The architect acts and replies `DONE <id>: <one line of what happened>`; the hub
   appends ` → DONE <time> UTC: <what happened>` to the item's line in `## Ruled`.
5. If the owner rules in chat to another architect directly, that architect sends the hub
   `RULED <id>: <word> (owner, <time> UTC, in chat)`, and the hub records it the same way.
6. The hub's own asks use the same format, under `main-<n>`.

The hub writes the file as little as possible: one write per scan, recording every ruling
found, and new items in batches. It re-reads the file immediately before each write. Every
time it writes, in the file or in a message, is UTC on the 24-hour clock, read from the clock
with `date -u '+%H:%M UTC'`: that is the `<time> UTC` above, and the Q&A times in 3c. A stamp
adds the date (section 2).

### 3b. A ruling that carries a question comes back as an item

When the owner's word carries a question or a choice ("retry, but could this sign people out
twice?"), the hub does not answer it in the relay and move on. It posts a new item with the
options and its recommendation before directing anyone, unless the answer is a plain fact with
no design behind it. The same holds for a gap the hub finds after a ruling (a receipt that did
not cover what was ruled on, a step the ruling implied but did not say): it goes into the file,
as an item or as a line under the ruled item, not into chat alone. Chat tells the owner the
file changed; the file is where the decision lives.

### 3c. The owner's question gets the architect's answer, in the item

When the owner writes a question instead of a word (in the tab's comment box, under the word
line, or in chat), the hub, in order:

1. Relays it verbatim to the owning architect:
   `afx send architect:<name> '<id>: no word yet. The owner asks: "<question>". Answer in one short plain-words message.'`
2. Pastes the answer into the item, above the `**Your word:**` line, as two labelled lines,
   adding its own check where it can make one:

   ```markdown
   - **You asked (02:05 UTC):** "Could retry hide a real sign-out from the user?"
   - **Web's answer (02:12 UTC):** No. A refresh that fails still signs the user out and says why.
     Main checked the test that forces a failed refresh: it signs out and shows the message.
   ```

3. Lifts the question out from under the word line, so that nothing follows the
   `**Your word:**` line. The scan no longer reads the question as a ruling, and the tab takes
   a submit again. The item stays open, and the owner rules after reading the answer. If the
   answer changes the choice, the hub updates the options.

A second question gets a second pair of lines under the first.

## 4. The file

Create it with `afx decisions init`, which writes the template below to
`codev/state/pending-decisions.md`, or to the path `dashboard.decisionsFile` names, and never
replaces a file that is already there. The Decisions tab appears once the file exists.

```markdown
# Pending owner decisions — all architects (hub: main)

Rule inline: one word on the line under an item's **Your word:** line, or in the Decisions tab.
Newest first. Only main edits this file; architects send items with `afx send architect:main 'DECISION …'`.

_Status: 0 open._
_Zone: UTC_

## Open

## Ruled
```

The `_Zone: UTC_` line stays UTC. Agents write every stamp in UTC, and the line is the zone of
any stamp that names none, bare times included; a person who types a time in another zone
writes the zone after it. Newest first in both sections.
`## Open` holds only what still needs a word; `## Ruled` keeps one line per item.
