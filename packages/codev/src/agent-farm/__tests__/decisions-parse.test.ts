/**
 * Spec 1819 — decisions file parser and structural grammar.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyLines } from '../servers/decisions/grammar.js';
import { parseDecisions, parseOptions, toDecisionsDocument } from '../servers/decisions/parse.js';

const FIXTURE = readFileSync(resolve(import.meta.dirname, 'fixtures/decisions/issue-format.md'), 'utf8');

/** A minimal file with one item whose body is `body` and whose tail after the Your-word line is `tail`. */
function oneItem(body: string, yourWord = '**Your word:** `accept` = merge / `hold`', tail = ''): string {
  return `# Decisions\n\n## Open\n\n### main-1 · 2026-10-17 9:00 am UTC · Question one?\n\n${body}\n\n${yourWord}\n${tail}`;
}

describe('classifyLines (structural grammar)', () => {
  it('records offsets and line endings that reconstruct the text exactly', () => {
    const text = 'a\r\nb\n\nc';
    const lines = classifyLines(text);
    expect(lines.map(l => [l.text, l.eol])).toEqual([['a', '\r\n'], ['b', '\n'], ['', '\n'], ['c', '']]);
    expect(lines.map(l => text.slice(l.start, l.end) + l.eol).join('')).toBe(text);
  });

  it('classifies ATX headings with up to three leading spaces, and strips closing hashes', () => {
    const lines = classifyLines('### a\n   ## Open ##\n    ### code\n#nospace\n#\n####### seven');
    expect(lines.map(l => [l.headingLevel, l.headingText])).toEqual([
      [3, 'a'],
      [2, 'Open'],
      [0, ''],
      [0, ''],
      [1, ''],
      [0, ''],
    ]);
  });

  it('treats headings and Your-word lines inside fences as content', () => {
    const text = '```\n### x\n## Ruled\n**Your word:** `a`\n```\n### y';
    const lines = classifyLines(text);
    expect(lines.slice(1, 4).every(l => l.fenced && l.headingLevel === 0 && !l.yourWord)).toBe(true);
    expect(lines[5].headingLevel).toBe(3);
  });

  it('closes a fence only with the same character, at least as long, with no info string', () => {
    const lines = classifyLines('~~~~\n```\n~~~\n~~~~ x\n~~~~~\n# after');
    expect(lines.map(l => l.fenced)).toEqual([true, true, true, true, true, false]);
    expect(lines[4].fenceDelimiter).toBe(true);
    expect(lines[5].headingLevel).toBe(1);
  });

  it('runs an unclosed fence to end of file', () => {
    const lines = classifyLines('```\n### x\n## y');
    expect(lines.every(l => l.fenced)).toBe(true);
  });

  it('recognizes Your-word lines with up to three leading spaces only', () => {
    const lines = classifyLines('**Your word:** a\n   **Your word:** b\n    **Your word:** c');
    expect(lines.map(l => l.yourWord)).toEqual([true, true, false]);
  });
});

describe('parseOptions', () => {
  it('parses backticked words with descriptions; the first is recommended', () => {
    expect(parseOptions('**Your word:** `approve` = approve and merge / `rework` = send back / `hold`')).toEqual([
      { word: 'approve', description: 'approve and merge', recommended: true },
      { word: 'rework', description: 'send back', recommended: false },
      { word: 'hold', description: '', recommended: false },
    ]);
  });

  it('keeps backticks, `=` and ` / ` not followed by a backtick inside a description', () => {
    expect(parseOptions('**Your word:** `a` = run `gh pr merge` with x=1 / or this / `b` = that')).toEqual([
      { word: 'a', description: 'run `gh pr merge` with x=1 / or this', recommended: true },
      { word: 'b', description: 'that', recommended: false },
    ]);
  });

  it('returns no options when no segment starts with a backticked word', () => {
    expect(parseOptions('**Your word:** approve or reject')).toEqual([]);
  });

  it('reads later options when the first segment is not one; the first option found is recommended', () => {
    expect(parseOptions('**Your word:** approve / `rework` = send back / `hold`')).toEqual([
      { word: 'rework', description: 'send back', recommended: true },
      { word: 'hold', description: '', recommended: false },
    ]);
  });

  it('reads a description only after `=`', () => {
    expect(parseOptions('**Your word:** `hold` (wait a day) / `go` = now')).toEqual([
      { word: 'hold', description: '', recommended: true },
      { word: 'go', description: 'now', recommended: false },
    ]);
  });
});

