/**
 * `afx ide` CLI (Spec 1789): server discovery order, the not-found refusal,
 * `afx ide install`, the richer status, and the per-call Tower timeouts.
 *
 * Discovery runs against temp directories used as fake `PATH` entries and fake
 * global `node_modules` trees; `npm` is a fake shell script on `PATH`. Tower is
 * a stubbed `http.request` that records every call, so a test can assert that
 * no request was made.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

interface TowerCall {
  method: string;
  timeout: number;
  body: unknown;
}

const h = vi.hoisted(() => ({
  tower: {
    calls: [] as TowerCall[],
    status: 200,
    response: {} as unknown,
    delayMs: 0,
  },
}));

vi.mock('@cluesmith/codev-core/auth', () => ({ ensureLocalKey: () => 'test-key' }));

// A stub Tower: answers after `delayMs`, unless the request's own timeout fires first.
vi.mock('node:http', () => {
  const request = vi.fn(
    (opts: { method: string; timeout: number }, onResponse: (res: EventEmitter & { statusCode: number }) => void) => {
      const req = new EventEmitter() as EventEmitter & {
        write: (chunk: string) => void;
        end: () => void;
        destroy: () => void;
      };
      let payload = '';
      let answered = false;
      let timedOut = false;
      req.write = (chunk: string) => {
        payload += chunk;
      };
      req.destroy = () => {};
      req.end = () => {
        let body: unknown;
        if (payload !== '') body = JSON.parse(payload);
        h.tower.calls.push({ method: opts.method, timeout: opts.timeout, body });
        setTimeout(() => {
          if (answered) return;
          timedOut = true;
          req.emit('timeout');
        }, opts.timeout);
        setTimeout(() => {
          if (timedOut) return;
          answered = true;
          const res = new EventEmitter() as EventEmitter & { statusCode: number };
          res.statusCode = h.tower.status;
          onResponse(res);
          res.emit('data', Buffer.from(JSON.stringify(h.tower.response)));
          res.emit('end');
        }, h.tower.delayMs);
      };
      return req;
    },
  );
  return { default: { request }, request };
});

import { ideInstall, ideStart, ideStatus, ideStop, resolveIdeServerPath } from '../commands/ide.js';
import { IDE_START_BUDGET_MS } from '../lib/ide-version.js';

const root = mkdtempSync(join(tmpdir(), 'ide-command-'));
let caseDir: string;
let caseCount = 0;
let output: string[];
let savedPath: string | undefined;

function writeExecutable(path: string, content: string): string {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}

function dir(...parts: string[]): string {
  const path = join(caseDir, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

/** A fake server binary that prints a `--version` block. */
function fakeServer(path: string, version = '1.138.0'): string {
  return writeExecutable(path, `#!/bin/sh\nprintf '${version}\\nabc123\\narm64\\n'\n`);
}

/** A fake installed `@cluesmith/codev-ide` package directory with its bin. */
function fakeIdePackage(packageDir: string, name = '@cluesmith/codev-ide'): string {
  mkdirSync(join(packageDir, 'bin'), { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name, bin: { 'codev-ide-server': 'bin/codev-ide-server' } }),
  );
  return fakeServer(join(packageDir, 'bin', 'codev-ide-server'));
}

/** A fake `npm` whose `root -g` prints `globalRoot`. */
function fakeNpmRoot(binDir: string, globalRoot: string): void {
  writeExecutable(join(binDir, 'npm'), `#!/bin/sh\nif [ "$1" = root ]; then echo '${globalRoot}'; exit 0; fi\nexit 1\n`);
}

function printed(): string {
  return output.join('\n');
}

beforeEach(() => {
  caseCount += 1;
  caseDir = join(root, `case-${caseCount}`);
  mkdirSync(caseDir);
  h.tower.calls = [];
  h.tower.status = 200;
  h.tower.response = {};
  h.tower.delayMs = 0;
  output = [];
  savedPath = process.env.PATH;
  const capture = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as never);
});

