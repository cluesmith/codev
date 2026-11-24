/**
 * Issue #1914: the dashboard's Open IDE link over Codev Cloud.
 *
 * - `ideAvailability` (the signal `/api/status` carries): local = record
 *   present; tunnel = record present AND the recorded port accepts a connect.
 * - The forward's authorization is unchanged: the tunnel marker alone, with no
 *   key and no forward cookie, is refused (the real auth seam, only the local
 *   key source mocked).
 * - The dashboard: `openIde()` is evaluated from the real template with stubbed
 *   browser globals, for both branches; plus source assertions that the link is
 *   built relative to the page and that the old `./api/ide` poll is gone.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs, { rmSync } from 'node:fs';
import path from 'node:path';

const TMP_DIR = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(tmpdir(), `pir-1914-${process.pid}-${Date.now()}`);
});

const KEY = 'k'.repeat(64);

vi.mock('@cluesmith/codev-core/constants', async (importActual) => {
  const actual = await importActual<typeof import('@cluesmith/codev-core/constants')>();
  return { ...actual, AGENT_FARM_DIR: TMP_DIR };
});

vi.mock('@cluesmith/codev-core/auth', () => ({
  ensureLocalKey: vi.fn(() => KEY),
  readLocalKey: vi.fn(() => KEY),
}));

import { ideAvailability } from '../servers/ide-server.js';
import { writeIdeRecord, deleteIdeRecord, type IdeServerRecord } from '../lib/ide-record.js';
import { isRequestAllowed, resetExpectedKeyCache } from '../utils/server-utils.js';

function recordFor(port: number): IdeServerRecord {
  return { prefix: '/ide/', port, serverPath: '/does/not/matter', pid: 0, startedAt: new Date().toISOString() };
}

/** A port nothing listens on: bind, read the port, close. */
async function deadPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = addr && typeof addr !== 'string' ? addr.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('ideAvailability (Issue #1914)', () => {
  let live: http.Server;
  let livePort: number;

  beforeAll(async () => {
    live = http.createServer((_req, res) => res.end());
    await new Promise<void>((resolve) => live.listen(0, '127.0.0.1', () => resolve()));
    const addr = live.address();
    livePort = addr && typeof addr !== 'string' ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => live.close(() => resolve()));
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  afterEach(() => deleteIdeRecord());

  it('is false with no record, locally and over the tunnel', async () => {
    expect(await ideAvailability(false)).toBe(false);
    expect(await ideAvailability(true)).toBe(false);
  });

  it('locally: a recorded server counts even when its port is dead (the mint respawns it)', async () => {
    writeIdeRecord(recordFor(await deadPort()));
    expect(await ideAvailability(false)).toBe(true);
  });

  it('over the tunnel: a recorded server counts only when its port accepts a connect', async () => {
    writeIdeRecord(recordFor(await deadPort()));
    expect(await ideAvailability(true)).toBe(false);

    writeIdeRecord(recordFor(livePort));
    expect(await ideAvailability(true)).toBe(true);
  });
});

describe('the /ide forward: the tunnel marker is never a credential (Issue #1914)', () => {
  function ideReq(headers: Record<string, string>): http.IncomingMessage {
    return { method: 'GET', url: '/ide/?folder=%2Fw', headers: { host: 'localhost:4100', ...headers } } as unknown as http.IncomingMessage;
  }

  it('refuses a tunnel-marked request with no key and no forward cookie', () => {
    resetExpectedKeyCache();
    expect(isRequestAllowed(ideReq({ 'x-codev-tunnel-proxy': '1' }))).toBe(false);
  });

  it('allows the request the tunnel client actually sends: marker plus the stamped key', () => {
    resetExpectedKeyCache();
    expect(isRequestAllowed(ideReq({ 'x-codev-tunnel-proxy': '1', 'codev-tower-key': KEY }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dashboard (templates/tower.html)
// ---------------------------------------------------------------------------

const towerHtmlPath = path.resolve(import.meta.dirname, '../../../templates/tower.html');
const html = fs.readFileSync(towerHtmlPath, 'utf-8');

function fnSource(signature: string): string {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`(async )?function ${escaped} \\{[\\s\\S]*?\\n    \\}`));
  expect(match, signature).not.toBeNull();
  return match![0];
}

interface OpenIdeRun {
  fetches: Array<{ url: string; options: unknown }>;
  navigatedTo: string | null;
  toasts: string[];
}

/** Run the template's real openIde() with stubbed browser globals. */
async function runOpenIde(opts: { viaTunnel: boolean; pageUrl: string; mintStatus?: number }): Promise<OpenIdeRun> {
  const run: OpenIdeRun = { fetches: [], navigatedTo: null, toasts: [] };
  const tab = {
    opener: {} as unknown,
    closed: false,
    location: {
      set href(value: string) {
        run.navigatedTo = value;
      },
    },
    close() {
      this.closed = true;
    },
  };
  const window = { open: () => tab };
  const location = { href: opts.pageUrl };
  const authFetch = async (url: string, options: unknown) => {
    run.fetches.push({ url, options });
    const status = opts.mintStatus ?? 204;
    return { ok: status >= 200 && status < 300, status };
  };
  const showToast = (message: string) => run.toasts.push(message);

  const source = [fnSource('ideFolderUriPath(workspacePath)'), fnSource('ideTargetUrl(workspacePath)'), fnSource('openIde(workspacePath)')].join('\n');
  const factory = new Function(
    'window', 'location', 'authFetch', 'showToast', 'ideViaTunnel',
    `${source}\nreturn openIde;`,
  );
  const openIde = factory(window, location, authFetch, showToast, opts.viaTunnel) as (p: string) => Promise<void>;
  await openIde('/home/dev/proj');
  return run;
}

describe('dashboard openIde() (Issue #1914)', () => {
  it('over the tunnel: no mint, no Tower fetch at all, navigates under the prefix the browser used', async () => {
    const run = await runOpenIde({ viaTunnel: true, pageUrl: 'https://cloud.codevos.ai/t/my-slug/' });
    expect(run.fetches).toEqual([]);
    expect(run.navigatedTo).toBe('https://cloud.codevos.ai/t/my-slug/ide/?folder=%2Fhome%2Fdev%2Fproj');
    expect(run.toasts).toEqual([]);
  });

  it('follows a renamed slug: the link is whatever prefix the page is on, never a stored one', async () => {
    const run = await runOpenIde({ viaTunnel: true, pageUrl: 'https://cloud.codevos.ai/t/renamed-tower/' });
    expect(run.navigatedTo).toBe('https://cloud.codevos.ai/t/renamed-tower/ide/?folder=%2Fhome%2Fdev%2Fproj');
  });

  it('locally: mints the forward cookie first, then navigates (#1869 unchanged)', async () => {
    const run = await runOpenIde({ viaTunnel: false, pageUrl: 'http://localhost:4100/' });
    expect(run.fetches).toHaveLength(1);
    expect(run.fetches[0].url).toBe('./api/ide/session');
    expect(run.fetches[0].options).toEqual({ method: 'POST' });
    expect(run.navigatedTo).toBe('http://localhost:4100/ide/?folder=%2Fhome%2Fdev%2Fproj');
  });

  it('locally: a failed mint closes the tab and shows a toast instead of navigating', async () => {
    const run = await runOpenIde({ viaTunnel: false, pageUrl: 'http://localhost:4100/', mintStatus: 503 });
    expect(run.navigatedTo).toBeNull();
    expect(run.toasts).toEqual(['Failed to open IDE: HTTP 503']);
  });
});

describe('dashboard source pins (Issue #1914)', () => {
  it('openIde() and ideTargetUrl() never construct a /t/ path; the URL is relative to location.href', () => {
    const open = fnSource('openIde(workspacePath)');
    const target = fnSource('ideTargetUrl(workspacePath)');
    expect(open).not.toContain('/t/');
    expect(target).not.toContain('/t/');
    expect(target).toContain("new URL('./ide/?folder='");
    expect(target).toContain('location.href');
  });

  it('the tunnel branch carries no Tower key and no forward cookie: the mint is the only fetch, and only locally', () => {
    const open = fnSource('openIde(workspacePath)');
    expect(open.match(/authFetch\(/g)).toHaveLength(1);
    expect(open).not.toContain('codev-tower-key');
    expect(open).not.toContain('getAuthHeaders');
    const guard = open.indexOf('if (!ideViaTunnel)');
    const mint = open.indexOf("authFetch('./api/ide/session'");
    expect(guard).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(guard);
  });

  it('the IDE signal comes from the /api/status poll; the dashboard no longer fetches ./api/ide', () => {
    expect(html).not.toContain("authFetch('./api/ide')");
    expect(html).not.toContain('refreshIdeStatus');
    const refresh = fnSource('refresh()');
    expect(refresh).toContain('data.ide.available');
    expect(refresh).toContain('data.ide.viaTunnel');
  });
});
