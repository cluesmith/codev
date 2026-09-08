/**
 * Issue #1497 — open-architect must not substitute a different architect while
 * claiming to be `main`.
 *
 * The defect is *which terminal receives text*, so a resolver-return assertion
 * proves nothing on its own. These tests capture the actual delivery target:
 *
 *   1. Injection-capture (the real misdelivery seam): a live `TerminalManager`
 *      with a `web` terminal seeded under `architect:web`. `injectArchitectText`
 *      at `'main'` must NOT reach it (returns false, its `sendText` recorder is
 *      never called); at `'web'` it reaches it exactly once. This is a real
 *      `sendText` capture through the real map lookup, not a resolver spy.
 *   2. Resolve-refusal (`resolveArchitectTarget`): a non-live `main` resolves to
 *      `undefined`, so no substitute name is ever produced to hand downstream.
 *   3. Call-site invariant (`openResolvedArchitect`): with `main` not live the
 *      resolution refuses (never calls `openArchitect`, shows the warning); when
 *      the target is live it hands `openArchitect` the occupant's OWN name.
 *
 * The full live round-trip (real Tower pty + VSCode UI, main flickering, press
 * open-architect then referenceIssueInArchitect) runs at the dev-approval gate
 * on the reviewer's machine — a real `openArchitect` dials a Tower pty and
 * cannot run headless.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ResolvableArchitect } from '../open-architect.js';

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void): { dispose: () => void } => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire = (e: T): void => { this.listeners.forEach(l => l(e)); };
  }
  return {
    EventEmitter,
    Uri: { joinPath: (...parts: unknown[]) => ({ path: parts.join('/') }) },
  };
});

const { TerminalManager } = await import('../terminal-manager.js');
const { resolveArchitectTarget, openResolvedArchitect } = await import('../open-architect.js');

/** A fake vscode.Terminal that records `sendText` and `show` calls. */
function fakeTerminal() {
  return {
    show: vi.fn(),
    sendText: vi.fn(),
  };
}

/** Construct a real TerminalManager with inert fakes for its constructor deps. */
function makeManager() {
  const outputChannel = { appendLine: vi.fn() } as never;
  const connectionManager = {} as never;
  const overviewCache = { getData: () => undefined } as never;
  const extensionUri = { path: '/ext' } as never;
  return new TerminalManager(connectionManager, outputChannel, extensionUri, overviewCache);
}

/** Seed a fake terminal into the manager's private map under `key`. */
function seedTerminal(manager: InstanceType<typeof TerminalManager>, key: string, terminal: unknown) {
  const terminals = (manager as unknown as { terminals: Map<string, unknown> }).terminals;
  terminals.set(key, { terminal, pty: {}, type: 'architect', id: 't-web' });
}

describe('#1497 injection-capture — text injected at `main` cannot reach `web`', () => {
  it('injectArchitectText("…", "main") does not reach a terminal cached under architect:web', () => {
    const manager = makeManager();
    const web = fakeTerminal();
    seedTerminal(manager, 'architect:web', web);

    const reached = manager.injectArchitectText('#5 "title" ', 'main');

    expect(reached).toBe(false);
    expect(web.sendText).not.toHaveBeenCalled();
    expect(web.show).not.toHaveBeenCalled();
  });

  it('injectArchitectText("…", "web") reaches web exactly once (a terminal is reachable only under its own key)', () => {
    const manager = makeManager();
    const web = fakeTerminal();
    seedTerminal(manager, 'architect:web', web);

    const reached = manager.injectArchitectText('#5 "title" ', 'web');

    expect(reached).toBe(true);
    expect(web.sendText).toHaveBeenCalledTimes(1);
    expect(web.sendText).toHaveBeenCalledWith('#5 "title" ', false);
  });
});

describe('#1497 resolve-refusal — no substitute name is ever produced', () => {
  const web: ResolvableArchitect = { name: 'web', terminalId: 't-web' };
  const main: ResolvableArchitect = { name: 'main', terminalId: 't-main' };

  it('a non-live `main` resolves to undefined (no fallback to architects[0])', () => {
    expect(resolveArchitectTarget([web], 'main')).toBeUndefined();
  });

  it('a live `main` resolves to itself', () => {
    expect(resolveArchitectTarget([main, web], 'main')).toEqual(main);
  });

  it('a named architect resolves to its own object', () => {
    expect(resolveArchitectTarget([main, web], 'web')).toEqual(web);
  });

  it('an empty roster resolves to undefined', () => {
    expect(resolveArchitectTarget([], 'main')).toBeUndefined();
  });
});

describe('#1497 call-site invariant — openResolvedArchitect', () => {
  const web: ResolvableArchitect = { name: 'web', terminalId: 't-web' };
  const main: ResolvableArchitect = { name: 'main', terminalId: 't-main' };

  it('refuses a non-live `main`: never opens a terminal, warns naming what was asked', async () => {
    const openArchitect = vi.fn();
    const warn = vi.fn();

    const resolved = await openResolvedArchitect([web], 'main', { openArchitect, warn });

    expect(resolved).toBeUndefined();
    expect(openArchitect).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Codev: No 'main' architect found — is the workspace activated?");
  });

  it('opens a live target under its OWN name (never the requested name) and returns it', async () => {
    const openArchitect = vi.fn();
    const warn = vi.fn();

    const resolved = await openResolvedArchitect([main, web], 'main', { openArchitect, warn });

    expect(resolved).toBe('main');
    expect(openArchitect).toHaveBeenCalledWith('t-main', 'main', true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a resolved target is opened under its own name even for a named architect', async () => {
    const openArchitect = vi.fn();
    const warn = vi.fn();

    const resolved = await openResolvedArchitect([main, web], 'web', { openArchitect, warn });

    expect(resolved).toBe('web');
    expect(openArchitect).toHaveBeenCalledWith('t-web', 'web', true);
  });

  it('refuses when the resolved architect has no terminalId yet (no open, warns)', async () => {
    const openArchitect = vi.fn();
    const warn = vi.fn();

    const resolved = await openResolvedArchitect([{ name: 'main' }], 'main', { openArchitect, warn });

    expect(resolved).toBeUndefined();
    expect(openArchitect).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