afterEach(() => {
  process.env.PATH = savedPath;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveIdeServerPath', () => {
  it('--server-path wins without consulting PATH (Scenario 3)', async () => {
    const pathDir = dir('path');
    fakeServer(join(pathDir, 'codev-ide-server'));
    const explicit = fakeServer(join(dir('explicit'), 'my-server'));

    const found = await resolveIdeServerPath({ serverPath: explicit, env: { PATH: pathDir } });

    expect(found).toBe(explicit);
  });

  it('a nonexistent --server-path keeps the not-found error (Scenario 3)', async () => {
    const missing = join(caseDir, 'nope', 'codev-ide-server');

    await expect(resolveIdeServerPath({ serverPath: missing })).rejects.toThrow(
      `IDE server binary not found at ${missing}`,
    );
  });

  it('resolves codev-ide-server on PATH, skipping entries without an executable one (Scenario 4)', async () => {
    const empty = dir('empty');
    const notExecutable = dir('not-executable');
    writeFileSync(join(notExecutable, 'codev-ide-server'), '#!/bin/sh\n');
    const pathDir = dir('path');
    const server = fakeServer(join(pathDir, 'codev-ide-server'));

    const found = await resolveIdeServerPath({
      env: { PATH: ['', empty, notExecutable, pathDir].join(':') },
      codevRoot: dir('codev'),
    });

    expect(found).toBe(server);
  });

  it('returns the PATH bin link itself, not its real path, so in-place upgrades apply', async () => {
    const real = fakeIdePackage(dir('lib', 'node_modules', '@cluesmith', 'codev-ide'));
    const binDir = dir('bin');
    const link = join(binDir, 'codev-ide-server');
    symlinkSync(real, link);

    const found = await resolveIdeServerPath({ env: { PATH: binDir }, codevRoot: dir('codev') });

    expect(found).toBe(link);
  });

  it('falls back to @cluesmith/codev-ide as a sibling of the running codev install (Scenario 5)', async () => {
    const scope = dir('lib', 'node_modules', '@cluesmith');
    const codevRoot = dir('lib', 'node_modules', '@cluesmith', 'codev');
    const bin = fakeIdePackage(join(scope, 'codev-ide'));

    const found = await resolveIdeServerPath({ env: { PATH: dir('empty') }, codevRoot });

    expect(found).toBe(bin);
  });

  it('falls back to npm root -g when there is no sibling', async () => {
    const globalRoot = dir('global', 'node_modules');
    const bin = fakeIdePackage(join(globalRoot, '@cluesmith', 'codev-ide'));
    const npmDir = dir('npm-bin');
    fakeNpmRoot(npmDir, globalRoot);

    const found = await resolveIdeServerPath({ env: { PATH: npmDir }, codevRoot: dir('codev') });

    expect(found).toBe(bin);
  });

  it('ignores a codev-ide directory whose package.json names another package', async () => {
    const globalRoot = dir('global', 'node_modules');
    fakeIdePackage(join(globalRoot, '@cluesmith', 'codev-ide'), 'not-codev-ide');
    const npmDir = dir('npm-bin');
    fakeNpmRoot(npmDir, globalRoot);

    const found = await resolveIdeServerPath({ env: { PATH: npmDir }, codevRoot: dir('codev') });

    expect(found).toBeNull();
  });

  it('returns null when nothing is found and npm is missing', async () => {
    const found = await resolveIdeServerPath({ env: { PATH: dir('empty') }, codevRoot: dir('codev') });

    expect(found).toBeNull();
  });
});

describe('ideStart', () => {
  it('nothing found: exits 1 with the install hints and never calls Tower (Scenario 6)', async () => {
    process.env.PATH = dir('empty');

    await expect(ideStart()).rejects.toThrow('process.exit:1');

    expect(h.tower.calls).toHaveLength(0);
    expect(printed()).toContain('afx ide install');
    expect(printed()).toContain('npm i -g @cluesmith/codev-ide');
    expect(printed()).toContain('--server-path');
  });

  it('a nonexistent --server-path exits 1 without calling Tower', async () => {
    const missing = join(caseDir, 'missing-server');

    await expect(ideStart({ serverPath: missing })).rejects.toThrow('process.exit:1');

    expect(h.tower.calls).toHaveLength(0);
    expect(printed()).toContain(`IDE server binary not found at ${missing}`);
  });

  it('sends the discovered path and prints the versions with no restart hint', async () => {
    const pathDir = dir('path');
    const server = fakeServer(join(pathDir, 'codev-ide-server'));
    process.env.PATH = pathDir;
    h.tower.response = { ok: true, port: 8200, pid: 4242, serverVersion: '1.138.0', sidebarVersion: '3.3.4', restartRequired: false };

    await ideStart();

    expect(h.tower.calls).toHaveLength(1);
    expect(h.tower.calls[0]).toMatchObject({ method: 'POST', body: { serverPath: server } });
    expect(printed()).toContain('Checking the server version and installing the Codev sidebar');
    expect(printed()).toMatch(/Server version:.*1\.138\.0/);
    expect(printed()).toMatch(/Sidebar version:.*3\.3\.4/);
    expect(printed()).not.toContain('afx ide stop && afx ide start');
  });

  it('prints the restart hint when Tower reports restartRequired', async () => {
    const server = fakeServer(join(dir('explicit'), 'codev-ide-server'));
    h.tower.response = { ok: true, port: 8200, pid: 4242, serverVersion: '1.138.0', restartRequired: true };

    await ideStart({ serverPath: server });

    expect(printed()).toContain('afx ide stop && afx ide start');
    expect(printed()).toMatch(/Sidebar version:.*unknown/);
  });

  it('uses IDE_START_BUDGET_MS as the POST timeout', async () => {
    const server = fakeServer(join(dir('explicit'), 'codev-ide-server'));

    await ideStart({ serverPath: server });

    expect(h.tower.calls[0].timeout).toBe(IDE_START_BUDGET_MS);
  });

  it('a Tower that answers after more than 30 s does not trip a client timeout', async () => {
    const server = fakeServer(join(dir('explicit'), 'codev-ide-server'));
    h.tower.delayMs = 45_000;
    h.tower.response = { ok: true, port: 8200, pid: 4242 };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const started = ideStart({ serverPath: server });
    await vi.advanceTimersByTimeAsync(45_000);
    await started;

    expect(printed()).toContain('IDE server started');
    expect(printed()).not.toContain('Timed out');
  });

  it('reports a Tower refusal and exits 1', async () => {
    const server = fakeServer(join(dir('explicit'), 'codev-ide-server'));
    h.tower.status = 400;
    h.tower.response = { error: 'IDE server is version 1.100.0, below the supported floor' };

    await expect(ideStart({ serverPath: server })).rejects.toThrow('process.exit:1');

    expect(printed()).toContain('below the supported floor');
  });
});

