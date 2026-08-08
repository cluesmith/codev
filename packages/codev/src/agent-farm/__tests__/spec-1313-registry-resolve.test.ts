/**
 * Spec 1313 — `resolveAgentInRegistry` (the dead-session / offline-hold resolver).
 *
 * When `resolveTarget` finds no LIVE terminal, `handleSend` falls back to this
 * resolver so a message to a KNOWN-but-offline agent is HELD (`no-live-pty`) rather
 * than 404'd. These tests drive it directly with mocked `getWorkspaceTerminals`
 * (used by the cross-workspace `findWorkspaceByBasename` mapping) and mocked
 * `state.js` registry reads (`getBuilders` / architect lookups), so the resolution
 * logic is covered without a live Tower or a real global.db.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkspaceTerminals } from '../servers/tower-types.js';
import type { Builder } from '../types.js';

const {
  mockGetWorkspaceTerminals,
  mockGetBuilders,
  mockGetArchitects,
  mockGetArchitectByName,
  mockLookupBuilderSpawningArchitect,
} = vi.hoisted(() => ({
  mockGetWorkspaceTerminals: vi.fn<() => Map<string, WorkspaceTerminals>>(),
  mockGetBuilders: vi.fn<(ws?: string) => Builder[]>(),
  mockGetArchitects: vi.fn<(ws: string) => Array<{ name: string }>>(),
  mockGetArchitectByName: vi.fn<(ws: string, name: string) => { name: string } | null>(),
  mockLookupBuilderSpawningArchitect: vi.fn<(id: string, ws?: string) => string | null | undefined>(),
}));

vi.mock('../servers/tower-terminals.js', () => ({
  getWorkspaceTerminals: () => mockGetWorkspaceTerminals(),
}));

vi.mock('../state.js', () => ({
  getBuilders: (ws?: string) => mockGetBuilders(ws),
  getArchitects: (ws: string) => mockGetArchitects(ws),
  getArchitectByName: (ws: string, name: string) => mockGetArchitectByName(ws, name),
  lookupBuilderSpawningArchitect: (id: string, ws?: string) => mockLookupBuilderSpawningArchitect(id, ws),
}));

import { resolveAgentInRegistry, isResolveError } from '../servers/tower-messages.js';

const WS_A = '/home/user/proj-a';
const WS_B = '/home/user/proj-b';

/** A minimal WorkspaceTerminals; the resolver only cares that the key (path) exists. */
function emptyEntry(): WorkspaceTerminals {
  return { architects: new Map(), builders: new Map(), shells: new Map(), fileTabs: new Map() };
}

/** A Builder stub carrying only the `.id` the resolver reads. */
function builder(id: string): Builder {
  return { id } as unknown as Builder;
}

describe('Spec 1313 — resolveAgentInRegistry (offline-hold fallback)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: both workspaces are live-registered (so findWorkspaceByBasename can
    // map a project basename → path); registries are empty unless a test sets them.
    mockGetWorkspaceTerminals.mockReturnValue(
      new Map([[WS_A, emptyEntry()], [WS_B, emptyEntry()]]),
    );
    mockGetBuilders.mockReturnValue([]);
    mockGetArchitects.mockReturnValue([]);
    mockGetArchitectByName.mockReturnValue(null);
    mockLookupBuilderSpawningArchitect.mockReturnValue(undefined);
  });

  it('holds a bare builder that is registered but has no live PTY', () => {
    mockGetBuilders.mockImplementation((ws) => (ws === WS_A ? [builder('spir-100')] : []));

    const result = resolveAgentInRegistry('spir-100', WS_A);
    if (isResolveError(result)) throw new Error(`unexpected: ${result.message}`);
    expect(result).toEqual({ workspacePath: WS_A, agent: 'spir-100', kind: 'builder' });
  });

  it('tail-matches a bare builder by numeric suffix (leading zeros stripped)', () => {
    mockGetBuilders.mockImplementation((ws) => (ws === WS_A ? [builder('spir-100')] : []));

    const result = resolveAgentInRegistry('100', WS_A);
    if (isResolveError(result)) throw new Error(`unexpected: ${result.message}`);
    expect(result.agent).toBe('spir-100');
  });

  it('NOT_FOUND for a bare agent absent from the registry (mail is not held for a stranger)', () => {
    mockGetBuilders.mockReturnValue([]);
    const result = resolveAgentInRegistry('spir-999', WS_A);
    expect(isResolveError(result) && result.code).toBe('NOT_FOUND');
  });

  // ---- Fix (Spec 1313 review): cross-workspace project:agent offline hold ----

  it('holds a cross-workspace project:builder against the TARGET workspace registry', () => {
    // proj-b is live-registered (findWorkspaceByBasename maps it → WS_B); its
    // builder spir-200 is registered but its PTY is down → hold against WS_B.
    mockGetBuilders.mockImplementation((ws) => (ws === WS_B ? [builder('spir-200')] : []));

    const result = resolveAgentInRegistry('proj-b:spir-200', WS_A, 'spir-100');
    if (isResolveError(result)) throw new Error(`unexpected: ${result.message}`);
    expect(result).toEqual({ workspacePath: WS_B, agent: 'spir-200', kind: 'builder' });
  });

  it('NOT_FOUND when the project workspace is not active (findWorkspaceByBasename boundary)', () => {
    // Only WS_A is live-registered; proj-b maps to no workspace.
    mockGetWorkspaceTerminals.mockReturnValue(new Map([[WS_A, emptyEntry()]]));

    const result = resolveAgentInRegistry('proj-b:spir-200', WS_A);
    expect(isResolveError(result) && result.code).toBe('NOT_FOUND');
  });

  it('NOT_FOUND for project:builder when the agent is absent from the target registry', () => {
    mockGetBuilders.mockReturnValue([]); // proj-b is live but has no such builder
    const result = resolveAgentInRegistry('proj-b:spir-200', WS_A);
    expect(isResolveError(result) && result.code).toBe('NOT_FOUND');
  });
});
