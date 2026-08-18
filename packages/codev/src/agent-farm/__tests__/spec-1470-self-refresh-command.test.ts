/**
 * `afx self-refresh` command surface — Spec 1470, Phase 4.
 *
 * The orchestrator tests prove the state machine's ordering. These prove the
 * WRAPPER, and the split matters for the same reason it did in Spec 1273: the
 * orchestrator cannot tell whether `sendRaw` was wired to Tower's `raw` route or
 * its `escape` route, and it cannot tell whose terminal the ports actually
 * address. Both are invisible from inside, and both would ship a command that
 * fails in a way the state machine's tests call success.
 *
 * The property this file exists to protect above all others: **this command can
 * only ever reach the terminal of the builder that ran it.** It takes no target,
 * derives identity from the worktree, and every Tower call must carry that
 * derived id.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockSendMessage,
  mockIsRunning,
  mockDetectWorkspaceRoot,
  mockDetectCurrentBuilderId,
  mockFindBuilderById,
  mockFatal,
  mockRunSelfRefresh,
  mockBeginSelfRefresh,
  mockExecFileSync,
} = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockIsRunning: vi.fn(),
  mockDetectWorkspaceRoot: vi.fn(),
  mockDetectCurrentBuilderId: vi.fn(),
  mockFindBuilderById: vi.fn(),
  mockFatal: vi.fn((msg: string) => {
    throw new Error(`FATAL: ${msg}`);
  }),
  mockRunSelfRefresh: vi.fn(),
  mockBeginSelfRefresh: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

vi.mock('../lib/tower-client.js', () => ({
  TowerClient: class {
    isRunning = mockIsRunning;
    sendMessage = mockSendMessage;
  },
}));

vi.mock('../commands/send.js', () => ({
  detectWorkspaceRoot: mockDetectWorkspaceRoot,
  detectCurrentBuilderId: mockDetectCurrentBuilderId,
}));

vi.mock('../lib/builder-lookup.js', () => ({ findBuilderById: mockFindBuilderById }));

vi.mock('../utils/logger.js', () => ({
  logger: {
    header: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    kv: vi.fn(),
  },
  fatal: mockFatal,
}));

vi.mock('../utils/index.js', () => ({
  getConfig: () => ({ workspaceRoot: '/tmp/ws', codevDir: '/tmp/ws/codev' }),
}));
vi.mock('../../lib/config.js', () => ({ loadConfig: () => ({ harness: undefined }) }));
vi.mock('../../lib/forge.js', () => ({ loadForgeConfig: () => null }));
vi.mock('../../lib/github.js', () => ({ fetchIssue: async () => null }));
vi.mock('../commands/spawn-roles.js', () => ({
  buildPromptFromTemplate: () => '# prompt',
  buildResumeNotice: (id: string) => `resume ${id}`,
}));

vi.mock('node:child_process', () => ({ execFileSync: mockExecFileSync }));

vi.mock('../commands/reset/context.js', () => ({
  resolveBuilderContext: (opts: Record<string, unknown>) => ({
    builderId: opts.builderId,
    worktree: opts.worktree,
    branch: opts.branch,
    protocol: 'spir',
    mode: 'strict',
    harnessName: 'claude',
    harness: { supportsContextReset: true },
    porch: { projectId: '1470', projectName: 'ctx-refresh', phase: 'implement' },
    specName: null,
    specPath: null,
    planPath: null,
    issueNumber: opts.issueNumber,
    taskText: opts.taskText,
  }),
}));

vi.mock('../commands/reset/self.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../commands/reset/self.js')>();
  return { ...actual, runSelfRefresh: mockRunSelfRefresh, beginSelfRefresh: mockBeginSelfRefresh };
});

const SELF = {
  id: 'spir-1470',
  name: 'spir-1470',
  worktree: '/tmp/ws/.builders/spir-1470',
  branch: 'builder/spir-1470',
  terminalId: 'term-self',
  issueNumber: 1470,
  taskText: undefined,
};

/** A different builder, which this command must never be able to reach. */
const OTHER = {
  id: 'spir-9999',
  name: 'spir-9999',
  worktree: '/tmp/ws/.builders/spir-9999',
  branch: 'builder/spir-9999',
  terminalId: 'term-other',
  issueNumber: 9999,
  taskText: undefined,
};