describe('ideStop', () => {
  it('uses IDE_START_BUDGET_MS as the DELETE timeout', async () => {
    h.tower.response = { stopped: true, port: 8200 };

    await ideStop();

    expect(h.tower.calls[0]).toMatchObject({ method: 'DELETE', timeout: IDE_START_BUDGET_MS });
  });
});

describe('ideStatus (Scenario 22)', () => {
  it('shows the server version, extensions directory and sidebar version of a full record', async () => {
    h.tower.response = {
      record: {
        prefix: '/ide/',
        port: 8200,
        serverPath: '/usr/local/bin/codev-ide-server',
        serverVersion: '1.138.0',
        extensionsDir: '/home/u/.agent-farm/ide-extensions',
        sidebarVersion: '3.3.4',
      },
      alive: true,
      pid: 4242,
    };

    await ideStatus();

    expect(h.tower.calls[0].method).toBe('GET');
    expect(h.tower.calls[0].timeout).toBeLessThan(IDE_START_BUDGET_MS);
    expect(printed()).toMatch(/Server version:.*1\.138\.0/);
    expect(printed()).toMatch(/Extensions dir:.*\/home\/u\/\.agent-farm\/ide-extensions/);
    expect(printed()).toMatch(/Sidebar version:.*3\.3\.4/);
    expect(printed()).toContain('yes (PID 4242)');
  });

  it('shows unknown for the fields a legacy record lacks and still reports the live server', async () => {
    h.tower.response = {
      record: { prefix: '/ide/', port: 8200, serverPath: '/opt/server/bin/codev-ide-server' },
      alive: true,
      pid: 4242,
    };

    await ideStatus();

    expect(printed()).toMatch(/Server version:.*unknown/);
    expect(printed()).toMatch(/Extensions dir:.*unknown/);
    expect(printed()).toMatch(/Sidebar version:.*unknown/);
    expect(printed()).toContain('yes (PID 4242)');
  });

  it('hints at a bare afx ide start when no server is registered', async () => {
    h.tower.response = { record: null, alive: false, pid: null };

    await ideStatus();

    expect(printed()).toContain('Start one with: afx ide start');
    expect(printed()).not.toContain('--server-path');
  });
});

describe('ideInstall (Scenario 24)', () => {
  /** A fake `npm`: `i -g` installs a fake server into its own dir, or fails like EACCES when told to. */
  function fakeNpmInstall(binDir: string, failWith?: number): void {
    let install = `printf '#!/bin/sh\\nprintf "1.138.0\\\\nabc123\\\\narm64\\\\n"\\n' > '${binDir}/codev-ide-server'\n/bin/chmod +x '${binDir}/codev-ide-server'\nexit 0`;
    if (failWith !== undefined) {
      install = `echo 'npm error code EACCES' >&2\nexit ${failWith}`;
    }
    writeExecutable(join(binDir, 'npm'), `#!/bin/sh\nif [ "$1" = i ]; then\n${install}\nfi\nexit 1\n`);
  }

  it('reports the installed server version on success', async () => {
    const binDir = dir('npm-bin');
    fakeNpmInstall(binDir);
    process.env.PATH = binDir;

    await ideInstall();

    expect(printed()).toContain('Installed Codev IDE server 1.138.0');
    expect(printed()).toContain(join(binDir, 'codev-ide-server'));
    expect(h.tower.calls).toHaveLength(0);
  });

  it("exits with npm's non-zero status on failure", async () => {
    const binDir = dir('npm-bin');
    fakeNpmInstall(binDir, 243);
    process.env.PATH = binDir;

    await expect(ideInstall()).rejects.toThrow('process.exit:243');

    expect(printed()).toContain('npm exited with status 243');
    expect(h.tower.calls).toHaveLength(0);
  });
});