describe('parseDecisions — the issue format', () => {
  const parsed = parseDecisions(FIXTURE);
  const doc = toDecisionsDocument(parsed, 'codev/state/pending-decisions.md');

  it('finds the open items in file order with ids, stamps and questions', () => {
    expect(doc.problems).toEqual([]);
    expect(doc.items.map(i => i.id)).toEqual(['onboarding-3', 'main-11']);
    expect(doc.items[0].question).toBe('Should the composer get a new scan tool, or reuse the chat tools?');
    expect(doc.items[0].stamp).toEqual({ raw: '2026-10-17 12:10 am PT', instant: '2026-10-17T07:10:00.000Z' });
    expect(doc.items[1].stamp?.instant).toBe('2026-10-17T04:45:00.000Z');
  });

  it('parses the options with the first recommended', () => {
    expect(doc.items[0].options.map(o => [o.word, o.recommended])).toEqual([
      ['newtool', true],
      ['reuse', false],
      ['hold', false],
    ]);
    expect(doc.items[0].options[1].description).toBe('reuse the chat tools');
  });

  it("prefers the Your-word line's description to the body's Options entry", () => {
    // The body says `newtool` = "add a scan tool to the composer"; the Your-word line wins.
    expect(doc.items[0].options[0].description).toBe('add the scan tool');
  });

  it('extracts the Q&A thread with continuation lines and removes it from the body', () => {
    expect(doc.items[0].qa).toEqual([
      { kind: 'asked', time: '6:07 am', markdown: '"why a new tool? Don\'t we have existing tools?"', answered: true },
      {
        kind: 'answer',
        name: 'Onboarding',
        time: '6:09 am',
        markdown: 'The Daybreak composer does not get the chat tool set.\nMain checked the code: the tool list is built separately.',
      },
    ]);
    expect(doc.items[0].bodyMarkdown).toContain('- **Problem:**');
    expect(doc.items[0].bodyMarkdown).toContain('- **Links:**');
    expect(doc.items[0].bodyMarkdown).not.toContain('You asked');
    expect(doc.items[0].bodyMarkdown).not.toContain('Main checked the code');
    expect(doc.items[0].bodyMarkdown).not.toContain('Your word');
  });

  it('reports unruled, writable items with fingerprints, and the ruled section', () => {
    for (const item of doc.items) {
      expect(item.currentRuling).toBe('');
      expect(item.writable).toBe(true);
      expect(item.problems).toEqual([]);
      expect(item.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(doc.ruledMarkdown).toBe('- **main-10** · ruled `approve` 11:02 pm · relayed 11:03 pm: merged · DONE 11:20 pm: released');
    expect(doc.path).toBe('codev/state/pending-decisions.md');
    expect(doc.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fingerprints exactly the item text', () => {
    const item = parsed.items[1];
    expect(FIXTURE.slice(item.start, item.end).startsWith('### main-11')).toBe(true);
    expect(FIXTURE.slice(item.start, item.end).endsWith('`hold`\n\n')).toBe(true);
  });

  it('does not change an item\'s fingerprint when only the spacing before the next item changes', () => {
    const respaced = parseDecisions(FIXTURE.replace('`hold`\n\n### main-11', '`hold`\n\n\n\n### main-11'));
    expect(respaced.items[0].fingerprint).toBe(parsed.items[0].fingerprint);
  });

  it('changes the version and only the edited item\'s fingerprint when one item changes', () => {
    const edited = parseDecisions(FIXTURE.replace('the retry fix is green', 'the retry fix is now green'));
    expect(edited.version).not.toBe(parsed.version);
    expect(edited.items[0].fingerprint).toBe(parsed.items[0].fingerprint);
    expect(edited.items[1].fingerprint).not.toBe(parsed.items[1].fingerprint);
  });
});

describe('parseDecisions — descriptions from the body\'s Options', () => {
  const BARE = '**Your word:** `raised` / `rotated` / `wait`';
  const descriptions = (text: string) => parseDecisions(text).items[0].options.map(o => [o.word, o.description]);

  it.each([
    ['(a) `w` = …', '- **Options:** (a) `raised` = raise the limit now (b) `rotated` = rotate the key'],
    ['(a) `w`: …', '- **Options:** (a) `raised`: raise the limit now (b) `rotated`: rotate the key'],
    ['- `w` = … list', '- **Options:**\n  - `raised` = raise the limit now\n  - `rotated` = rotate the key\n- **Fix:** none'],
  ])('reads the %s form for bare words; a word with no entry stays bare', (_form, body) => {
    expect(descriptions(oneItem(body, BARE))).toEqual([
      ['raised', 'raise the limit now'],
      ['rotated', 'rotate the key'],
      ['wait', ''],
    ]);
  });

  it('keeps the recommended marker on the first option and the body unchanged', () => {
    const body = '- **Options:** (a) `raised` = raise the limit now (b) `rotated` = rotate the key';
    const item = parseDecisions(oneItem(body, BARE)).items[0];
    expect(item.options.map(o => o.recommended)).toEqual([true, false, false]);
    expect(item.bodyMarkdown).toBe(body);
  });

  it('reads the label mid-line, and a list under an unlisted label after a blank line', () => {
    expect(descriptions(oneItem('- **Root cause:** why. For a choice: **Options:** (a) `raised` = raise it', BARE))[0])
      .toEqual(['raised', 'raise it']);
    expect(descriptions(oneItem('**Options:**\n\n- `raised` = raise it\n* `rotated`: rotate it', BARE)).slice(0, 2))
      .toEqual([['raised', 'raise it'], ['rotated', 'rotate it']]);
  });

  it('joins a wrapped entry and drops a trailing separator', () => {
    const body = '- **Options:** (a) `raised` = raise the\n  limit now; (b) `rotated` = rotate the key,';
    expect(descriptions(oneItem(body, BARE)).slice(0, 2)).toEqual([['raised', 'raise the limit now'], ['rotated', 'rotate the key']]);
  });

  it("uses the body only for options the Your-word line leaves bare", () => {
    const body = '- **Options:** (a) `raised` = from the body (b) `rotated` = rotate the key';
    expect(descriptions(oneItem(body, '**Your word:** `raised` = from the line / `rotated` / `wait`'))).toEqual([
      ['raised', 'from the line'],
      ['rotated', 'rotate the key'],
      ['wait', ''],
    ]);
  });

  it('ignores entries without = or :, entries after the Options list ends, fenced Options, and text after the Your-word line', () => {
    expect(descriptions(oneItem('- **Options:** (a) `raised` (b) `rotated` rotate', BARE))).toEqual([
      ['raised', ''], ['rotated', ''], ['wait', ''],
    ]);
    expect(descriptions(oneItem('- **Options:** (a) `raised` = raise it\n- **Fix:** see\n- `rotated` = not an option entry', BARE))[1])
      .toEqual(['rotated', '']);
    expect(descriptions(oneItem('```\n- **Options:** (a) `raised` = fenced\n```', BARE))[0]).toEqual(['raised', '']);
    expect(descriptions(oneItem('- **Problem:** p', BARE, '**Options:** (a) `raised` = written after the line\n'))[0])
      .toEqual(['raised', '']);
  });

  it('does not read Options inside a Q&A entry', () => {
    const body = '- **Problem:** p\n- **Ops\'s answer (7:00 am):** pick one.\n  **Options:** (a) `raised` = quoted in an answer';
    expect(descriptions(oneItem(body, BARE))[0]).toEqual(['raised', '']);
  });
});

describe('parseDecisions — headings', () => {
  it('re-joins a question containing the separator', () => {
    const { items } = parseDecisions('## Open\n### a-1 · 2026-10-17 9:00 am UTC · Is A · B ok?\n**Your word:** `y`\n');
    expect(items[0].question).toBe('Is A · B ok?');
    expect(items[0].stamp?.raw).toBe('2026-10-17 9:00 am UTC');
  });

  it('yields no stamp for a heading without separators', () => {
    const { items } = parseDecisions('## Open\n### a-1 Plain question\n**Your word:** `y`\n');
    expect(items.map(i => [i.id, i.stamp, i.question])).toEqual([['a-1', null, 'Plain question']]);
  });

  it('reads a heading with no stamp as id and question: the question is not read as a stamp (#1836)', () => {
    const { items } = parseDecisions('## Open\n### a-2 · Only a question\n**Your word:** `y`\n### a-3 · Is A · B ok?\n**Your word:** `y`\n');
    expect(items.map(i => [i.id, i.stamp, i.question])).toEqual([['a-2', null, 'Only a question'], ['a-3', null, 'Is A · B ok?']]);
  });

  it('keeps a first part that is not a stamp in the question, as written (#1836)', () => {
    const { items } = parseDecisions('## Open\n### a-4 · yesterday 9 am PT · Ship it?\n**Your word:** `y`\n### a-5 · 10:30 standup?\n**Your word:** `y`\n');
    expect(items.map(i => [i.stamp, i.question])).toEqual([[null, 'yesterday 9 am PT · Ship it?'], [null, '10:30 standup?']]);
  });

  describe("the file's `_Zone:` line (#1836)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const file = (header: string, heading: string): string =>
      `# Decisions\n\n${header}\n\n## Open\n\n### ${heading}\n\n**Your word:** \`y\`\n\n## Ruled\n`;

    it('converts a time-only stamp as today in the zone the header names', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-19T18:00:00.000Z'));
      const [item] = parseDecisions(file('_Status: 1 open._\n_Zone: PT_', 'main-3 · 6:30 pm · Ship it?')).items;
      expect(item.stamp).toEqual({ raw: '6:30 pm', instant: '2026-10-20T01:30:00.000Z', timeOnly: true });
      expect(item.question).toBe('Ship it?');
      expect(parseDecisions(file('_Zone: America/Los_Angeles._', 'main-3 · 6:30 pm · Ship it?')).items[0].stamp?.instant)
        .toBe('2026-10-20T01:30:00.000Z');
    });

    it('shows a time-only stamp as written, with no reason, when the file names no zone', () => {
      const [item] = parseDecisions(file('_Status: 1 open._', 'main-3 · 6:30 pm · Ship it?')).items;
      expect(item.stamp).toEqual({ raw: '6:30 pm', instant: null, timeOnly: true });
      expect(item.question).toBe('Ship it?');
    });

    it('reads the zone only from the header, and only when it is named once', () => {
      const late = '# Decisions\n\n## Open\n\n_Zone: PT_\n\n### main-3 · 6:30 pm · Ship it?\n\n**Your word:** `y`\n';
      expect(parseDecisions(late).items[0].stamp?.instant).toBeNull();
      const fenced = file('```\n_Zone: PT_\n```', 'main-3 · 6:30 pm · Ship it?');
      expect(parseDecisions(fenced).items[0].stamp?.instant).toBeNull();
      const twice = file('_Zone: PT_\n_Zone: ET_', 'main-3 · 6:30 pm · Ship it?');
      expect(parseDecisions(twice).items[0].stamp?.instant).toBeNull();
    });

    it("leaves a full stamp's own zone, and an ambiguous file zone's warning, in place", () => {
      const full = parseDecisions(file('_Zone: PT_', 'main-3 · 2026-10-17 9:40 pm ET · Ship it?')).items[0];
      expect(full.stamp).toEqual({ raw: '2026-10-17 9:40 pm ET', instant: '2026-10-18T01:40:00.000Z' });
      const ist = parseDecisions(file('_Zone: IST_', 'main-3 · 6:30 pm · Ship it?')).items[0];
      expect(ist.stamp?.unconvertedReason).toBe('unknown-zone');
      const placeholder = parseDecisions(file('_Zone: <zone>_', 'main-3 · 6:30 pm · Ship it?')).items[0];
      expect(placeholder.stamp?.unconvertedReason).toBe('unknown-zone');
    });
  });

  it('accepts indented item headings and keeps level-4 headings in the body', () => {
    const { items } = parseDecisions('## Open\n  ### a-1 · 2026-10-17 9:00 am UTC · Q\n#### Detail\ntext\n**Your word:** `y`\n');
    expect(items).toHaveLength(1);
    expect(items[0].bodyMarkdown).toBe('#### Detail\ntext');
  });

  it('does not treat fenced `###`, `## Ruled` or `**Your word:**` as structure', () => {
    const text = oneItem('```\n### fake-1\n## Ruled\n**Your word:** `x`\n```');
    const { items, ruledMarkdown } = parseDecisions(text);
    expect(items.map(i => i.id)).toEqual(['main-1']);
    expect(items[0].problems).toEqual([]);
    expect(items[0].options.map(o => o.word)).toEqual(['accept', 'hold']);
    expect(ruledMarkdown).toBe('');
  });

  it('lets an unclosed fence swallow the rest of the file', () => {
    const { items } = parseDecisions(oneItem('```\nunclosed', '**Your word:** `a`', '\n### main-2 · x · y\n'));
    expect(items.map(i => i.id)).toEqual(['main-1']);
    expect(items[0].problems).toEqual(['your-word-missing']);
  });

  it('ignores ### headings outside ## Open', () => {
    const { items } = parseDecisions('### stray\n## Open\n### a-1 · x · y\n**Your word:** `y`\n## Ruled\n### not-an-item\n');
    expect(items.map(i => i.id)).toEqual(['a-1']);
  });
});

describe('parseDecisions — current ruling', () => {
  it('shows a word on the next line as the current ruling and makes the item read-only', () => {
    const { items } = parseDecisions(oneItem('- **Context:** c', undefined, 'accept\n'));
    expect(items[0].currentRuling).toBe('accept');
    expect(items[0].writable).toBe(false);
  });

  it('keeps a word plus sentence and multiple paragraphs verbatim', () => {
    const tail = 'accept\n\naccept but don\'t add the limit.\n\nSecond paragraph.\n';
    const { items } = parseDecisions(oneItem('- **Context:** c', undefined, tail));
    expect(items[0].currentRuling).toBe('accept\n\naccept but don\'t add the limit.\n\nSecond paragraph.');
  });

  it('counts a REVIEW-comment-only tail as a ruling, verbatim', () => {
    const { items } = parseDecisions(oneItem('- **Context:** c', undefined, '<!-- REVIEW: what about X? -->\n'));
    expect(items[0].currentRuling).toBe('<!-- REVIEW: what about X? -->');
    expect(items[0].writable).toBe(false);
  });

  it('treats blank lines after the Your-word line as unruled', () => {
    const { items } = parseDecisions(oneItem('- **Context:** c', undefined, '\n\n   \n'));
    expect(items[0].currentRuling).toBe('');
    expect(items[0].writable).toBe(true);
  });
});

describe('parseDecisions — Q&A thread', () => {
  it('keeps two pairs in file order, newest at the bottom', () => {
    const body = [
      '- **You asked (6:07 am):** first?',
      '- **Onboarding\'s answer (6:09 am):** one.',
      '- **You asked (7:00 am):** second?',
      '- **Onboarding\'s answer (7:05 am):** two.',
    ].join('\n');
    const { items } = parseDecisions(oneItem(body));
    expect(items[0].qa.map(e => [e.kind, e.time, e.markdown])).toEqual([
      ['asked', '6:07 am', 'first?'],
      ['answer', '6:09 am', 'one.'],
      ['asked', '7:00 am', 'second?'],
      ['answer', '7:05 am', 'two.'],
    ]);
    expect(items[0].bodyMarkdown).toBe('');
  });

  it('marks a question with no answer yet, and keeps an orphan answer', () => {
    const body = '- **Main\'s answer (5:00 am):** orphan.\n- **You asked (6:07 am):** pending?';
    const { items } = parseDecisions(oneItem(body));
    expect(items[0].qa).toEqual([
      { kind: 'answer', name: 'Main', time: '5:00 am', markdown: 'orphan.' },
      { kind: 'asked', time: '6:07 am', markdown: 'pending?', answered: false },
    ]);
  });

  it('accepts a curly apostrophe and a multi-word name', () => {
    const { items } = parseDecisions(oneItem('- **Mobile Web’s answer (6:09 am):** yes.'));
    expect(items[0].qa).toEqual([{ kind: 'answer', name: 'Mobile Web', time: '6:09 am', markdown: 'yes.' }]);
  });

  it('keeps the time text verbatim and leaves other body lines in place', () => {
    const body = '- **Problem:** p\n- **You asked (Tue 6:07 am):** q?\n- **Fix:** f';
    const { items } = parseDecisions(oneItem(body));
    expect(items[0].qa[0]).toMatchObject({ kind: 'asked', time: 'Tue 6:07 am' });
    expect(items[0].bodyMarkdown).toBe('- **Problem:** p\n- **Fix:** f');
  });

  it('takes only indented lines as continuation: unindented prose and headings stay in the body', () => {
    const body = '- **You asked (6:07 am):** why?\n  more of the question\nUnindented prose.\n- **Main\'s answer (6:09 am):** because.\n#### Detail\ntext';
    const { items } = parseDecisions(oneItem(body));
    expect(items[0].qa.map(e => e.markdown)).toEqual(['why?\nmore of the question', 'because.']);
    expect(items[0].bodyMarkdown).toBe('Unindented prose.\n#### Detail\ntext');
  });

  it('starts a new entry rather than continuing when an indented line is itself an entry', () => {
    const body = '- **You asked (6:07 am):** why?\n  - **Main\'s answer (6:09 am):** because.';
    const { items } = parseDecisions(oneItem(body));
    expect(items[0].qa.map(e => e.kind)).toEqual(['asked', 'answer']);
  });

  it('does not read Q&A lines inside a fence', () => {
    const { items } = parseDecisions(oneItem('```\n- **You asked (1:00 am):** no\n```'));
    expect(items[0].qa).toEqual([]);
  });
});

describe('parseDecisions — malformed input', () => {
  it('reports a file with no ## Open', () => {
    const doc = parseDecisions('# Decisions\n\n## Ruled\n- x\n');
    expect(doc.problems).toEqual(['open-missing']);
    expect(doc.items).toEqual([]);
  });

  it('reports multiple ## Open sections and makes every item read-only', () => {
    const doc = parseDecisions('## Open\n### a-1 · x · y\n**Your word:** `y`\n## Open\n### a-2 · x · y\n**Your word:** `y`\n');
    expect(doc.problems).toEqual(['open-multiple']);
    expect(doc.items.map(i => i.writable)).toEqual([false, false]);
  });

  it('flags an item with no Your-word line', () => {
    const { items } = parseDecisions('## Open\n### a-1 · x · y\n- **Context:** c\n');
    expect(items[0].problems).toEqual(['your-word-missing']);
    expect(items[0].options).toEqual([]);
    expect(items[0].bodyMarkdown).toBe('- **Context:** c');
    expect(items[0].writable).toBe(false);
  });

  it('flags an item with two Your-word lines', () => {
    const { items } = parseDecisions('## Open\n### a-1 · x · y\n**Your word:** `a`\n**Your word:** `b`\n');
    expect(items[0].problems).toEqual(['your-word-multiple']);
    expect(items[0].options).toEqual([]);
    expect(items[0].writable).toBe(false);
  });

  it('flags every copy of a duplicate id', () => {
    const { items } = parseDecisions('## Open\n### a-1 · x · y\n**Your word:** `a`\n### a-1 · x · z\n**Your word:** `a`\n');
    expect(items.map(i => i.problems)).toEqual([['duplicate-id'], ['duplicate-id']]);
    expect(items.map(i => i.writable)).toEqual([false, false]);
  });

  it('flags a heading with no id', () => {
    const { items } = parseDecisions('## Open\n###\n**Your word:** `a`\n');
    expect(items[0].problems).toEqual(['id-missing']);
  });

  it('handles an empty ## Open and a missing ## Ruled', () => {
    const doc = parseDecisions('## Open\n\n');
    expect(doc.problems).toEqual([]);
    expect(doc.items).toEqual([]);
    expect(doc.ruledMarkdown).toBe('');
  });

  it('parses a CRLF file the same as its LF form, and detects CRLF', () => {
    const crlf = FIXTURE.replace(/\n/g, '\r\n');
    const a = toDecisionsDocument(parseDecisions(FIXTURE), 'p');
    const b = parseDecisions(crlf);
    expect(b.eol).toBe('\r\n');
    const bd = toDecisionsDocument(b, 'p');
    expect(bd.items.map(i => [i.id, i.bodyMarkdown, i.options, i.qa])).toEqual(a.items.map(i => [i.id, i.bodyMarkdown, i.options, i.qa]));
  });

  it('parses a file without a trailing newline', () => {
    const { items, eol } = parseDecisions('## Open\n### a-1 · x · y\n**Your word:** `a`');
    expect(eol).toBe('\n');
    expect(items[0].options.map(o => o.word)).toEqual(['a']);
    expect(items[0].writable).toBe(true);
  });
});

describe('parseDecisions — independent of the machine time zone', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('produces identical documents under different TZ values', () => {
    const results = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles'].map(tz => {
      process.env.TZ = tz;
      return JSON.stringify(toDecisionsDocument(parseDecisions(FIXTURE), 'p'));
    });
    expect(new Set(results).size).toBe(1);
  });
});
