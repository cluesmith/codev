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

import {
  buildForwardHeaders,
  mergeConnectionTokenCookie,
  matchIdePrefix,
  getPublicAuthority,
  stripCookie,
  stripConnectionTokenSetCookie,
  copyResponseHeaders,
  rebuildUpgradeResponse,
  injectWorkbenchConnectionToken,
  type PublicAuthority,
} from '../servers/ide-forward.js';
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

  it('stamps x-forwarded-* from the public authority when tunnel-borne', () => {
    const tunnelBorne = buildForwardHeaders(
      { 'x-codev-tunnel-proxy': '1', host: 'localhost:4100', accept: '*/*' },
      8200,
      AUTHORITY,
      null,
    );
    expect(tunnelBorne['x-forwarded-host']).toBe('cloud.codevos.ai');
    expect(tunnelBorne['x-forwarded-proto']).toBe('https');
    expect(tunnelBorne['x-forwarded-prefix']).toBe('/t/mytower/ide');
  });

  it("stamps Tower's own authority (the incoming Host) for a local request, with no prefix (Issue #1869)", () => {
    // Without this the IDE server derives remoteAuthority from the rewritten
    // Host (its own port) and the workbench dials it directly, bypassing Tower.
    const local = buildForwardHeaders({ host: 'localhost:4100', accept: '*/*' }, 8200, AUTHORITY, null);
    expect(local['host']).toBe('127.0.0.1:8200');
    expect(local['x-forwarded-host']).toBe('localhost:4100');
    expect(local['x-forwarded-proto']).toBe('http');
    expect(local['x-forwarded-prefix']).toBeUndefined();
  });

  it('a local request without a Host gets no x-forwarded-host', () => {
    const local = buildForwardHeaders({ accept: '*/*' }, 8200, null, null);
    expect(local['x-forwarded-host']).toBeUndefined();
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

  it("REPLACES an incoming vscode-tkn with Tower's, keeping other cookies (Issue #1869)", () => {
    expect(mergeConnectionTokenCookie('vscode-tkn=stale; other=1', 'TK')).toBe('other=1; vscode-tkn=TK');
    expect(mergeConnectionTokenCookie('vscode-tkn=stale', 'TK')).toBe('vscode-tkn=TK');
    expect(mergeConnectionTokenCookie(['a=1', 'vscode-tkn=stale', 'vscode-tkn2=keep'], 'TK')).toBe('a=1; vscode-tkn2=keep; vscode-tkn=TK');
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

describe('stripCookie / forward cookie never reaches the IDE server (Issue #1869)', () => {
  const NAME = 'codev-ide-session';

  it('removes the pair when first, middle, last, or the only pair', () => {
    expect(stripCookie(`${NAME}=v; a=1; b=2`, NAME)).toBe('a=1; b=2');
    expect(stripCookie(`a=1; ${NAME}=v; b=2`, NAME)).toBe('a=1; b=2');
    expect(stripCookie(`a=1; b=2; ${NAME}=v`, NAME)).toBe('a=1; b=2');
    expect(stripCookie(`${NAME}=v`, NAME)).toBe('');
  });

  it('handles the string[] shape and an absent header', () => {
    expect(stripCookie(['a=1', `${NAME}=v`, 'b=2'], NAME)).toBe('a=1; b=2');
    expect(stripCookie(undefined, NAME)).toBe('');
  });

  it('does not over-strip a name-prefixed cookie', () => {
    expect(stripCookie(`${NAME}2=keep; ${NAME}=v`, NAME)).toBe(`${NAME}2=keep`);
  });

  it('buildForwardHeaders strips it, keeps other cookies, and still injects vscode-tkn', () => {
    const out = buildForwardHeaders({ cookie: `a=1; ${NAME}=secret; b=2` }, 8200, null, 'TK');
    expect(out['cookie']).toBe('a=1; b=2; vscode-tkn=TK');
  });

  it('buildForwardHeaders drops the Cookie header entirely when only the forward cookie was sent and no token exists', () => {
    const out = buildForwardHeaders({ cookie: `${NAME}=secret` }, 8200, null, null);
    expect(out['cookie']).toBeUndefined();
  });

  it("a browser-held vscode-tkn is replaced by Tower's and the forward cookie is gone", () => {
    const out = buildForwardHeaders({ cookie: `${NAME}=secret; vscode-tkn=STALE; other=1` }, 8200, null, 'TK');
    expect(out['cookie']).toBe('other=1; vscode-tkn=TK');
  });

  it('C1: client-supplied x-forwarded-* never reach the IDE server unless Tower set them', () => {
    const spoof = { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', 'x-forwarded-prefix': '/evil' };
    const local = buildForwardHeaders({ host: 'localhost:4100', ...spoof }, 8200, null, null);
    expect(local['x-forwarded-host']).toBe('localhost:4100');
    expect(local['x-forwarded-proto']).toBe('http');
    expect(local['x-forwarded-prefix']).toBeUndefined();

    const tunnelNoAuthority = buildForwardHeaders({ 'x-codev-tunnel-proxy': '1', ...spoof }, 8200, null, null);
    expect(tunnelNoAuthority['x-forwarded-host']).toBeUndefined();
    expect(tunnelNoAuthority['x-forwarded-proto']).toBeUndefined();
    expect(tunnelNoAuthority['x-forwarded-prefix']).toBeUndefined();

    const tunnel = buildForwardHeaders({ 'x-codev-tunnel-proxy': '1', ...spoof }, 8200, AUTHORITY, null);
    expect(tunnel['x-forwarded-host']).toBe('cloud.codevos.ai');
    expect(tunnel['x-forwarded-prefix']).toBe('/t/mytower/ide');
  });
});

describe('the IDE connection token never reaches the browser (Issue #1869)', () => {
  it('drops vscode-tkn Set-Cookie entries and keeps the others', () => {
    expect(stripConnectionTokenSetCookie('vscode-tkn=T; Max-Age=604800; SameSite=Lax')).toBeUndefined();
    expect(stripConnectionTokenSetCookie(['a=1; Path=/', 'vscode-tkn=T; SameSite=Lax', 'b=2'])).toEqual(['a=1; Path=/', 'b=2']);
    expect(stripConnectionTokenSetCookie('vscode-tkn2=keep')).toEqual(['vscode-tkn2=keep']);
    expect(stripConnectionTokenSetCookie(undefined)).toBeUndefined();
  });

  it('copyResponseHeaders strips it from HTTP responses and keeps caching headers', () => {
    const upstream = {
      'set-cookie': ['vscode-tkn=T; Max-Age=604800; SameSite=Lax', 'other=1'],
      'cache-control': 'no-store',
      etag: '"x"',
      connection: 'keep-alive',
    };
    const out = copyResponseHeaders(upstream, true);
    expect(out['set-cookie']).toEqual(['other=1']);
    expect(copyResponseHeaders({ 'set-cookie': ['vscode-tkn=T; Max-Age=604800'] }, true)['set-cookie']).toBeUndefined();
    // Tunnel path (local-only scope): relayed unchanged.
    expect(copyResponseHeaders(upstream, false)['set-cookie']).toEqual(upstream['set-cookie']);
    expect(out['cache-control']).toBe('no-store');
    expect(out['etag']).toBe('"x"');
    expect(out['connection']).toBeUndefined();
  });

  it('rebuildUpgradeResponse strips it from the 101 response', () => {
    const raw = rebuildUpgradeResponse({
      statusCode: 101,
      statusMessage: 'Switching Protocols',
      headers: { upgrade: 'websocket', 'set-cookie': ['vscode-tkn=T; SameSite=Lax', 'other=1'] },
    }, true);
    expect(raw).not.toContain('vscode-tkn');
    expect(raw).toContain('set-cookie: other=1');
    expect(raw).toContain('upgrade: websocket');
    const tunnel = rebuildUpgradeResponse({ statusCode: 101, statusMessage: 'Switching Protocols', headers: { 'set-cookie': ['vscode-tkn=T'] } }, false);
    expect(tunnel).toContain('set-cookie: vscode-tkn=T');
  });
});

describe('injectWorkbenchConnectionToken (Issue #1869)', () => {
  const META = '<meta id="vscode-workbench-web-configuration" data-settings="{&quot;remoteAuthority&quot;:&quot;127.0.0.1:4100&quot;}">';

  it('inserts the token as the first key of the escaped configuration JSON', () => {
    const out = injectWorkbenchConnectionToken(`<html><head>${META}</head></html>`, 'abc123');
    expect(out).toContain('data-settings="{&quot;connectionToken&quot;:&quot;abc123&quot;,&quot;remoteAuthority&quot;');
    const settings = /data-settings="([^"]*)"/.exec(out as string)?.[1].replace(/&quot;/g, '"');
    expect(JSON.parse(settings as string)).toEqual({ connectionToken: 'abc123', remoteAuthority: '127.0.0.1:4100' });
  });

  it('returns null when the page carries no workbench configuration', () => {
    expect(injectWorkbenchConnectionToken('<html>not the workbench</html>', 'abc')).toBeNull();
  });

  it('returns null when a connectionToken is already configured', () => {
    const pre = META.replace('{&quot;', '{&quot;connectionToken&quot;:&quot;x&quot;,&quot;');
    expect(injectWorkbenchConnectionToken(pre, 'abc')).toBeNull();
  });

  it('handles the empty-object configuration without a trailing comma', () => {
    const out = injectWorkbenchConnectionToken('<meta id="vscode-workbench-web-configuration" data-settings="{}">', 'abc');
    expect(out).toBe('<meta id="vscode-workbench-web-configuration" data-settings="{&quot;connectionToken&quot;:&quot;abc&quot;}">');
  });

  it('returns null when the configuration does not decode to a JSON object', () => {
    expect(injectWorkbenchConnectionToken('<meta id="vscode-workbench-web-configuration" data-settings="{not json">', 'abc')).toBeNull();
  });

  it('decodes other character references in the configuration before validating', () => {
    const meta = '<meta id="vscode-workbench-web-configuration" data-settings="{&quot;a&quot;:&quot;x&amp;y&#39;z&quot;}">';
    const out = injectWorkbenchConnectionToken(meta, 'abc') as string;
    const settings = /data-settings="([^"]*)"/.exec(out)?.[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
    expect(JSON.parse(settings as string)).toEqual({ connectionToken: 'abc', a: "x&y'z" });
  });

  it('refuses a token that could break out of the attribute', () => {
    expect(injectWorkbenchConnectionToken(META, 'a"b')).toBeNull();
    expect(injectWorkbenchConnectionToken(META, 'a&quot;b')).toBeNull();
  });
});
