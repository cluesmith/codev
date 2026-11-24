/**
 * Spec 1940, phases 2 and 3 — named architects across workspaces, the builder rule, and
 * explicit workspace names in the resolvers.
 *
 * Drives the two resolvers (`resolveTarget` against live terminals, `resolveAgentInRegistry`
 * against the durable registry) with a fake terminal map and a fake registry. Most cases run
 * against BOTH, because the phase's promise is that the two cannot disagree: mail to a named
 * architect in another workspace must be held when it has no live terminal, under the same
 * rules that would have delivered it.
 *
 * Two workspaces on one Tower:
 *   codev        main, review     builders spir-100 (spawned by review), legacy-1 (no architect)
 *   codev-cloud  main, tunnel, review
 * `review` exists in both on purpose: an architect of the same name in another workspace is
 * not the one that spawned a builder.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WorkspaceTerminals } from '../servers/tower-types.js';
import type { Builder } from '../types.js';

const {
  mockGetWorkspaceTerminals,
  mockGetBuilders,
  mockGetArchitects,
  mockGetArchitectByName,
  mockLookupBuilderSpawningArchitect,
  mockGetRegisteredWorkspaces,
} = vi.hoisted(() => ({
  mockGetWorkspaceTerminals: vi.fn<() => Map<string, WorkspaceTerminals>>(),
  mockGetBuilders: vi.fn<(ws?: string) => Builder[]>(),
  mockGetArchitects: vi.fn<(ws: string) => Array<{ name: string }>>(),
  mockGetArchitectByName: vi.fn<(ws: string, name: string) => { name: string } | null>(),
  mockLookupBuilderSpawningArchitect: vi.fn<(id: string, ws?: string) => string | null | undefined>(),
  mockGetRegisteredWorkspaces: vi.fn<() => Array<{ workspacePath: string; explicitName: string | null }>>(),
}));

vi.mock('../servers/tower-terminals.js', () => ({
  getWorkspaceTerminals: () => mockGetWorkspaceTerminals(),
}));

vi.mock('../state.js', () => ({
  getBuilders: (ws?: string) => mockGetBuilders(ws),
  getArchitects: (ws: string) => mockGetArchitects(ws),
  getArchitectByName: (ws: string, name: string) => mockGetArchitectByName(ws, name),
  lookupBuilderSpawningArchitect: (id: string, ws?: string) => mockLookupBuilderSpawningArchitect(id, ws),
  getRegisteredWorkspaces: () => mockGetRegisteredWorkspaces(),
}));

import {
  parseTarget,
  resolveTarget,
  resolveAgentInRegistry,
  isResolveError,
  addressSpoofingErrorMessage,
  architectGoneErrorMessage,
  crossWorkspaceBuilderErrorMessage,
  legacyBuilderErrorMessage,
  type ResolveError,
} from '../servers/tower-messages.js';
import { CROSS_TOWER_UNAVAILABLE_MESSAGE } from '../utils/agent-names.js';

const CODEV = '/home/user/codev';
const CLOUD = '/home/user/codev-cloud';

/** The registry: which architects each workspace has, and who spawned each builder. */
const ARCHITECTS: Record<string, string[]> = {
  [CODEV]: ['main', 'review'],
  [CLOUD]: ['main', 'review', 'tunnel'],
};
const SPAWNED_BY: Record<string, Record<string, string | null>> = {
  [CODEV]: { 'spir-100': 'review', 'legacy-1': null },
  [CLOUD]: {},
};

function entry(architects: string[], builders: string[] = [], shells: string[] = []): WorkspaceTerminals {
  return {
    architects: new Map(architects.map((name) => [name, `term-${name}`])),
    builders: new Map(builders.map((id) => [id, `term-${id}`])),
    shells: new Map(shells.map((id) => [id, `term-${id}`])),
    fileTabs: new Map(),
  };
}

/** Every architect has a live terminal, unless a test takes some away. */
function allLive(): Map<string, WorkspaceTerminals> {
  return new Map([
    [CODEV, entry(ARCHITECTS[CODEV], ['spir-100', 'legacy-1'], ['shell-1'])],
    [CLOUD, entry(ARCHITECTS[CLOUD], [], ['shell-7'])],
  ]);
}

interface Outcome {
  /** The architect or id reached, or null when the address was refused. */
  reached: string | null;
  workspacePath?: string;
  error?: ResolveError;
}

