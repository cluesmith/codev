/**
 * Tests for agent naming utilities (utils/agent-names.ts)
 * Spec 0110: Messaging Infrastructure — Phase 1
 */

import { describe, it, expect } from 'vitest';
import {
  buildAgentName,
  parseAgentName,
  parseAddress,
  namesATower,
  localAddressOnlyMessage,
  resolveAgentName,
  taskBuilderId,
} from '../utils/agent-names.js';
import type { Builder } from '../types.js';

// Helper to create a minimal Builder object for testing
function makeBuilder(id: string, overrides?: Partial<Builder>): Builder {
  return {
    id,
    name: id,
    status: 'implementing',
    phase: 'init',
    worktree: `/tmp/.builders/${id}`,
    branch: `builder/${id}`,
    type: 'spec',
    ...overrides,
  };
}

describe('taskBuilderId (#1992)', () => {
  it('names a task builder from its worktree name or short id, as spawn does', () => {
    expect(taskBuilderId('task-bEPd')).toBe('builder-task-bepd');
    expect(taskBuilderId('bEPd')).toBe('builder-task-bepd');
    expect(taskBuilderId('task-S0-L')).toBe('builder-task-s0-l');
    expect(taskBuilderId('task-_-LM')).toBe('builder-task-_-lm');
    expect(taskBuilderId('task-0123')).toBe('builder-task-123');
    expect(taskBuilderId('0123')).toBe('builder-task-123');
  });
});

describe('buildAgentName', () => {
  it('generates spec builder names with default spir protocol', () => {
    expect(buildAgentName('spec', '0109')).toBe('builder-spir-109');
    expect(buildAgentName('spec', '1')).toBe('builder-spir-1');
  });

  it('generates spec builder names with explicit protocol', () => {
    expect(buildAgentName('spec', '0109', 'tick')).toBe('builder-tick-109');
    expect(buildAgentName('spec', '42', 'experiment')).toBe('builder-experiment-42');
  });

  it('generates bugfix builder names', () => {
    expect(buildAgentName('bugfix', '42')).toBe('builder-bugfix-42');
    expect(buildAgentName('bugfix', '269')).toBe('builder-bugfix-269');
  });

  it('generates pir builder names', () => {
    expect(buildAgentName('pir', '737')).toBe('builder-pir-737');
    expect(buildAgentName('pir', '0042')).toBe('builder-pir-42');
  });

  it('generates task builder names', () => {
    expect(buildAgentName('task', 'AbCd')).toBe('builder-task-abcd');
    expect(buildAgentName('task', 'XyZ1')).toBe('builder-task-xyz1');
  });

  it('generates protocol builder names', () => {
    expect(buildAgentName('protocol', 'AbCd', 'experiment')).toBe('builder-experiment-abcd');
    expect(buildAgentName('protocol', 'XyZ1', 'maintain')).toBe('builder-maintain-xyz1');
  });

  it('handles shell and worktree types without builder- prefix', () => {
    expect(buildAgentName('shell', 'AbCd')).toBe('shell-abcd');
    expect(buildAgentName('worktree', 'XyZ1')).toBe('worktree-xyz1');
  });

  it('strips leading zeros from numeric IDs', () => {
    expect(buildAgentName('spec', '0001')).toBe('builder-spir-1');
    expect(buildAgentName('bugfix', '042')).toBe('builder-bugfix-42');
  });

});

describe('parseAgentName', () => {
  it('parses valid builder names', () => {
    expect(parseAgentName('builder-spir-109')).toEqual({ protocol: 'spir', id: '109' });
    expect(parseAgentName('builder-bugfix-42')).toEqual({ protocol: 'bugfix', id: '42' });
    expect(parseAgentName('builder-task-abcd')).toEqual({ protocol: 'task', id: 'abcd' });
  });

  it('handles case-insensitive parsing', () => {
    expect(parseAgentName('BUILDER-SPIR-109')).toEqual({ protocol: 'spir', id: '109' });
    expect(parseAgentName('Builder-Bugfix-42')).toEqual({ protocol: 'bugfix', id: '42' });
  });

  it('returns null for non-builder names', () => {
    expect(parseAgentName('architect')).toBeNull();
    expect(parseAgentName('0109')).toBeNull();
    expect(parseAgentName('builder')).toBeNull();
    expect(parseAgentName('builder-')).toBeNull();
    expect(parseAgentName('')).toBeNull();
  });
});

// The old two-slot `parseAddress` and its unit block are gone (Spec 1940). The one shared
// parser is re-exported here and is covered row by row by the shared table in
// `address-conformance.test.ts`. What is left to pin in this file is that the re-export
// IS that parser, and the two shapes whose meaning changed with it.
describe('parseAddress (the shared parser, re-exported)', () => {
  it('reads the forms the old parser read, into the structured address', () => {
    expect(parseAddress('ARCHITECT')).toEqual({ ok: true, address: { kind: 'architect' } });
    expect(parseAddress('Codev-Public:Builder-SPIR-109')).toEqual({
      ok: true,
      address: { workspace: 'codev-public', kind: 'id', name: 'builder-spir-109' },
    });
  });

  it('reads a named architect in another workspace, which the old parser could not', () => {
    expect(parseAddress('codev-cloud:architect:tunnel')).toEqual({
      ok: true,
      address: { workspace: 'codev-cloud', kind: 'architect', name: 'tunnel' },
    });
  });

  it('refuses `:agent` and `a:b:c`, which the old parser passed on to fail as not found', () => {
    const leadingColon = parseAddress(':agent');
    const threeParts = parseAddress('a:b:c');
    expect(leadingColon.ok).toBe(false);
    expect(threeParts.ok).toBe(false);
    if (leadingColon.ok || threeParts.ok) return;
    expect(leadingColon.error.code).toBe('EMPTY_COMPONENT');
    expect(threeParts.error.code).toBe('TOO_MANY_COMPONENTS');
    expect(threeParts.error.expected).toContain('[<workspace>:]architect[:<name>]');
  });
});

