/**
 * Tests for `codev.openPRById` (issue #1179) — the browser-open routing of the
 * PR mirror of `openIssueById`. `open-pr-by-id.ts` imports `vscode` at module
 * load, so we stub it (the established pattern from open-issue-by-id.test.ts)
 * with controllable window / env spies.
 *
 * Input validation itself is `parseIssueId`, exhaustively covered in
 * open-issue-by-id.test.ts — here we only assert the PR command wires it in
 * (`#42` → fetches `42`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const showInputBox = vi.fn();
const showErrorMessage = vi.fn();
const showWarningMessage = vi.fn();
const openExternal = vi.fn();
const executeCommand = vi.fn();

vi.mock('vscode', () => ({
  window: { showInputBox, showErrorMessage, showWarningMessage },
  env: { openExternal },
  commands: { executeCommand },
  Uri: { parse: (s: string) => ({ toString: () => s, __parsed: s }) },
}));

const { openPRById, openPRInBrowser } = await import('../commands/open-pr-by-id.js');

const makeConn = (overrides: Record<string, unknown> = {}) => ({
  getState: () => 'connected',
  getWorkspacePath: () => '/ws',
  getClient: () => ({ getPR: vi.fn().mockResolvedValue({ title: 't', body: '', state: 'MERGED', url: 'https://forge/pull/42' }) }),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('openPRById', () => {
  it('opens the forge url in the browser when present', async () => {
    showInputBox.mockResolvedValue('42');
    await openPRById(makeConn() as never);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal.mock.calls[0][0].__parsed).toBe('https://forge/pull/42');
  });

  it('accepts a #-prefixed id and fetches the bare number (parseIssueId reuse)', async () => {
    showInputBox.mockResolvedValue('#42');
    const getPR = vi.fn().mockResolvedValue({ title: 't', body: '', state: 'OPEN', url: 'https://forge/pull/42' });
    await openPRById(makeConn({ getClient: () => ({ getPR }) }) as never);
    expect(getPR).toHaveBeenCalledWith('42', '/ws');
  });

  it('warns when the PR is not found', async () => {
    showInputBox.mockResolvedValue('42');
    const conn = makeConn({ getClient: () => ({ getPR: vi.fn().mockResolvedValue(null) }) });
    await openPRById(conn as never);
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('warns when the PR resolves without a url (no in-editor PR preview to fall back to)', async () => {
    showInputBox.mockResolvedValue('42');
    const conn = makeConn({ getClient: () => ({ getPR: vi.fn().mockResolvedValue({ title: 't', body: '', state: 'OPEN' }) }) });
    await openPRById(conn as never);
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('errors when not connected to Tower', async () => {
    showInputBox.mockResolvedValue('42');
    const conn = makeConn({ getState: () => 'disconnected' });
    await openPRById(conn as never);
    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('does nothing when the input box is dismissed', async () => {
    showInputBox.mockResolvedValue(undefined);
    await openPRById(makeConn() as never);
    expect(openExternal).not.toHaveBeenCalled();
    expect(showWarningMessage).not.toHaveBeenCalled();
  });
});

describe('openPRInBrowser', () => {
  it('opens the browser directly without any input box (QuickPick dynamic-item path)', async () => {
    await openPRInBrowser(makeConn() as never, '42');
    expect(showInputBox).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal.mock.calls[0][0].__parsed).toBe('https://forge/pull/42');
  });
});
