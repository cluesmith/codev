/**
 * Issue #1740: tracker-key issue ids (Jira/Linear `ENG-123`) in the Work view's labels.
 */

import { describe, it, expect } from 'vitest';
import { issueRef } from '../lib/issueIds.js';

describe('issueRef', () => {
  it('keeps # for numbers and non-key ids, drops it for a canonical key', () => {
    expect(issueRef('42')).toBe('#42');
    expect(issueRef('task-AbCd')).toBe('#task-AbCd');
    expect(issueRef('ENG-123')).toBe('ENG-123');
  });
});
