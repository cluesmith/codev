/**
 * Spec 1940, phase 5 — the address book (`GET /api/address-book`, `afx workspace list`).
 *
 * The promise under test is that the listing is true for whoever asks: an address marked
 * sendable reaches the agent it is printed beside when THAT caller sends to it, and one
 * that is not is refused. So every case is checked twice: against the table written here,
 * and by feeding each address back through the real resolvers as the caller.
 *
 * Three workspaces on one Tower, with a fake terminal map and a fake registry:
 *   codev        main, review              builder-spir-12 (spawned by review)
 *   codev-cloud  main, review, tunnel      builder-spir-7 (spawned by review), shell-7
 *                tunnel is registered and has no terminal
 *   scratch      registered, not running
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AddressBookAgent, AddressBookWorkspace } from '@cluesmith/codev-types';
import type { WorkspaceTerminals } from '../servers/tower-types.js';
import type { Builder } from '../types.js';

const {
  mockGetWorkspaceTerminals,
  mockGetSession,
  mockGetBuilders,
  mockGetArchitects,
  mockGetArchitectByName,
  mockLookupBuilderSpawningArchitect,
  mockGetRegisteredWorkspaces,
} = vi.hoisted(() => ({
  mockGetWorkspaceTerminals: vi.fn<() => Map<string, WorkspaceTerminals>>(),
  mockGetSession: vi.fn<(id: string) => { writable: boolean } | undefined>(),
  mockGetBuilders: vi.fn<(ws?: string) => Builder[]>(),
  mockGetArchitects: vi.fn<(ws: string) => Array<{ name: string }>>(),
  mockGetArchitectByName: vi.fn<(ws: string, name: string) => { name: string } | null>(),
  mockLookupBuilderSpawningArchitect: vi.fn<(id: string, ws?: string) => string | null | undefined>(),
  mockGetRegisteredWorkspaces: vi.fn<() => Array<{ workspacePath: string; explicitName: string | null }>>(),
}));

vi.mock('../servers/tower-terminals.js', () => ({
  getWorkspaceTerminals: () => mockGetWorkspaceTerminals(),
  getTerminalManager: () => ({ getSession: (id: string) => mockGetSession(id) }),
}));

vi.mock('../state.js', () => ({
  getBuilders: (ws?: string) => mockGetBuilders(ws),
  getArchitects: (ws: string) => mockGetArchitects(ws),
  getArchitectByName: (ws: string, name: string) => mockGetArchitectByName(ws, name),
  lookupBuilderSpawningArchitect: (id: string, ws?: string) => mockLookupBuilderSpawningArchitect(id, ws),
  getRegisteredWorkspaces: () => mockGetRegisteredWorkspaces(),
}));

import { addressBook } from '../servers/tower-address-book.js';
import {
  parseTarget,
  resolveTarget,
  resolveAgentInRegistry,
  isResolveError,
  type SenderContext,
} from '../servers/tower-messages.js';

const CODEV = '/home/user/codev';
const CLOUD = '/home/user/codev-cloud';
const SCRATCH = '/home/user/scratch';

/** The registry and the terminal map. Each test may change them; `beforeEach` puts them back. */
let architects: Record<string, string[]>;
let spawnedBy: Record<string, Record<string, string | null>>;
let explicitNames: Record<string, string>;
let stopped: string[];
let terminals: Map<string, WorkspaceTerminals>;
/** Terminal ids that are on the map and whose terminal has exited. */
let exited: Set<string>;
/** Terminal ids whose session is still there and takes no input: its process connection is down. */
let disconnected: Set<string>;

function entry(architectNames: string[], builders: string[] = [], shells: string[] = []): WorkspaceTerminals {
  return {
    architects: new Map(architectNames.map((name) => [name, `term-${name}`])),
    builders: new Map(builders.map((id) => [id, `term-${id}`])),
    shells: new Map(shells.map((id) => [id, `term-${id}`])),
    fileTabs: new Map(),
  };
}

