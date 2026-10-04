/**
 * IDE prefix forward — header hygiene, prefix match, public-authority derivation
 * (Issue #1668). These pin the security-critical bits of the forward: what
 * reaches the IDE server (never Tower's key or tunnel marker), and when the
 * `x-forwarded-*` set is stamped.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../lib/cloud-config.js', () => ({
  readCloudConfig: vi.fn(),
}));

import { buildForwardHeaders, mergeConnectionTokenCookie, matchIdePrefix, getPublicAuthority, type PublicAuthority } from '../servers/ide-forward.js';
import { readCloudConfig } from '../lib/cloud-config.js';

const AUTHORITY: PublicAuthority = { host: 'cloud.codevos.ai', proto: 'https', prefix: '/t/mytower/ide' };

describe('matchIdePrefix', () => {
  it('matches the bare prefix and any subpath', () => {
    expect(matchIdePrefix('/ide')).toBe(true);
    expect(matchIdePrefix('/ide/')).toBe(true);
    expect(matchIdePrefix('/ide/static/x.js')).toBe(true);
  });

  it('does not match lookalikes or unrelated paths', () => {
    expect(matchIdePrefix('/ideas')).toBe(false);
    expect(matchIdePrefix('/api/ide')).toBe(false);
    expect(matchIdePrefix('/')).toBe(false);
    expect(matchIdePrefix('/workspace/abc/ide/')).toBe(false);
  });
});

describe('buildForwardHeaders', () => {
  it('strips Tower-internal, leak-prone, and hop-by-hop headers and sets the loopback Host', () => {
    const out = buildForwardHeaders(
      {
        host: 'localhost:4100',
        'codev-tower-key': 'the-secret-key',
        'codev-web-key': 'legacy-secret',
        'x-codev-tunnel-proxy': '1',
        'x-forwarded-port': '4100',
        'x-original-host': 'localhost',
        connection: 'keep-alive',
        accept: 'text/html',
        cookie: 'other=1',
      },
      8200,
      null,
      null,
    );

    // Tower's credential and tunnel marker must NEVER reach the IDE server.
    expect(out['codev-tower-key']).toBeUndefined();
    expect(out['codev-web-key']).toBeUndefined();
    expect(out['x-codev-tunnel-proxy']).toBeUndefined();
    // Leak-prone forwarded hints stripped (a stale port breaks the browser WS dial).
    expect(out['x-forwarded-port']).toBeUndefined();
    expect(out['x-original-host']).toBeUndefined();
    // Hop-by-hop dropped.
    expect(out['connection']).toBeUndefined();
    // Host rewritten to the loopback target.
    expect(out['host']).toBe('127.0.0.1:8200');
    // Innocent headers preserved (no token passed ⇒ Cookie untouched).
    expect(out['accept']).toBe('text/html');
    expect(out['cookie']).toBe('other=1');
  });

  it('stamps x-forwarded-* from the public authority ONLY when tunnel-borne', () => {
    const tunnelBorne = buildForwardHeaders({ 'x-codev-tunnel-proxy': '1', accept: '*/*' }, 8200, AUTHORITY, null);
    expect(tunnelBorne['x-forwarded-host']).toBe('cloud.codevos.ai');
    expect(tunnelBorne['x-forwarded-proto']).toBe('https');
    expect(tunnelBorne['x-forwarded-prefix']).toBe('/t/mytower/ide');

    const local = buildForwardHeaders({ accept: '*/*' }, 8200, AUTHORITY, null);
    expect(local['x-forwarded-host']).toBeUndefined();
    expect(local['x-forwarded-proto']).toBeUndefined();
    expect(local['x-forwarded-prefix']).toBeUndefined();
  });

  it('does not stamp x-forwarded-* when tunnel-borne but no authority is known', () => {
    const out = buildForwardHeaders({ 'x-codev-tunnel-proxy': '1' }, 8200, null, null);
    expect(out['x-forwarded-host']).toBeUndefined();
  });

  it('marker integrity: a forged x-codev-tunnel-proxy never survives into the forward', () => {
    const out = buildForwardHeaders({ 'x-codev-tunnel-proxy': 'forged', accept: '*/*' }, 8200, null, null);
    expect(out['x-codev-tunnel-proxy']).toBeUndefined();
  });

  it('preserves the ?folder query implicitly (query is on the URL, not headers) — headers untouched', () => {
    // Sanity: buildForwardHeaders is header-only; it must not invent or drop query-carrying headers.
    const out = buildForwardHeaders({ accept: '*/*' }, 8200, null, null);
    expect(Object.keys(out)).toContain('accept');
  });

  it('injects the connection token as a vscode-tkn cookie when a token is given', () => {
    const out = buildForwardHeaders({ accept: '*/*' }, 8200, null, 'TOKEN123');
    expect(out['cookie']).toBe('vscode-tkn=TOKEN123');
  });

  it('merges the token into an existing Cookie header without clobbering other cookies', () => {
    const out = buildForwardHeaders({ cookie: 'a=1; b=2' }, 8200, null, 'TK');
    expect(out['cookie']).toBe('a=1; b=2; vscode-tkn=TK');
  });

  it('does not inject when no token is available (server unspawned)', () => {
    const out = buildForwardHeaders({ cookie: 'a=1' }, 8200, null, null);
    expect(out['cookie']).toBe('a=1');
  });
});

describe('mergeConnectionTokenCookie', () => {
  it('sets the cookie when none exists', () => {
    expect(mergeConnectionTokenCookie(undefined, 'TK')).toBe('vscode-tkn=TK');
  });

  it('appends, preserving existing cookies', () => {
    expect(mergeConnectionTokenCookie('a=1; b=2', 'TK')).toBe('a=1; b=2; vscode-tkn=TK');
  });

  it('never clobbers an already-present vscode-tkn', () => {
    expect(mergeConnectionTokenCookie('vscode-tkn=already; x=1', 'TK')).toBe('vscode-tkn=already; x=1');
  });

  it('joins an array-valued Cookie header before merging', () => {
    expect(mergeConnectionTokenCookie(['a=1', 'b=2'], 'TK')).toBe('a=1; b=2; vscode-tkn=TK');
  });
});

describe('getPublicAuthority', () => {
  afterEach(() => vi.clearAllMocks());

  it('derives host/proto/prefix from the cloud config, matching the advertised accessUrl', () => {
    (readCloudConfig as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      tower_id: 't1',
      tower_name: 'mytower',
      api_key: 'ctk_x',
      server_url: 'https://cloud.codevos.ai',
    });
    expect(getPublicAuthority()).toEqual({ host: 'cloud.codevos.ai', proto: 'https', prefix: '/t/mytower/ide' });
  });

  it('returns null when the tower is not cloud-registered', () => {
    (readCloudConfig as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(getPublicAuthority()).toBeNull();
  });
});
