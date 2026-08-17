/**
 * `afx refresh` command surface — Spec 1273, phase 6 (renamed from `reset` by #1489).
 *
 * The orchestrator tests prove the state machine's ordering. These prove the
 * WRAPPER: that the right things are bound to the right ports and the target is
 * resolved the way every other builder-addressed command resolves it.
 *
 * That split matters because the two bugs this file exists to catch were both
 * invisible from the orchestrator's side. The orchestrator cannot tell whether
 * `sendRaw` was wired to Tower's `raw` or its `escape` route, and it cannot tell
 * whether the builder was looked up by exact id or by the shared resolver. Both
 * were wrong at some point in this phase, and both would have shipped a command
 * that fails in a way the state machine's tests call success.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockSendMessage,
  mockIsRunning,
  mockGetTerminal,
  mockGetTerminalOutput,
  mockDetectWorkspaceRoot,
  mockDetectCurrentBuilderId,
  mockFindBuilderById,
  mockFatal,
  mockRunReset,
} = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockIsRunning: vi.fn(),
  mockGetTerminal: vi.fn(),
  mockGetTerminalOutput: vi.fn(),
  mockDetectWorkspaceRoot: vi.fn(),
  mockDetectCurrentBuilderId: vi.fn(),
  mockFindBuilderById: vi.fn(),
  mockFatal: vi.fn((msg: string) => {
    throw new Error(`FATAL: ${msg}`);
  }),
  mockRunReset: vi.fn(),
}));

vi.mock('../lib/tower-client.js', () => ({
  TowerClient: class {
    isRunning = mockIsRunning;
    sendMessage = mockSendMessage;
    getTerminal = mockGetTerminal;
    getTerminalOutput = mockGetTerminalOutput;
  },
}));

vi.mock('../commands/send.js', () => ({
  detectWorkspaceRoot: mockDetectWorkspaceRoot,
  detectCurrentBuilderId: mockDetectCurrentBuilderId,
}));

vi.mock('../lib/builder-lookup.js', () => ({
  findBuilderById: mockFindBuilderById,
}));

vi.mock('../utils/logger.js', () => ({
  logger: { header: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn(), kv: vi.fn() },
  fatal: mockFatal,
}));

vi.mock('../utils/index.js', () => ({
  getConfig: () => ({ workspaceRoot: '/tmp/ws', codevDir: '/tmp/ws/codev' }),
}));

vi.mock('../../lib/config.js', () => ({
  loadConfig: () => ({ harness: undefined }),
}));

vi.mock('../../lib/forge.js', () => ({ loadForgeConfig: () => null }));
vi.mock('../../lib/github.js', () => ({ fetchIssue: async () => null }));

vi.mock('../commands/spawn-roles.js', () => ({
  buildPromptFromTemplate: () => '# prompt',
  buildResumeNotice: (id: string) => `resume ${id}`,
}));

vi.mock('../commands/reset/context.js', () => ({
  resolveBuilderContext: (opts: Record<string, unknown>) => ({
    builderId: opts.builderId,
    worktree: opts.worktree,
    branch: opts.branch,
    protocol: 'aspir',
    mode: 'strict',
    harnessName: 'claude',
    harness: { supportsContextReset: true },
    porch: null,
    specName: null,
    specPath: null,
    planPath: null,
    issueNumber: opts.issueNumber,
    taskText: opts.taskText,
  }),
}));

vi.mock('../commands/reset/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../commands/reset/index.js')>();
  return { ...actual, runReset: mockRunReset };
});

const BUILDER = {
  id: 'aspir-1273',
  name: 'aspir-1273',
  worktree: '/tmp/ws/.builders/aspir-1273',
  branch: 'builder/aspir-1273',
  terminalId: 'term-1',
  issueNumber: 1273,
  taskText: undefined,
};

describe('afx refresh — command surface (Spec 1273)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning.mockResolvedValue(true);
    mockDetectWorkspaceRoot.mockReturnValue('/tmp/ws');
    mockDetectCurrentBuilderId.mockReturnValue(null);
    mockFindBuilderById.mockReturnValue(BUILDER);
    mockGetTerminal.mockResolvedValue({ id: 'term-1', status: 'running', lastDataAt: 0 });
    mockGetTerminalOutput.mockResolvedValue({ lines: [], total: 0, hasMore: false });
    mockSendMessage.mockResolvedValue({ ok: true, resolvedTo: 'aspir-1273' });
    mockRunReset.mockResolvedValue({
      outcome: 'completed',
      steps: [],
      nonce: 'abc123abc123',
      statePath: '/tmp/ws/.builders/aspir-1273/.builder-state.md',
      reorientPath: '/tmp/ws/.builders/aspir-1273/.builder-reorient.md',
      saveRequest: 'save request text',
      stateBytes: 5000,
    });
  });

  // ==========================================================================
  // Addressing parity
  // ==========================================================================

  it('resolves the target through the shared resolver, not an exact-id lookup', async () => {
    // `getBuilder` matches the id EXACTLY. Using it meant `afx refresh 1273`
    // failed against a builder registered as `aspir-1273` while `afx send 1273`
    // reached it fine — a command the architect cannot address the way they
    // already type addresses is one that gets typed wrong under pressure.
    const { refresh } = await import('../commands/reset.js');

    await refresh({ builder: '1273' });

    expect(mockFindBuilderById).toHaveBeenCalledWith('1273');
  });

  it('aborts when the target cannot be resolved or is ambiguous', async () => {
    mockFindBuilderById.mockReturnValue(null);
    const { refresh } = await import('../commands/reset.js');

    await expect(refresh({ builder: 'nope' })).rejects.toThrow(/FATAL/);
    expect(mockRunReset).not.toHaveBeenCalled();
  });

  it('refuses a registry row missing the worktree or branch', async () => {
    mockFindBuilderById.mockReturnValue({ ...BUILDER, worktree: '' });
    const { refresh } = await import('../commands/reset.js');

    await expect(refresh({ builder: '1273' })).rejects.toThrow(/incomplete registry row/);
    expect(mockRunReset).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Port bindings — the channel each action actually travels down
  // ==========================================================================

  it('binds /clear to Tower\'s raw channel, and ESC to its escape channel', async () => {
    const { refresh } = await import('../commands/reset.js');
    await refresh({ builder: '1273' });

    const terminal = mockRunReset.mock.calls[0][0].terminal;

    await terminal.sendRaw('/clear');
    const rawCall = mockSendMessage.mock.calls.at(-1)!;
    expect(rawCall[1]).toBe('/clear');
    expect(rawCall[2]).toMatchObject({ raw: true });
    // The decisive assertion: NOT escape. Tower's escape route writes a
    // hardcoded ESC and discards the body, so `escape: true` here would turn
    // the clear into an interrupt while every signal still read as success.
    expect(rawCall[2].escape).toBeUndefined();

    await terminal.sendEscape();
    const escCall = mockSendMessage.mock.calls.at(-1)!;
    expect(escCall[1]).toBe('\x1b');
    expect(escCall[2]).toMatchObject({ escape: true });
    expect(escCall[2].raw).toBeUndefined();
  });

  it('sends the save request and re-orientation as formatted messages', async () => {
    const { refresh } = await import('../commands/reset.js');
    await refresh({ builder: '1273' });

    const terminal = mockRunReset.mock.calls[0][0].terminal;
    await terminal.sendMessage('save your state');

    const call = mockSendMessage.mock.calls.at(-1)!;
    expect(call[2].raw).toBeUndefined();
    expect(call[2].escape).toBeUndefined();
  });

  it('reports lastDataAt as undefined rather than defaulting it to zero', async () => {
    // An older Tower omits the field. The orchestrator treats undefined as
    // "unobservable" and refuses to clear; collapsing it to 0 at this boundary
    // would defeat that check before the orchestrator ever saw it.
    mockGetTerminal.mockResolvedValue({ id: 'term-1', status: 'running' });
    const { refresh } = await import('../commands/reset.js');
    await refresh({ builder: '1273' });

    const terminal = mockRunReset.mock.calls[0][0].terminal;
    await expect(terminal.observe()).resolves.toEqual({ exists: true, lastDataAt: undefined });
  });

  it('binds readOutput so the clear confirmation can actually succeed', async () => {
    // Left unbound, `confirmClear` returns false on every production run and the
    // report says "clear-unconfirmed" forever — a check that looks attempted and
    // can only ever pass in tests.
    mockGetTerminalOutput.mockResolvedValue({
      lines: ['> /clear', 'context cleared'],
      total: 2,
      hasMore: false,
    });
    const { refresh } = await import('../commands/reset.js');
    await refresh({ builder: '1273' });

    const terminal = mockRunReset.mock.calls[0][0].terminal;
    expect(terminal.readOutput).toBeDefined();
    const out = await terminal.readOutput();
    expect(out.lines.join('\n')).toContain('context cleared');
    // `total` must come through — the confirmation window depends on it.
    expect(out.total).toBe(2);
  });

  it('returns null recent output rather than throwing when Tower cannot serve it', async () => {
    // Confirmation is advisory: an older Tower or a 404 must degrade to
    // "unconfirmed", never fail the reset that already succeeded.
    mockGetTerminalOutput.mockResolvedValue(null);
    const { refresh } = await import('../commands/reset.js');
    await refresh({ builder: '1273' });

    const terminal = mockRunReset.mock.calls[0][0].terminal;
    await expect(terminal.readOutput()).resolves.toBeNull();
  });

  it('reports a non-running terminal as absent', async () => {
    mockGetTerminal.mockResolvedValue({ id: 'term-1', status: 'exited' });
    const { refresh } = await import('../commands/reset.js');
    await refresh({ builder: '1273' });

    const terminal = mockRunReset.mock.calls[0][0].terminal;
    await expect(terminal.observe()).resolves.toEqual({ exists: false });
  });

  // ==========================================================================
  // Options plumbing
  // ==========================================================================

  it('converts --timeout from seconds to milliseconds', async () => {
    // The flag is documented in seconds; the orchestrator takes ms. An
    // unconverted 300 would make the receipt wait 0.3s instead of 5 minutes and
    // abort against every real builder.
    const { refresh } = await import('../commands/reset.js');
    await refresh({ builder: '1273', timeout: 300 });

    expect(mockRunReset.mock.calls[0][0].receiptTimeoutMs).toBe(300_000);
  });

  it('passes --note through as the addendum', async () => {
    const { refresh } = await import('../commands/reset.js');
    await refresh({ builder: '1273', note: 'Ignore the stale PR comment.' });

    expect(mockRunReset.mock.calls[0][0].addendum).toBe('Ignore the stale PR comment.');
  });

  it('forwards --dry-run and --interrupt-first', async () => {
    const { refresh } = await import('../commands/reset.js');
    await refresh({ builder: '1273', dryRun: true, interruptFirst: true });

    const opts = mockRunReset.mock.calls[0][0];
    expect(opts.dryRun).toBe(true);
    expect(opts.interruptFirst).toBe(true);
  });

  // ==========================================================================
  // Numeric flag validation — the wrapper must not pass a gate-disabling value
  // ==========================================================================

  it('rejects a gate-disabling numeric option before runReset is called', async () => {
    // The CLI layer validates first, but the wrapper is also reachable
    // programmatically, and `refresh()` must not forward a value that would
    // silently switch off R2 or R4. The orchestrator's own guard is what
    // enforces it; this asserts the wrapper does not swallow that refusal and
    // report success anyway.
    mockRunReset.mockRejectedValue(
      Object.assign(new Error('Invalid quietWindowMs: -1.'), { name: 'ResetPreflightError' }),
    );
    const { refresh } = await import('../commands/reset.js');

    await expect(refresh({ builder: '1273', quietWindow: -1 })).rejects.toThrow(/FATAL/);
  });

  it('omits an unset numeric option rather than passing NaN or zero', async () => {
    // `options.timeout ? ... : undefined` on an absent flag must yield
    // undefined so the orchestrator's own default applies. Passing 0 or NaN
    // here would disable the gate the default exists to enforce.
    const { refresh } = await import('../commands/reset.js');
    await refresh({ builder: '1273' });

    const opts = mockRunReset.mock.calls[0][0];
    expect(opts.receiptTimeoutMs).toBeUndefined();
    expect(opts.minBytes).toBeUndefined();
    expect(opts.quietWindowMs ?? opts.quietWindow).toBeUndefined();
  });

  it('exits non-zero when the run aborts, so a script cannot read it as success', async () => {
    mockRunReset.mockResolvedValue({
      outcome: 'aborted',
      steps: [],
      abortReason: 'Save-state receipt not verified.',
      nonce: 'abc123abc123',
      statePath: '/x/.builder-state.md',
      reorientPath: '/x/.builder-reorient.md',
      saveRequest: 'save request text',
    });
    const previous = process.exitCode;
    const { refresh } = await import('../commands/reset.js');

    await refresh({ builder: '1273' });

    expect(process.exitCode).toBe(1);
    process.exitCode = previous;
  });
});
