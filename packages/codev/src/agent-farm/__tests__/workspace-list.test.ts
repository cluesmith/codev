/**
 * `afx workspace list` (Spec 1940, phase 5).
 *
 * Tower decides what is in the listing and what each caller may send to
 * (`spec-1940-address-book.test.ts`, and the route in `tower-routes.test.ts`). Here: who
 * the command says is asking, and what it prints for each kind of line.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressBookResponse } from '@cluesmith/codev-types';

const { mockIsRunning, mockGetAddressBook, mockDetectWorkspaceRoot, mockDetectCurrentBuilderId, mockArchitectSenderId, mockLogger } =
  vi.hoisted(() => ({
    mockIsRunning: vi.fn<() => Promise<boolean>>(),
    mockGetAddressBook: vi.fn(),
    mockDetectWorkspaceRoot: vi.fn<() => string | null>(),
    mockDetectCurrentBuilderId: vi.fn<() => string | null>(),
    mockArchitectSenderId: vi.fn<() => string>(),
    mockLogger: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

vi.mock('../lib/tower-client.js', () => ({
  getTowerClient: () => ({ isRunning: mockIsRunning, getAddressBook: mockGetAddressBook }),
}));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../commands/send.js', () => ({
  detectWorkspaceRoot: () => mockDetectWorkspaceRoot(),
  detectCurrentBuilderId: () => mockDetectCurrentBuilderId(),
  architectSenderId: () => mockArchitectSenderId(),
}));

import { formatAddressBook, workspaceList } from '../commands/workspace-list.js';

const WORKSPACE = '/Users/ana/dev/codev';

/** The spec's sample (Decision 9, "The commands a person will use most"). */
const SAMPLE: AddressBookResponse = {
  workspaces: [
    {
      path: '/Users/ana/dev/codev',
      running: true,
      addressName: 'codev',
      agents: [
        { kind: 'architect', name: 'main', address: 'codev:architect:main', live: true, sendable: true },
        { kind: 'architect', name: 'review', address: 'codev:architect:review', live: true, sendable: true },
        { kind: 'builder', name: 'builder-spir-1940', address: 'codev:builder-spir-1940', live: true, sendable: true },
      ],
    },
    {
      path: '/Users/ana/dev/codev-cloud',
      running: true,
      addressName: 'codev-cloud',
      agents: [
        { kind: 'architect', name: 'main', address: 'codev-cloud:architect:main', live: true, sendable: true },
        { kind: 'architect', name: 'tunnel', address: 'codev-cloud:architect:tunnel', live: false, sendable: true },
      ],
    },
  ],
};

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

