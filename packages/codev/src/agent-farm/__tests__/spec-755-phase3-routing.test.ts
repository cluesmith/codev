/**
 * Spec 755 Phase 3 — affinity-aware architect routing tests.
 *
 * Drives `resolveTarget` directly with mocked `getWorkspaceTerminals` and
 * `lookupBuilderSpawningArchitect`, asserting the full routing matrix:
 *
 *   1.  Single-architect baseline (regression): builder → 'architect' → 'main'.
 *   2.  Two architects, scoped: builder spawned by 'main' → 'main' only.
 *   3.  Two architects, scoped: builder spawned by 'sibling' → 'sibling' only.
 *   4.  Legacy builder (no spawnedByArchitect), 'main' present: → 'main'.
 *   5.  Legacy builder (no spawnedByArchitect), 'main' absent: → error (verbatim).
 *   6.  Architect-gone, 'main' present: → 'main'.
 *   7.  Architect-gone, 'main' absent: → error (verbatim).
 *   8.  Architect reconnect: route by name, not by stale terminalId.
 *   9.  Non-builder sender ('architect', no sender): → 'main'.
 *  10.  Cross-architect spoofing: builder targets 'architect:other' → rejected.
 *  11.  'architect:<name>' allowed when name matches sender's spawningArchitect.
 *  12.  Cron-style sender (not a builder): → 'main'.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkspaceTerminals } from '../servers/tower-types.js';

const { mockGetWorkspaceTerminals, mockLookupBuilderSpawningArchitect } = vi.hoisted(() => ({
  mockGetWorkspaceTerminals: vi.fn<() => Map<string, WorkspaceTerminals>>(),
  mockLookupBuilderSpawningArchitect: vi.fn<(id: string) => string | null | undefined>(),
}));

vi.mock('../servers/tower-terminals.js', () => ({
  getWorkspaceTerminals: () => mockGetWorkspaceTerminals(),
  // Every terminal on the fake map is open, so a workspace with one is running (Issue #1978).
  getTerminalManager: () => ({ getSession: () => ({ status: 'running' }) }),
}));

vi.mock('../state.js', () => ({
  lookupBuilderSpawningArchitect: (id: string) => mockLookupBuilderSpawningArchitect(id),
}));

import {
  parseTarget,
  resolveTarget,
  isResolveError,
  legacyBuilderErrorMessage,
  architectGoneErrorMessage,
  addressSpoofingErrorMessage,
} from '../servers/tower-messages.js';

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

describe('Spec 755 Phase 3 — routing matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ------------------------------------------------------------------
  // 1. Single-architect baseline (regression)
  // ------------------------------------------------------------------
  it('routes builder → "architect" → main in a single-architect workspace (fast path)', () => {
    mockGetWorkspaceTerminals.mockReturnValue(new Map([[WS, mkEntry({ main: 'term-main' }, { 'spir-100': 'term-b' })]]));
    // Fast path doesn't even touch state.db, so spawningArchitect lookup must not be called.

    const result = resolve('architect', WS, 'spir-100');
    expect(isResolveError(result)).toBe(false);
    if (!isResolveError(result)) {
      expect(result.terminalId).toBe('term-main');
      expect(result.agent).toBe('architect');
    }
    // Fast-path guarantee: no state.db read.
    expect(mockLookupBuilderSpawningArchitect).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // 2 & 3. Two architects, scoped routing
  // ------------------------------------------------------------------
  it('routes builder spawned by main → "architect" → main when both exist', () => {
    mockGetWorkspaceTerminals.mockReturnValue(new Map([[WS, mkEntry(
      { main: 'term-main', sibling: 'term-sibling' },
      { 'spir-100': 'term-b' },
    )]]));
    mockLookupBuilderSpawningArchitect.mockReturnValue('main');

    const result = resolve('architect', WS, 'spir-100');
    if (isResolveError(result)) throw new Error(`unexpected: ${result.message}`);
    expect(result.terminalId).toBe('term-main');
  });

  it('routes builder spawned by sibling → "architect" → sibling, NOT main', () => {
    mockGetWorkspaceTerminals.mockReturnValue(new Map([[WS, mkEntry(
      { main: 'term-main', sibling: 'term-sibling' },
      { 'spir-100': 'term-b' },
    )]]));
    mockLookupBuilderSpawningArchitect.mockReturnValue('sibling');

    const result = resolve('architect', WS, 'spir-100');
    if (isResolveError(result)) throw new Error(`unexpected: ${result.message}`);
    expect(result.terminalId).toBe('term-sibling');
    expect(result.terminalId).not.toBe('term-main');
  });

  // ------------------------------------------------------------------
  // 4 & 5. Legacy builder fallback
  // ------------------------------------------------------------------
  it('routes legacy builder (spawnedByArchitect=null) → "main" if present', () => {
    mockGetWorkspaceTerminals.mockReturnValue(new Map([[WS, mkEntry(
      { main: 'term-main', sibling: 'term-sibling' },
      { 'legacy-1': 'term-l' },
    )]]));
    mockLookupBuilderSpawningArchitect.mockReturnValue(null); // legacy row

    const result = resolve('architect', WS, 'legacy-1');
    if (isResolveError(result)) throw new Error(`unexpected: ${result.message}`);
    expect(result.terminalId).toBe('term-main');
  });

  it('errors verbatim when legacy builder has no main architect', () => {
    mockGetWorkspaceTerminals.mockReturnValue(new Map([[WS, mkEntry(
      { sibling: 'term-sibling', 'architect-3': 'term-a3' },
      { 'legacy-1': 'term-l' },
    )]]));
    mockLookupBuilderSpawningArchitect.mockReturnValue(null);

    const result = resolve('architect', WS, 'legacy-1');
    expect(isResolveError(result)).toBe(true);
    if (isResolveError(result)) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.message).toBe(legacyBuilderErrorMessage('legacy-1', ['sibling', 'architect-3']));
    }
  });

  // ------------------------------------------------------------------
  // 6 & 7. Architect-gone fallback
  // ------------------------------------------------------------------
  it('routes architect-gone builder → "main" when present', () => {
    // Builder spawned by 'sibling', but only 'main' is registered now.
    mockGetWorkspaceTerminals.mockReturnValue(new Map([[WS, mkEntry(
      { main: 'term-main' },
      { 'spir-100': 'term-b' },
    )]]));
    mockLookupBuilderSpawningArchitect.mockReturnValue('sibling');

    const result = resolve('architect', WS, 'spir-100');
    if (isResolveError(result)) throw new Error(`unexpected: ${result.message}`);
    expect(result.terminalId).toBe('term-main');
  });

  it('errors verbatim when architect-gone builder has no main fallback', () => {
    // Builder spawned by 'sibling', only 'cousin' / 'architect-3' registered.
    mockGetWorkspaceTerminals.mockReturnValue(new Map([[WS, mkEntry(
      { cousin: 'term-cousin', 'architect-3': 'term-a3' },
      { 'spir-100': 'term-b' },
    )]]));
    mockLookupBuilderSpawningArchitect.mockReturnValue('sibling');

    const result = resolve('architect', WS, 'spir-100');
    expect(isResolveError(result)).toBe(true);
    if (isResolveError(result)) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.message).toBe(
        architectGoneErrorMessage('spir-100', 'sibling', ['cousin', 'architect-3']),
      );
    }
  });

  // ------------------------------------------------------------------
  // 8. Architect reconnect (different terminalId, same name)
  // ------------------------------------------------------------------
  it('routes by architect name, not by stale terminalId (reconnect transparency)', () => {
    // First state: sibling at term-1.
    mockGetWorkspaceTerminals.mockReturnValue(new Map([[WS, mkEntry(
      { main: 'term-main', sibling: 'term-1' },
      { 'spir-100': 'term-b' },
    )]]));
    mockLookupBuilderSpawningArchitect.mockReturnValue('sibling');

    let result = resolve('architect', WS, 'spir-100');
    if (isResolveError(result)) throw new Error('unexpected');
    expect(result.terminalId).toBe('term-1');

    // Architect 'sibling' reconnects with a new terminalId. The architect's
    // name is unchanged; routing must follow.
    mockGetWorkspaceTerminals.mockReturnValue(new Map([[WS, mkEntry(
      { main: 'term-main', sibling: 'term-2-after-reconnect' },
      { 'spir-100': 'term-b' },
    )]]));

    result = resolve('architect', WS, 'spir-100');
    if (isResolveError(result)) throw new Error('unexpected');
    expect(result.terminalId).toBe('term-2-after-reconnect');
  });

  // ------------------------------------------------------------------
  // 9. Non-builder sender ('architect' from no-sender context)
  // ------------------------------------------------------------------
  it('routes non-builder send → "main" (no sender)', () => {
    mockGetWorkspaceTerminals.mockReturnValue(new Map([[WS, mkEntry(
      { main: 'term-main', sibling: 'term-sibling' },
    )]]));
    // sender is undefined.
    const result = resolve('architect', WS);
    if (isResolveError(result)) throw new Error('unexpected');
    expect(result.terminalId).toBe('term-main');
    expect(mockLookupBuilderSpawningArchitect).not.toHaveBeenCalled();
  });

  // Spoofing rejection / per-architect-by-name routing is exercised
  // end-to-end through the `architect:<name>` parsing block below. The
  // plain-name lookup variants (e.g. resolve('sibling', WS, ...))
  // are intentionally NOT supported: 'sibling' is not a workspace-local
  // agent name, it's an architect's name, and the per-name route must
  // go through the `architect:` prefix.

  // ------------------------------------------------------------------
  // End-to-end `architect:<name>` parsing — Codex caught that the old two-slot
  // parser was splitting these incorrectly as `project:agent` cross-workspace
  // addresses. The shared parser (Spec 1940) reads `architect:<name>` as a named
  // architect, and the resolver applies the spoofing check.
  // ------------------------------------------------------------------
  it('routes architect:<name> through resolveArchitectByName (allowed when matches)', () => {
    mockGetWorkspaceTerminals.mockReturnValue(new Map([[WS, mkEntry(
      { main: 'term-main', sibling: 'term-sibling' },
      { 'spir-100': 'term-b' },
    )]]));
    mockLookupBuilderSpawningArchitect.mockReturnValue('sibling');

    const result = resolve('architect:sibling', WS, 'spir-100');
    if (isResolveError(result)) throw new Error(`unexpected: ${result.message}`);
    expect(result.terminalId).toBe('term-sibling');
    expect(result.agent).toBe('sibling');
  });

  it('rejects architect:<other> from a builder spawned by a different architect (verbatim)', () => {
    mockGetWorkspaceTerminals.mockReturnValue(new Map([[WS, mkEntry(
      { main: 'term-main', sibling: 'term-sibling' },
      { 'spir-100': 'term-b' },
    )]]));
    mockLookupBuilderSpawningArchitect.mockReturnValue('main');

    const result = resolve('architect:sibling', WS, 'spir-100');
    expect(isResolveError(result)).toBe(true);
    if (isResolveError(result)) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.message).toBe(addressSpoofingErrorMessage('spir-100'));
    }
  });

  it('allows non-builder sender to address any architect:<name>', () => {
    mockGetWorkspaceTerminals.mockReturnValue(new Map([[WS, mkEntry(
      { main: 'term-main', sibling: 'term-sibling' },
    )]]));
    mockLookupBuilderSpawningArchitect.mockReturnValue(undefined); // not a builder

    const result = resolve('architect:sibling', WS, 'architect');
    if (isResolveError(result)) throw new Error(`unexpected: ${result.message}`);
    expect(result.terminalId).toBe('term-sibling');
  });

  it('returns NOT_FOUND for architect:<name> when the name is not registered', () => {
    mockGetWorkspaceTerminals.mockReturnValue(new Map([[WS, mkEntry(
      { main: 'term-main' },
    )]]));

    const result = resolve('architect:ghost', WS);
    expect(isResolveError(result)).toBe(true);
    if (isResolveError(result)) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.message).toContain("Architect 'ghost'");
    }
  });

  it('returns NO_CONTEXT for architect:<name> without a workspace context', () => {
    mockGetWorkspaceTerminals.mockReturnValue(new Map());

    const result = resolve('architect:sibling');
    expect(isResolveError(result)).toBe(true);
    if (isResolveError(result)) {
      expect(result.code).toBe('NO_CONTEXT');
    }
  });

  // ------------------------------------------------------------------
  // Fast-path edge case: single architect with non-default name
  // ------------------------------------------------------------------
  it('does NOT fast-path when the sole architect is not named main', () => {
    // Edge case: workspace started with a custom name (uncommon but valid).
    mockGetWorkspaceTerminals.mockReturnValue(new Map([[WS, mkEntry(
      { 'feature-team': 'term-ft' },
      { 'spir-100': 'term-b' },
    )]]));
    mockLookupBuilderSpawningArchitect.mockReturnValue('feature-team');

    const result = resolve('architect', WS, 'spir-100');
    if (isResolveError(result)) throw new Error(`unexpected: ${result.message}`);
    expect(result.terminalId).toBe('term-ft');
    // Fast path should have been skipped (size === 1 but not 'main' key).
    expect(mockLookupBuilderSpawningArchitect).toHaveBeenCalledWith('spir-100');
  });
});
