/**
 * Spec 1951 — the pure parsers behind `codev check pr`: the `pr-view` contract fields it
 * relies on, `git log -z` and `git merge-tree -z` output, per-line attribution matching,
 * and width-bounded lists.
 */

import { describe, expect, it } from 'vitest';
import { matchLines, parseLogMessages, parseMergeTree, parsePrView } from '../pr.js';
import { CheckCommandError, fitList } from '../report.js';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

describe('Spec 1951 — parsePrView', () => {
  const view = { title: 'T', body: 'B', state: 'OPEN', url: 'u', isDraft: true, headRefName: 'builder/spir-7', baseRefName: 'main', headRefOid: SHA };

  it('reads the fields the command needs', () => {
    expect(parsePrView(view)).toEqual({
      ok: true,
      value: { title: 'T', body: 'B', state: 'OPEN', url: 'u', draft: true, headRef: 'builder/spir-7', baseRef: 'main', head: SHA },
    });
  });

  it('keeps optional fields it does not get as null, never a guess', () => {
    const result = parsePrView({ headRefName: 'b', baseRefName: 'main', headRefOid: SHA });
    expect(result).toEqual({ ok: true, value: { title: null, body: null, state: null, url: null, draft: null, headRef: 'b', baseRef: 'main', head: SHA } });
  });

  it.each([
    [{ ...view, headRefOid: undefined }, 'pr-view did not return headRefOid'],
    [{ ...view, headRefOid: '' }, 'pr-view did not return headRefOid'],
    [{ ...view, headRefOid: 'abc1234' }, 'pr-view returned headRefOid "abc1234", not a full commit SHA'],
    [{ ...view, headRefOid: 42 }, 'pr-view returned headRefOid 42, not a full commit SHA'],
    [{ ...view, baseRefName: undefined }, 'pr-view did not return baseRefName'],
    [{ ...view, headRefName: '--upload-pack=x' }, 'pr-view returned headRefName "--upload-pack=x", not a valid branch name'],
    [{ ...view, baseRefName: 'a..b' }, 'pr-view returned baseRefName "a..b", not a valid branch name'],
    [[], 'pr-view returned something other than a JSON object'],
    ['text', 'pr-view returned something other than a JSON object'],
  ])('refuses %j', (data, reason) => {
    expect(parsePrView(data)).toEqual({ ok: false, reason });
  });
});

describe('Spec 1951 — git output parsers', () => {
  it('parses git log -z --format=%H%x00%B, empty messages included', () => {
    expect(parseLogMessages(`${SHA}\0second\n\0${SHA2}\0first\n\nTrailer: x\n\0`)).toEqual([
      { sha: SHA, message: 'second\n' },
      { sha: SHA2, message: 'first\n\nTrailer: x\n' },
    ]);
    expect(parseLogMessages(`${SHA}\0\0`)).toEqual([{ sha: SHA, message: '' }]);
    expect(parseLogMessages('')).toEqual([]);
  });

  it('fails loudly on log output it does not understand', () => {
    expect(() => parseLogMessages(`${SHA}\0msg\0extra`)).toThrow(CheckCommandError);
    expect(() => parseLogMessages('nothex\0msg\0')).toThrow(/not a commit SHA/);
  });

  it('parses merge-tree -z: the tree, then the conflicted files', () => {
    expect(parseMergeTree(`${SHA}\0`)).toEqual({ tree: SHA, files: [] });
    expect(parseMergeTree(`${SHA}\n`)).toEqual({ tree: SHA, files: [] });
    expect(parseMergeTree(`${SHA}\0a b.txt\0dir/c\0`)).toEqual({ tree: SHA, files: ['a b.txt', 'dir/c'] });
    expect(() => parseMergeTree('fatal: bad\0')).toThrow(CheckCommandError);
  });
});

describe('Spec 1951 — attribution matching', () => {
  const patterns = [{ source: '^\\s*Co-Authored-By:', regex: /^\s*Co-Authored-By:/i }];

  it('reports 1-based line numbers per matching line', () => {
    expect(matchLines('title\r\n\r\n  co-authored-by: X\nCo-Authored-By: Y', patterns)).toEqual([
      { line: 3, text: '  co-authored-by: X' },
      { line: 4, text: 'Co-Authored-By: Y' },
    ]);
  });

  it('matches each line on its own, so an anchor cannot match mid-message', () => {
    expect(matchLines('mentions Co-Authored-By: in prose', patterns)).toEqual([]);
  });
});

describe('Spec 1951 — fitList', () => {
  it('shows what fits, at least one item, then the count of the rest', () => {
    expect(fitList([], 10)).toBe('');
    expect(fitList(['a', 'b', 'c'], 10)).toBe('a, b, c');
    expect(fitList(['aaaa', 'bbbb', 'cccc'], 10)).toBe('aaaa, bbbb, … +1');
    expect(fitList(['a-very-long-path'], 5)).toBe('a-very-long-path');
    expect(fitList(['a-very-long-path', 'b'], 5)).toBe('a-very-long-path, … +1');
  });
});