describe('namesATower', () => {
  it('is true for a well-formed afx:// address, with or without an owner', () => {
    expect(namesATower('afx://devvm/codev:architect')).toBe(true);
    expect(namesATower('afx://sam@studio/codev:architect:data')).toBe(true);
    expect(namesATower('  AFX://devvm/codev:builder-spir-1940  ')).toBe(true);
  });

  it('is false for every local form', () => {
    for (const local of ['architect', 'architect:review', 'codev:architect:review', 'builder-spir-1940', 'codev:1940', 'afx:architect']) {
      expect(namesATower(local)).toBe(false);
    }
  });

  it('is false for a malformed afx:// address, which is left to fail as malformed', () => {
    for (const malformed of ['afx://devvm', 'afx://devvm/architect', 'afx://dev_vm/codev:architect', 'afx:/devvm/codev:architect']) {
      expect(namesATower(malformed)).toBe(false);
    }
  });

  // Spec 1967: cross-Tower messaging exists now, so the refusal no longer says it does not.
  // What refuses an afx:// address is something that reaches only this Tower's agents.
  it('has one refusal text for what takes only a local address, naming afx send for another Tower', () => {
    const message = localAddressOnlyMessage('afx interrupt');
    expect(message).toMatch(/^afx interrupt takes a local address: \[<workspace>:\]architect\[:<name>\]/);
    expect(message).toContain('only afx send reaches one');
    expect(message).not.toMatch(/not available/);
  });
});

describe('resolveAgentName', () => {
  const builders: Builder[] = [
    makeBuilder('builder-spir-109'),
    makeBuilder('builder-spir-110'),
    makeBuilder('builder-bugfix-42'),
    makeBuilder('builder-task-abcd'),
  ];

  describe('exact match', () => {
    it('matches exact builder ID (case-insensitive)', () => {
      const result = resolveAgentName('builder-spir-109', builders);
      expect(result.builder?.id).toBe('builder-spir-109');
    });

    it('matches exact builder ID case-insensitively', () => {
      const result = resolveAgentName('BUILDER-SPIR-109', builders);
      expect(result.builder?.id).toBe('builder-spir-109');
    });

    it('matches exact builder ID with mixed case', () => {
      const result = resolveAgentName('Builder-Spir-109', builders);
      expect(result.builder?.id).toBe('builder-spir-109');
    });
  });

  describe('tail match', () => {
    it('matches bare numeric ID via tail match', () => {
      const result = resolveAgentName('109', builders);
      expect(result.builder?.id).toBe('builder-spir-109');
    });

    it('matches bare numeric ID with leading zeros stripped', () => {
      const result = resolveAgentName('0109', builders);
      expect(result.builder?.id).toBe('builder-spir-109');
    });

    it('matches protocol-id tail', () => {
      const result = resolveAgentName('bugfix-42', builders);
      expect(result.builder?.id).toBe('builder-bugfix-42');
    });

    it('matches task shortId tail', () => {
      const result = resolveAgentName('abcd', builders);
      expect(result.builder?.id).toBe('builder-task-abcd');
    });

    it('matches case-insensitively for tail match', () => {
      const result = resolveAgentName('ABCD', builders);
      expect(result.builder?.id).toBe('builder-task-abcd');
    });
  });

  describe('ambiguity', () => {
    it('returns ambiguous when bare ID matches multiple builders', () => {
      // Add a builder where '10' is ambiguous (matches builder-spir-110 via -110 ending)
      // Actually '10' won't match since 109 ends with -109, not -10
      // Let's test with builders that share a suffix
      const ambiguousBuilders = [
        makeBuilder('builder-spir-42'),
        makeBuilder('builder-bugfix-42'),
      ];
      const result = resolveAgentName('42', ambiguousBuilders);
      expect(result.builder).toBeNull();
      expect(result.ambiguous).toHaveLength(2);
      expect(result.ambiguous!.map(b => b.id)).toContain('builder-spir-42');
      expect(result.ambiguous!.map(b => b.id)).toContain('builder-bugfix-42');
    });
  });

  describe('no match', () => {
    it('returns null for unknown builder', () => {
      const result = resolveAgentName('unknown-builder', builders);
      expect(result.builder).toBeNull();
      expect(result.ambiguous).toBeUndefined();
    });

    it('returns null for non-existent numeric ID', () => {
      const result = resolveAgentName('999', builders);
      expect(result.builder).toBeNull();
    });
  });

  describe('mixed old/new format builders', () => {
    it('resolves old-format builder IDs (bare numbers)', () => {
      const mixedBuilders = [
        makeBuilder('0109'),  // old format
        makeBuilder('builder-spir-110'),  // new format
      ];

      // Exact match for old format
      const result1 = resolveAgentName('0109', mixedBuilders);
      expect(result1.builder?.id).toBe('0109');

      // Exact match for new format
      const result2 = resolveAgentName('builder-spir-110', mixedBuilders);
      expect(result2.builder?.id).toBe('builder-spir-110');

      // Tail match for new format via bare ID
      const result3 = resolveAgentName('110', mixedBuilders);
      expect(result3.builder?.id).toBe('builder-spir-110');
    });
  });
});
