// Tests for `af cron` CLI handlers (Spec 399 Phase 4)
// Mocks TowerClient.request to test each handler function.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock TowerClient via tower-client module
const mockRequest = vi.hoisted(() => vi.fn());

vi.mock('../lib/tower-client.js', () => ({
  DEFAULT_TOWER_PORT: 4100,
  getTowerClient: () => ({ request: mockRequest }),
}));

// Mock logger to capture output; fatal throws instead of process.exit
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  header: vi.fn(),
  kv: vi.fn(),
  blank: vi.fn(),
  row: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
  fatal: vi.fn((msg: string) => {
    throw new Error(`FATAL: ${msg}`);
  }),
}));

import { cronList, cronStatus, cronRun, cronEnable, cronDisable } from '../commands/cron.js';
import { fatal } from '../utils/logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// cronList
// ============================================================================

describe('cronList', () => {
  it('displays tasks in table format', async () => {
    mockRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: [
        { name: 'CI Check', schedule: '*/30 * * * *', enabled: true, workspacePath: '/home/user/project' },
        { name: 'Stale PRs', schedule: '0 */4 * * *', enabled: false, workspacePath: '/home/user/other' },
      ],
    });

    await cronList();

    expect(mockRequest).toHaveBeenCalledWith('/api/cron/tasks');
    expect(mockLogger.header).toHaveBeenCalledWith('Cron Tasks');
    // Header row + separator + 2 data rows = 4 calls
    expect(mockLogger.row).toHaveBeenCalledTimes(4);
  });

  it('shows message when no tasks', async () => {
    mockRequest.mockResolvedValue({ ok: true, status: 200, data: [] });

    await cronList();

    expect(mockLogger.info).toHaveBeenCalledWith('No cron tasks configured.');
    expect(mockLogger.header).not.toHaveBeenCalled();
  });

  it('passes workspace filter when not --all', async () => {
    mockRequest.mockResolvedValue({ ok: true, status: 200, data: [] });

    await cronList({ workspace: '/ws1' });

    expect(mockRequest).toHaveBeenCalledWith('/api/cron/tasks?workspace=%2Fws1');
  });

  it('skips workspace filter when --all', async () => {
    mockRequest.mockResolvedValue({ ok: true, status: 200, data: [] });

    await cronList({ all: true, workspace: '/ws1' });

    expect(mockRequest).toHaveBeenCalledWith('/api/cron/tasks');
  });

  it('calls fatal on API error', async () => {
    mockRequest.mockResolvedValue({ ok: false, status: 0, error: 'Tower not running' });

    await expect(cronList()).rejects.toThrow('FATAL: Tower not running');
  });
});

// ============================================================================
// cronStatus
// ============================================================================

describe('cronStatus', () => {
  it('displays task details with last run info', async () => {
    mockRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        name: 'CI Check',
        schedule: '*/30 * * * *',
        enabled: true,
        command: 'echo test',
        target: 'architect',
        timeout: 30,
        workspacePath: '/ws',
        last_run: 1700000000,
        last_result: 'success',
        last_output: 'output text',
      },
    });

    await cronStatus('CI Check');

    expect(mockRequest).toHaveBeenCalledWith('/api/cron/tasks/CI%20Check/status');
    expect(mockLogger.header).toHaveBeenCalledWith('Task: CI Check');
    expect(mockLogger.kv).toHaveBeenCalledWith('Schedule', '*/30 * * * *');
    expect(mockLogger.kv).toHaveBeenCalledWith('Last Result', 'success');
  });

  it('shows never when no last run', async () => {
    mockRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        name: 'CI Check',
        schedule: '*/30 * * * *',
        enabled: true,
        command: 'echo test',
        target: 'architect',
        timeout: 30,
        workspacePath: '/ws',
        last_run: null,
        last_result: null,
      },
    });

    await cronStatus('CI Check');

    expect(mockLogger.kv).toHaveBeenCalledWith('Last Run', 'never');
  });

  it('passes workspace query param', async () => {
    mockRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        name: 'T', schedule: '@hourly', enabled: true, command: 'x',
        target: 'architect', timeout: 30, workspacePath: '/ws',
        last_run: null, last_result: null,
      },
    });

    await cronStatus('T', { workspace: '/ws' });

    expect(mockRequest).toHaveBeenCalledWith('/api/cron/tasks/T/status?workspace=%2Fws');
  });
});

// ============================================================================
// cronRun
// ============================================================================

describe('cronRun', () => {
  it('triggers task and shows success', async () => {
    mockRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true, result: 'success', output: 'done' },
    });

    await cronRun('CI Check');

    expect(mockRequest).toHaveBeenCalledWith('/api/cron/tasks/CI%20Check/run', { method: 'POST' });
    expect(mockLogger.success).toHaveBeenCalledWith("Task 'CI Check' completed successfully");
  });

  it('shows failure result', async () => {
    mockRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true, result: 'failure', output: 'error msg' },
    });

    await cronRun('CI Check');

    expect(mockLogger.error).toHaveBeenCalledWith("Task 'CI Check' failed");
  });
});

// ============================================================================
// cronEnable / cronDisable
// ============================================================================

describe('cronEnable', () => {
  it('enables a task', async () => {
    mockRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true, enabled: true },
    });

    await cronEnable('CI Check');

    expect(mockRequest).toHaveBeenCalledWith('/api/cron/tasks/CI%20Check/enable', { method: 'POST' });
    expect(mockLogger.success).toHaveBeenCalledWith("Task 'CI Check' enabled");
  });
});

describe('cronDisable', () => {
  it('disables a task', async () => {
    mockRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true, enabled: false },
    });

    await cronDisable('CI Check');

    expect(mockRequest).toHaveBeenCalledWith('/api/cron/tasks/CI%20Check/disable', { method: 'POST' });
    expect(mockLogger.success).toHaveBeenCalledWith("Task 'CI Check' disabled");
  });

  it('passes workspace param', async () => {
    mockRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true, enabled: false },
    });

    await cronDisable('CI Check', { workspace: '/ws' });

    expect(mockRequest).toHaveBeenCalledWith(
      '/api/cron/tasks/CI%20Check/disable?workspace=%2Fws',
      { method: 'POST' },
    );
  });
});