async function importCommand() {
  return import('../commands/self-refresh.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  mockIsRunning.mockResolvedValue(true);
  mockDetectWorkspaceRoot.mockReturnValue('/tmp/ws');
  mockDetectCurrentBuilderId.mockReturnValue('spir-1470');
  mockFindBuilderById.mockReturnValue(SELF);
  mockSendMessage.mockResolvedValue({ ok: true, resolvedTo: 'spir-1470' });
  mockExecFileSync.mockReturnValue(Buffer.from(''));
  mockBeginSelfRefresh.mockReturnValue({
    nonce: 'abc123def456',
    statePath: '/tmp/ws/.builders/spir-1470/.builder-state.md',
    challengePath: '/tmp/ws/.builders/spir-1470/.builder-refresh-challenge',
    saveRequest: 'SAVE REQUEST TEXT',
  });
  mockRunSelfRefresh.mockResolvedValue({
    outcome: 'completed',
    steps: [{ name: 'clear', at: 1 }],
    statePath: '/tmp/ws/.builders/spir-1470/.builder-state.md',
    reorientPath: '/tmp/ws/.builders/spir-1470/.builder-reorient.md',
    stateBytes: 2048,
    payload: { inline: 'INLINE FRAME', longForm: 'LONG', longFormFileName: '.builder-reorient.md' },
  });
});

// ---------------------------------------------------------------------------
// Identity is derived, never supplied
// ---------------------------------------------------------------------------