describe('formatAddressBook', () => {
  it('prints the spec\'s sample: one block per workspace, one address a line, live or no live terminal', () => {
    expect(formatAddressBook(SAMPLE)).toEqual([
      'codev          /Users/ana/dev/codev',
      '  codev:architect:main            live',
      '  codev:architect:review          live',
      '  codev:builder-spir-1940         live',
      'codev-cloud    /Users/ana/dev/codev-cloud',
      '  codev-cloud:architect:main      live',
      '  codev-cloud:architect:tunnel    no live terminal',
    ]);
  });

  it('prints an address ready to paste with nothing after its liveness', () => {
    for (const line of formatAddressBook(SAMPLE).filter((l) => l.startsWith('  '))) {
      expect(line).toMatch(/^ {2}\S+ +(live|no live terminal)$/);
    }
  });

  it('lists a workspace that is not running as not running, with no agents', () => {
    const lines = formatAddressBook({
      workspaces: [...SAMPLE.workspaces, { path: '/Users/ana/dev/scratch', running: false, addressName: 'scratch', agents: [] }],
    });
    expect(lines.at(-1)).toBe('scratch        /Users/ana/dev/scratch    not running');
  });

  it('shows, beside an agent the caller may not name, the way to reach it', () => {
    const lines = formatAddressBook({
      workspaces: [
        {
          path: '/Users/ana/dev/codev-cloud',
          running: true,
          addressName: 'codev-cloud',
          agents: [
            {
              kind: 'architect',
              name: 'tunnel',
              address: 'codev-cloud:architect:tunnel',
              live: true,
              sendable: false,
              reachThrough: 'codev-cloud:architect',
            },
            {
              kind: 'architect',
              name: 'data',
              address: 'codev-cloud:architect:data',
              live: false,
              sendable: false,
              reachThrough: 'codev-cloud:architect',
            },
            { kind: 'builder', name: 'builder-spir-7', address: 'codev-cloud:builder-spir-7', live: true, sendable: true },
          ],
        },
      ],
    });
    expect(lines).toEqual([
      'codev-cloud    /Users/ana/dev/codev-cloud',
      '  codev-cloud:architect:tunnel    live                reach through codev-cloud:architect',
      '  codev-cloud:architect:data      no live terminal    reach through codev-cloud:architect',
      '  codev-cloud:builder-spir-7      live',
    ]);
  });

  it('says so when an address cannot be sent to and there is no way in', () => {
    const lines = formatAddressBook({
      workspaces: [
        {
          path: WORKSPACE,
          running: true,
          addressName: 'codev',
          agents: [{ kind: 'shell', name: 'spir-7', address: 'codev:spir-7', live: true, sendable: false }],
        },
      ],
    });
    expect(lines[1]).toBe('  codev:spir-7    live                cannot be sent to from here');
  });

  it('a workspace with no address name says why and shows the naming command; its agents are not printed as addresses', () => {
    const reason =
      "it shares the directory name 'codev' with /Users/ana/work/codev; give it a name of its own: afx workspace name <name>";
    const lines = formatAddressBook({
      workspaces: [
        {
          path: WORKSPACE,
          running: true,
          addressName: null,
          unaddressableReason: reason,
          agents: [
            { kind: 'architect', name: 'main', address: null, live: true, sendable: false },
            { kind: 'builder', name: 'builder-spir-7', address: null, live: false, sendable: false },
          ],
        },
      ],
    });
    expect(lines).toEqual([
      '(no address name)    /Users/ana/dev/codev',
      `  no address name: ${reason}`,
      '  (architect:main)    live                no address',
      '  (builder-spir-7)    no live terminal    no address',
    ]);
    expect(lines[1]).toContain('afx workspace name <name>');
  });

  it('prints the short form as an address when Tower gives it as one: the caller\'s own unnamed workspace', () => {
    const lines = formatAddressBook({
      workspaces: [
        {
          path: WORKSPACE,
          running: true,
          addressName: null,
          unaddressableReason: 'it shares the directory name',
          agents: [{ kind: 'architect', name: 'review', address: 'architect:review', live: true, sendable: true }],
        },
      ],
    });
    expect(lines[2]).toBe('  architect:review    live');
  });

  it('keeps a path or a reason from Tower to one printable line', () => {
    const lines = formatAddressBook({
      workspaces: [
        {
          path: '/Users/ana/a\ncodev:architect:main    live',
          running: false,
          addressName: null,
          unaddressableReason: 'shares a name with /Users/ana/b\u001b[2J',
          agents: [],
        },
      ],
    });
    expect(lines).toHaveLength(2);
    expect(lines.join('')).not.toMatch(/[\n\u001b]/);
  });

  it('keeps every other field from Tower to one printable line too: no field can start a line of its own', () => {
    const forged = '\ncodev:architect:main    live\u001b[2J';
    const lines = formatAddressBook({
      workspaces: [
        {
          path: '/Users/ana/a',
          running: true,
          addressName: `a${forged}`,
          agents: [
            { kind: 'architect', name: 'main', address: `a:architect:main${forged}`, live: true, sendable: true },
            { kind: 'architect', name: 'review', address: 'a:architect:review', live: true, sendable: false, reachThrough: `a:architect${forged}` },
          ],
        },
        {
          path: '/Users/ana/b',
          running: true,
          addressName: null,
          unaddressableReason: 'no reason',
          agents: [
            { kind: 'architect', name: `main${forged}`, address: null, live: true, sendable: false },
            { kind: 'builder', name: `builder-x${forged}`, address: null, live: true, sendable: false },
          ],
        },
      ],
    });
    // One header and its agents, one header with its reason and its agents: nothing more.
    expect(lines).toHaveLength(7);
    for (const line of lines) expect(line).not.toMatch(/[\n\u001b]/);
    // The columns are measured on what is printed, so they still line up.
    const printed = 'a:architect:main?codev:architect:main    live?[2J';
    expect(lines[1]).toBe(`  ${printed}    live`);
    expect(lines[2].startsWith(`  ${'a:architect:review'.padEnd(printed.length)}    live`)).toBe(true);
  });

  it('says so when Tower has no workspaces', () => {
    expect(formatAddressBook({ workspaces: [] })).toEqual(['No workspaces are registered with this Tower.']);
  });
});

