/**
 * Tests for the VSCode command provider (the command relay).
 *
 * Mocks `vscode` (the established pattern from overview-cache.test.ts) with a
 * controllable window so we can drive focus, plus a fake ConnectionManager that
 * lets us fire synthetic `command` SSE envelopes and inspect which VSCode command
 * each verb runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', () => {
  const window = {
    state: { focused: true },
  };
  return {
    window,
    commands: { executeCommand: vi.fn() },
    Disposable: {
      from: (...ds: Array<{ dispose?: () => void }>) => ({
        dispose: () => ds.forEach((d) => d.dispose?.()),
      }),
    },
  };
});

const vscode = (await import('vscode')) as unknown as {
  window: { state: { focused: boolean } };
  commands: { executeCommand: ReturnType<typeof vi.fn> };
};
const { wireCommandProvider } = await import('../command-relay.js');

function makeConnMgr(workspacePath: string | null = null) {
  let sse: ((e: { type: string; data: string }) => void) | null = null;
  return {
    mgr: {
      onSSEEvent: (l: (e: { type: string; data: string }) => void) => {
        sse = l;
        return { dispose: () => { sse = null; } };
      },
      getWorkspacePath: () => workspacePath,
    },
    // Tower sends {type, title, body:JSON} on the SSE data field, no event: name.
    fire: (type: string, payload: unknown) =>
      sse?.({ type: '', data: JSON.stringify({ type, title: type, body: JSON.stringify(payload) }) }),
  };
}

describe('wireCommandProvider', () => {
  beforeEach(() => {
    vscode.window.state.focused = true;
    vscode.commands.executeCommand.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps a canonical verb to its VSCode command and runs it with args', async () => {
    const { mgr, fire } = makeConnMgr();
    wireCommandProvider(mgr as never);

    fire('command', { verb: 'open-terminal', args: ['spir-809'] });
    await new Promise((r) => setTimeout(r, 0));

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('codev.openBuilderById', 'spir-809');
  });

  it('ignores a verb that is not in the provider map (the allowlist)', async () => {
    const { mgr, fire } = makeConnMgr();
    wireCommandProvider(mgr as never);

    fire('command', { verb: 'kill-everything', args: [] });
    await new Promise((r) => setTimeout(r, 0));

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('does not run a relayed verb when the window is not focused (single active provider)', async () => {
    vscode.window.state.focused = false;
    const { mgr, fire } = makeConnMgr();
    wireCommandProvider(mgr as never);

    fire('command', { verb: 'open-terminal', args: ['spir-809'] });
    await new Promise((r) => setTimeout(r, 0));

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('coerces non-array verb args to an empty arg list (no crash on a stray object)', async () => {
    const { mgr, fire } = makeConnMgr();
    wireCommandProvider(mgr as never);

    fire('command', { verb: 'refresh-overview', args: { not: 'an array' } });
    await new Promise((r) => setTimeout(r, 0));

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('codev.refreshOverview');
  });

  it('ignores a non-command SSE envelope', async () => {
    const { mgr, fire } = makeConnMgr();
    wireCommandProvider(mgr as never);

    fire('some-other-event', { verb: 'open-terminal', args: ['x'] });
    await new Promise((r) => setTimeout(r, 0));

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('drops a command addressed to a different workspace', async () => {
    const { mgr, fire } = makeConnMgr('/work/alpha');
    wireCommandProvider(mgr as never);

    fire('command', { verb: 'view-diff', args: ['0809'], workspace: '/work/beta' });
    await new Promise((r) => setTimeout(r, 0));

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('runs a command addressed to this workspace', async () => {
    const { mgr, fire } = makeConnMgr('/work/alpha');
    wireCommandProvider(mgr as never);

    fire('command', { verb: 'view-diff', args: ['0809'], workspace: '/work/alpha' });
    await new Promise((r) => setTimeout(r, 0));

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('codev.viewDiff', '0809');
  });

  it('runs a workspace-less command (scope not yet populated by controllers)', async () => {
    const { mgr, fire } = makeConnMgr('/work/alpha');
    wireCommandProvider(mgr as never);

    fire('command', { verb: 'view-diff', args: ['0809'] });
    await new Promise((r) => setTimeout(r, 0));

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('codev.viewDiff', '0809');
  });

  it('strips a controller-supplied options arg from approve-gate (no silent human-gate approval)', async () => {
    const { mgr, fire } = makeConnMgr();
    wireCommandProvider(mgr as never);

    // A crafted `{ skipConfirmation: true }` must NOT reach codev.approveGate — that
    // path runs `porch approve --a-human-explicitly-approved-this` with no human.
    fire('command', { verb: 'approve-gate', args: ['0042', { skipConfirmation: true }] });
    await new Promise((r) => setTimeout(r, 0));

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('codev.approveGate', '0042');
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      'codev.approveGate', '0042', { skipConfirmation: true });
  });
});