const ARCHITECT: SenderContext = { id: 'architect:main', workspace: CODEV };
const BUILDER: SenderContext = { id: 'builder-spir-12', workspace: CODEV };

const workspaceAt = (path: string, caller: SenderContext = ARCHITECT): AddressBookWorkspace =>
  addressBook(caller).workspaces.find((w) => w.path === path)!;

/** One agent's line, as a short string a table can be compared against. */
function line(agent: AddressBookAgent): string {
  const liveness = agent.live ? 'live' : 'no terminal';
  let outcome = 'sendable';
  if (!agent.sendable) outcome = agent.reachThrough === undefined ? 'not sendable' : `through ${agent.reachThrough}`;
  return `${agent.address ?? `<no address: ${agent.kind} ${agent.name}>`} | ${liveness} | ${outcome}`;
}

const linesOf = (path: string, caller: SenderContext = ARCHITECT) => workspaceAt(path, caller).agents.map(line);

/** Send to `text` as `caller`, as the route does: live terminals, then the registry. */
function sendAs(caller: SenderContext, text: string): { workspacePath: string; reached: string } | { refused: string } {
  const address = parseTarget(text);
  if (isResolveError(address)) return { refused: address.code };
  const live = resolveTarget(address, caller);
  if (!isResolveError(live)) return { workspacePath: live.workspacePath, reached: live.terminalId.replace(/^term-/, '') };
  if (live.code !== 'NOT_FOUND') return { refused: live.code };
  const held = resolveAgentInRegistry(address, caller);
  return isResolveError(held) ? { refused: held.code } : { workspacePath: held.workspacePath, reached: held.agent };
}

beforeEach(() => {
  vi.clearAllMocks();
  architects = { [CODEV]: ['main', 'review'], [CLOUD]: ['main', 'review', 'tunnel'] };
  spawnedBy = { [CODEV]: { 'builder-spir-12': 'review' }, [CLOUD]: { 'builder-spir-7': 'review' } };
  explicitNames = {};
  stopped = [SCRATCH];
  exited = new Set();
  disconnected = new Set();
  terminals = new Map([
    [CODEV, entry(['main', 'review'], ['builder-spir-12'])],
    [CLOUD, entry(['main', 'review'], ['builder-spir-7'], ['shell-7'])],
  ]);
  mockGetWorkspaceTerminals.mockImplementation(() => terminals);
  mockGetSession.mockImplementation((id) => (exited.has(id) ? undefined : { writable: !disconnected.has(id) }));
  mockGetArchitects.mockImplementation((ws) => (architects[ws] ?? []).map((name) => ({ name })));
  mockGetArchitectByName.mockImplementation((ws, name) => ((architects[ws] ?? []).includes(name) ? { name } : null));
  mockGetBuilders.mockImplementation((ws) => Object.keys(spawnedBy[ws ?? ''] ?? {}).map((id) => ({ id }) as unknown as Builder));
  mockLookupBuilderSpawningArchitect.mockImplementation((id, ws) => {
    const scopes = ws === undefined ? Object.values(spawnedBy) : [spawnedBy[ws] ?? {}];
    return scopes.find((rows) => id in rows)?.[id];
  });
  mockGetRegisteredWorkspaces.mockImplementation(() =>
    [...new Set([...terminals.keys(), ...stopped, ...Object.keys(explicitNames)])].map((workspacePath) => ({
      workspacePath,
      explicitName: explicitNames[workspacePath] ?? null,
    })),
  );
});

