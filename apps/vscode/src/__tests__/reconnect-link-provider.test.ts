/**
 * PIR #939: the reconnect affordance on the terminal give-up message.
 *
 * Verifies the link provider matches the real marker emitted by the adapter's
 * give-up state (#936) — using the shared `RECONNECT_LINK_TEXT` constant so the
 * two cannot drift — and that a click routes back to the clicked terminal's
 * adapter via TerminalManager.reconnectByTerminal.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({}));
vi.mock('@cluesmith/codev-sdk/escape-buffer', () => ({ EscapeBuffer: class {} }));
vi.mock('@cluesmith/codev-types', () => ({ FRAME_CONTROL: 0x00, FRAME_DATA: 0x01 }));

const { ReconnectTerminalLinkProvider } = await import('../terminal-link-provider.js');
const { RECONNECT_LINK_TEXT } = await import('../terminal-adapter.js');

function makeProvider() {
  const calls: unknown[] = [];
  const terminalManager = { reconnectByTerminal: (t: unknown) => calls.push(t) };
  const provider = new (ReconnectTerminalLinkProvider as unknown as new (tm: unknown) => {
    provideTerminalLinks(ctx: { line: string; terminal: unknown }): Array<{ startIndex: number; length: number; terminal: unknown }>;
    handleTerminalLink(link: { terminal: unknown }): void;
  })(terminalManager);
  return { provider, calls };
}

describe('PIR #939 — ReconnectTerminalLinkProvider', () => {
  it('produces no link on an ordinary line', () => {
    const { provider } = makeProvider();
    expect(provider.provideTerminalLinks({ line: 'some normal output', terminal: {} })).toHaveLength(0);
  });

  it('matches the marker in the real give-up message and spans exactly the token', () => {
    const { provider } = makeProvider();
    // The exact string the adapter's giveUp() emits (sans ANSI, as xterm hands
    // the provider the decoded line).
    const line = `[Codev: Connection lost — unable to reconnect after 6 attempts. ${RECONNECT_LINK_TEXT}]`;
    const term = { id: 't1' };
    const links = provider.provideTerminalLinks({ line, terminal: term });

    expect(links).toHaveLength(1);
    expect(line.substr(links[0].startIndex, links[0].length)).toBe(RECONNECT_LINK_TEXT);
    expect(links[0].terminal).toBe(term); // threads the clicked terminal through
  });

  it('routes a click to reconnectByTerminal for the clicked terminal', () => {
    const { provider, calls } = makeProvider();
    const term = { id: 't9' };
    provider.handleTerminalLink({ terminal: term });
    expect(calls).toEqual([term]);
  });
});
