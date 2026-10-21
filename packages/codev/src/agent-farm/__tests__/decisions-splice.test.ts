/**
 * Spec 1819 — the ruling splice: byte-exact insertion, every refusal, and re-parse verification.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDecisions } from '../servers/decisions/parse.js';
import { MAX_COMMENT_LENGTH, spliceRuling, type RulingRequest, type SpliceResult } from '../servers/decisions/splice.js';

const FIXTURE = readFileSync(resolve(import.meta.dirname, 'fixtures/decisions/issue-format.md'), 'utf8');

const PREAMBLE = '# Pending owner decisions\n\n_Status: 2 open._\n\n## Open\n\n';
const NEXT_ITEM = '### main-11 · …\n\n- **Context:** the next item.\n\n**Your word:** `yes` / `no`\n\n## Ruled\n\n- **main-10** · ruled `approve`\n';

/** A file whose first item, `a-1`, ends with `yourWord` followed by `after`. */
function file(yourWord: string, after = `\n${NEXT_ITEM}`): string {
  return `${PREAMBLE}### a-1 · 2026-10-17 12:10 am PT · Question?\n\n- **Context:** why.\n\n${yourWord}\n${after}`;
}

const ACCEPT_LINE = '**Your word:** `accept` = merge as is / `rework` = send back / `hold`';

function fingerprintOf(text: string, id: string): string {
  const item = parseDecisions(text).items.find(i => i.id === id);
  if (!item) throw new Error(`no item ${id} in fixture`);
  return item.fingerprint;
}

function rule(text: string, request: Partial<RulingRequest> & { id?: string }): SpliceResult {
  const id = request.id ?? 'a-1';
  return spliceRuling(text, { fingerprint: fingerprintOf(text, id), ...request, id });
}

function ok(result: SpliceResult): string {
  if (!result.ok) throw new Error(`splice refused: ${result.code}: ${result.message}`);
  return result.text;
}

/** The spliced text is the original with one contiguous range inserted after the Your-word line. */
function expectOnlyInsertion(original: string, spliced: string, id = 'a-1'): string {
  const parsed = parseDecisions(original);
  const item = parsed.items.find(i => i.id === id)!;
  const yourWord = parsed.lines[item.yourWordLines[0]];
  const at = yourWord.end + yourWord.eol.length;
  const insertedLength = spliced.length - original.length;
  expect(insertedLength).toBeGreaterThan(0);
  expect(spliced.slice(0, at)).toBe(original.slice(0, at));
  expect(spliced.slice(at + insertedLength)).toBe(original.slice(at));
  return spliced.slice(at, at + insertedLength);
}

function expectRefusal(result: SpliceResult, code: string): void {
  expect(result.ok).toBe(false);
  expect(result).toEqual({ ok: false, code, message: expect.any(String) });
  expect('text' in result).toBe(false);
  if (!result.ok) expect(result.message.length).toBeGreaterThan(10);
}

describe('spliceRuling — the spec examples, byte for byte', () => {
  it('choosing accept with a comment', () => {
    const before = `${ACCEPT_LINE}\n\n### main-11 · …`;
    const after = `${ACCEPT_LINE}\naccept\n\naccept but don't add the limit on additional tests. That could easily backfire.\n\n### main-11 · …`;
    const text = file(ACCEPT_LINE);
    expect(text).toContain(before);
    const spliced = ok(
      rule(text, { word: 'accept', comment: "accept but don't add the limit on additional tests. That could easily backfire." }),
    );
    expect(spliced).toBe(text.replace(before, after));
  });

  it('a comment with no word', () => {
    const line = '**Your word:** `keep` = keep the skills / `drop` = drop them / `hold`';
    const before = `${line}\n\n### main-11 · …`;
    const comment = "Wait. That means if someone after onboarding connects whatsapp they can't do the scan? Keep the skills…";
    const after = `${line}\n${comment}\n\n### main-11 · …`;
    const text = file(line);
    expect(ok(rule(text, { comment }))).toBe(text.replace(before, after));
  });
});