describe('Spec 1940 phase 5 — the address book', () => {
  describe('as an architect', () => {
    it('lists every workspace: the running ones with their agents, then the ones that are not running', () => {
      expect(addressBook(ARCHITECT).workspaces.map((w) => [w.path, w.addressName, w.running])).toEqual([
        [CODEV, 'codev', true],
        [CLOUD, 'codev-cloud', true],
        [SCRATCH, 'scratch', false],
      ]);
      expect(workspaceAt(SCRATCH).agents).toEqual([]);
    });

    it('gives every agent as an address ready to paste, with whether it has a live terminal', () => {
      expect(linesOf(CODEV)).toEqual([
        'codev:architect:main | live | sendable',
        'codev:architect:review | live | sendable',
        'codev:builder-spir-12 | live | sendable',
      ]);
      expect(linesOf(CLOUD)).toEqual([
        'codev-cloud:architect:main | live | sendable',
        'codev-cloud:architect:review | live | sendable',
        'codev-cloud:architect:tunnel | no terminal | sendable',
        'codev-cloud:builder-spir-7 | live | sendable',
        'codev-cloud:shell-7 | live | sendable',
      ]);
    });

    it('says which kind each agent is, and its name', () => {
      expect(workspaceAt(CLOUD).agents.map((a) => `${a.kind} ${a.name}`)).toEqual([
        'architect main',
        'architect review',
        'architect tunnel',
        'builder builder-spir-7',
        'shell shell-7',
      ]);
    });
  });

  describe('as a builder', () => {
    it('marks the architects it may not name, with the way to reach each, and hides nothing', () => {
      expect(linesOf(CODEV, BUILDER)).toEqual([
        // Its own workspace: only the architect that spawned it. Another is reached through it.
        'codev:architect:main | live | through architect',
        'codev:architect:review | live | sendable',
        'codev:builder-spir-12 | live | sendable',
      ]);
      expect(linesOf(CLOUD, BUILDER)).toEqual([
        // Another workspace: no architect by name, whatever it is called; the front door is the way in.
        'codev-cloud:architect:main | live | through codev-cloud:architect',
        'codev-cloud:architect:review | live | through codev-cloud:architect',
        'codev-cloud:architect:tunnel | no terminal | through codev-cloud:architect',
        'codev-cloud:builder-spir-7 | live | sendable',
        'codev-cloud:shell-7 | live | sendable',
      ]);
    });

    it('offers no way in when that way reaches nobody: its own architect is gone and there is no main', () => {
      architects[CODEV] = ['other'];
      terminals.set(CODEV, entry(['other'], ['builder-spir-12']));
      expect(linesOf(CODEV, BUILDER)).toContain('codev:architect:other | live | not sendable');
      expect(sendAs(BUILDER, 'architect')).toEqual({ refused: 'NOT_FOUND' });
    });
  });

  describe.each([
    ['an architect', ARCHITECT],
    ['a named architect in the other workspace', { id: 'architect:tunnel', workspace: CLOUD }],
    ['a builder', BUILDER],
    ['a builder in the other workspace', { id: 'builder-spir-7', workspace: CLOUD }],
    ['a shell', { id: 'shell-7', workspace: CLOUD }],
    ['a caller outside every workspace', {}],
  ] as Array<[string, SenderContext]>)('fed back through the resolver as %s', (_who, caller) => {
    it('every address marked sendable reaches the agent it was printed for', () => {
      let checked = 0;
      for (const workspace of addressBook(caller).workspaces) {
        for (const agent of workspace.agents.filter((a) => a.sendable)) {
          expect(sendAs(caller, agent.address!), agent.address!).toEqual({ workspacePath: workspace.path, reached: agent.name });
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
    });

    it('every address not marked sendable is refused, and its way in is accepted', () => {
      for (const workspace of addressBook(caller).workspaces) {
        for (const agent of workspace.agents.filter((a) => !a.sendable)) {
          expect(sendAs(caller, agent.address!), agent.address!).toHaveProperty('refused');
          expect(sendAs(caller, agent.reachThrough!), agent.reachThrough!).toHaveProperty('reached');
        }
      }
    });
  });

  it('refuses nothing to a caller that is not a builder', () => {
    for (const caller of [ARCHITECT, { id: 'shell-7', workspace: CLOUD }, {}] as SenderContext[]) {
      const agents = addressBook(caller).workspaces.flatMap((w) => w.agents);
      expect(agents.filter((a) => !a.sendable)).toEqual([]);
    }
  });

  describe('a live terminal', () => {
    it('is one that is on the terminal map and still has a session', () => {
      exited.add('term-review');
      const review = workspaceAt(CODEV).agents.find((a) => a.name === 'review')!;
      // Mail to it is held, as for an agent with no entry: the address still reaches it.
      expect(review).toMatchObject({ live: false, sendable: true });
    });

    it('is one that takes input: a session whose process connection is down is not live', () => {
      // The send route holds mail for it as `no-live-pty`; the listing must not call it live.
      disconnected.add('term-builder-spir-7');
      const builder = workspaceAt(CLOUD).agents.find((a) => a.name === 'builder-spir-7')!;
      expect(builder).toMatchObject({ live: false, sendable: true });
    });

    it('a registered builder with no terminal is listed, and its mail would be held for it', () => {
      spawnedBy[CLOUD]['builder-air-9'] = 'main';
      expect(linesOf(CLOUD)).toContain('codev-cloud:builder-air-9 | no terminal | sendable');
      expect(sendAs(ARCHITECT, 'codev-cloud:builder-air-9')).toEqual({ workspacePath: CLOUD, reached: 'builder-air-9' });
    });

    it('an architect with a terminal and no registry row is listed once', () => {
      terminals.set(CLOUD, entry(['main', 'review', 'guest']));
      expect(workspaceAt(CLOUD).agents.filter((a) => a.kind === 'architect').map((a) => a.name)).toEqual([
        'main',
        'review',
        'tunnel',
        'guest',
      ]);
    });
  });

  describe('a workspace with no usable name', () => {
    const OTHER = '/home/user/work/codev';

    beforeEach(() => {
      architects[OTHER] = ['main'];
      terminals.set(OTHER, entry(['main']));
    });

    it('two workspaces that share a directory name both say so, with the command that fixes it', () => {
      for (const path of [CODEV, OTHER]) {
        const workspace = workspaceAt(path);
        expect(workspace.addressName).toBeNull();
        expect(workspace.unaddressableReason).toContain('shares the directory name');
        expect(workspace.unaddressableReason).toContain('afx workspace name <name>');
      }
    });

    it('gives the caller its own workspace\'s agents in the short form, which still reaches them', () => {
      expect(linesOf(CODEV)).toEqual([
        'architect:main | live | sendable',
        'architect:review | live | sendable',
        'builder-spir-12 | live | sendable',
      ]);
      expect(sendAs(ARCHITECT, 'architect:review')).toEqual({ workspacePath: CODEV, reached: 'review' });
      // The builder's rule holds in the short form too.
      expect(linesOf(CODEV, BUILDER)[0]).toBe('architect:main | live | through architect');
    });

    it('gives no address for the agents of the other one: nothing reaches them from outside', () => {
      expect(linesOf(OTHER)).toEqual(['<no address: architect main> | live | not sendable']);
      expect(sendAs(ARCHITECT, 'codev:architect:main')).toEqual({ refused: 'AMBIGUOUS' });
    });

    it('once one is named, both have addresses again', () => {
      explicitNames[OTHER] = 'work';
      expect(linesOf(OTHER)).toEqual(['work:architect:main | live | sendable']);
      expect(linesOf(CODEV)[0]).toBe('codev:architect:main | live | sendable');
    });

    it('a workspace whose directory name is another\'s explicit name says it needs one of its own', () => {
      explicitNames[OTHER] = 'work';
      explicitNames[CLOUD] = 'codev';
      const shadowed = workspaceAt(CODEV, { id: 'architect:main', workspace: CLOUD });
      expect(shadowed.addressName).toBeNull();
      expect(shadowed.unaddressableReason).toContain(`is the name of the workspace ${CLOUD}`);
      expect(shadowed.unaddressableReason).toContain('afx workspace name <name>');
      expect(shadowed.agents.every((a) => a.address === null && !a.sendable)).toBe(true);
    });

    it('a directory name that cannot be written in an address is not printed as one', () => {
      const NOTES = '/home/user/My Notes';
      architects[NOTES] = ['main'];
      terminals.set(NOTES, entry(['main']));
      const notes = workspaceAt(NOTES);
      expect(notes.addressName).toBeNull();
      expect(notes.unaddressableReason).toContain('cannot be written in an address');
      expect(notes.agents.map(line)).toEqual(['<no address: architect main> | live | not sendable']);
    });
  });

  it('uses an explicit name in every address of that workspace', () => {
    explicitNames[CLOUD] = 'cloud';
    expect(workspaceAt(CLOUD).addressName).toBe('cloud');
    expect(linesOf(CLOUD)[2]).toBe('cloud:architect:tunnel | no terminal | sendable');
    expect(linesOf(CLOUD, BUILDER)[0]).toBe('cloud:architect:main | live | through cloud:architect');
  });

  describe('an address is never marked sendable when it would reach another agent', () => {
    it('a shell whose id is the tail of a builder\'s id', () => {
      // `codev-cloud:spir-7` is read as a builder id first, and matches builder-spir-7 by its tail.
      terminals.set(CLOUD, entry(['main', 'review'], ['builder-spir-7'], ['spir-7']));
      expect(sendAs(ARCHITECT, 'codev-cloud:spir-7')).toEqual({ workspacePath: CLOUD, reached: 'builder-spir-7' });
      expect(linesOf(CLOUD)).toContain('codev-cloud:spir-7 | live | not sendable');
    });

    it('two registered builders whose ids differ only in letter case: the address is one agent\'s, not both', () => {
      // An address is lower-cased, and the registry answers it with the first id that matches.
      spawnedBy[CLOUD] = { 'Builder-Air-9': 'main', 'builder-air-9': 'main' };
      terminals.set(CLOUD, entry(['main', 'review']));
      expect(sendAs(ARCHITECT, 'codev-cloud:builder-air-9')).toEqual({ workspacePath: CLOUD, reached: 'Builder-Air-9' });
      expect(linesOf(CLOUD).filter((l) => l.includes('air-9'))).toEqual([
        'codev-cloud:builder-air-9 | no terminal | sendable',
        'codev-cloud:builder-air-9 | no terminal | not sendable',
      ]);
    });

    it('a name that changes hands while the listing is built: the old holder\'s lines are not marked sendable', () => {
      // The listing reads the name table once; each address is then resolved against the
      // table as it is at that moment. Here `cloud` moves to codev between the two.
      explicitNames[CLOUD] = 'cloud';
      const before = mockGetRegisteredWorkspaces.getMockImplementation()!;
      mockGetRegisteredWorkspaces.mockImplementationOnce(before).mockImplementation(() => [
        { workspacePath: CODEV, explicitName: 'cloud' },
        { workspacePath: CLOUD, explicitName: null },
      ]);
      const listed = workspaceAt(CLOUD);
      // `cloud:architect:main` now reaches codev's `main`, which is not the agent on this line.
      expect(listed.agents.map(line)).toContain('cloud:architect:main | live | not sendable');
      expect(listed.agents.some((a) => a.sendable)).toBe(false);
    });

    it('a builder in a directory called `architect`: its address would read as a named architect', () => {
      const ARCH = '/home/user/architect';
      architects[ARCH] = ['main'];
      spawnedBy[ARCH] = { 'builder-spir-3': 'main' };
      terminals.set(ARCH, entry(['main'], ['builder-spir-3']));
      const builder = workspaceAt(ARCH).agents.find((a) => a.kind === 'builder')!;
      expect(builder).toMatchObject({ address: null, sendable: false });
    });
  });

  it('reads the caller\'s workspace by its key, as the send route does', () => {
    // Nothing but the caller differs: no caller workspace means no workspace is "its own".
    explicitNames = {};
    const outside = addressBook({ id: 'builder-spir-12' }).workspaces.find((w) => w.path === CODEV)!;
    // Matched by id alone, it is still a builder, and may still not name `main`.
    expect(outside.agents.map(line)[0]).toBe('codev:architect:main | live | through codev:architect');
  });
});
