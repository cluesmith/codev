// Tests for `afx inbox` CLI handlers (Spec 1313, Phase 7).
// Mocks TowerClient.request to test the list/dismiss handlers in isolation — the
// projection they render, the query they build, the escalation marker, and the
// 404 path. The DB-touching route + delivery behavior is covered by the mailbox
// and send/cron-delivery unit tests; here we test only the CLI surface.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockRequest = vi.hoisted(() => vi.fn());

vi.mock('../lib/tower-client.js', () => ({
  DEFAULT_TOWER_PORT: 4100,
  getTowerClient: () => ({ request: mockRequest }),
}));

// Mock logger to capture output; fatal throws instead of process.exit.
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

// Config drives the workspace-scoped default (decision 8): `afx inbox` with no
// --workspace lists the current workspace, so the handler queries getConfig().workspaceRoot.
const CURRENT_WS = '/home/user/project';
const mockGetConfig = vi.hoisted(() => vi.fn());
vi.mock('../utils/config.js', () => ({ getConfig: mockGetConfig }));

import { inboxList, inboxDismiss } from '../commands/inbox.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockReturnValue({ workspaceRoot: CURRENT_WS });
});

/** One held row as GET /api/inbox returns it (metadata only — never a body). */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'abcdef01-2345-6789-abcd-ef0123456789',
    workspacePath: '/home/user/project',
    toAgent: 'spir-1',
    fromAgent: 'architect',
    reason: 'busy',
    escalated: false,
    createdAt: Date.now() - 5000,
    ...overrides,
  };
}

// ============================================================================
// inboxList
// ============================================================================

describe('inboxList', () => {
  it('lists held rows in table format (header + separator + one row per message)', async () => {
    mockRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: [row(), row({ id: 'ffffffff-0000-0000-0000-000000000000', toAgent: 'spir-2', reason: 'no-profile' })],
    });

    await inboxList();

    expect(mockRequest).toHaveBeenCalledWith('/api/inbox?workspace=%2Fhome%2Fuser%2Fproject');
    expect(mockLogger.header).toHaveBeenCalledWith('Held messages (2)');
    // Header row + separator + 2 data rows = 4 row() calls.
    expect(mockLogger.row).toHaveBeenCalledTimes(4);
  });

  it('shows a friendly message when nothing is held', async () => {
    mockRequest.mockResolvedValue({ ok: true, status: 200, data: [] });

    await inboxList();

    expect(mockLogger.info).toHaveBeenCalledWith('No held messages.');
    expect(mockLogger.header).not.toHaveBeenCalled();
  });

  it('scopes to a workspace when --workspace is given (URL-encoded query)', async () => {
    mockRequest.mockResolvedValue({ ok: true, status: 200, data: [] });

    await inboxList({ workspace: '/ws1' });

    expect(mockRequest).toHaveBeenCalledWith('/api/inbox?workspace=%2Fws1');
  });

  it('defaults to the current workspace (from config) when --workspace is omitted', async () => {
    mockRequest.mockResolvedValue({ ok: true, status: 200, data: [] });

    await inboxList();

    // Decision 8: workspace-scoped — the default query carries the current workspace root.
    expect(mockRequest).toHaveBeenCalledWith('/api/inbox?workspace=%2Fhome%2Fuser%2Fproject');
  });

  it('marks an escalated row with a trailing "!" on its reason', async () => {
    mockRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: [row({ reason: 'busy', escalated: true })],
    });

    await inboxList();

    const dataRow = mockLogger.row.mock.calls.find(
      (c) => Array.isArray(c[0]) && (c[0] as string[]).includes('busy!'),
    );
    expect(dataRow).toBeDefined();
  });

  it('calls fatal on an API error', async () => {
    mockRequest.mockResolvedValue({ ok: false, status: 0, error: 'Tower not running' });

    await expect(inboxList()).rejects.toThrow('FATAL: Tower not running');
  });
});

// ============================================================================
// inboxDismiss
// ============================================================================

describe('inboxDismiss', () => {
  it('POSTs the dismiss and reports success', async () => {
    mockRequest.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });

    await inboxDismiss('abc123');

    expect(mockRequest).toHaveBeenCalledWith('/api/inbox/abc123/dismiss', { method: 'POST' });
    expect(mockLogger.success).toHaveBeenCalledWith('Dismissed held message abc123');
  });

  it('URL-encodes the id in the path', async () => {
    mockRequest.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });

    await inboxDismiss('a b/c');

    expect(mockRequest).toHaveBeenCalledWith('/api/inbox/a%20b%2Fc/dismiss', { method: 'POST' });
  });

  it('calls fatal when the id names no held row (404)', async () => {
    mockRequest.mockResolvedValue({ ok: false, status: 404, error: "No held message with id 'nope'" });

    await expect(inboxDismiss('nope')).rejects.toThrow("FATAL: No held message with id 'nope'");
  });
});
