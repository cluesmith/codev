/**
 * IDE server version handshake (Spec 1789): floor constant, `--version`
 * parsing, comparison, subprocess env, and the check itself run against fake
 * server binaries (small shell scripts in a temp dir).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  IDE_SERVER_MIN_VERSION,
  IDE_SERVER_UPGRADE_COMMAND,
  IDE_VERSION_TIMEOUT_MS,
  IDE_INSTALL_TIMEOUT_MS,
  IDE_READY_TIMEOUT_MS,
  IDE_STOP_EXIT_TIMEOUT_MS,
  IDE_START_BUDGET_MS,
  IdeServerVersionError,
  buildIdeServerEnv,
  checkIdeServerVersion,
  compareVersions,
  parseIdeServerVersion,
  runIdeServerCommand,
} from '../lib/ide-version.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const EMBEDDED_MANIFEST = join(PACKAGE_ROOT, 'ide-extension', 'manifest.json');
const EXTENSION_PACKAGE_JSON = resolve(PACKAGE_ROOT, '../../apps/vscode/package.json');

/** Minimum version of a simple engine range (`^x.y.z`, `~x.y.z`, `>=x.y.z`, `x.y.z`). */
function rangeMinimum(range: string): string {
  const match = /^(?:\^|~|>=)?\s*(\d+\.\d+\.\d+)$/.exec(range.trim());
  if (!match) {
    throw new Error(`unsupported engines.vscode range ${JSON.stringify(range)}: teach rangeMinimum this form`);
  }
  return match[1];
}

/**
 * Every source of the sidebar's engine range present in this checkout: the
 * source package.json always, plus the embedded manifest when built. Reading
 * the package.json even when a manifest exists means a stale manifest cannot
 * mask a drifted engine.
 */
function sidebarEngineSources(): Array<{ source: string; range: string }> {
  const pkg = JSON.parse(readFileSync(EXTENSION_PACKAGE_JSON, 'utf-8'));
  const sources = [{ source: EXTENSION_PACKAGE_JSON, range: pkg.engines.vscode }];
  if (existsSync(EMBEDDED_MANIFEST)) {
    const manifest = JSON.parse(readFileSync(EMBEDDED_MANIFEST, 'utf-8'));
    sources.push({ source: EMBEDDED_MANIFEST, range: manifest.engines.vscode });
  }
  return sources;
}

