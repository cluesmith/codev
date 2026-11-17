/**
 * #1809: a window rooted at a builder worktree never activates Codev there.
 *
 * It attaches read-only to the parent workspace: Tower calls use the parent
 * root, the activate POST is never sent (for the worktree or the parent), and
 * Tower is never auto-started from such a window. A normal workspace window is
 * the control: it still activates and auto-starts exactly as before.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { state, client, autoStartTower } = vi.hoisted(() => ({
  state: {
    workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
    healthy: true,
  },
  client: {
    getHealth: vi.fn(),
    activateWorkspace: vi.fn(),
  },
  autoStartTower: vi.fn(),
}));

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(e: T) { for (const l of this.listeners) { l(e); } }
    dispose() {}
  }
  return {
    EventEmitter,
    window: { showErrorMessage: vi.fn() },
    workspace: {
      get workspaceFolders() { return state.workspaceFolders; },
      getConfiguration: () => ({
        get: <T>(_key: string, fallback?: T) => fallback,
      }),
    },
  };
});

vi.mock('@cluesmith/codev-sdk/tower-client', () => ({
  TowerClient: class { constructor() { return client; } },
}));
vi.mock('../tower-starter.js', () => ({ autoStartTower }));
vi.mock('../sse-client.js', () => ({
  SSEClient: class {
    onEvent() { return { dispose: () => {} }; }
    connect() {}
    dispose() {}
  },
}));
vi.mock('../auth-wrapper.js', () => ({
  AuthWrapper: class {
    initialize = vi.fn(async () => {});
    getKeySync = () => null;
  },
}));

import { ConnectionManager } from '../connection-manager.js';

const outputChannel = { appendLine: vi.fn() } as never;
const context = { secrets: {} } as never;

let root: string;

beforeEach(() => {
  vi.clearAllMocks();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'codev-cm-')));
  mkdirSync(join(root, 'codev'));
  client.getHealth.mockImplementation(async () => (state.healthy ? { status: 'ok', uptime: 1 } : null));
  client.activateWorkspace.mockResolvedValue({ ok: true });
  autoStartTower.mockResolvedValue(false);
  state.healthy = true;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function openFolder(dir: string): void {
  state.workspaceFolders = [{ uri: { fsPath: dir } }];
}

function worktreeOf(id: string): string {
  const worktree = join(root, '.builders', id);
  mkdirSync(join(worktree, 'codev'), { recursive: true });
  return worktree;
}

describe('ConnectionManager in a builder-worktree window', () => {
  it('connects on the parent root and never sends activate', async () => {
    const worktree = worktreeOf('pir-1802');
    openFolder(worktree);
    const cm = new ConnectionManager(context, outputChannel);

    await cm.initialize();

    expect(cm.getState()).toBe('connected');
    expect(cm.getWorkspacePath()).toBe(root);
    expect(cm.getWindowRoot()).toBe(worktree);
    expect(cm.getBuilderWorktree()).toEqual({ builderId: 'pir-1802', worktreePath: worktree });
    expect(client.activateWorkspace).not.toHaveBeenCalled();
    cm.dispose();
  });

  it('never auto-starts Tower when Tower is down', async () => {
    openFolder(worktreeOf('pir-1802'));
    state.healthy = false;
    const cm = new ConnectionManager(context, outputChannel);

    await cm.initialize();
    await cm.reconnect();

    expect(autoStartTower).not.toHaveBeenCalled();
    expect(client.activateWorkspace).not.toHaveBeenCalled();
    cm.dispose();
  });
});

describe('ConnectionManager in a workspace-root window (control)', () => {
  it('activates its own root', async () => {
    openFolder(root);
    const cm = new ConnectionManager(context, outputChannel);

    await cm.initialize();

    expect(cm.getWorkspacePath()).toBe(root);
    expect(cm.getWindowRoot()).toBe(root);
    expect(cm.getBuilderWorktree()).toBeNull();
    expect(client.activateWorkspace).toHaveBeenCalledWith(root);
    cm.dispose();
  });

  it('auto-starts Tower when Tower is down', async () => {
    openFolder(root);
    state.healthy = false;
    const cm = new ConnectionManager(context, outputChannel);

    await cm.initialize();

    expect(autoStartTower).toHaveBeenCalled();
    cm.dispose();
  });
});
