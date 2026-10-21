/**
 * Issue #1740: tracker-key issue ids (Jira/Linear `ENG-123`) on the dashboard.
 */

import { describe, it, expect } from 'vitest';
import { findBuilderTab, issueRef } from '../src/lib/issueIds.js';
import type { Builder, OverviewBuilder } from '../src/lib/api.js';

const tab = (id: string, name = id) => ({ id, name } as unknown as Builder);
const builder = (over: Partial<OverviewBuilder>) => ({ id: 'x', issueId: null, roleId: null, ...over } as OverviewBuilder);

describe('issueRef', () => {
  it('keeps # for numbers and non-key ids, drops it for a canonical key', () => {
    expect(issueRef('42')).toBe('#42');
    expect(issueRef('task-AbCd')).toBe('#task-AbCd');
    expect(issueRef('ENG-123')).toBe('ENG-123');
  });
});

describe('findBuilderTab', () => {
  it('opens a tracker-key builder by its roleId (upper-case key, lower-case terminal id)', () => {
    const tabs = [tab('builder-pir-eng-12'), tab('builder-pir-eng-123')];
    expect(findBuilderTab(builder({ id: 'ENG-123', issueId: 'ENG-123', roleId: 'builder-pir-eng-123' }), tabs)?.id)
      .toBe('builder-pir-eng-123');
  });

  it('prefers the exact roleId over a substring collision', () => {
    const tabs = [tab('builder-spir-123'), tab('builder-spir-12')];
    expect(findBuilderTab(builder({ id: '12', issueId: '12', roleId: 'builder-spir-12' }), tabs)?.id).toBe('builder-spir-12');
  });

  it('falls back to a case-insensitive substring match without a roleId (older Tower)', () => {
    expect(findBuilderTab(builder({ id: 'ENG-7', issueId: 'ENG-7' }), [tab('builder-pir-eng-7')])?.id).toBe('builder-pir-eng-7');
    expect(findBuilderTab(builder({ id: '42', issueId: '42' }), [tab('builder-bugfix-42', 'Bugfix #42')])?.id).toBe('builder-bugfix-42');
  });

  it('returns undefined with no tabs', () => {
    expect(findBuilderTab(builder({ issueId: '1' }), undefined)).toBeUndefined();
  });
});