describe('identity', () => {
  it('derives the builder from the worktree and never accepts a target', async () => {
    const { selfRefresh } = await importCommand();
    await selfRefresh({});

    // The ONLY lookup is of the derived id. Nothing consults an argument.
    expect(mockDetectCurrentBuilderId).toHaveBeenCalled();
    expect(mockFindBuilderById).toHaveBeenCalledWith('spir-1470');
  });

  it('refuses when run outside a builder worktree', async () => {
    mockDetectCurrentBuilderId.mockReturnValue(null);
    const { selfRefresh } = await importCommand();

    await expect(selfRefresh({})).rejects.toThrow(/must be run from inside a builder worktree/i);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('surfaces the anti-spoofing resolver error verbatim rather than guessing', async () => {
    // #1094: a silent bare-name fallback once misrouted builder messages to
    // `main`. The specific reason has to reach the operator.
    mockDetectCurrentBuilderId.mockImplementation(() => {
      throw new Error('Cannot resolve canonical builder id for worktree: no matching row');
    });
    const { selfRefresh } = await importCommand();

    await expect(selfRefresh({})).rejects.toThrow(/no matching row/);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('refuses when the registry row is missing', async () => {
    mockFindBuilderById.mockReturnValue(null);
    const { selfRefresh } = await importCommand();

    await expect(selfRefresh({})).rejects.toThrow(/no matching registry row/i);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('refuses when the registry row is incomplete', async () => {
    mockFindBuilderById.mockReturnValue({ ...SELF, worktree: undefined });
    const { selfRefresh } = await importCommand();

    await expect(selfRefresh({})).rejects.toThrow(/incomplete registry row/i);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The property that matters most: it can only reach ITSELF
// ---------------------------------------------------------------------------

describe('cannot target another session', () => {
  it('every Tower call addresses the derived self id', async () => {
    // Drive the real port bindings by letting the orchestrator mock invoke them.
    mockRunSelfRefresh.mockImplementation(async (opts: Record<string, unknown>) => {
      const terminal = opts.terminal as {
        scheduleReentry: (m: string, d: number) => Promise<void>;
        sendRaw: (t: string) => Promise<void>;
      };
      await terminal.scheduleReentry('re-entry frame', 15);
      await terminal.sendRaw('/clear');
      return {
        outcome: 'completed',
        steps: [{ name: 'clear', at: 1 }],
        statePath: '/s',
        stateBytes: 2048,
      };
    });

    const { selfRefresh } = await importCommand();
    await selfRefresh({});

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    for (const call of mockSendMessage.mock.calls) {
      const [target, , opts] = call;
      expect(target, 'every Tower call must address the derived self id').toBe('spir-1470');
      expect((opts as { from: string }).from).toBe('spir-1470');
    }
  });

  it('addresses ITS OWN id even when another builder exists in the registry', async () => {
    // If the command ever resolved a target from anywhere but the worktree,
    // this is where it would show up.
    mockFindBuilderById.mockImplementation((id: string) => (id === 'spir-1470' ? SELF : OTHER));
    mockRunSelfRefresh.mockImplementation(async (opts: Record<string, unknown>) => {
      const terminal = opts.terminal as { sendRaw: (t: string) => Promise<void> };
      await terminal.sendRaw('/clear');
      return { outcome: 'completed', steps: [], statePath: '/s', stateBytes: 1 };
    });

    const { selfRefresh } = await importCommand();
    await selfRefresh({});

    expect(mockSendMessage).toHaveBeenCalledWith('spir-1470', '/clear', expect.anything());
    expect(mockSendMessage).not.toHaveBeenCalledWith(
      'spir-9999',
      expect.anything(),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Port wiring — the mistakes the orchestrator cannot see
// ---------------------------------------------------------------------------

describe('port bindings', () => {
  it('delivers /clear through the RAW route, never escape', async () => {
    // Tower's escape route writes a hardcoded ESC and DISCARDS the body, so
    // binding this to escape would turn /clear into an interrupt: the run would
    // report success while the builder kept its entire context.
    mockRunSelfRefresh.mockImplementation(async (opts: Record<string, unknown>) => {
      const terminal = opts.terminal as { sendRaw: (t: string) => Promise<void> };
      await terminal.sendRaw('/clear');
      return { outcome: 'completed', steps: [], statePath: '/s', stateBytes: 1 };
    });

    const { selfRefresh } = await importCommand();
    await selfRefresh({});

    const [, text, opts] = mockSendMessage.mock.calls[0];
    expect(text).toBe('/clear');
    expect((opts as { raw?: boolean }).raw).toBe(true);
    expect((opts as { escape?: boolean }).escape).toBeUndefined();
  });

  it('schedules the re-entry with deliverAfter, and NOT as raw', async () => {
    // Raw would type the frame as literal input rather than delivering it as a
    // message; deliverAfter is what puts it in the durable mailbox.
    mockRunSelfRefresh.mockImplementation(async (opts: Record<string, unknown>) => {
      const terminal = opts.terminal as {
        scheduleReentry: (m: string, d: number) => Promise<void>;
      };
      await terminal.scheduleReentry('FRAME', 42);
      return { outcome: 'completed', steps: [], statePath: '/s', stateBytes: 1 };
    });

    const { selfRefresh } = await importCommand();
    await selfRefresh({});

    const [, message, opts] = mockSendMessage.mock.calls[0];
    expect(message).toBe('FRAME');
    expect((opts as { deliverAfter?: number }).deliverAfter).toBe(42);
    expect((opts as { raw?: boolean }).raw).toBeUndefined();
  });

  it('reports a failed Tower send as a thrown error, not a silent success', async () => {
    mockSendMessage.mockResolvedValue({ ok: false, error: 'tower said no' });
    mockRunSelfRefresh.mockImplementation(async (opts: Record<string, unknown>) => {
      const terminal = opts.terminal as { sendRaw: (t: string) => Promise<void> };
      await expect(terminal.sendRaw('/clear')).rejects.toThrow(/tower said no/);
      return { outcome: 'aborted', steps: [], statePath: '/s', failure: 'clear-failed' };
    });

    const { selfRefresh } = await importCommand();
    await selfRefresh({});
    expect(process.exitCode).toBe(1);
  });

  it('detects uncommitted tracked changes via git exit status', async () => {
    mockRunSelfRefresh.mockImplementation(async (opts: Record<string, unknown>) => {
      const git = opts.git as { hasUncommittedTrackedChanges: () => boolean };
      expect(git.hasUncommittedTrackedChanges()).toBe(false);

      mockExecFileSync.mockImplementation(() => {
        throw new Error('exit 1');
      });
      expect(git.hasUncommittedTrackedChanges()).toBe(true);

      return { outcome: 'completed', steps: [], statePath: '/s', stateBytes: 1 };
    });

    const { selfRefresh } = await importCommand();
    await selfRefresh({});
  });
});

// ---------------------------------------------------------------------------
// The boundary guard must not be opt-in
// ---------------------------------------------------------------------------

describe('expectedBoundary', () => {
  it('is ALWAYS passed through to the orchestrator', async () => {
    // Phase 3's review: an optional guard that callers may omit protects nobody
    // by default. The CLI must always hand it over.
    const { selfRefresh } = await importCommand();
    await selfRefresh({ boundary: 'enter:review' });

    expect(mockRunSelfRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ expectedBoundary: 'enter:review' }),
    );
  });

  it('passes the key even when no boundary is known, as an explicit no-expectation', async () => {
    const { selfRefresh } = await importCommand();
    await selfRefresh({});

    const call = mockRunSelfRefresh.mock.calls[0][0] as Record<string, unknown>;
    expect('expectedBoundary' in call).toBe(true);
    expect(call.expectedBoundary).toBeUndefined();
  });

  it('binds the boundary into the challenge at begin', async () => {
    const { selfRefresh } = await importCommand();
    await selfRefresh({ begin: true, boundary: 'enter:implement' });

    expect(mockBeginSelfRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ boundary: 'enter:implement' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Flag validation at the boundary
// ---------------------------------------------------------------------------

describe('safety flag validation', () => {
  const flags = [
    ['minBytes', '--min-bytes'],
    ['delay', '--delay'],
    ['stabilityWindow', '--stability-window'],
    ['challengeMaxAge', '--challenge-max-age'],
  ] as const;

  for (const [key, flag] of flags) {
    for (const bad of ['0', '-1', 'abc']) {
      it(`rejects ${flag} ${bad}`, async () => {
        const { selfRefresh } = await importCommand();
        // Message differs by reason — non-numeric vs below floor — so assert the
        // flag is named and that nothing ran, rather than pinning prose.
        await expect(selfRefresh({ [key]: bad })).rejects.toThrow(
          new RegExp(flag.replace(/-/g, '\\-')),
        );
        expect(mockRunSelfRefresh).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
      });
    }
  }

  it('rejects a FRACTIONAL delay, the fatal direction', async () => {
    // `--delay 0.001` would let the re-entry and the clear race for the same
    // clean prompt; if the re-entry lands first it is delivered and immediately
    // wiped — a cleared builder with nobody coming back.
    const { selfRefresh } = await importCommand();
    await expect(selfRefresh({ delay: '0.001' })).rejects.toThrow(/whole number/i);
    expect(mockRunSelfRefresh).not.toHaveBeenCalled();
  });

  it.each([
    ['minBytes', '1', '--min-bytes'],
    ['stabilityWindow', '1', '--stability-window'],
    ['delay', '1', '--delay'],
  ])('rejects a positive-but-too-small %s', async (key, value) => {
    // Validity is not sanity: each of these neuters the gate it configures while
    // still reporting success.
    const { selfRefresh } = await importCommand();
    await expect(selfRefresh({ [key]: value })).rejects.toThrow(/must be at least/i);
    expect(mockRunSelfRefresh).not.toHaveBeenCalled();
  });

  it('accepts valid values and forwards them', async () => {
    const { selfRefresh } = await importCommand();
    await selfRefresh({ minBytes: '2000', delay: '20' });

    expect(mockRunSelfRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ minBytes: 2000, reentryDelaySeconds: 20 }),
    );
  });
});

// ---------------------------------------------------------------------------
// begin is the harmless half
// ---------------------------------------------------------------------------

describe('begin', () => {
  it('does not require Tower, because it destroys nothing', async () => {
    // Requiring a live Tower here would fail the harmless half of the handshake
    // for a reason that only matters to the destructive half.
    mockIsRunning.mockResolvedValue(false);
    const { selfRefresh } = await importCommand();

    await selfRefresh({ begin: true });

    expect(mockBeginSelfRefresh).toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('never runs the orchestrator', async () => {
    const { selfRefresh } = await importCommand();
    await selfRefresh({ begin: true });
    expect(mockRunSelfRefresh).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Execute refuses without Tower — a clear with no re-entry is unrecoverable
// ---------------------------------------------------------------------------

describe('execute preflight', () => {
  it('refuses to run when Tower is down', async () => {
    mockIsRunning.mockResolvedValue(false);
    const { selfRefresh } = await importCommand();

    await expect(selfRefresh({})).rejects.toThrow(/Tower is not running/);
    expect(mockRunSelfRefresh).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

describe('exit codes', () => {
  it('exits non-zero when the refresh is refused', async () => {
    // Refusing is the SAFE outcome, but silence would let a caller read
    // "refused to clear" as "cleared and fine".
    mockRunSelfRefresh.mockResolvedValue({
      outcome: 'aborted',
      steps: [],
      statePath: '/s',
      failure: 'receipt-rejected',
      reason: 'too small',
    });

    const { selfRefresh } = await importCommand();
    await selfRefresh({});
    expect(process.exitCode).toBe(1);
  });

  it('leaves the exit code alone on success', async () => {
    const { selfRefresh } = await importCommand();
    await selfRefresh({});
    expect(process.exitCode).toBeUndefined();
  });

  it('does NOT exit non-zero on a clean dry run', async () => {
    // A rehearsal that verified and assembled is a success. Phase 3 gave it a
    // distinct outcome precisely so this branch could not be got wrong.
    mockRunSelfRefresh.mockResolvedValue({
      outcome: 'dry-run',
      steps: [],
      statePath: '/s',
      stateBytes: 2048,
      payload: { inline: 'FRAME', longForm: 'L', longFormFileName: 'f' },
    });

    const { selfRefresh } = await importCommand();
    await selfRefresh({ dryRun: true });
    expect(process.exitCode).toBeUndefined();
  });
});
