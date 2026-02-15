/**
 * Tests for tower-messages.ts (resolveTarget, broadcastMessage, subscriber management)
 * Spec 0110: Messaging Infrastructure — Phases 2 & 3
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkspaceTerminals } from '../servers/tower-types.js';

// ============================================================================
// Mocks
// ============================================================================

const { mockGetWorkspaceTerminals } = vi.hoisted(() => ({
  mockGetWorkspaceTerminals: vi.fn<() => Map<string, WorkspaceTerminals>>(),
}));

vi.mock('../servers/tower-terminals.js', () => ({
  getWorkspaceTerminals: () => mockGetWorkspaceTerminals(),
}));

import {
  resolveTarget,
  isResolveError,
  addSubscriber,
  removeSubscriber,
  broadcastMessage,
  getSubscriberCount,
} from '../servers/tower-messages.js';
import type { MessageFrame } from '../servers/tower-messages.js';

// ============================================================================
// Helpers
// ============================================================================

function makeWorkspaceTerminals(overrides?: Partial<WorkspaceTerminals>): WorkspaceTerminals {
  return {
    builders: new Map(),
    shells: new Map(),
    fileTabs: new Map(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('resolveTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('architect resolution', () => {
    it('resolves "architect" to the architect terminal', () => {
      const ws = makeWorkspaceTerminals({ architect: 'term-arch-001' });
      mockGetWorkspaceTerminals.mockReturnValue(new Map([['/home/user/project', ws]]));

      const result = resolveTarget('architect', '/home/user/project');
      expect(isResolveError(result)).toBe(false);
      expect(result).toEqual({
        terminalId: 'term-arch-001',
        workspacePath: '/home/user/project',
        agent: 'architect',
      });
    });

    it('resolves "arch" shorthand to the architect terminal', () => {
      const ws = makeWorkspaceTerminals({ architect: 'term-arch-001' });
      mockGetWorkspaceTerminals.mockReturnValue(new Map([['/home/user/project', ws]]));

      const result = resolveTarget('arch', '/home/user/project');
      expect(isResolveError(result)).toBe(false);
      expect(result).toEqual({
        terminalId: 'term-arch-001',
        workspacePath: '/home/user/project',
        agent: 'architect',
      });
    });

    it('returns NOT_FOUND when no architect terminal exists', () => {
      const ws = makeWorkspaceTerminals();
      mockGetWorkspaceTerminals.mockReturnValue(new Map([['/home/user/project', ws]]));

      const result = resolveTarget('architect', '/home/user/project');
      expect(isResolveError(result)).toBe(true);
      if (isResolveError(result)) {
        expect(result.code).toBe('NOT_FOUND');
      }
    });
  });

  describe('builder exact match', () => {
    it('resolves exact builder ID (case-insensitive)', () => {
      const ws = makeWorkspaceTerminals({
        builders: new Map([['builder-spir-109', 'term-b109']]),
      });
      mockGetWorkspaceTerminals.mockReturnValue(new Map([['/home/user/project', ws]]));

      const result = resolveTarget('builder-spir-109', '/home/user/project');
      expect(isResolveError(result)).toBe(false);
      expect(result).toEqual({
        terminalId: 'term-b109',
        workspacePath: '/home/user/project',
        agent: 'builder-spir-109',
      });
    });

    it('resolves builder with different case', () => {
      const ws = makeWorkspaceTerminals({
        builders: new Map([['builder-spir-109', 'term-b109']]),
      });
      mockGetWorkspaceTerminals.mockReturnValue(new Map([['/home/user/project', ws]]));

      const result = resolveTarget('BUILDER-SPIR-109', '/home/user/project');
      expect(isResolveError(result)).toBe(false);
      if (!isResolveError(result)) {
        expect(result.terminalId).toBe('term-b109');
      }
    });
  });

  describe('builder tail match', () => {
    it('resolves bare numeric ID via tail match', () => {
      const ws = makeWorkspaceTerminals({
        builders: new Map([['builder-spir-109', 'term-b109']]),
      });
      mockGetWorkspaceTerminals.mockReturnValue(new Map([['/home/user/project', ws]]));

      const result = resolveTarget('109', '/home/user/project');
      expect(isResolveError(result)).toBe(false);
      if (!isResolveError(result)) {
        expect(result.terminalId).toBe('term-b109');
        expect(result.agent).toBe('builder-spir-109');
      }
    });

    it('resolves bare numeric ID with leading zeros stripped', () => {
      const ws = makeWorkspaceTerminals({
        builders: new Map([['builder-spir-109', 'term-b109']]),
      });
      mockGetWorkspaceTerminals.mockReturnValue(new Map([['/home/user/project', ws]]));

      const result = resolveTarget('0109', '/home/user/project');
      expect(isResolveError(result)).toBe(false);
      if (!isResolveError(result)) {
        expect(result.terminalId).toBe('term-b109');
      }
    });

    it('resolves protocol-id tail (bugfix-42)', () => {
      const ws = makeWorkspaceTerminals({
        builders: new Map([['builder-bugfix-42', 'term-bf42']]),
      });
      mockGetWorkspaceTerminals.mockReturnValue(new Map([['/home/user/project', ws]]));

      const result = resolveTarget('bugfix-42', '/home/user/project');
      expect(isResolveError(result)).toBe(false);
      if (!isResolveError(result)) {
        expect(result.terminalId).toBe('term-bf42');
      }
    });

    it('returns AMBIGUOUS when multiple builders match tail', () => {
      const ws = makeWorkspaceTerminals({
        builders: new Map([
          ['builder-spir-42', 'term-s42'],
          ['builder-bugfix-42', 'term-bf42'],
        ]),
      });
      mockGetWorkspaceTerminals.mockReturnValue(new Map([['/home/user/project', ws]]));

      const result = resolveTarget('42', '/home/user/project');
      expect(isResolveError(result)).toBe(true);
      if (isResolveError(result)) {
        expect(result.code).toBe('AMBIGUOUS');
        expect(result.message).toContain('builder-spir-42');
        expect(result.message).toContain('builder-bugfix-42');
      }
    });
  });

  describe('shell resolution', () => {
    it('resolves exact shell ID', () => {
      const ws = makeWorkspaceTerminals({
        shells: new Map([['shell-1', 'term-sh1']]),
      });
      mockGetWorkspaceTerminals.mockReturnValue(new Map([['/home/user/project', ws]]));

      const result = resolveTarget('shell-1', '/home/user/project');
      expect(isResolveError(result)).toBe(false);
      if (!isResolveError(result)) {
        expect(result.terminalId).toBe('term-sh1');
        expect(result.agent).toBe('shell-1');
      }
    });
  });

  describe('cross-project resolution', () => {
    it('resolves project:agent address', () => {
      const ws = makeWorkspaceTerminals({ architect: 'term-arch-ext' });
      mockGetWorkspaceTerminals.mockReturnValue(
        new Map([['/home/user/other-project', ws]]),
      );

      const result = resolveTarget('other-project:architect');
      expect(isResolveError(result)).toBe(false);
      if (!isResolveError(result)) {
        expect(result.terminalId).toBe('term-arch-ext');
        expect(result.workspacePath).toBe('/home/user/other-project');
      }
    });

    it('returns NOT_FOUND for unknown project', () => {
      mockGetWorkspaceTerminals.mockReturnValue(new Map());

      const result = resolveTarget('nonexistent:architect');
      expect(isResolveError(result)).toBe(true);
      if (isResolveError(result)) {
        expect(result.code).toBe('NOT_FOUND');
        expect(result.message).toContain('nonexistent');
      }
    });

    it('returns AMBIGUOUS when multiple workspaces share the same basename', () => {
      const ws1 = makeWorkspaceTerminals({ architect: 'term-1' });
      const ws2 = makeWorkspaceTerminals({ architect: 'term-2' });
      mockGetWorkspaceTerminals.mockReturnValue(
        new Map([
          ['/home/alice/project', ws1],
          ['/home/bob/project', ws2],
        ]),
      );

      const result = resolveTarget('project:architect');
      expect(isResolveError(result)).toBe(true);
      if (isResolveError(result)) {
        expect(result.code).toBe('AMBIGUOUS');
      }
    });
  });

  describe('no context', () => {
    it('returns NO_CONTEXT when no fallback workspace and no project prefix', () => {
      const result = resolveTarget('architect');
      expect(isResolveError(result)).toBe(true);
      if (isResolveError(result)) {
        expect(result.code).toBe('NO_CONTEXT');
      }
    });

    it('returns NO_CONTEXT when fallback workspace is undefined', () => {
      const result = resolveTarget('builder-spir-109', undefined);
      expect(isResolveError(result)).toBe(true);
      if (isResolveError(result)) {
        expect(result.code).toBe('NO_CONTEXT');
      }
    });
  });

  describe('not found', () => {
    it('returns NOT_FOUND for unknown agent', () => {
      const ws = makeWorkspaceTerminals({
        builders: new Map([['builder-spir-109', 'term-b109']]),
      });
      mockGetWorkspaceTerminals.mockReturnValue(new Map([['/home/user/project', ws]]));

      const result = resolveTarget('unknown-agent', '/home/user/project');
      expect(isResolveError(result)).toBe(true);
      if (isResolveError(result)) {
        expect(result.code).toBe('NOT_FOUND');
      }
    });

    it('returns NOT_FOUND for workspace with no terminals registered', () => {
      mockGetWorkspaceTerminals.mockReturnValue(new Map());

      const result = resolveTarget('architect', '/home/user/missing');
      expect(isResolveError(result)).toBe(true);
      if (isResolveError(result)) {
        expect(result.code).toBe('NOT_FOUND');
      }
    });
  });

  describe('malformed addresses', () => {
    it('treats empty agent after project: as NOT_FOUND', () => {
      // parseAddress('project:') returns { project: 'project', agent: '' }
      // Empty agent won't match architect, builders, or shells
      const ws = makeWorkspaceTerminals({ architect: 'term-1' });
      mockGetWorkspaceTerminals.mockReturnValue(new Map([['/home/user/project', ws]]));

      const result = resolveTarget('project:', '/home/user/project');
      expect(isResolveError(result)).toBe(true);
      if (isResolveError(result)) {
        expect(result.code).toBe('NOT_FOUND');
      }
    });

    it('handles whitespace-only target via fallback (resolved as NOT_FOUND)', () => {
      const ws = makeWorkspaceTerminals();
      mockGetWorkspaceTerminals.mockReturnValue(new Map([['/home/user/project', ws]]));

      // Whitespace becomes empty string after parseAddress lowercasing
      const result = resolveTarget(' ', '/home/user/project');
      expect(isResolveError(result)).toBe(true);
    });
  });

  describe('error code contract', () => {
    it('NO_CONTEXT errors map to 400 status (INVALID_PARAMS in handler)', () => {
      // Verify the error code is NO_CONTEXT at the resolver level
      const result = resolveTarget('architect');
      expect(isResolveError(result)).toBe(true);
      if (isResolveError(result)) {
        expect(result.code).toBe('NO_CONTEXT');
        // Handler maps this to { error: 'INVALID_PARAMS' } with status 400
      }
    });

    it('AMBIGUOUS errors include candidate list in message', () => {
      const ws = makeWorkspaceTerminals({
        builders: new Map([
          ['builder-spir-99', 'term-s99'],
          ['builder-bugfix-99', 'term-bf99'],
        ]),
      });
      mockGetWorkspaceTerminals.mockReturnValue(new Map([['/home/user/project', ws]]));

      const result = resolveTarget('99', '/home/user/project');
      expect(isResolveError(result)).toBe(true);
      if (isResolveError(result)) {
        expect(result.code).toBe('AMBIGUOUS');
        expect(result.message).toContain('builder-spir-99');
        expect(result.message).toContain('builder-bugfix-99');
      }
    });

    it('NOT_FOUND errors include descriptive message', () => {
      const ws = makeWorkspaceTerminals();
      mockGetWorkspaceTerminals.mockReturnValue(new Map([['/home/user/myproject', ws]]));

      const result = resolveTarget('nonexistent', '/home/user/myproject');
      expect(isResolveError(result)).toBe(true);
      if (isResolveError(result)) {
        expect(result.code).toBe('NOT_FOUND');
        expect(result.message).toContain('nonexistent');
      }
    });
  });
});

// ============================================================================
// Phase 3: Subscriber Management and Broadcast
// ============================================================================

/** Create a mock WebSocket for testing. */
function makeMockWs(): { send: ReturnType<typeof vi.fn>; readyState: number } {
  return { send: vi.fn(), readyState: 1 /* OPEN */ };
}

