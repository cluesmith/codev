// The hub architect's notice of a Decisions-tab ruling (#1828): its text and its frame.

import { describe, it, expect } from 'vitest';
import { rulingNotice } from '../servers/decisions/notice.js';
import { formatUserViaDecisionsTabMessage } from '../utils/message-format.js';

describe('rulingNotice', () => {
  it('is RULED <id>: <word> for a bare word', () => {
    expect(rulingNotice({ id: 'main-11', word: 'accept', fingerprint: 'f' })).toBe('RULED main-11: accept');
  });

  it('puts the comment on the lines after the word', () => {
    expect(rulingNotice({ id: 'main-11', word: 'accept', comment: 'but keep the limit\nand ship it', fingerprint: 'f' }))
      .toBe('RULED main-11: accept\nbut keep the limit\nand ship it');
  });

  it('is QUESTION <id>: with the text after it for a comment-only submit', () => {
    expect(rulingNotice({ id: 'main-4', word: '', comment: 'why not both?', fingerprint: 'f' })).toBe('QUESTION main-4:\nwhy not both?');
    expect(rulingNotice({ id: 'main-4', comment: 'why not both?', fingerprint: 'f' })).toBe('QUESTION main-4:\nwhy not both?');
  });

  it('trims the comment as the file does and gives every line break as \\n', () => {
    expect(rulingNotice({ id: 'main-11', word: 'hold', comment: '  \r\nfirst\r\nsecond\rthird\n\n', fingerprint: 'f' }))
      .toBe('RULED main-11: hold\nfirst\nsecond\nthird');
  });

  it('drops a whitespace-only comment', () => {
    expect(rulingNotice({ id: 'main-11', word: 'accept', comment: ' \n ', fingerprint: 'f' })).toBe('RULED main-11: accept');
  });
});

describe('formatUserViaDecisionsTabMessage', () => {
  it('frames the notice as the owner relayed by the Decisions tab, naming the hub', () => {
    const frame = formatUserViaDecisionsTabMessage('main', 'RULED main-11: accept\nship it');
    expect(frame).toMatch(/^### \[USER via Decisions tab → main \| \d{4}-\d{2}-\d{2}T[^\]]+\] ###\nRULED main-11: accept\nship it\n#+$/);
  });

  it('leaves a raw notice unframed', () => {
    expect(formatUserViaDecisionsTabMessage('main', 'RULED main-11: accept', true)).toBe('RULED main-11: accept');
  });

  it('refuses to frame a notice with no recipient', () => {
    expect(() => formatUserViaDecisionsTabMessage('', 'RULED main-11: accept')).toThrow(/recipient/);
  });
});
