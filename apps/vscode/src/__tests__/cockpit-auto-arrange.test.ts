/**
 * Spec 1963 scenario 7: the Cockpit's first-show auto-arrange and its one-time notice.
 * - It fires once per window session: when the view is already visible at creation, or on its
 *   first visibility change. Later shows do not fire it.
 * - It waits for the window's first connection attempt (`ready()`), so the architect can resolve.
 * - It does not fire with `codev.cockpit.autoArrange` off, in a builder-worktree window or in a
 *   window with no Codev workspace.
 * - The notice is shown on the first auto-arrange when the global-state flag is unset, and the flag
 *   is set. It is not shown when the flag is set or when the arrange did not happen. *Don't arrange
 *   automatically* turns the setting off; dismissing it leaves the setting alone. A manual arrange
 *   goes straight to the arranger, never through this module (pinned in contributes-cockpit).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Listener = (event: unknown) => void;

class FakeView {
  visible = false;
  private listeners: Listener[] = [];
  readonly onDidChangeVisibility = (listener: Listener) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
  };
  setVisible(visible: boolean) {
    this.visible = visible;
    for (const listener of [...this.listeners]) { listener({ visible }); }
  }
  get listenerCount() { return this.listeners.length; }
}

class FakeMemento {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  update = vi.fn(async (key: string, value: unknown) => { this.values.set(key, value); });
}

const showInformationMessage = vi.fn<(message: string, ...items: string[]) => Promise<string | undefined>>();

vi.mock('vscode', () => ({
  window: { showInformationMessage },
}));

const { CockpitAutoArrange, AUTO_ARRANGE_NOTICE, AUTO_ARRANGE_NOTICE_KEY, DONT_ARRANGE_AUTOMATICALLY } =
  await import('../cockpit/auto-arrange.js');

/** Let the arrange and the notice's awaits run. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(opts: { visible?: boolean; offered?: boolean; enabled?: boolean; arranged?: boolean; noticeShown?: boolean } = {}) {
  const view = new FakeView();
  view.visible = opts.visible ?? false;
  const globalState = new FakeMemento();
  if (opts.noticeShown) { globalState.values.set(AUTO_ARRANGE_NOTICE_KEY, true); }
  const settings = { enabled: opts.enabled ?? true };
  const arrange = vi.fn(async () => opts.arranged ?? true);
  const disable = vi.fn(async () => { settings.enabled = false; });
  const log: string[] = [];
  const auto = new CockpitAutoArrange({
    view,
    offered: () => opts.offered ?? true,
    enabled: () => settings.enabled,
    arrange,
    globalState,
    disable,
    log: (line) => { log.push(line); },
  });
  return { auto, view, globalState, settings, arrange, disable, log };
}

beforeEach(() => {
  showInformationMessage.mockReset();
  showInformationMessage.mockResolvedValue(undefined);
});

describe('the first-show trigger', () => {
  it('arranges when the view is already visible at creation (a restored window), once ready', async () => {
    const { auto, arrange } = setup({ visible: true });
    await flush();
    expect(arrange).not.toHaveBeenCalled();

    auto.ready();
    await flush();

    expect(arrange).toHaveBeenCalledTimes(1);
  });

  it('arranges on the first visibility change after ready, and not on later shows', async () => {
    const { auto, view, arrange } = setup();
    auto.ready();
    await flush();
    expect(arrange).not.toHaveBeenCalled();

    view.setVisible(true);
    await flush();
    view.setVisible(false);
    view.setVisible(true);
    await flush();

    expect(arrange).toHaveBeenCalledTimes(1);
  });

  it('a first show before ready arranges once at ready, even if the view was hidden again meanwhile', async () => {
    const { auto, view, arrange } = setup();
    view.setVisible(true);
    view.setVisible(false);

    auto.ready();
    auto.ready();
    await flush();

    expect(arrange).toHaveBeenCalledTimes(1);
  });

  it('does not arrange with codev.cockpit.autoArrange off, and the first show is spent', async () => {
    const { auto, view, settings, arrange } = setup({ enabled: false });
    auto.ready();
    view.setVisible(true);
    await flush();
    settings.enabled = true;
    view.setVisible(false);
    view.setVisible(true);
    await flush();

    expect(arrange).not.toHaveBeenCalled();
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it('does not arrange in a builder-worktree or no-workspace window', async () => {
    const { auto, view, arrange } = setup({ offered: false });
    auto.ready();
    view.setVisible(true);
    await flush();

    expect(arrange).not.toHaveBeenCalled();
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it('stops listening when disposed', () => {
    const { auto, view } = setup();
    expect(view.listenerCount).toBe(1);
    auto.dispose();
    expect(view.listenerCount).toBe(0);
  });
});

describe('the one-time first-auto-arrange notice', () => {
  it('is shown on the first auto-arrange, with the flag set first, whatever the user does', async () => {
    const { auto, globalState } = setup({ visible: true });
    auto.ready();
    await flush();

    expect(globalState.update).toHaveBeenCalledWith(AUTO_ARRANGE_NOTICE_KEY, true);
    expect(showInformationMessage).toHaveBeenCalledTimes(1);
    expect(showInformationMessage).toHaveBeenCalledWith(AUTO_ARRANGE_NOTICE, DONT_ARRANGE_AUTOMATICALLY);
  });

  it("Don't arrange automatically turns the setting off (at the user level, in the extension's wiring)", async () => {
    showInformationMessage.mockResolvedValue(DONT_ARRANGE_AUTOMATICALLY);
    const { auto, disable, settings } = setup({ visible: true });
    auto.ready();
    await flush();

    expect(disable).toHaveBeenCalledTimes(1);
    expect(settings.enabled).toBe(false);
  });

  it('dismissing it leaves the setting unchanged, and the flag stays set', async () => {
    const { auto, disable, globalState } = setup({ visible: true });
    auto.ready();
    await flush();

    expect(disable).not.toHaveBeenCalled();
    expect(globalState.get(AUTO_ARRANGE_NOTICE_KEY)).toBe(true);
  });

  it('is not shown again once the flag is set, in this or any other window', async () => {
    const { auto, arrange } = setup({ visible: true, noticeShown: true });
    auto.ready();
    await flush();

    expect(arrange).toHaveBeenCalledTimes(1);
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it('is not shown when the arrange did not happen, and the flag stays unset', async () => {
    const { auto, globalState } = setup({ visible: true, arranged: false });
    auto.ready();
    await flush();

    expect(showInformationMessage).not.toHaveBeenCalled();
    expect(globalState.get(AUTO_ARRANGE_NOTICE_KEY)).toBeUndefined();
  });

  it('a failure is logged, never an unhandled rejection', async () => {
    const { auto, globalState, log } = setup({ visible: true });
    globalState.update.mockRejectedValueOnce(new Error('storage is read-only'));
    auto.ready();
    await flush();

    expect(log).toEqual(['Cockpit auto-arrange failed: storage is read-only']);
  });
});