function makeFrame(overrides?: Partial<MessageFrame>): MessageFrame {
  return {
    type: 'message',
    timestamp: '2026-02-15T00:00:00.000Z',
    from: { project: 'proj-a', agent: 'architect' },
    to: { project: 'proj-a', agent: 'builder-spir-109' },
    content: 'Hello builder',
    metadata: { source: 'api' },
    ...overrides,
  };
}

describe('subscriber management', () => {
  beforeEach(() => {
    // Clean up subscribers between tests by removing all
    // We can't access the set directly, so add/remove cycle
    // Instead, we'll track what we add and remove each in afterEach
  });

  it('addSubscriber increases count and removeSubscriber decreases it', () => {
    const ws1 = makeMockWs();
    const ws2 = makeMockWs();
    const baseline = getSubscriberCount();

    addSubscriber(ws1 as any);
    expect(getSubscriberCount()).toBe(baseline + 1);

    addSubscriber(ws2 as any);
    expect(getSubscriberCount()).toBe(baseline + 2);

    removeSubscriber(ws1 as any);
    expect(getSubscriberCount()).toBe(baseline + 1);

    removeSubscriber(ws2 as any);
    expect(getSubscriberCount()).toBe(baseline);
  });

  it('removeSubscriber is a no-op for unknown WebSocket', () => {
    const ws = makeMockWs();
    const baseline = getSubscriberCount();

    removeSubscriber(ws as any); // never added
    expect(getSubscriberCount()).toBe(baseline);
  });
});

