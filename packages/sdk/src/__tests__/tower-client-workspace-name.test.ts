/**
 * `TowerClient.setWorkspaceAddressName` wire contract (Spec 1940).
 *
 * `afx workspace name` travels CLI → TowerClient → HTTP → Tower. The codev package
 * resolves this client from the sdk's built `dist`, so the request it puts on the wire is
 * tested here, against the source.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TowerClient } from '../tower-client.js';
import { encodeWorkspacePath } from '../workspace.js';

const WORKSPACE = '/home/ana/work/codev';

interface Captured {
  url: string;
  method?: string;
  body: unknown;
}

function towerAnswering(status: number, payload: unknown): Captured[] {
  const captured: Captured[] = [];
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      captured.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => JSON.parse(text),
        text: async () => text,
      } as unknown as Response;
    }),
  );
  return captured;
}

describe('TowerClient.setWorkspaceAddressName', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PUTs the name to the workspace\'s address-name route and returns what Tower stored', async () => {
    const captured = towerAnswering(200, { explicitName: 'work', addressName: 'work' });

    const outcome = await new TowerClient().setWorkspaceAddressName(WORKSPACE, 'Work');

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(`http://localhost:4100/api/workspaces/${encodeWorkspacePath(WORKSPACE)}/address-name`);
    expect(captured[0].method).toBe('PUT');
    // The name goes as typed: Tower lower-cases and checks it.
    expect(captured[0].body).toEqual({ name: 'Work' });
    expect(outcome).toEqual({ ok: true, result: { explicitName: 'work', addressName: 'work' } });
  });

  it('sends null to clear, as an explicit null and not a missing field', async () => {
    const captured = towerAnswering(200, { explicitName: null, addressName: 'codev' });

    const outcome = await new TowerClient().setWorkspaceAddressName(WORKSPACE, null);

    expect(captured[0].body).toEqual({ name: null });
    expect(outcome).toEqual({ ok: true, result: { explicitName: null, addressName: 'codev' } });
  });

  it('passes on why a cleared workspace has no address name', async () => {
    const result = { explicitName: null, addressName: null, unaddressableReason: 'it shares the directory name' };
    towerAnswering(200, result);

    expect(await new TowerClient().setWorkspaceAddressName(WORKSPACE, null)).toEqual({ ok: true, result });
  });

  it.each([
    [400, 'INVALID_NAME', "'my notes' cannot be a workspace name"],
    [400, 'RESERVED_NAME', "'architect' is a reserved word in addresses and cannot be a workspace name."],
    [409, 'NAME_TAKEN', "'cloud' is already the name of the workspace /home/ana/codev-cloud."],
    [404, 'NOT_FOUND', 'Workspace /home/ana/work/codev is not registered with Tower.'],
  ])('a %i %s refusal comes back with Tower\'s reason and its code', async (status, code, message) => {
    towerAnswering(status, { error: code, message });

    const outcome = await new TowerClient().setWorkspaceAddressName(WORKSPACE, 'x');

    expect(outcome).toEqual({ ok: false, error: `${message} (${code})`, errorCode: code });
  });

  it('reports a Tower that is not running, with no code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:4100'); }));

    expect(await new TowerClient().setWorkspaceAddressName(WORKSPACE, 'work')).toEqual({ ok: false, error: 'Tower not running' });
  });
});
