/**
 * `TowerClient.getAddressBook` wire contract (Spec 1940, phase 5).
 *
 * `afx workspace list` travels CLI → TowerClient → HTTP → Tower. The codev package
 * resolves this client from the sdk's built `dist`, so the request it puts on the wire is
 * tested here, against the source.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AddressBookResponse } from '@cluesmith/codev-types';
import { TowerClient } from '../tower-client.js';

function towerAnswering(status: number, payload: unknown): string[] {
  const urls: string[] = [];
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      expect(init?.method ?? 'GET').toBe('GET');
      urls.push(String(url));
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => JSON.parse(text),
        text: async () => text,
      } as unknown as Response;
    }),
  );
  return urls;
}

const BOOK: AddressBookResponse = {
  workspaces: [
    {
      path: '/home/ana/dev/codev',
      running: true,
      addressName: 'codev',
      agents: [{ kind: 'architect', name: 'main', address: 'codev:architect:main', live: true, sendable: true }],
    },
  ],
};

describe('TowerClient.getAddressBook', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks as the caller: its workspace and its sender id, as a send gives them', async () => {
    const urls = towerAnswering(200, BOOK);

    const outcome = await new TowerClient().getAddressBook({ workspace: '/home/ana/my dev/codev', from: 'architect:review' });

    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]);
    expect(`${url.origin}${url.pathname}`).toBe('http://localhost:4100/api/address-book');
    expect(url.searchParams.get('workspace')).toBe('/home/ana/my dev/codev');
    expect(url.searchParams.get('from')).toBe('architect:review');
    expect(outcome).toEqual({ ok: true, result: BOOK });
  });

  it('sends no query for a caller outside every workspace', async () => {
    const urls = towerAnswering(200, BOOK);
    await new TowerClient().getAddressBook();
    expect(urls).toEqual(['http://localhost:4100/api/address-book']);
  });

  it('gives only the part of the caller it was given', async () => {
    const urls = towerAnswering(200, BOOK);
    await new TowerClient().getAddressBook({ from: 'builder-spir-7' });
    expect(urls).toEqual(['http://localhost:4100/api/address-book?from=builder-spir-7']);
  });

  it('returns Tower\'s reason when the request is refused', async () => {
    towerAnswering(400, { error: 'INVALID_PARAMS', message: 'Invalid "from" parameter' });
    const outcome = await new TowerClient().getAddressBook({ from: 'bad id' });
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: string }).error).toContain('Invalid "from" parameter');
    expect(outcome).not.toHaveProperty('unknownRoute');
  });

  it('marks the answer of a Tower from before the address book: its plain-text 404 for a route it does not have', async () => {
    towerAnswering(404, 'Not found');
    const outcome = await new TowerClient().getAddressBook({ from: 'architect:main' });
    expect(outcome).toEqual({ ok: false, error: 'Not found', unknownRoute: true });
  });

  it('does not take another failure for an older Tower', async () => {
    towerAnswering(500, 'Internal server error');
    expect(await new TowerClient().getAddressBook()).toEqual({ ok: false, error: 'Internal server error' });
  });
});
