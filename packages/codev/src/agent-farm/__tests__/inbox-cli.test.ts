// Tests for `afx inbox` CLI handlers (Spec 1313, Phase 7).
// Mocks TowerClient.request to test the list/dismiss handlers in isolation — the
// projection they render, the query they build, the escalation marker, and the
// 404 path. The DB-touching route + delivery behavior is covered by the mailbox
// and send/cron-delivery unit tests; here we test only the CLI surface.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MAX_SENDER_ID_LENGTH } from '../utils/message-format.js';

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

import { inboxList, inboxShow, inboxDismiss } from '../commands/inbox.js';

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

  // Issue #1478: FROM → TO is the column whose whole job is identity. It used to be
  // hard-sliced to 22 chars, so long builder ids and `architect:<name>` senders were
  // silently cut mid-name — an identity the operator cannot act on.
  describe('FROM → TO column (issue #1478)', () => {
    /** The FROM → TO cell (index 3) of the single rendered data row. */
    function fromToCell(): { cell: string; width: number } {
      const dataRow = mockLogger.row.mock.calls[2];
      return { cell: (dataRow[0] as string[])[3], width: (dataRow[1] as number[])[3] };
    }

    it('renders a long from → to pair in full instead of truncating it', async () => {
      const longFrom = 'architect:integration-review';
      const longTo = 'builder-aspir-1478-carry-architect-name';
      mockRequest.mockResolvedValue({
        ok: true,
        status: 200,
        data: [row({ fromAgent: longFrom, toAgent: longTo })],
      });

      await inboxList();

      const { cell, width } = fromToCell();
      expect(cell).toBe(`${longFrom} → ${longTo}`);
      // …and the column is wide enough to hold it, so padEnd can't clip it either.
      expect(width).toBeGreaterThanOrEqual(cell.length);
    });

    it('sizes the column to the widest row, and never below its header', async () => {
      mockRequest.mockResolvedValue({
        ok: true,
        status: 200,
        data: [
          row({ fromAgent: 'architect:main', toAgent: 'spir-1' }),
          row({ id: 'ffffffff-0000-0000-0000-000000000000', fromAgent: 'architect:main', toAgent: 'builder-a-very-long-builder-id' }),
        ],
      });

      await inboxList();

      const widest = 'architect:main → builder-a-very-long-builder-id'.length;
      const headerWidth = (mockLogger.row.mock.calls[0][1] as number[])[3];
      // One width for the whole column — header, separator and every data row share it.
      expect(headerWidth).toBeGreaterThanOrEqual(widest);
      for (const call of mockLogger.row.mock.calls) {
        expect((call[1] as number[])[3]).toBe(headerWidth);
      }
    });

    it('keeps a short table compact — the column never shrinks below "FROM → TO"', async () => {
      mockRequest.mockResolvedValue({ ok: true, status: 200, data: [row({ fromAgent: 'a', toAgent: 'b' })] });

      await inboxList();

      expect(fromToCell().width).toBeGreaterThanOrEqual('FROM → TO'.length);
    });

    it('renders a missing sender as "?" (unchanged)', async () => {
      mockRequest.mockResolvedValue({ ok: true, status: 200, data: [row({ fromAgent: null })] });

      await inboxList();

      expect(fromToCell().cell).toBe('? → spir-1');
    });

    // Maintainer review (PR #1486): sizing to content means ONE oversized stored value
    // sets the padding for EVERY row. `POST /api/send` now refuses such a sender, so
    // this is defence in depth for rows written before that check — and it must not
    // become the 22-char truncation again, which was the defect.
    it('shows a pair of maximum-length legitimate ids whole', async () => {
      const maxFrom = `architect:${'a'.repeat(MAX_SENDER_ID_LENGTH - 'architect:'.length)}`;
      const maxTo = 'b'.repeat(MAX_SENDER_ID_LENGTH);
      mockRequest.mockResolvedValue({
        ok: true,
        status: 200,
        data: [row({ fromAgent: maxFrom, toAgent: maxTo })],
      });

      await inboxList();

      const { cell, width } = fromToCell();
      expect(cell).toBe(`${maxFrom} → ${maxTo}`);
      expect(cell).not.toContain('…');
      expect(width).toBeGreaterThanOrEqual(cell.length);
    });

    it('caps a stored sender that exceeds the identity bound, and does not pad every row to it', async () => {
      mockRequest.mockResolvedValue({
        ok: true,
        status: 200,
        data: [row({ fromAgent: 'x'.repeat(200_000), toAgent: 'spir-1' })],
      });

      await inboxList();

      const { cell, width } = fromToCell();
      const ceiling = MAX_SENDER_ID_LENGTH * 2 + ' → '.length;
      expect(cell.length).toBe(ceiling);
      expect(cell.endsWith('…')).toBe(true);
      expect(width).toBeLessThanOrEqual(ceiling + 2);
    });
  });
});

// ============================================================================
// inboxShow
// ============================================================================

describe('inboxShow', () => {
  /** A full row as GET /api/inbox/:id returns it — INCLUDING the body. */
  function fullRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'abcdef01-2345-6789-abcd-ef0123456789',
      workspacePath: '/home/user/project',
      toAgent: 'spir-1',
      fromAgent: 'architect',
      fromWorkspace: null,
      status: 'held',
      reason: 'busy',
      escalated: false,
      body: 'the full secret message body',
      createdAt: 1_700_000_000_000,
      resolvedAt: null,
      ...overrides,
    };
  }

  it('prints the message body verbatim (the show view surfaces the body, unlike the list)', async () => {
    // The body is printed raw via console.log (no [info]/indent decoration). The logger
    // mock's methods don't reach console, so console.log carries only the body here.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockRequest.mockResolvedValue({ ok: true, status: 200, data: fullRow() });

    await inboxShow('abcdef01-2345-6789-abcd-ef0123456789');

    expect(mockRequest).toHaveBeenCalledWith('/api/inbox/abcdef01-2345-6789-abcd-ef0123456789');
    expect(logSpy).toHaveBeenCalledWith('the full secret message body');
    // Metadata renders through logger.kv.
    expect(mockLogger.kv).toHaveBeenCalledWith('Status', 'held');
    logSpy.mockRestore();
  });

  it('marks an escalated row and shows fromWorkspace when present', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: fullRow({ escalated: true, fromWorkspace: 'marketmaker' }),
    });

    await inboxShow('abc');

    expect(mockLogger.kv).toHaveBeenCalledWith('Status', 'held (escalated)');
    expect(mockLogger.kv).toHaveBeenCalledWith('From → To', 'architect (marketmaker) → spir-1');
    logSpy.mockRestore();
  });

  it('URL-encodes the id in the path', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockRequest.mockResolvedValue({ ok: true, status: 200, data: fullRow() });

    await inboxShow('a b/c');

    expect(mockRequest).toHaveBeenCalledWith('/api/inbox/a%20b%2Fc');
    logSpy.mockRestore();
  });

  it('calls fatal when the id names no row (404)', async () => {
    mockRequest.mockResolvedValue({ ok: false, status: 404, error: "No message with id 'nope'" });

    await expect(inboxShow('nope')).rejects.toThrow("FATAL: No message with id 'nope'");
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