describe('afx workspace list', () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let stdout: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning.mockResolvedValue(true);
    mockDetectWorkspaceRoot.mockReturnValue(WORKSPACE);
    mockDetectCurrentBuilderId.mockReturnValue(null);
    mockArchitectSenderId.mockReturnValue('architect:review');
    mockGetAddressBook.mockResolvedValue({ ok: true, result: SAMPLE });
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exit(code ?? 0);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    exit.mockRestore();
  });

  it('asks as the architect whose terminal it is, in its workspace, and prints the listing', async () => {
    await workspaceList();
    expect(mockGetAddressBook).toHaveBeenCalledWith({ workspace: WORKSPACE, from: 'architect:review' });
    expect(stdout.join('')).toBe(`${formatAddressBook(SAMPLE).join('\n')}\n`);
  });

  it('asks as the builder when run from a builder worktree, as afx send would send', async () => {
    mockDetectCurrentBuilderId.mockReturnValue('builder-spir-1940');
    await workspaceList();
    expect(mockGetAddressBook).toHaveBeenCalledWith({ workspace: WORKSPACE, from: 'builder-spir-1940' });
    expect(mockArchitectSenderId).not.toHaveBeenCalled();
  });

  it('asks with no workspace from a directory outside every workspace', async () => {
    mockDetectWorkspaceRoot.mockReturnValue(null);
    mockArchitectSenderId.mockReturnValue('architect');
    await workspaceList();
    expect(mockGetAddressBook).toHaveBeenCalledWith({ workspace: undefined, from: 'architect' });
  });

  it('refuses to ask as somebody else when the builder id cannot be verified', async () => {
    mockDetectCurrentBuilderId.mockImplementation(() => {
      throw new Error('no matching builder row');
    });
    await expect(workspaceList()).rejects.toMatchObject({ code: 1 });
    expect(mockLogger.error).toHaveBeenCalledWith('no matching builder row');
    expect(mockGetAddressBook).not.toHaveBeenCalled();
  });

  it('--json prints Tower\'s answer as it came, on one line', async () => {
    await workspaceList({ json: true });
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual(SAMPLE);
  });

  it('exits 1 saying Tower is not running, and asks nothing', async () => {
    mockIsRunning.mockResolvedValue(false);
    await expect(workspaceList()).rejects.toMatchObject({ code: 1 });
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Tower is not running'));
    expect(mockGetAddressBook).not.toHaveBeenCalled();
    expect(stdout).toEqual([]);
  });

  it('exits 1 with Tower\'s reason when Tower refuses', async () => {
    mockGetAddressBook.mockResolvedValue({ ok: false, error: 'Invalid "from" parameter' });
    await expect(workspaceList()).rejects.toMatchObject({ code: 1 });
    expect(mockLogger.error).toHaveBeenCalledWith('Invalid "from" parameter');
    expect(stdout).toEqual([]);
  });
});