/** Send from `sender` in `workspace`, resolving against live terminals, as the route does. */
function live(target: string, workspace?: string, sender?: string): Outcome {
  const address = parseTarget(target);
  if (isResolveError(address)) return { reached: null, error: address };
  const result = resolveTarget(address, { id: sender, workspace });
  if (isResolveError(result)) return { reached: null, error: result };
  // A live architect resolves to its terminal; name the architect that terminal belongs to.
  return { reached: result.terminalId.replace(/^term-/, ''), workspacePath: result.workspacePath };
}

/** The same send, resolved against the registry (the recipient has no live terminal). */
function registry(target: string, workspace?: string, sender?: string): Outcome {
  const address = parseTarget(target);
  if (isResolveError(address)) return { reached: null, error: address };
  const result = resolveAgentInRegistry(address, { id: sender, workspace });
  if (isResolveError(result)) return { reached: null, error: result };
  return { reached: result.agent, workspacePath: result.workspacePath };
}

const BOTH = [
  ['live terminals', live],
  ['the registry', registry],
] as const;

describe('Spec 1940 phase 2 — addresses across workspaces', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkspaceTerminals.mockImplementation(allLive);
    mockGetArchitects.mockImplementation((ws) => (ARCHITECTS[ws] ?? []).map((name) => ({ name })));
    mockGetArchitectByName.mockImplementation((ws, name) => ((ARCHITECTS[ws] ?? []).includes(name) ? { name } : null));
    mockGetBuilders.mockImplementation((ws) => Object.keys(SPAWNED_BY[ws ?? ''] ?? {}).map((id) => ({ id }) as unknown as Builder));
    mockLookupBuilderSpawningArchitect.mockImplementation((id, ws) => {
      // As the real one: scoped to a workspace when one is given, else matched by id alone.
      const scopes = ws === undefined ? Object.values(SPAWNED_BY) : [SPAWNED_BY[ws] ?? {}];
      return scopes.find((rows) => id in rows)?.[id];
    });
    // No workspace has an explicit name: every workspace is addressed by its basename.
    mockGetRegisteredWorkspaces.mockImplementation(() =>
      [...mockGetWorkspaceTerminals().keys()].map((workspacePath) => ({ workspacePath, explicitName: null })),
    );
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe.each(BOTH)('a named architect in another workspace, against %s', (_where, resolve) => {
    it('is reached by an architect', () => {
      expect(resolve('codev-cloud:architect:tunnel', CODEV, 'architect:review')).toEqual({
        reached: 'tunnel',
        workspacePath: CLOUD,
      });
    });

    it('is reached by a sender that gives no id (a human at a shell)', () => {
      expect(resolve('codev-cloud:architect:tunnel', CODEV)).toEqual({ reached: 'tunnel', workspacePath: CLOUD });
    });

    it('is reached from outside any workspace', () => {
      expect(resolve('codev-cloud:architect:tunnel', undefined, 'architect')).toEqual({
        reached: 'tunnel',
        workspacePath: CLOUD,
      });
    });

    it('fails for an unknown name, naming the workspace, its architects and its front door', () => {
      const { error } = resolve('codev-cloud:architect:ghost', CODEV, 'architect:review');
      expect(error?.code).toBe('NOT_FOUND');
      expect(error?.message).toContain("Architect 'ghost'");
      expect(error?.message).toContain("workspace 'codev-cloud'");
      expect(error?.message).toContain('Architects there: main, review, tunnel.');
      expect(error?.message).toContain('Front door: codev-cloud:architect.');
    });

    it('fails for an unknown workspace, as an address to its front door does', () => {
      expect(resolve('nowhere:architect:tunnel', CODEV, 'architect:review').error?.code).toBe('NOT_FOUND');
    });
  });

  it('is held, not refused, when the architect is registered and has no live terminal', () => {
    // `tunnel` is between sessions: registered, no terminal.
    mockGetWorkspaceTerminals.mockReturnValue(new Map([
      [CODEV, entry(ARCHITECTS[CODEV])],
      [CLOUD, entry(['main', 'review'])],
    ]));
    const address = 'codev-cloud:architect:tunnel';
    // The live resolver says NOT_FOUND, which is what sends the route to the registry...
    expect(live(address, CODEV, 'architect:review').error?.code).toBe('NOT_FOUND');
    // ...and the registry knows the recipient, so the route holds the mail for it.
    expect(registry(address, CODEV, 'architect:review')).toEqual({ reached: 'tunnel', workspacePath: CLOUD });
  });

  it('says the unknown name the same way in the sender\'s own workspace, with the short front door', () => {
    const { error } = live('architect:ghost', CODEV, 'architect:main');
    expect(error?.code).toBe('NOT_FOUND');
    expect(error?.message).toBe(
      "Architect 'ghost' not found in workspace 'codev'. Architects there: main, review. Front door: architect.",
    );
  });

  describe.each(BOTH)('the builder rule, against %s', (_where, resolve) => {
    it('lets a builder name its own spawning architect, with or without its workspace in front', () => {
      expect(resolve('architect:review', CODEV, 'spir-100').reached).toBe('review');
      expect(resolve('codev:architect:review', CODEV, 'spir-100')).toEqual({ reached: 'review', workspacePath: CODEV });
    });

    it('refuses <own workspace>:architect:<other> with the Spec 755 message, unchanged', () => {
      for (const address of ['architect:main', 'codev:architect:main']) {
        expect(resolve(address, CODEV, 'spir-100').error).toEqual({
          code: 'NOT_FOUND',
          message: addressSpoofingErrorMessage('spir-100'),
        });
      }
    });

    it('refuses a named architect in another workspace, naming that workspace\'s front door', () => {
      const { error } = resolve('codev-cloud:architect:tunnel', CODEV, 'spir-100');
      expect(error).toEqual({
        code: 'REFUSED',
        message: crossWorkspaceBuilderErrorMessage('spir-100', 'codev-cloud:architect'),
      });
      expect(error?.message).toBe(
        'builder spir-100 may only address its own spawning architect; ' +
          'reach that workspace through its front door: afx send codev-cloud:architect "…"',
      );
    });

    it('refuses it even when that architect has the same name as the one that spawned the builder', () => {
      // spir-100 was spawned by codev's `review`. codev-cloud's `review` is someone else.
      expect(resolve('codev-cloud:architect:review', CODEV, 'spir-100').error?.code).toBe('REFUSED');
    });

    it('refuses before it looks the name up, so a builder cannot learn which architects exist', () => {
      const { error } = resolve('codev-cloud:architect:ghost', CODEV, 'spir-100');
      expect(error?.code).toBe('REFUSED');
      expect(error?.message).not.toContain('tunnel');
    });

    it('refuses a legacy builder, which has no spawning architect to name, in both places', () => {
      expect(resolve('architect:main', CODEV, 'legacy-1').error).toEqual({
        code: 'NOT_FOUND',
        message: addressSpoofingErrorMessage('legacy-1'),
      });
      expect(resolve('codev-cloud:architect:main', CODEV, 'legacy-1').error?.code).toBe('REFUSED');
    });

    it('asks who the sender is in the SENDER\'s workspace, not the target\'s', () => {
      resolve('codev-cloud:architect:tunnel', CODEV, 'spir-100');
      expect(mockLookupBuilderSpawningArchitect).toHaveBeenCalledTimes(1);
      expect(mockLookupBuilderSpawningArchitect).toHaveBeenCalledWith('spir-100', CODEV);
    });

    it('does not take a builder id that exists only in the TARGET workspace for a builder', () => {
      // An architect whose id happens to match a builder row in the workspace it writes to.
      SPAWNED_BY[CLOUD]['architect:review'] = 'main';
      try {
        expect(resolve('codev-cloud:architect:tunnel', CODEV, 'architect:review').reached).toBe('tunnel');
      } finally {
        delete SPAWNED_BY[CLOUD]['architect:review'];
      }
    });

    it('reaches another workspace\'s front door, as today', () => {
      expect(resolve('codev-cloud:architect', CODEV, 'spir-100')).toEqual({ reached: 'main', workspacePath: CLOUD });
    });
  });

  describe.each(BOTH)('affinity is for the sender\'s own workspace only, against %s', (_where, resolve) => {
    it('sends <other workspace>:architect from a builder to that workspace\'s main, not to a namesake of its architect', () => {
      // spir-100 was spawned by `review`, and codev-cloud has a `review` too.
      expect(resolve('codev-cloud:architect', CODEV, 'spir-100')).toEqual({ reached: 'main', workspacePath: CLOUD });
    });

    it('asks nothing about the sender to do so', () => {
      resolve('codev-cloud:architect', CODEV, 'spir-100');
      expect(mockLookupBuilderSpawningArchitect).not.toHaveBeenCalled();
    });

    it('keeps today\'s affinity for bare architect and for <own workspace>:architect', () => {
      expect(resolve('architect', CODEV, 'spir-100')).toEqual({ reached: 'review', workspacePath: CODEV });
      expect(resolve('codev:architect', CODEV, 'spir-100')).toEqual({ reached: 'review', workspacePath: CODEV });
    });

    it('gives the front door, main, to an architect and to a human', () => {
      expect(resolve('codev-cloud:architect', CODEV, 'architect:review').reached).toBe('main');
      expect(resolve('codev-cloud:architect', CODEV).reached).toBe('main');
    });

    it('gives the first registered when the other workspace has no main', () => {
      mockGetWorkspaceTerminals.mockReturnValue(new Map([
        [CODEV, entry(ARCHITECTS[CODEV])],
        [CLOUD, entry(['tunnel', 'review'])],
      ]));
      mockGetArchitects.mockImplementation((ws) => (ws === CLOUD ? [{ name: 'tunnel' }, { name: 'review' }] : []));
      mockGetArchitectByName.mockImplementation((ws, name) => (ws === CLOUD && name !== 'main' ? { name } : null));
      expect(resolve('codev-cloud:architect', CODEV, 'spir-100').reached).toBe('tunnel');
    });
  });

  // The route asks the registry whenever the live resolver says NOT_FOUND, and the Spec 755
  // refusals below are NOT_FOUND. A registry that answered them with "the first registered"
  // would hold a builder's mail for an architect it has nothing to do with.
  describe.each(BOTH)('a builder with no architect of its own, in a workspace with no main, against %s', (_where, resolve) => {
    beforeEach(() => {
      // codev has lost `main` and `review`; two unrelated architects remain.
      mockGetWorkspaceTerminals.mockReturnValue(new Map([[CODEV, entry(['alpha', 'beta'], ['spir-100', 'legacy-1'])]]));
      mockGetArchitects.mockImplementation((ws) => (ws === CODEV ? [{ name: 'alpha' }, { name: 'beta' }] : []));
      mockGetArchitectByName.mockImplementation((ws, name) => (ws === CODEV && ['alpha', 'beta'].includes(name) ? { name } : null));
    });

    it('refuses bare architect from a builder whose architect has gone, with the Spec 755 message', () => {
      for (const address of ['architect', 'codev:architect']) {
        expect(resolve(address, CODEV, 'spir-100')).toEqual({
          reached: null,
          error: { code: 'NOT_FOUND', message: architectGoneErrorMessage('spir-100', 'review', ['alpha', 'beta']) },
        });
      }
    });

    it('refuses bare architect from a legacy builder, with the Spec 755 message', () => {
      expect(resolve('architect', CODEV, 'legacy-1')).toEqual({
        reached: null,
        error: { code: 'NOT_FOUND', message: legacyBuilderErrorMessage('legacy-1', ['alpha', 'beta']) },
      });
    });

    it('still gives the first registered to a sender that is not a builder, and to one from another workspace', () => {
      expect(resolve('architect', CODEV, 'architect:alpha').reached).toBe('alpha');
      expect(resolve('architect', CODEV).reached).toBe('alpha');
      expect(resolve('codev:architect', CLOUD, 'architect:tunnel').reached).toBe('alpha');
    });
  });

  describe.each(BOTH)('a builder whose architect has gone, in a workspace that has a main, against %s', (_where, resolve) => {
    it('reaches main', () => {
      mockGetWorkspaceTerminals.mockReturnValue(new Map([[CODEV, entry(['main', 'beta'], ['spir-100', 'legacy-1'])]]));
      mockGetArchitects.mockImplementation((ws) => (ws === CODEV ? [{ name: 'beta' }, { name: 'main' }] : []));
      mockGetArchitectByName.mockImplementation((ws, name) => (ws === CODEV && ['main', 'beta'].includes(name) ? { name } : null));
      expect(resolve('architect', CODEV, 'spir-100').reached).toBe('main');
      expect(resolve('architect', CODEV, 'legacy-1').reached).toBe('main');
    });
  });

  describe('the issue #1094 warning ("affinity routing bypassed")', () => {
    it('no longer fires for a builder writing to another workspace\'s front door', () => {
      expect(live('codev-cloud:architect', CODEV, 'spir-100').reached).toBe('main');
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not fire there for a sender that looks like a builder and has no row either', () => {
      expect(live('codev-cloud:architect', CODEV, 'bugfix-2461').reached).toBe('main');
      expect(warn).not.toHaveBeenCalled();
    });

    it('still fires for a sender that looks like a builder and has no row in its own workspace', () => {
      expect(live('architect', CODEV, 'bugfix-2461').reached).toBe('main');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('affinity routing bypassed');
      expect(warn.mock.calls[0][0]).toContain("'bugfix-2461'");
    });

    it('still fires when that sender writes its own workspace in front', () => {
      live('codev:architect', CODEV, 'bugfix-2461');
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('malformed shapes fail with the shape that was expected', () => {
    it('a Tower written as a second workspace', () => {
      const { error } = live('devvm:codev:architect', CODEV, 'architect:main');
      expect(error?.code).toBe('MALFORMED_ADDRESS');
      expect(error?.message).toContain('a local address has at most a workspace before `architect`');
      expect(error?.message).toContain('Expected [<workspace>:]architect[:<name>]');
    });

    it.each([
      ['two parts after architect', 'codev:architect:a:b'],
      ['three plain parts', 'a:b:c'],
      ['an empty part', 'codev::architect'],
      ['a leading colon', ':architect'],
    ])('%s', (_note, address) => {
      expect(live(address, CODEV, 'architect:main').error?.code).toBe('MALFORMED_ADDRESS');
    });

    it('resolves nothing and asks nothing for a malformed address', () => {
      live('a:b:c', CODEV, 'spir-100');
      expect(mockGetWorkspaceTerminals).not.toHaveBeenCalled();
      expect(mockLookupBuilderSpawningArchitect).not.toHaveBeenCalled();
    });
  });

  describe.each(BOTH)('an afx:// address, against %s', (_where, resolve) => {
    it.each([
      'afx://devvm/codev:architect',
      'afx://devvm/codev:architect:local',
      'afx://devvm/codev:builder-spir-1940',
      'afx://sam@studio/codev-cloud:architect:data',
      // Even one that might be this Tower: until stage 2 a Tower does not know its own name.
      'afx://mbp/codev:architect',
    ])('%s is refused as cross-Tower messaging not available', (address) => {
      expect(resolve(address, CODEV, 'architect:main').error).toEqual({
        code: 'CROSS_TOWER_UNAVAILABLE',
        message: CROSS_TOWER_UNAVAILABLE_MESSAGE,
      });
    });

    it('is refused before anything is looked up', () => {
      resolve('afx://devvm/codev:architect:local', CODEV, 'spir-100');
      expect(mockGetWorkspaceTerminals).not.toHaveBeenCalled();
      expect(mockLookupBuilderSpawningArchitect).not.toHaveBeenCalled();
    });

    it.each([
      ['no workspace', 'afx://devvm/architect'],
      ['nothing after the Tower', 'afx://devvm'],
      ['a port', 'afx://devvm:4100/codev:architect'],
      ['a reserved word as the workspace', 'afx://devvm/builder:architect'],
      ['a mistyped scheme', 'afx:/devvm/codev:architect'],
    ])('a malformed one (%s) fails as malformed, not as unavailable', (_note, address) => {
      const { error } = resolve(address, CODEV, 'architect:main');
      expect(error?.code).toBe('MALFORMED_ADDRESS');
      expect(error?.message).toContain('Expected afx://');
    });
  });

  describe('reserved words do not change what resolves today', () => {
    const ARCH = '/home/user/arch';
    const BUILDER = '/home/user/builder';

    beforeEach(() => {
      mockGetWorkspaceTerminals.mockReturnValue(new Map([
        [CODEV, entry(['main'])],
        [ARCH, { ...entry(['main']), builders: new Map([['review', 'term-agent-review']]) }],
        [BUILDER, entry(['main', 'other'])],
      ]));
    });

    it('arch:review reaches the agent `review` in a workspace whose basename is `arch`', () => {
      const address = parseTarget('arch:review');
      if (isResolveError(address)) throw new Error(address.message);
      expect(resolveTarget(address, { id: 'architect:main', workspace: CODEV })).toEqual({
        terminalId: 'term-agent-review',
        workspacePath: ARCH,
        agent: 'review',
      });
    });

    it('builder:architect reaches the front door of a workspace whose basename is `builder`', () => {
      expect(live('builder:architect', CODEV, 'architect:main')).toEqual({ reached: 'main', workspacePath: BUILDER });
    });
  });

  describe('shell ids resolve as today', () => {
    it('alone, in the sender\'s workspace', () => {
      expect(live('shell-1', CODEV, 'architect:main')).toEqual({ reached: 'shell-1', workspacePath: CODEV });
    });

    it('as <workspace>:<shell-id>', () => {
      expect(live('codev-cloud:shell-7', CODEV, 'architect:main')).toEqual({ reached: 'shell-7', workspacePath: CLOUD });
    });

    it('and are not in the registry, so a shell with no terminal is not found', () => {
      expect(registry('codev-cloud:shell-7', CODEV, 'architect:main').error?.code).toBe('NOT_FOUND');
    });
  });

  describe('a same-workspace send runs no database query it did not run before', () => {
    /** Every read of the registry the live resolver could make. */
    function queries() {
      return {
        lookup: mockLookupBuilderSpawningArchitect.mock.calls,
        builders: mockGetBuilders.mock.calls.length,
        architects: mockGetArchitects.mock.calls.length,
        architectByName: mockGetArchitectByName.mock.calls.length,
        // Phase 3: the workspace name table, read only for an address that names a workspace.
        names: mockGetRegisteredWorkspaces.mock.calls.length,
      };
    }
    const NONE = { lookup: [], builders: 0, architects: 0, architectByName: 0, names: 0 };

    it('bare architect in a workspace whose only architect is main: none', () => {
      mockGetWorkspaceTerminals.mockReturnValue(new Map([[CODEV, entry(['main'], ['spir-100'])]]));
      expect(live('architect', CODEV, 'spir-100').reached).toBe('main');
      expect(queries()).toEqual(NONE);
    });

    it('bare architect with several architects: the one builder lookup, in the sender\'s workspace', () => {
      expect(live('architect', CODEV, 'spir-100').reached).toBe('review');
      expect(queries()).toEqual({ ...NONE, lookup: [['spir-100', CODEV]] });
    });

    it('architect:<name>: the one builder lookup', () => {
      expect(live('architect:review', CODEV, 'spir-100').reached).toBe('review');
      expect(queries()).toEqual({ ...NONE, lookup: [['spir-100', CODEV]] });
    });

    it('architect:<name> that does not exist: the one builder lookup, and the hint costs none', () => {
      expect(live('architect:ghost', CODEV, 'architect:main').error?.code).toBe('NOT_FOUND');
      expect(queries()).toEqual({ ...NONE, lookup: [['architect:main', CODEV]] });
    });

    it('a builder id, a tail of one, and a shell id: none', () => {
      expect(live('spir-100', CODEV, 'architect:main').reached).toBe('spir-100');
      expect(live('100', CODEV, 'architect:main').reached).toBe('spir-100');
      expect(live('shell-1', CODEV, 'architect:main').reached).toBe('shell-1');
      expect(queries()).toEqual(NONE);
    });

    it('a sender with no id: none, whatever it addresses', () => {
      expect(live('architect', CODEV).reached).toBe('main');
      expect(live('architect:review', CODEV).reached).toBe('review');
      expect(queries()).toEqual(NONE);
    });

    it('the registry resolver reads no name table either for an address that names no workspace', () => {
      expect(registry('architect', CODEV, 'architect:main').reached).toBe('main');
      expect(registry('architect:review', CODEV).reached).toBe('review');
      expect(registry('spir-100', CODEV).reached).toBe('spir-100');
      expect(queries().names).toBe(0);
    });

    it('an address that names a workspace reads the name table once', () => {
      expect(live('codev-cloud:architect', CODEV, 'architect:main').reached).toBe('main');
      expect(queries().names).toBe(1);
      expect(live('codev:architect', CODEV, 'architect:main').reached).toBe('main');
      expect(queries().names).toBe(2);
    });
  });

  describe('a sender with no workspace', () => {
    it('is still held to the builder rule when its id is a builder\'s: leaving the workspace out opens nothing', () => {
      expect(live('codev-cloud:architect:tunnel', undefined, 'spir-100').error?.code).toBe('REFUSED');
      expect(registry('codev-cloud:architect:tunnel', undefined, 'spir-100').error?.code).toBe('REFUSED');
      expect(mockLookupBuilderSpawningArchitect).toHaveBeenCalledWith('spir-100', undefined);
    });

    it('may name an architect anywhere when it is not a builder', () => {
      expect(live('codev-cloud:architect:tunnel', undefined, 'architect').reached).toBe('tunnel');
    });

    it('still cannot use an address that names no workspace', () => {
      expect(live('architect:review', undefined, 'architect').error?.code).toBe('NO_CONTEXT');
      expect(live('architect', undefined, 'architect').error?.code).toBe('NO_CONTEXT');
      expect(registry('builder-spir-1', undefined, 'architect').error?.code).toBe('NO_CONTEXT');
    });
  });
});

describe('Spec 1940 phase 3 — explicit workspace names, in both resolvers', () => {
  // Two workspaces whose directories are both called `codev`, and a third.
  const WORK = '/home/user/work/codev';
  const NOTES = '/home/user/My Notes';
  /** Explicit names, by workspace path. A test sets the ones it wants. */
  let names: Record<string, string>;
  /** Registered workspaces that are not running. */
  let stopped: string[];

  function running(...paths: string[]): void {
    mockGetWorkspaceTerminals.mockReturnValue(new Map(paths.map((p) => [p, entry(['main', 'review'], [], ['shell-1'])])));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    names = {};
    stopped = [];
    running(CODEV, WORK, CLOUD);
    mockGetRegisteredWorkspaces.mockImplementation(() =>
      [...mockGetWorkspaceTerminals().keys(), ...stopped].map((workspacePath) => ({
        workspacePath,
        explicitName: names[workspacePath] ?? null,
      })),
    );
    mockGetArchitects.mockImplementation(() => [{ name: 'main' }, { name: 'review' }]);
    mockGetArchitectByName.mockImplementation((_ws, name) => (['main', 'review'].includes(name) ? { name } : null));
    mockGetBuilders.mockReturnValue([]);
    mockLookupBuilderSpawningArchitect.mockReturnValue(undefined);
  });

  describe.each(BOTH)('against %s', (_where, resolve) => {
    it('two workspaces that share a basename: the address fails, listing both paths and the command', () => {
      const { error } = resolve('codev:architect', CLOUD, 'architect:main');
      expect(error?.code).toBe('AMBIGUOUS');
      expect(error?.message).toContain(CODEV);
      expect(error?.message).toContain(WORK);
      expect(error?.message).toContain('afx workspace name <name>');
    });

    it('an error about a named workspace calls it what the sender wrote, not its directory', () => {
      names[WORK] = 'work';
      for (const to of ['work:architect:ghost', 'work:spir-404']) {
        const { error } = resolve(to, CLOUD, 'architect:main');
        expect(error?.code).toBe('NOT_FOUND');
        expect(error?.message).toContain("workspace 'work'");
        expect(error?.message).not.toContain("workspace 'codev'");
      }
    });

    it('after one is named, both resolve', () => {
      names[WORK] = 'work';
      expect(resolve('codev:architect', CLOUD, 'architect:main')).toEqual({ reached: 'main', workspacePath: CODEV });
      expect(resolve('work:architect', CLOUD, 'architect:main')).toEqual({ reached: 'main', workspacePath: WORK });
      expect(resolve('work:architect:review', CLOUD, 'architect:main')).toEqual({ reached: 'review', workspacePath: WORK });
    });

    it('an address is matched lower-cased, however the sender typed it', () => {
      names[WORK] = 'work';
      expect(resolve('Work:architect', CLOUD, 'architect:main')).toEqual({ reached: 'main', workspacePath: WORK });
    });

    it('a named workspace no longer answers to its basename, and the error says what it is called', () => {
      names[CLOUD] = 'cloud';
      const { error } = resolve('codev-cloud:architect', CODEV, 'architect:main');
      expect(error?.code).toBe('NOT_FOUND');
      expect(error?.message).toContain("addressed as 'cloud'");
      expect(resolve('cloud:architect', CODEV, 'architect:main')).toEqual({ reached: 'main', workspacePath: CLOUD });
    });

    it('a workspace whose basename equals an existing explicit name does not take the name', () => {
      // CLOUD holds the name `codev`. Only one `codev` directory is running here.
      running(CODEV, CLOUD);
      names[CLOUD] = 'codev';
      expect(resolve('codev:architect', CODEV, 'architect:main')).toEqual({ reached: 'main', workspacePath: CLOUD });
    });

    it('an explicit name whose workspace is not running fails saying so, and is never delivered to a basename match', () => {
      running(CODEV);
      stopped = [CLOUD];
      names[CLOUD] = 'codev';
      const { error, reached } = resolve('codev:architect', CODEV, 'architect:main');
      expect(reached).toBeNull();
      expect(error?.code).toBe('NOT_FOUND');
      expect(error?.message).toContain(`Workspace 'codev' (${CLOUD}) is not running.`);
      // The running workspace with that basename is told it needs a name of its own.
      expect(error?.message).toContain(CODEV);
      expect(error?.message).toContain('a name of its own');
    });

    it('a registered workspace that is not running is reported as not running', () => {
      running(CODEV);
      stopped = [CLOUD];
      const { error } = resolve('codev-cloud:architect', CODEV, 'architect:main');
      expect(error?.code).toBe('NOT_FOUND');
      expect(error?.message).toBe(`Workspace 'codev-cloud' (${CLOUD}) is not running.`);
    });

    it('changing a name takes effect on the next address: the old name stops resolving', () => {
      names[WORK] = 'work';
      expect(resolve('work:architect', CLOUD).reached).toBe('main');
      names[WORK] = 'office';
      expect(resolve('work:architect', CLOUD).error?.code).toBe('NOT_FOUND');
      expect(resolve('office:architect', CLOUD)).toEqual({ reached: 'main', workspacePath: WORK });
    });

    it('clearing a name brings the basename back, and with it the ambiguity', () => {
      names[WORK] = 'work';
      expect(resolve('codev:architect', CLOUD).workspacePath).toBe(CODEV);
      delete names[WORK];
      expect(resolve('work:architect', CLOUD).error?.code).toBe('NOT_FOUND');
      expect(resolve('codev:architect', CLOUD).error?.code).toBe('AMBIGUOUS');
    });

    it('a workspace whose basename has a space is still reached by its local address', () => {
      running(CODEV, NOTES);
      expect(resolve('my notes:architect', CODEV, 'architect:main')).toEqual({ reached: 'main', workspacePath: NOTES });
    });

    it('a sender writing its own workspace by its explicit name is in its own workspace', () => {
      // Affinity and the Spec 755 wording depend on this: a builder may name its own
      // spawning architect with its workspace's explicit name in front.
      names[WORK] = 'work';
      mockLookupBuilderSpawningArchitect.mockImplementation((id, ws) =>
        id === 'spir-7' && (ws === undefined || ws === WORK) ? 'review' : undefined,
      );
      mockGetBuilders.mockImplementation((ws) => (ws === WORK ? [{ id: 'spir-7' } as unknown as Builder] : []));
      expect(resolve('work:architect:review', WORK, 'spir-7')).toEqual({ reached: 'review', workspacePath: WORK });
      expect(resolve('work:architect', WORK, 'spir-7')).toEqual({ reached: 'review', workspacePath: WORK });
      // ...and naming another architect there is still the Spec 755 refusal, unchanged.
      expect(resolve('work:architect:main', WORK, 'spir-7').error).toEqual({
        code: 'NOT_FOUND',
        message: addressSpoofingErrorMessage('spir-7'),
      });
    });

    it('the builder rule names the front door by the name the sender wrote', () => {
      names[WORK] = 'work';
      mockLookupBuilderSpawningArchitect.mockImplementation((id, ws) =>
        id === 'spir-100' && (ws === undefined || ws === CODEV) ? 'review' : undefined,
      );
      const { error } = resolve('work:architect:review', CODEV, 'spir-100');
      expect(error).toEqual({
        code: 'REFUSED',
        message: crossWorkspaceBuilderErrorMessage('spir-100', 'work:architect'),
      });
    });
  });

  it('a shell in a named workspace is reached as <name>:<shell-id>', () => {
    names[WORK] = 'work';
    expect(live('work:shell-1', CLOUD, 'architect:main')).toEqual({ reached: 'shell-1', workspacePath: WORK });
  });
});
