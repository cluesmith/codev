/**
 * PIR #1412: clickable `#N` / `PR #N` terminal references.
 *
 * Two halves: `IssueRefTerminalLinkProvider.provideTerminalLinks` (detection —
 * spans, flags, multiple refs per line) and `openTerminalRef` (resolution —
 * issue-first with the url-based PR discriminator, and the `issueTarget`
 * setting). Both import `vscode` at module load, so we stub it (the established
 * pattern from open-issue-by-id.test.ts), and stub the three reuse helper
 * modules so we can assert delegation without real fetches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const showErrorMessage = vi.fn();
const showWarningMessage = vi.fn();
const getConfiguration = vi.fn();
const executeCommand = vi.fn();

vi.mock('vscode', () => ({
  window: { showErrorMessage, showWarningMessage },
  workspace: { getConfiguration },
  commands: { executeCommand },
}));

const openPRInBrowser = vi.fn();
const openIssueInBrowser = vi.fn();

vi.mock('../commands/open-pr-by-id.js', () => ({ openPRInBrowser }));
vi.mock('../commands/open-issue-by-id.js', () => ({ openIssueInBrowser }));

// terminal-link-provider.ts pulls in terminal-adapter.js (via RECONNECT_LINK_TEXT)
// and terminal-manager types; stub the adapter so the module loads in isolation.
vi.mock('../terminal-adapter.js', () => ({ RECONNECT_LINK_TEXT: '[reconnect]' }));

const { IssueRefTerminalLinkProvider } = await import('../terminal-link-provider.js');
const { openTerminalRef } = await import('../commands/open-terminal-ref.js');

function makeProvider() {
  return new (IssueRefTerminalLinkProvider as unknown as new (cm: unknown) => {
    provideTerminalLinks(ctx: { line: string; terminal: unknown }): Array<{
      startIndex: number; length: number; number: string; isPR: boolean; tooltip: string;
    }>;
  })({});
}

describe('PIR #1412 — IssueRefTerminalLinkProvider detection', () => {
  it('produces no link on an ordinary line', () => {
    expect(makeProvider().provideTerminalLinks({ line: 'nothing to see here', terminal: {} }))
      .toHaveLength(0);
  });

  it('claims a bare #N and spans exactly the token', () => {
    const line = 'see #915 for context';
    const links = makeProvider().provideTerminalLinks({ line, terminal: {} });
    expect(links).toHaveLength(1);
    expect(line.substr(links[0].startIndex, links[0].length)).toBe('#915');
    expect(links[0]).toMatchObject({ number: '915', isPR: false });
  });

  it('claims the whole `PR #N` span (not the inner #N)', () => {
    const line = 'merged PR #1402 today';
    const links = makeProvider().provideTerminalLinks({ line, terminal: {} });
    expect(links).toHaveLength(1);
    expect(line.substr(links[0].startIndex, links[0].length)).toBe('PR #1402');
    expect(links[0]).toMatchObject({ number: '1402', isPR: true });
  });

  it('detects multiple refs per line with correct flags and spans', () => {
    const line = 'see #12 and PR #34 before #56';
    const links = makeProvider().provideTerminalLinks({ line, terminal: {} });
    expect(links).toHaveLength(3);
    expect(links.map((l) => ({ number: l.number, isPR: l.isPR }))).toEqual([
      { number: '12', isPR: false },
      { number: '34', isPR: true },
      { number: '56', isPR: false },
    ]);
    for (const l of links) {
      expect(line.substr(l.startIndex, l.length)).toMatch(/^(PR )?#\d+$/);
    }
  });

  it('ignores non-numeric (#fff) and spaced (# 1) forms', () => {
    expect(makeProvider().provideTerminalLinks({ line: 'color #fff and # 1 heading', terminal: {} }))
      .toHaveLength(0);
  });

  it('is case-insensitive on the PR prefix', () => {
    const links = makeProvider().provideTerminalLinks({ line: 'pr #7', terminal: {} });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ number: '7', isPR: true });
  });
});

describe('PIR #1412 — openTerminalRef resolution', () => {
  const getIssue = vi.fn();
  const connected = {
    getClient: () => ({ getIssue }),
    getWorkspacePath: () => '/work',
    getState: () => 'connected',
  };

  function withSetting(target: string) {
    getConfiguration.mockReturnValue({ get: () => target });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    withSetting('editor');
  });

  it('routes an explicit PR ref straight to openPRInBrowser without a discriminator fetch', async () => {
    await openTerminalRef(connected as never, { number: '1402', isPR: true });
    expect(openPRInBrowser).toHaveBeenCalledWith(connected, '1402');
    expect(getIssue).not.toHaveBeenCalled();
  });

  it('opens a genuine issue in the editor viewer by default', async () => {
    getIssue.mockResolvedValue({ url: 'https://github.com/o/r/issues/915' });
    await openTerminalRef(connected as never, { number: '915', isPR: false });
    expect(executeCommand).toHaveBeenCalledWith('codev.viewBacklogIssue', '915');
    expect(openIssueInBrowser).not.toHaveBeenCalled();
    expect(openPRInBrowser).not.toHaveBeenCalled();
  });

  it('opens a genuine issue in the browser when issueTarget = browser', async () => {
    withSetting('browser');
    getIssue.mockResolvedValue({ url: 'https://github.com/o/r/issues/915' });
    await openTerminalRef(connected as never, { number: '915', isPR: false });
    expect(openIssueInBrowser).toHaveBeenCalledWith(connected, '915');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('falls through to the PR browser-open when a bare #N resolves to a PR url', async () => {
    getIssue.mockResolvedValue({ url: 'https://github.com/o/r/pull/1405' });
    await openTerminalRef(connected as never, { number: '1405', isPR: false });
    expect(openPRInBrowser).toHaveBeenCalledWith(connected, '1405');
    expect(executeCommand).not.toHaveBeenCalled();
    expect(openIssueInBrowser).not.toHaveBeenCalled();
  });

  it('warns and opens nothing when the number is unresolvable', async () => {
    getIssue.mockResolvedValue(null);
    await openTerminalRef(connected as never, { number: '999999', isPR: false });
    expect(showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('#999999'));
    expect(executeCommand).not.toHaveBeenCalled();
    expect(openIssueInBrowser).not.toHaveBeenCalled();
    expect(openPRInBrowser).not.toHaveBeenCalled();
  });

  it('errors on a bare #N click when not connected', async () => {
    const disconnected = { getClient: () => null, getWorkspacePath: () => null, getState: () => 'disconnected' };
    await openTerminalRef(disconnected as never, { number: '915', isPR: false });
    expect(showErrorMessage).toHaveBeenCalledWith('Codev: Not connected to Tower');
    expect(getIssue).not.toHaveBeenCalled();
  });
});
