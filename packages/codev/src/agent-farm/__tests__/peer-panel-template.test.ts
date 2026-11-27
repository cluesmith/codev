/**
 * Spec 1967, plan phase 13 (the architect's ruling on the Peers panel): the section is hidden on a
 * Tower with no Codev Cloud registration while remote messaging is off, and shown in every other
 * case. The template's own `peersPanelShown()` and `renderPeers()` are evaluated from
 * `templates/tower.html` with a stubbed `document`, as `pir-1914-ide-cloud-availability.test.ts`
 * does for `openIde()`. The browser check of the hidden side is `e2e/peers-panel.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { PeerPanelResponse } from '@cluesmith/codev-types';

const towerHtmlPath = path.resolve(import.meta.dirname, '../../../templates/tower.html');
const html = fs.readFileSync(towerHtmlPath, 'utf-8');

function fnSource(signature: string): string {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`function ${escaped} \\{[\\s\\S]*?\\n    \\}`));
  expect(match, signature).not.toBeNull();
  return match![0];
}

function panel(over: Partial<PeerPanelResponse>): PeerPanelResponse {
  return {
    remoteMessaging: 'off',
    towerName: null,
    tunnel: 'down',
    relay: { state: 'unknown', why: null },
    listing: { fresh: false, refreshedAt: null, problem: 'not-connected', retryAfterSec: null },
    towers: [],
    clockSkewSince: null,
    viaTunnel: false,
    ...over,
  };
}

const peersPanelShown = new Function(`${fnSource('peersPanelShown(panel)')}\nreturn peersPanelShown;`)() as (
  panel: PeerPanelResponse,
) => boolean;

/** The template's renderPeers() and the helpers it calls, against a stubbed container. */
function render(state: { kind: 'ready'; panel: PeerPanelResponse }, before: string): string {
  const container = { innerHTML: before };
  const document = { getElementById: (id: string) => (id === 'peers-container' ? container : null) };
  const helpers = [
    'escapeHtml(str)',
    'peerTime(epochMs)',
    'peerModeText(mode)',
    'peerMayMessage(tower)',
    'peerMarkText(mark)',
    'peerItsSwitch(state)',
    'renderPeerRow(tower)',
    'peersListingNote(panel)',
    'peersRelayNote(relay)',
    'peersPanelShown(panel)',
    'renderPeers(state)',
  ].map(fnSource);
  const run = new Function('document', `${helpers.join('\n')}\nreturn renderPeers;`)(document) as (s: typeof state) => void;
  run(state);
  return container.innerHTML;
}

describe('Spec 1967: when the Peers section is shown', () => {
  it('is hidden on a Tower with no Codev Cloud registration while remote messaging is off', () => {
    const unregisteredOff = panel({});
    expect(peersPanelShown(unregisteredOff)).toBe(false);
    // A section shown by an earlier answer goes away too.
    expect(render({ kind: 'ready', panel: unregisteredOff }, '<section data-testid="peers-panel"></section>')).toBe('');
  });

  it('is shown on a registered Tower with the switch off, and on an unregistered one with it on', () => {
    const registeredOff = panel({ towerName: 'ana-s-mbp', listing: { fresh: true, refreshedAt: 1, problem: null, retryAfterSec: null } });
    const unregisteredOn = panel({ remoteMessaging: 'on' });
    expect(peersPanelShown(registeredOff)).toBe(true);
    expect(peersPanelShown(unregisteredOn)).toBe(true);
    expect(render({ kind: 'ready', panel: registeredOff }, '')).toContain('data-testid="peers-panel"');
    const shownOn = render({ kind: 'ready', panel: unregisteredOn }, '');
    expect(shownOn).toContain('data-testid="peers-panel"');
    expect(shownOn).toContain('This Tower is not connected to Codev Cloud');
  });
});
