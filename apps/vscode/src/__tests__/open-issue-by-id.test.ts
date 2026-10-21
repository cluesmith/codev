/**
 * Tests for `codev.openIssueById` — the pure `parseIssueId` normalizer and the
 * command handler's browser-vs-fallback routing. `open-issue-by-id.ts` imports
 * `vscode` at module load, so we stub it (the established pattern from
 * command-relay.test.ts) with controllable window / env / commands spies.
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

const { parseIssueId, parseIssueInput, openIssueById } = await import('../commands/open-issue-by-id.js');

describe('parseIssueId', () => {
  it('accepts a bare numeric id', () => {
    expect(parseIssueId('1234')).toBe('1234');
  });

  it('accepts a single leading hash', () => {
    expect(parseIssueId('#1234')).toBe('1234');
  });

  it('trims surrounding whitespace', () => {
    expect(parseIssueId('  1234  ')).toBe('1234');
    expect(parseIssueId(' #1234 ')).toBe('1234');
  });

  it('preserves leading zeros as typed (normalization is the forge\'s job)', () => {
    expect(parseIssueId('007')).toBe('007');
  });

  it('rejects empty / whitespace-only input', () => {
    expect(parseIssueId('')).toBeUndefined();
    expect(parseIssueId('   ')).toBeUndefined();
  });

  it('rejects a lone hash', () => {
    expect(parseIssueId('#')).toBeUndefined();
    expect(parseIssueId(' # ')).toBeUndefined();
  });

  it('rejects non-numeric input', () => {
    expect(parseIssueId('abc')).toBeUndefined();
    expect(parseIssueId('12a3')).toBeUndefined();
    expect(parseIssueId('12.3')).toBeUndefined();
    expect(parseIssueId('-5')).toBeUndefined();
  });

  it('rejects more than one leading hash', () => {
    expect(parseIssueId('##12')).toBeUndefined();
    expect(parseIssueId('#12#')).toBeUndefined();
  });
});

describe('openIssueById', () => {
  const makeConn = (overrides: Record<string, unknown> = {}) => ({
    getState: () => 'connected',
    getWorkspacePath: () => '/ws',
    getClient: () => ({ getIssue: vi.fn().mockResolvedValue({ title: 't', body: '', state: 'open', url: 'https://forge/issues/42', comments: [] }) }),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the forge url in the browser when present', async () => {
    showInputBox.mockResolvedValue('42');
    const conn = makeConn();
    await openIssueById(conn as never);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal.mock.calls[0][0].__parsed).toBe('https://forge/issues/42');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('accepts a #-prefixed id and fetches the bare number', async () => {
    showInputBox.mockResolvedValue('#42');
    const getIssue = vi.fn().mockResolvedValue({ title: 't', body: '', state: 'open', url: 'https://forge/issues/42', comments: [] });
    await openIssueById(makeConn({ getClient: () => ({ getIssue }) }) as never);
    expect(getIssue).toHaveBeenCalledWith('42', '/ws');
  });

  it('falls back to the in-editor preview when the issue has no url', async () => {
    showInputBox.mockResolvedValue('42');
    const conn = makeConn({ getClient: () => ({ getIssue: vi.fn().mockResolvedValue({ title: 't', body: '', state: 'open', comments: [] }) }) });
    await openIssueById(conn as never);
    expect(openExternal).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledWith('codev.viewBacklogIssue', '42');
  });

  it('warns when the issue is not found', async () => {
    showInputBox.mockResolvedValue('42');
    const conn = makeConn({ getClient: () => ({ getIssue: vi.fn().mockResolvedValue(null) }) });
    await openIssueById(conn as never);
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('errors when not connected to Tower', async () => {
    showInputBox.mockResolvedValue('42');
    const conn = makeConn({ getState: () => 'disconnected' });
    await openIssueById(conn as never);
    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('does nothing when the input box is dismissed', async () => {
    showInputBox.mockResolvedValue(undefined);
    await openIssueById(makeConn() as never);
    expect(openExternal).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
    expect(showWarningMessage).not.toHaveBeenCalled();
  });
});

describe('tracker keys in Open Issue by ID (#1740)', () => {
  it('parseIssueId stays numeric-only (Open PR by ID shares it)', () => {
    expect(parseIssueId('ENG-12')).toBeUndefined();
  });

  it('parseIssueInput accepts keys only when allowed, canonicalized', () => {
    expect(parseIssueInput(' eng-12 ', true)).toBe('ENG-12');
    expect(parseIssueInput('#ENG-12', true)).toBe('ENG-12');
    expect(parseIssueInput('42', true)).toBe('42');
    expect(parseIssueInput('ENG-12', false)).toBeUndefined();
    expect(parseIssueInput('UTF 8', true)).toBeUndefined();
  });

  function validatorFor(getOverview?: () => unknown) {
    let validate: ((v: string) => string | undefined) | undefined;
    showInputBox.mockImplementation(async (opts: { validateInput: (v: string) => string | undefined }) => {
      validate = opts.validateInput;
      return undefined;
    });
    return openIssueById({} as never, getOverview as never).then(() => validate!);
  }

  it('rejects a key inline on a numeric-id workspace', async () => {
    const validate = await validatorFor(() => ({ issueIdKind: 'number', backlog: [] }));
    expect(validate('ABC-12')).toMatch(/numeric/);
    expect(validate('42')).toBeUndefined();
  });

  it('accepts a key on a Jira workspace, even with an empty backlog', async () => {
    const validate = await validatorFor(() => ({ issueIdKind: 'key', backlog: [] }));
    expect(validate('PROJ-123')).toBeUndefined();
  });

  it('accepts a key when the kind is unknown (overview not loaded)', async () => {
    const validate = await validatorFor(() => null);
    expect(validate('PROJ-123')).toBeUndefined();
  });

  it('fetches the canonical key', async () => {
    showInputBox.mockResolvedValue('proj-123');
    const getIssue = vi.fn().mockResolvedValue({ title: 't', body: '', state: 'open', url: 'https://x/browse/PROJ-123', comments: [] });
    const conn = { getState: () => 'connected', getWorkspacePath: () => '/ws', getClient: () => ({ getIssue }) };
    await openIssueById(conn as never, () => ({ issueIdKind: 'key', backlog: [] }) as never);
    expect(getIssue).toHaveBeenCalledWith('PROJ-123', '/ws');
  });
});
