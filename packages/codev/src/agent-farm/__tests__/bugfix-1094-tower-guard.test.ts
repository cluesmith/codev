/**
 * Issue #1094 — Tower-side defense-in-depth guard.
 *
 * When `resolveAgentInWorkspace` is asked to route 'architect' for a `sender`
 * that LOOKS like a builder id (canonical `builder-<protocol>-<id>` or the bare
 * worktree form `<protocol>-<id>`) but `lookupBuilderSpawningArchitect` returns
 * `undefined` (no matching state.db row), affinity routing has been silently
 * bypassed. The send still falls through to 'main' (unchanged behavior), but a
 * warning is now emitted so the misroute is visible instead of silent.
 *
 * Also unit-tests the `looksLikeBuilderId` heuristic directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WorkspaceTerminals } from '../servers/tower-types.js';

const { mockGetWorkspaceTerminals, mockLookupBuilderSpawningArchitect } = vi.hoisted(() => ({
  mockGetWorkspaceTerminals: vi.fn<() => Map<string, WorkspaceTerminals>>(),
  mockLookupBuilderSpawningArchitect: vi.fn<(id: string) => string | null | undefined>(),
}));

vi.mock('../servers/tower-terminals.js', () => ({
  getWorkspaceTerminals: () => mockGetWorkspaceTerminals(),
}));

vi.mock('../state.js', () => ({
  lookupBuilderSpawningArchitect: (id: string) => mockLookupBuilderSpawningArchitect(id),
}));

import { parseTarget, resolveTarget, isResolveError, looksLikeBuilderId } from '../servers/tower-messages.js';

const WS = '/home/user/project';

/**
 * Resolve address text the way the send route does (Spec 1940): read it once with the
 * shared parser, then resolve the structured address for a sender. `workspace` is the
 * sender's workspace, which is also where an address that names none is read.
 */
function resolve(target: string, workspace?: string, sender?: string) {
  const address = parseTarget(target);
  if (isResolveError(address)) return address;
  return resolveTarget(address, { id: sender, workspace });
}

function mkEntry(architects: Record<string, string>, builders: Record<string, string> = {}): WorkspaceTerminals {
  return {
    architects: new Map(Object.entries(architects)),
    builders: new Map(Object.entries(builders)),
    shells: new Map(),
    fileTabs: new Map(),
  };
}

describe('looksLikeBuilderId — issue #1094', () => {
  it('matches canonical and bare builder ids', () => {
    expect(looksLikeBuilderId('builder-bugfix-2461')).toBe(true);
    expect(looksLikeBuilderId('bugfix-2461')).toBe(true);
    expect(looksLikeBuilderId('bugfix-2461-some-slug')).toBe(true);
    expect(looksLikeBuilderId('spir-100')).toBe(true);
  });

  it('does not match architect senders', () => {
    expect(looksLikeBuilderId('architect')).toBe(false);
    expect(looksLikeBuilderId('arch')).toBe(false);
    expect(looksLikeBuilderId('main')).toBe(false);
    expect(looksLikeBuilderId('sibling')).toBe(false);
  });
});

describe('Tower guard — non-canonical builder sender warns before main fallback', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns when a builder-shaped sender has no state.db row, then routes to main', () => {
    // Two architects → fast path skipped → lookup consulted. The bare,
    // non-canonical sender id is exactly what the old send.ts fallback shipped.
    mockGetWorkspaceTerminals.mockReturnValue(
      new Map([[WS, mkEntry({ main: 'term-main', triage: 'term-triage' })]]),
    );
    mockLookupBuilderSpawningArchitect.mockReturnValue(undefined); // no matching row

    const result = resolve('architect', WS, 'bugfix-2461');
    if (isResolveError(result)) throw new Error(`unexpected: ${result.message}`);
    // Behavior unchanged: still falls through to main.
    expect(result.terminalId).toBe('term-main');
    // But the bypass is now visible.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('bugfix-2461');
    expect(warnSpy.mock.calls[0][0]).toMatch(/issue #1094/);
  });

  it('does NOT warn for a legitimate non-builder (architect) sender', () => {
    mockGetWorkspaceTerminals.mockReturnValue(
      new Map([[WS, mkEntry({ main: 'term-main', sibling: 'term-sibling' })]]),
    );
    mockLookupBuilderSpawningArchitect.mockReturnValue(undefined); // not a builder

    const result = resolve('architect', WS, 'architect');
    if (isResolveError(result)) throw new Error(`unexpected: ${result.message}`);
    expect(result.terminalId).toBe('term-main');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn when there is no sender at all', () => {
    mockGetWorkspaceTerminals.mockReturnValue(
      new Map([[WS, mkEntry({ main: 'term-main', sibling: 'term-sibling' })]]),
    );

    const result = resolve('architect', WS);
    if (isResolveError(result)) throw new Error(`unexpected: ${result.message}`);
    expect(result.terminalId).toBe('term-main');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