describe('broadcastMessage', () => {
  it('sends JSON frame to all subscribers', () => {
    const ws1 = makeMockWs();
    const ws2 = makeMockWs();
    addSubscriber(ws1 as any);
    addSubscriber(ws2 as any);

    const frame = makeFrame();
    broadcastMessage(frame);

    const expected = JSON.stringify(frame);
    expect(ws1.send).toHaveBeenCalledWith(expected);
    expect(ws2.send).toHaveBeenCalledWith(expected);

    // Clean up
    removeSubscriber(ws1 as any);
    removeSubscriber(ws2 as any);
  });

  it('filters by project when subscriber has projectFilter', () => {
    const wsAll = makeMockWs();
    const wsProjA = makeMockWs();
    const wsProjB = makeMockWs();

    addSubscriber(wsAll as any); // no filter — gets everything
    addSubscriber(wsProjA as any, 'proj-a'); // only proj-a
    addSubscriber(wsProjB as any, 'proj-b'); // only proj-b

    const frame = makeFrame({
      from: { project: 'proj-a', agent: 'architect' },
      to: { project: 'proj-a', agent: 'builder-spir-109' },
    });
    broadcastMessage(frame);

    expect(wsAll.send).toHaveBeenCalledTimes(1);
    expect(wsProjA.send).toHaveBeenCalledTimes(1); // matches from.project
    expect(wsProjB.send).not.toHaveBeenCalled(); // neither from nor to is proj-b

    // Clean up
    removeSubscriber(wsAll as any);
    removeSubscriber(wsProjA as any);
    removeSubscriber(wsProjB as any);
  });

  it('delivers to subscriber when projectFilter matches to.project', () => {
    const wsProjB = makeMockWs();
    addSubscriber(wsProjB as any, 'proj-b');

    const frame = makeFrame({
      from: { project: 'proj-a', agent: 'architect' },
      to: { project: 'proj-b', agent: 'builder-spir-42' },
    });
    broadcastMessage(frame);

    expect(wsProjB.send).toHaveBeenCalledTimes(1);

    removeSubscriber(wsProjB as any);
  });

  it('removes subscriber on send failure', () => {
    const wsBad = makeMockWs();
    wsBad.send.mockImplementation(() => { throw new Error('connection lost'); });

    addSubscriber(wsBad as any);
    const beforeCount = getSubscriberCount();

    broadcastMessage(makeFrame());

    // Subscriber should have been removed due to send error
    expect(getSubscriberCount()).toBe(beforeCount - 1);
  });

  it('sends nothing when there are no subscribers', () => {
    // Just verify it doesn't throw
    broadcastMessage(makeFrame());
  });

  it('includes all MessageFrame fields in broadcast payload', () => {
    const ws = makeMockWs();
    addSubscriber(ws as any);

    const frame = makeFrame({
      metadata: { raw: true, source: 'api' },
    });
    broadcastMessage(frame);

    const payload = JSON.parse(ws.send.mock.calls[0][0]);
    expect(payload.type).toBe('message');
    expect(payload.timestamp).toBe('2026-02-15T00:00:00.000Z');
    expect(payload.from).toEqual({ project: 'proj-a', agent: 'architect' });
    expect(payload.to).toEqual({ project: 'proj-a', agent: 'builder-spir-109' });
    expect(payload.content).toBe('Hello builder');
    expect(payload.metadata).toEqual({ raw: true, source: 'api' });

    removeSubscriber(ws as any);
  });
});