describe('spliceRuling — insertion shape', () => {
  it('word only: the word on the line after the Your-word line', () => {
    const text = file(ACCEPT_LINE);
    const spliced = ok(rule(text, { word: 'rework' }));
    expect(expectOnlyInsertion(text, spliced)).toBe('rework\n');
    expect(spliced).toBe(text.replace(`${ACCEPT_LINE}\n`, `${ACCEPT_LINE}\nrework\n`));
  });

  it('comment only', () => {
    const text = file(ACCEPT_LINE);
    expect(expectOnlyInsertion(text, ok(rule(text, { comment: 'not yet' })))).toBe('not yet\n');
  });

  it('word + comment: a blank line between them', () => {
    const text = file(ACCEPT_LINE);
    expect(expectOnlyInsertion(text, ok(rule(text, { word: 'hold', comment: 'after the release' })))).toBe(
      'hold\n\nafter the release\n',
    );
  });

  it('multi-line comment: trimmed, internal newlines and blank lines kept', () => {
    const text = file(ACCEPT_LINE);
    const comment = '\n  first paragraph\nstill first\n\n  indented second paragraph  \n\n';
    expect(expectOnlyInsertion(text, ok(rule(text, { word: 'accept', comment })))).toBe(
      'accept\n\nfirst paragraph\nstill first\n\n  indented second paragraph\n',
    );
  });

  it("comment CRLF and CR line breaks are written in the file's line ending", () => {
    const text = file(ACCEPT_LINE);
    expect(expectOnlyInsertion(text, ok(rule(text, { comment: 'one\r\ntwo\rthree' })))).toBe('one\ntwo\nthree\n');
  });

  it('a heading directly after the Your-word line gets a separating blank line', () => {
    const text = file(ACCEPT_LINE, NEXT_ITEM);
    expect(text).toContain(`${ACCEPT_LINE}\n### main-11`);
    const spliced = ok(rule(text, { word: 'accept' }));
    expect(expectOnlyInsertion(text, spliced)).toBe('accept\n\n');
    expect(spliced).toContain(`${ACCEPT_LINE}\naccept\n\n### main-11`);
  });

  it('a whitespace-only following line counts as blank', () => {
    const text = file(ACCEPT_LINE, `   \n${NEXT_ITEM}`);
    expect(expectOnlyInsertion(text, ok(rule(text, { word: 'accept' })))).toBe('accept\n');
  });

  it('Your-word line ending the file with a newline', () => {
    const text = file(ACCEPT_LINE, '');
    expect(text.endsWith(`${ACCEPT_LINE}\n`)).toBe(true);
    expect(ok(rule(text, { word: 'accept', comment: 'c' }))).toBe(`${text}accept\n\nc\n`);
  });

  it('Your-word line ending the file without a newline: the newline is supplied', () => {
    const text = file(ACCEPT_LINE, '').slice(0, -1);
    expect(text.endsWith(ACCEPT_LINE)).toBe(true);
    const spliced = ok(rule(text, { word: 'accept' }));
    expect(spliced).toBe(`${text}\naccept\n`);
    expect(spliced.slice(0, text.length)).toBe(text);
  });

  it('a CRLF file gets CRLF on every inserted line', () => {
    const text = file(ACCEPT_LINE).replace(/\n/g, '\r\n');
    const spliced = ok(rule(text, { word: 'accept', comment: 'line one\nline two' }));
    expect(expectOnlyInsertion(text, spliced)).toBe('accept\r\n\r\nline one\r\nline two\r\n');
    expect(spliced.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('a CRLF file without a final newline gets CRLF supplied', () => {
    const text = file(ACCEPT_LINE, '').replace(/\n/g, '\r\n').slice(0, -2);
    expect(ok(rule(text, { word: 'hold' }))).toBe(`${text}\r\nhold\r\n`);
  });

  it('works on the issue fixture: an item with a Q&A thread, and the item before ## Ruled', () => {
    const first = ok(rule(FIXTURE, { id: 'onboarding-3', word: 'reuse' }));
    expect(expectOnlyInsertion(FIXTURE, first, 'onboarding-3')).toBe('reuse\n');
    const second = ok(rule(first, { id: 'main-11', comment: 'merge it' }));
    expect(expectOnlyInsertion(first, second, 'main-11')).toBe('merge it\n');
    const parsed = parseDecisions(second);
    expect(parsed.items.map(i => [i.id, i.currentRuling, i.writable])).toEqual([
      ['onboarding-3', 'reuse', false],
      ['main-11', 'merge it', false],
    ]);
    expect(parsed.ruledMarkdown).toBe(parseDecisions(FIXTURE).ruledMarkdown);
  });

  it("re-parses with the inserted text as the item's current ruling", () => {
    const text = file(ACCEPT_LINE);
    const parsed = parseDecisions(ok(rule(text, { word: 'accept', comment: 'a\n\nb' })));
    const item = parsed.items.find(i => i.id === 'a-1')!;
    expect(item.currentRuling).toBe('accept\n\na\n\nb');
    expect(item.writable).toBe(false);
    expect(item.options.map(o => o.word)).toEqual(['accept', 'rework', 'hold']);
  });

  it('accepts a comment of exactly the length limit, and #-words that are not headings', () => {
    const text = file(ACCEPT_LINE);
    expect(rule(text, { comment: 'x'.repeat(MAX_COMMENT_LENGTH) }).ok).toBe(true);
    expect(rule(text, { comment: '#1819 looks fine\n    # indented four spaces is code, not a heading' }).ok).toBe(true);
    expect(rule(text, { comment: 'the label **Your word:** mid-line is not a Your-word line' }).ok).toBe(true);
  });
});

describe('spliceRuling — refusals', () => {
  const text = file(ACCEPT_LINE);

  it('invalid-request: no id, no fingerprint', () => {
    expectRefusal(spliceRuling(text, { id: '', word: 'accept', fingerprint: fingerprintOf(text, 'a-1') }), 'invalid-request');
    expectRefusal(spliceRuling(text, { id: 'a-1', word: 'accept', fingerprint: '' }), 'invalid-request');
  });

  it('empty-ruling: no word and an empty or whitespace comment', () => {
    expectRefusal(rule(text, {}), 'empty-ruling');
    expectRefusal(rule(text, { word: '', comment: ' \n\t ' }), 'empty-ruling');
  });

  it('comment-too-long: over the limit after trimming', () => {
    expectRefusal(rule(text, { comment: 'x'.repeat(MAX_COMMENT_LENGTH + 1) }), 'comment-too-long');
    expect(rule(text, { comment: `  ${'x'.repeat(MAX_COMMENT_LENGTH)}\n\n` }).ok).toBe(true);
  });

  it('comment-heading: any ATX heading line, indented by up to three spaces', () => {
    for (const heading of ['# x', '## Ruled', '### b-2 · new item', '   ### indented', '######', '#']) {
      expectRefusal(rule(text, { comment: `fine\n${heading}\nfine` }), 'comment-heading');
    }
  });

  it('comment-fence: backtick and tilde fence lines', () => {
    for (const fence of ['```', '```js', '~~~', '   ~~~~', '````']) {
      expectRefusal(rule(text, { comment: `look:\n${fence}\ncode` }), 'comment-fence');
    }
  });

  it('comment-your-word: a line beginning **Your word:**', () => {
    expectRefusal(rule(text, { comment: '**Your word:** `x`' }), 'comment-your-word');
    expectRefusal(rule(text, { comment: 'first\n  **Your word:** again' }), 'comment-your-word');
  });

  it('open-multiple: two ## Open sections make every item read-only', () => {
    const twoOpen = `${text}\n## Open\n\n### c-1 · x\n\n**Your word:** \`y\`\n`;
    expectRefusal(rule(twoOpen, { word: 'accept' }), 'open-multiple');
  });

  it('heading-missing: unknown id, an id only in ## Ruled, and a file with no ## Open', () => {
    expectRefusal(spliceRuling(text, { id: 'nope-1', word: 'accept', fingerprint: 'f' }), 'heading-missing');
    const inRuled = `${text}\n### r-1 · ruled item\n\n**Your word:** \`y\`\n`;
    expect(parseDecisions(inRuled).items.map(i => i.id)).toEqual(['a-1', 'main-11']);
    expectRefusal(spliceRuling(inRuled, { id: 'r-1', word: 'y', fingerprint: 'f' }), 'heading-missing');
    const noOpen = text.replace('## Open', '## Pending');
    expectRefusal(spliceRuling(noOpen, { id: 'a-1', word: 'accept', fingerprint: 'f' }), 'heading-missing');
  });

  it('heading-duplicate: the id appears twice in ## Open', () => {
    const dup = text.replace('### main-11 · …', '### a-1 · again');
    expectRefusal(spliceRuling(dup, { id: 'a-1', word: 'accept', fingerprint: parseDecisions(dup).items[0].fingerprint }), 'heading-duplicate');
  });

  it('your-word-missing and your-word-multiple', () => {
    expectRefusal(rule(file('- **Note:** no Your-word line here'), { comment: 'x' }), 'your-word-missing');
    expectRefusal(rule(file(`${ACCEPT_LINE}\n\n${ACCEPT_LINE}`), { word: 'accept' }), 'your-word-multiple');
  });

  it('already-ruled: text after the Your-word line, typed by hand or by an earlier submit', () => {
    expectRefusal(rule(file(`${ACCEPT_LINE}\naccept`), { word: 'rework' }), 'already-ruled');
    expectRefusal(rule(file(`${ACCEPT_LINE}\n\n<!-- REVIEW: is this right? -->`), { comment: 'x' }), 'already-ruled');
    // Two submits from cards rendered from the same version: the second is refused.
    const fingerprint = fingerprintOf(text, 'a-1');
    const first = ok(spliceRuling(text, { id: 'a-1', word: 'accept', fingerprint }));
    expectRefusal(spliceRuling(first, { id: 'a-1', word: 'rework', fingerprint }), 'already-ruled');
  });

  it("unknown-word: not on the item's current Your-word line", () => {
    expectRefusal(rule(text, { word: 'yes' }), 'unknown-word');
    expectRefusal(rule(text, { word: 'a' }), 'unknown-word');
    expectRefusal(rule(text, { word: 'Accept' }), 'unknown-word');
    expectRefusal(rule(text, { word: 'merge as is' }), 'unknown-word');
  });

  it('item-changed: the item was edited after the card rendered it', () => {
    const fingerprint = fingerprintOf(text, 'a-1');
    const edited = text.replace('- **Context:** why.', '- **Context:** why, revised.');
    expectRefusal(spliceRuling(edited, { id: 'a-1', word: 'accept', fingerprint }), 'item-changed');
    const optionAdded = text.replace(ACCEPT_LINE, `${ACCEPT_LINE} / \`later\``);
    expectRefusal(spliceRuling(optionAdded, { id: 'a-1', word: 'accept', fingerprint }), 'item-changed');
  });

  it('changes elsewhere in the file do not refuse', () => {
    const fingerprint = fingerprintOf(text, 'a-1');
    const elsewhere = text
      .replace('_Status: 2 open._', '_Status: 3 open — written 1:05 am._')
      .replace('## Open\n\n', '## Open\n\n### z-9 · 2026-10-17 1:00 am PT · Newest?\n\n**Your word:** `go`\n\n')
      .replace('- **Context:** the next item.', '- **Context:** the next item, edited.')
      .replace('- **main-10** · ruled `approve`', '- **main-10** · ruled `approve` · DONE 1:04 am: released');
    const spliced = ok(spliceRuling(elsewhere, { id: 'a-1', word: 'accept', fingerprint }));
    expect(expectOnlyInsertion(elsewhere, spliced)).toBe('accept\n');
  });

  it('every refusal leaves no output text', () => {
    const refusals = [
      rule(text, {}),
      rule(text, { word: 'nope' }),
      spliceRuling(text, { id: 'a-1', word: 'accept', fingerprint: 'stale' }),
    ];
    for (const r of refusals) expect(Object.keys(r).sort()).toEqual(['code', 'message', 'ok']);
  });
});

describe('spliceRuling — structure-changed, reached only by the re-parse verification', () => {
  // The comment checks do not cover the option word, so a Your-word line that offers a
  // pathological option passes every explicit check, and only the verification refuses it.
  const pathological = (option: string) => file(`**Your word:** \`${option}\` = odd / \`hold\``);

  it('an option word that is a level-2 heading (a new section)', () => {
    const text = pathological('##');
    expect(parseDecisions(text).items[0].options[0].word).toBe('##');
    expectRefusal(rule(text, { word: '##' }), 'structure-changed');
    expect(rule(text, { word: 'hold' }).ok).toBe(true);
  });

  it('an option word that is a level-3 heading (a new item)', () => {
    expectRefusal(rule(pathological('### b-1'), { word: '### b-1' }), 'structure-changed');
  });

  it('an option word that is a level-4 heading inside the item', () => {
    expectRefusal(rule(pathological('####'), { word: '####' }), 'structure-changed');
  });

  it('an option word that opens a fence, including in the last item of the file', () => {
    expectRefusal(rule(pathological('~~~'), { word: '~~~' }), 'structure-changed');
    const last = file('**Your word:** `~~~` = odd / `hold`', '');
    expectRefusal(rule(last, { word: '~~~' }), 'structure-changed');
  });

  it('an option word that is itself a Your-word line', () => {
    expectRefusal(rule(pathological('**Your word:**'), { word: '**Your word:**' }), 'structure-changed');
  });

  it('a pathological option with a comment is still refused, with no text', () => {
    const result = rule(pathological('##'), { word: '##', comment: 'fine comment' });
    expectRefusal(result, 'structure-changed');
  });
});

describe('spliceRuling — property: random valid comments preserve every original byte', () => {
  // Deterministic PRNG (mulberry32) so failures reproduce.
  function prng(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const PIECES = ['a', 'Z', ' ', '  ', '\n', '\r\n', '\n\n', '#', '`', '~', '*', '-', '=', '/', '·', 'é', '🙂', '**', 'Your word:', '>', '<!--', '-->', '\t', 'accept'];

  it('500 random comments: rejected only for a structural line, otherwise inserted exactly once after the Your-word line', () => {
    const random = prng(1819);
    const bases = [file(ACCEPT_LINE), file(ACCEPT_LINE, NEXT_ITEM), file(ACCEPT_LINE, '').replace(/\n/g, '\r\n').slice(0, -2)];
    let applied = 0;
    for (let n = 0; n < 500; n++) {
      const length = 1 + Math.floor(random() * 30);
      let comment = '';
      for (let k = 0; k < length; k++) comment += PIECES[Math.floor(random() * PIECES.length)];
      const base = bases[n % bases.length];
      const word = random() < 0.5 ? 'accept' : undefined;
      const result = rule(base, { word, comment });
      if (!result.ok) {
        expect(['empty-ruling', 'comment-heading', 'comment-fence', 'comment-your-word']).toContain(result.code);
        continue;
      }
      applied++;
      const inserted = expectOnlyInsertion(base, result.text);
      const eol = base.includes('\r\n') ? '\r\n' : '\n';
      const lines = comment.trim() ? comment.trim().split(/\r\n|\r|\n/) : [];
      const ruling = [...(word ? [word] : []), ...(word && lines.length ? [''] : []), ...lines];
      expect(inserted.replace(/^\r?\n/, '').startsWith(ruling.join(eol) + eol)).toBe(true);
      expect(parseDecisions(result.text).items.find(i => i.id === 'a-1')!.currentRuling).toBe(ruling.join('\n'));
    }
    expect(applied).toBeGreaterThan(200);
  });
});
