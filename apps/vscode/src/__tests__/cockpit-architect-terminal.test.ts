/**
 * Spec 1963: the `codev.terminalPosition` override is *Arrange Cockpit*'s alone. A real
 * `TerminalManager` with its pty adapter stubbed out:
 * - `openArchitect(…, 'editor')` opens the architect in the first editor group even with
 *   `terminalPosition: panel`;
 * - every other call keeps honouring the setting;
 * - an architect terminal already open is reused where it is, whatever the override says;
 * - `getArchitectTerminal` finds the terminal by the architect's own name, and only that one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const settings = new Map<string, unknown>();
const createTerminal = vi.fn((options: { name: string; location: unknown }) => ({
  name: options.name,
  location: options.location,
  show: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire = (e: T) => { this.listeners.forEach(l => l(e)); };
  }
  return {
    EventEmitter,
    Uri: { joinPath: (...parts: unknown[]) => ({ path: parts.join('/') }) },
    ViewColumn: { One: 1, Two: 2 },
    TerminalLocation: { Panel: 1, Editor: 2 },
    workspace: {
      getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings.get(key) ?? fallback }),
    },
    window: {
      createTerminal,
      onDidCloseTerminal: () => ({ dispose: () => {} }),
      tabGroups: { all: [] },
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
    },
  };
});

vi.mock('../terminal-adapter.js', () => ({
  CodevPseudoterminal: class { close() {} },
}));

const { TerminalManager } = await import('../terminal-manager.js');

function makeManager() {
  const connectionManager = { getWorkspacePath: () => '/work/codev', getClient: () => null } as never;
  const outputChannel = { appendLine: vi.fn() } as never;
  const overviewCache = { getData: () => undefined } as never;
  return new TerminalManager(connectionManager, outputChannel, { path: '/ext' } as never, overviewCache);
}

beforeEach(() => {
  settings.clear();
  createTerminal.mockClear();
});

describe("the architect's editor-area override (Arrange Cockpit only)", () => {
  it("opens the architect in the first editor group with terminalPosition 'panel'", async () => {
    settings.set('terminalPosition', 'panel');
    await makeManager().openArchitect('t-main', 'main', true, 'editor');

    expect(createTerminal).toHaveBeenCalledTimes(1);
    expect(createTerminal.mock.calls[0][0]).toMatchObject({ name: 'Codev: Architect', location: { viewColumn: 1 } });
  });

  it("without the override, terminalPosition 'panel' keeps the architect in the panel", async () => {
    settings.set('terminalPosition', 'panel');
    await makeManager().openArchitect('t-main', 'main', true);

    expect(createTerminal.mock.calls[0][0]).toMatchObject({ location: 1 });
  });

  it('reuses an open architect terminal where it is, whatever the override', async () => {
    settings.set('terminalPosition', 'panel');
    const manager = makeManager();
    await manager.openArchitect('t-main', 'main', false);
    const terminal = manager.getArchitectTerminal('main') as unknown as { show: ReturnType<typeof vi.fn> };

    await manager.openArchitect('t-main', 'main', true, 'editor');

    expect(createTerminal).toHaveBeenCalledTimes(1);
    expect(terminal.show).toHaveBeenLastCalledWith(false);
  });

  it("getArchitectTerminal finds a terminal by its architect's own name only", async () => {
    const manager = makeManager();
    await manager.openArchitect('t-web', 'web', false);

    expect(manager.getArchitectTerminal('main')).toBeUndefined();
    expect(manager.getArchitectTerminal('web')).toMatchObject({ name: 'Codev: Architect (web)' });
  });
});
