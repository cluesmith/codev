/**
 * `afx workspace name <name>` and `afx workspace name --clear` (Spec 1940, phase 3).
 *
 * The command asks Tower and reports what Tower answered; the naming rules are Tower's
 * (`workspace-address.test.ts`, and the route in `tower-routes.test.ts`). Here: which
 * workspace it names, what it sends, and what it prints for each answer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockIsRunning, mockSetName, mockDetectWorkspaceRoot, mockLogger } = vi.hoisted(() => ({
  mockIsRunning: vi.fn<() => Promise<boolean>>(),
  mockSetName: vi.fn(),
  mockDetectWorkspaceRoot: vi.fn<() => string | null>(),
  mockLogger: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../lib/tower-client.js', () => ({
  getTowerClient: () => ({ isRunning: mockIsRunning, setWorkspaceAddressName: mockSetName }),
}));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../commands/send.js', () => ({ detectWorkspaceRoot: () => mockDetectWorkspaceRoot() }));

import { workspaceName } from '../commands/workspace-name.js';

const WORKSPACE = '/home/ana/work/codev';

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

describe('afx workspace name', () => {
  let exit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning.mockResolvedValue(true);
    mockDetectWorkspaceRoot.mockReturnValue(WORKSPACE);
    exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exit(code ?? 0);
    }) as never);
  });

  afterEach(() => {
    exit.mockRestore();
  });

  it('names the current workspace and says how another workspace now reaches it', async () => {
    mockSetName.mockResolvedValue({ ok: true, result: { explicitName: 'work', addressName: 'work' } });

    await workspaceName({ name: 'Work' });

    // As typed: Tower lower-cases and checks.
    expect(mockSetName).toHaveBeenCalledWith(WORKSPACE, 'Work');
    expect(mockLogger.success).toHaveBeenCalledWith("This workspace is now addressed as 'work'.");
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('afx send work:architect'));
  });

  it('names the builder\'s workspace, not its worktree, when run from a builder worktree', async () => {
    // `detectWorkspaceRoot` is what maps `<workspace>/.builders/<id>` to `<workspace>`.
    mockSetName.mockResolvedValue({ ok: true, result: { explicitName: 'work', addressName: 'work' } });
    await workspaceName({ name: 'work' });
    expect(mockDetectWorkspaceRoot).toHaveBeenCalledTimes(1);
    expect(mockSetName.mock.calls[0][0]).toBe(WORKSPACE);
  });

  it('--clear sends null and says the workspace is addressed by its directory name again', async () => {
    mockSetName.mockResolvedValue({ ok: true, result: { explicitName: null, addressName: 'codev' } });

    await workspaceName({ clear: true });

    expect(mockSetName).toHaveBeenCalledWith(WORKSPACE, null);
    expect(mockLogger.success).toHaveBeenCalledWith(
      "Explicit name removed. This workspace is addressed by its directory name, 'codev'.",
    );
  });

  it('--clear warns, with the reason, when the workspace is left with no address name', async () => {
    mockSetName.mockResolvedValue({
      ok: true,
      result: { explicitName: null, addressName: null, unaddressableReason: "it shares the directory name 'codev' with /home/ana/codev" },
    });

    await workspaceName({ clear: true });

    expect(mockLogger.success).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Explicit name removed. This workspace now has no address name: it shares the directory name 'codev' with /home/ana/codev",
    );
  });

  it('prints Tower\'s reason and exits 1 when the name is refused', async () => {
    mockSetName.mockResolvedValue({
      ok: false,
      error: "'cloud' is already the name of the workspace /home/ana/codev-cloud. (NAME_TAKEN)",
      errorCode: 'NAME_TAKEN',
    });

    await expect(workspaceName({ name: 'cloud' })).rejects.toThrow('exit 1');

    expect(mockLogger.error).toHaveBeenCalledWith(
      "'cloud' is already the name of the workspace /home/ana/codev-cloud. (NAME_TAKEN)",
    );
    expect(mockLogger.success).not.toHaveBeenCalled();
  });

  it.each([
    ['neither a name nor --clear', {}],
    ['both a name and --clear', { name: 'work', clear: true }],
  ])('exits 1 without asking Tower when given %s', async (_what, options) => {
    await expect(workspaceName(options)).rejects.toThrow('exit 1');
    expect(mockSetName).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });

  it('exits 1 outside any workspace', async () => {
    mockDetectWorkspaceRoot.mockReturnValue(null);
    await expect(workspaceName({ name: 'work' })).rejects.toThrow('exit 1');
    expect(mockSetName).not.toHaveBeenCalled();
  });

  it('exits 1 when Tower is not running', async () => {
    mockIsRunning.mockResolvedValue(false);
    await expect(workspaceName({ name: 'work' })).rejects.toThrow('exit 1');
    expect(mockSetName).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Tower is not running'));
  });
});