describe('IDE_SERVER_MIN_VERSION floor', () => {
  it('is at least the sidebar engines.vscode minimum in every source (Scenario 11)', () => {
    const sources = sidebarEngineSources();
    expect(sources.map((entry) => entry.source)).toContain(EXTENSION_PACKAGE_JSON);
    expect(sources.map((entry) => entry.source).includes(EMBEDDED_MANIFEST)).toBe(existsSync(EMBEDDED_MANIFEST));
    for (const { source, range } of sources) {
      expect(
        compareVersions(IDE_SERVER_MIN_VERSION, rangeMinimum(range)),
        `floor ${IDE_SERVER_MIN_VERSION} is below engines.vscode ${range} in ${source}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('rangeMinimum would catch an engine bumped above the floor', () => {
    expect(compareVersions(IDE_SERVER_MIN_VERSION, rangeMinimum('^1.128.0'))).toBe(0);
    expect(compareVersions(IDE_SERVER_MIN_VERSION, rangeMinimum('^1.129.0'))).toBeLessThan(0);
    expect(() => rangeMinimum('1.x')).toThrow(/unsupported/);
  });
});

describe('IDE_START_BUDGET_MS', () => {
  it('covers one queued operation plus a full start', () => {
    const oneStart = IDE_VERSION_TIMEOUT_MS + IDE_INSTALL_TIMEOUT_MS + IDE_STOP_EXIT_TIMEOUT_MS + IDE_READY_TIMEOUT_MS;
    expect(IDE_START_BUDGET_MS).toBeGreaterThanOrEqual(oneStart * 2);
  });
});

describe('parseIdeServerVersion', () => {
  it('reads line 1 of the three-line server output', () => {
    expect(parseIdeServerVersion('1.138.0\nabc123def456\narm64\n')).toBe('1.138.0');
  });

  it('trims line 1 and accepts CRLF', () => {
    expect(parseIdeServerVersion('  1.128.0  \r\ncommit\r\n')).toBe('1.128.0');
  });

  it('never reads a package-style version on a later line', () => {
    expect(parseIdeServerVersion('1.138.0\n1.138.0-codev.1\n')).toBe('1.138.0');
  });

  it('refuses a prerelease suffix on line 1', () => {
    expect(parseIdeServerVersion('1.128.0-rc.1\ncommit\narm64')).toBeNull();
    expect(parseIdeServerVersion('1.138.0-codev.1')).toBeNull();
  });

  it('refuses garbage, empty output and a version not on line 1', () => {
    expect(parseIdeServerVersion('')).toBeNull();
    expect(parseIdeServerVersion('Codev IDE server 1.138.0')).toBeNull();
    expect(parseIdeServerVersion('\n1.138.0')).toBeNull();
    expect(parseIdeServerVersion('1.138')).toBeNull();
  });

  it('refuses leading zeroes in any component', () => {
    expect(parseIdeServerVersion('01.128.0')).toBeNull();
    expect(parseIdeServerVersion('1.0128.0')).toBeNull();
    expect(parseIdeServerVersion('1.128.00')).toBeNull();
    expect(parseIdeServerVersion('1.0.0')).toBe('1.0.0');
  });
});

describe('compareVersions', () => {
  it('compares numerically, not lexically', () => {
    expect(compareVersions('1.128.0', '1.128.0')).toBe(0);
    expect(compareVersions('1.138.0', '1.128.0')).toBeGreaterThan(0);
    expect(compareVersions('1.99.0', '1.128.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.999.999')).toBeGreaterThan(0);
    expect(compareVersions('1.128.1', '1.128.0')).toBeGreaterThan(0);
  });

  it('throws on non-strict input instead of returning NaN', () => {
    expect(() => compareVersions('1.128', '1.128.0')).toThrow(/not a strict/);
    expect(() => compareVersions('1.128.0', 'garbage')).toThrow(/not a strict/);
  });
});

describe('buildIdeServerEnv', () => {
  const nodeDir = dirname(process.execPath);

  it('prepends the running Node directory to PATH', () => {
    const env = buildIdeServerEnv({ PATH: ['/usr/bin', '/bin'].join(delimiter) });
    expect(env.PATH.split(delimiter)).toEqual([nodeDir, '/usr/bin', '/bin']);
  });

  it('moves the Node directory to the front when it appears later, without duplicating it', () => {
    const env = buildIdeServerEnv({ PATH: ['/usr/bin', nodeDir, '/bin', nodeDir].join(delimiter) });
    expect(env.PATH.split(delimiter)).toEqual([nodeDir, '/usr/bin', '/bin']);
  });

  it('sets PATH when the base env has none', () => {
    expect(buildIdeServerEnv({}).PATH).toBe(nodeDir);
  });

  it('strips Claude Code session markers like the agent env', () => {
    const env = buildIdeServerEnv({ PATH: '/usr/bin', CLAUDECODE: '1', HOME: '/home/dev' });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.HOME).toBe('/home/dev');
  });
});

describe('checkIdeServerVersion', () => {
  let dir: string;

  function fakeServer(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  function printing(name: string, output: string): string {
    return fakeServer(name, `printf '%s' '${output}'`);
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ide-version-test-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a version equal to the floor (Scenario 7)', async () => {
    const server = printing('equal', `${IDE_SERVER_MIN_VERSION}\ncommit\narm64\n`);
    await expect(checkIdeServerVersion(server)).resolves.toEqual({ version: IDE_SERVER_MIN_VERSION });
  });

  it('accepts a version above the floor, reading line 1 only (Scenario 7)', async () => {
    const server = printing('above', '1.138.0\n0123456789abcdef\narm64\n');
    await expect(checkIdeServerVersion(server)).resolves.toEqual({ version: '1.138.0' });
  });

  it('refuses a version below the floor, naming both versions and the upgrade (Scenario 8)', async () => {
    const server = printing('below', '1.127.9\ncommit\narm64\n');
    const error = await checkIdeServerVersion(server).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdeServerVersionError);
    const message = (error as Error).message;
    expect(message).toContain('1.127.9');
    expect(message).toContain(IDE_SERVER_MIN_VERSION);
    expect(message).toContain(IDE_SERVER_UPGRADE_COMMAND);
  });

  it('refuses a non-zero exit and surfaces stderr (Scenario 9)', async () => {
    const server = fakeServer('fails', `echo 'boom: missing runtime' >&2\nexit 3`);
    const error = await checkIdeServerVersion(server).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdeServerVersionError);
    const message = (error as Error).message;
    expect(message).toContain('failed to run --version');
    expect(message).toContain('boom: missing runtime');
    expect(message).toContain(IDE_SERVER_MIN_VERSION);
  });

  it('refuses a server that does not answer within the timeout (Scenario 9)', async () => {
    const server = fakeServer('hangs', 'exec sleep 5');
    const error = await checkIdeServerVersion(server, { timeoutMs: 200 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdeServerVersionError);
    const message = (error as Error).message;
    expect(message).toContain('did not answer --version');
    expect(message).toContain(IDE_SERVER_MIN_VERSION);
  });

  it('bounds a server that ignores SIGTERM and leaves a grandchild holding stdout', async () => {
    const server = fakeServer('ignores-term', `trap '' TERM\nsleep 5\necho 1.138.0`);
    const started = Date.now();
    const error = await checkIdeServerVersion(server, { timeoutMs: 300 }).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(error).toBeInstanceOf(IdeServerVersionError);
    expect((error as Error).message).toContain('did not answer --version');
  });

  it('keeps only a bounded head of a flooding stdout', async () => {
    const server = fakeServer('floods', `echo 1.138.0\nhead -c 1000000 /dev/zero | tr '\\0' x`);
    const run = await runIdeServerCommand(server, ['--version'], { timeoutMs: 5_000, env: buildIdeServerEnv() });
    expect(run.stdout.length).toBeLessThanOrEqual(64_000);
    expect(run.stdout.startsWith('1.138.0\n')).toBe(true);
    await expect(checkIdeServerVersion(server)).resolves.toEqual({ version: '1.138.0' });
  });

  it('refuses unparseable output, quoting line 1 (Scenario 9)', async () => {
    const server = printing('garbage', 'not a version\n');
    const error = await checkIdeServerVersion(server).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdeServerVersionError);
    const message = (error as Error).message;
    expect(message).toContain('"not a version"');
    expect(message).toContain(IDE_SERVER_MIN_VERSION);
  });

  it('refuses a prerelease line 1 as unparseable', async () => {
    const server = printing('prerelease', '1.128.0-rc.1\ncommit\narm64\n');
    await expect(checkIdeServerVersion(server)).rejects.toThrow(/unrecognized version/);
  });

  it('refuses a missing binary', async () => {
    await expect(checkIdeServerVersion(join(dir, 'does-not-exist'))).rejects.toBeInstanceOf(IdeServerVersionError);
  });

  it('runs the server with the env it is given', async () => {
    const server = fakeServer('env', `printf '%s\\n' "$IDE_VERSION_PROBE"`);
    const env = { ...buildIdeServerEnv(), IDE_VERSION_PROBE: '1.140.2' };
    await expect(checkIdeServerVersion(server, { env })).resolves.toEqual({ version: '1.140.2' });
  });
});
