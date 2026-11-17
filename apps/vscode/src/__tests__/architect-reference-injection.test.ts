/**
 * Unit tests for the pure helper that builds the text injected into the
 * architect terminal by `codev.referenceIssueInArchitect` (issue #808).
 *
 * The helper has no `vscode` dependency, so we can import the live
 * implementation directly (same pattern as `prune-builder-terminals.test.ts`).
 */

import { describe, it, expect } from 'vitest';
import { buildArchitectReferenceInjection } from '../architect-reference-injection.js';

describe('buildArchitectReferenceInjection', () => {
  it('includes the title in quotes with a trailing space when present', () => {
    expect(buildArchitectReferenceInjection('1234', 'Build feature X'))
      .toBe('#1234 "Build feature X" ');
  });

  it('escapes embedded double-quotes in the title', () => {
    expect(buildArchitectReferenceInjection('1234', 'Has "quoted" word'))
      .toBe('#1234 "Has \\"quoted\\" word" ');
  });

  it('escapes every double-quote, not just the first', () => {
    expect(buildArchitectReferenceInjection('1234', '"a" "b" "c"'))
      .toBe('#1234 "\\"a\\" \\"b\\" \\"c\\"" ');
  });

  it('falls back to `#<id> ` when the title is undefined', () => {
    expect(buildArchitectReferenceInjection('1234', undefined))
      .toBe('#1234 ');
  });

  it('falls back to `#<id> ` when the title is an empty string', () => {
    // The extractIssueTitle wrapper normalises '' to undefined, but the
    // helper guards against '' independently so the fallback is correct
    // even if a future caller skips that normalisation.
    expect(buildArchitectReferenceInjection('1234', ''))
      .toBe('#1234 ');
  });

  it('leaves backslashes in the title untouched', () => {
    // Acceptance criteria specify `"` escaping only; double-escaping `\`
    // would diverge from the visible row label.
    expect(buildArchitectReferenceInjection('1234', 'path\\to\\thing'))
      .toBe('#1234 "path\\to\\thing" ');
  });
});

describe('tracker keys (#1740)', () => {
  it('references a key without #', () => {
    expect(buildArchitectReferenceInjection('ENG-12', 'Fix login')).toBe('ENG-12 "Fix login" ');
    expect(buildArchitectReferenceInjection('ENG-12', undefined)).toBe('ENG-12 ');
  });

  it('keeps numeric references unchanged', () => {
    expect(buildArchitectReferenceInjection('42', undefined)).toBe('#42 ');
  });
});
