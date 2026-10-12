/**
 * Spec 1789 phase 3: the Tower-owned extensions directory and the idempotent
 * install of the embedded sidebar. AGENT_FARM_DIR is pointed at a temp dir so
 * the tests never touch the real ~/.agent-farm. The server is a fake script
 * that logs its argv and, on install, indexes the sidebar the way the real
 * CLI does, so the skip-after-install path is observable.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const TMP_DIR = vi.hoisted(() => `${process.env.TMPDIR || '/tmp'}/ide-extensions-test-${process.pid}-${Date.now()}`);

vi.mock('@cluesmith/codev-core/constants', async (importActual) => {
  const actual = await importActual<typeof import('@cluesmith/codev-core/constants')>();
  return { ...actual, AGENT_FARM_DIR: TMP_DIR };
});

import {
  IDE_EXTENSION_DIR,
  IDE_EXTENSION_MANIFEST,
  IDE_EXTENSION_VSIX,
  IdeExtensionsDirError,
  IdeSidebarInstallError,
  ensureIdeExtensionsDir,
  ensureSidebarInstalled,
  getIdeExtensionsDir,
  locateEmbeddedSidebar,
  readInstalledExtensionVersion,
} from '../lib/ide-extensions.js';
import { buildIdeServerEnv } from '../lib/ide-version.js';
import * as buildManifest from '../../../scripts/ide-extension-manifest.mjs';

const SIDEBAR_ID = 'cluesmith.codev-vscode';
const EMBEDDED_VERSION = '3.3.4';
const codevPkgRoot = resolve(import.meta.dirname, '..', '..', '..');

let root: string;

function freshDir(name: string): string {
  return mkdtempSync(join(root, `${name}-`));
}

function writeEmbedded(dir: string, manifest: unknown = { id: SIDEBAR_ID, version: EMBEDDED_VERSION }): string {
  writeFileSync(join(dir, IDE_EXTENSION_VSIX), 'fake vsix');
  writeFileSync(join(dir, IDE_EXTENSION_MANIFEST), JSON.stringify(manifest));
  return dir;
}

function writeIndex(dir: string, entries: unknown): void {
  writeFileSync(join(dir, 'extensions.json'), JSON.stringify(entries));
}

function indexEntry(id: string, version: string): Record<string, unknown> {
  return { identifier: { id }, version, relativeLocation: `${id}-${version}` };
}

/**
 * A fake server CLI. It appends its argv (one JSON line per run) to
 * $FAKE_ARGV_LOG; on `--install-extension` it either fails ($FAKE_EXIT,
 * $FAKE_STDERR), hangs ($FAKE_HANG), or upserts the sidebar into the
 * directory's index at $FAKE_INSTALL_VERSION, keeping other entries.
 */
function fakeServer(dir: string): string {
  const path = join(dir, 'fake-ide-server');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify(args) + '\\n');
if (process.env.FAKE_HANG) { setInterval(() => {}, 1000); return; }
if (process.env.FAKE_EXIT) { process.stderr.write(process.env.FAKE_STDERR || ''); process.exit(Number(process.env.FAKE_EXIT)); }
const dir = args[args.indexOf('--extensions-dir') + 1];
const indexPath = path.join(dir, 'extensions.json');
let index = [];
try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch {}
index = index.filter((e) => e.identifier.id.toLowerCase() !== '${SIDEBAR_ID}');
if (process.env.FAKE_INSTALL_VERSION !== 'none') {
  index.push({ identifier: { id: '${SIDEBAR_ID}' }, version: process.env.FAKE_INSTALL_VERSION });
}
fs.writeFileSync(indexPath, JSON.stringify(index));
`,
  );
  chmodSync(path, 0o755);
  return path;
}

interface Harness {
  server: string;
  extensionsDir: string;
  embeddedDir: string;
  argvLog: string;
  env: (extra?: Record<string, string>) => Record<string, string>;
  runs: () => string[][];
}

function harness(): Harness {
  const base = freshDir('harness');
  const argvLog = join(base, 'argv.log');
  const embeddedDir = join(base, 'embedded');
  mkdirSync(embeddedDir);
  writeEmbedded(embeddedDir);
  return {
    server: fakeServer(base),
    extensionsDir: join(base, 'ide-extensions'),
    embeddedDir,
    argvLog,
    env: (extra = {}) => ({
      ...buildIdeServerEnv(),
      FAKE_ARGV_LOG: argvLog,
      FAKE_INSTALL_VERSION: EMBEDDED_VERSION,
      ...extra,
    }),
    runs: () => {
      if (!existsSync(argvLog)) return [];
      return readFileSync(argvLog, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as string[]);
    },
  };
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  root = mkdtempSync(join(TMP_DIR, 'case-'));
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('embedded sidebar constants', () => {
  it('match the build script that writes the embedded directory', () => {
    expect(IDE_EXTENSION_DIR).toBe(buildManifest.IDE_EXTENSION_DIR);
    expect(IDE_EXTENSION_VSIX).toBe(buildManifest.IDE_EXTENSION_VSIX);
    expect(IDE_EXTENSION_MANIFEST).toBe(buildManifest.IDE_EXTENSION_MANIFEST);
  });
});

describe('getIdeExtensionsDir', () => {
  it('lives under AGENT_FARM_DIR', () => {
    expect(getIdeExtensionsDir()).toBe(resolve(TMP_DIR, 'ide-extensions'));
  });
});

describe('ensureIdeExtensionsDir', () => {
  it('creates a missing directory owner-only (0700), whatever the umask', () => {
    const dir = join(root, 'nested', 'ide-extensions');
    const previousUmask = process.umask(0o000);
    try {
      ensureIdeExtensionsDir(dir);
    } finally {
      process.umask(previousUmask);
    }
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('accepts an existing directory owned by the current user', () => {
    const dir = freshDir('owned');
    expect(() => ensureIdeExtensionsDir(dir)).not.toThrow();
  });

  it('refuses a symlink to a directory (Scenario 17)', () => {
    const target = freshDir('target');
    const link = join(root, 'link');
    symlinkSync(target, link);
    expect(() => ensureIdeExtensionsDir(link)).toThrow(IdeExtensionsDirError);
    expect(() => ensureIdeExtensionsDir(link)).toThrow(`${link} is a symlink`);
  });

  it('refuses a dangling symlink instead of creating through it', () => {
    const link = join(root, 'dangling');
    symlinkSync(join(root, 'nowhere'), link);
    expect(() => ensureIdeExtensionsDir(link)).toThrow('is a symlink');
    expect(existsSync(join(root, 'nowhere'))).toBe(false);
  });

  it('refuses a regular file', () => {
    const file = join(root, 'file');
    writeFileSync(file, '');
    expect(() => ensureIdeExtensionsDir(file)).toThrow(`${file} is not a directory`);
  });

  it('refuses a directory owned by another user (Scenario 17)', () => {
    const dir = freshDir('foreign');
    const otherUid = statSync(dir).uid + 1;
    expect(() => ensureIdeExtensionsDir(dir, { uid: otherUid })).toThrow(IdeExtensionsDirError);
    expect(() => ensureIdeExtensionsDir(dir, { uid: otherUid })).toThrow(/is owned by uid \d+, not the current user/);
  });
});

describe('locateEmbeddedSidebar', () => {
  it('returns the vsix path, id and version from the manifest', () => {
    const dir = writeEmbedded(freshDir('embedded'));
    expect(locateEmbeddedSidebar(dir)).toEqual({
      vsixPath: join(dir, IDE_EXTENSION_VSIX),
      id: SIDEBAR_ID,
      version: EMBEDDED_VERSION,
    });
  });

  it('returns null when the vsix is missing', () => {
    const dir = freshDir('no-vsix');
    writeFileSync(join(dir, IDE_EXTENSION_MANIFEST), JSON.stringify({ id: SIDEBAR_ID, version: EMBEDDED_VERSION }));
    expect(locateEmbeddedSidebar(dir)).toBeNull();
  });

  it('returns null when the manifest is missing, malformed or incomplete', () => {
    const missing = freshDir('no-manifest');
    writeFileSync(join(missing, IDE_EXTENSION_VSIX), 'fake vsix');
    expect(locateEmbeddedSidebar(missing)).toBeNull();

    const malformed = freshDir('malformed');
    writeFileSync(join(malformed, IDE_EXTENSION_VSIX), 'fake vsix');
    writeFileSync(join(malformed, IDE_EXTENSION_MANIFEST), '{not json');
    expect(locateEmbeddedSidebar(malformed)).toBeNull();

    expect(locateEmbeddedSidebar(writeEmbedded(freshDir('no-version'), { id: SIDEBAR_ID }))).toBeNull();
    expect(locateEmbeddedSidebar(writeEmbedded(freshDir('null'), null))).toBeNull();
  });

  it('defaults to the ide-extension directory of the installed package', () => {
    const located = locateEmbeddedSidebar();
    const expectedVsix = join(codevPkgRoot, IDE_EXTENSION_DIR, IDE_EXTENSION_VSIX);
    if (existsSync(expectedVsix)) {
      expect(located?.vsixPath).toBe(expectedVsix);
    } else {
      expect(located).toBeNull();
    }
  });
});

describe('readInstalledExtensionVersion', () => {
  it('returns null when the index is absent or unreadable', () => {
    const dir = freshDir('index');
    expect(readInstalledExtensionVersion(dir, SIDEBAR_ID)).toBeNull();
    writeFileSync(join(dir, 'extensions.json'), '{not json');
    expect(readInstalledExtensionVersion(dir, SIDEBAR_ID)).toBeNull();
    writeIndex(dir, { identifier: { id: SIDEBAR_ID }, version: '1.0.0' });
    expect(readInstalledExtensionVersion(dir, SIDEBAR_ID)).toBeNull();
  });

  it('returns null when the extension is not listed', () => {
    const dir = freshDir('index');
    writeIndex(dir, [indexEntry('other.extension', '2.0.0'), null, { version: '1.0.0' }]);
    expect(readInstalledExtensionVersion(dir, SIDEBAR_ID)).toBeNull();
  });

  it('matches the identifier case-insensitively', () => {
    const dir = freshDir('index');
    writeIndex(dir, [indexEntry('other.extension', '2.0.0'), indexEntry('Cluesmith.Codev-VSCode', '3.3.1')]);
    expect(readInstalledExtensionVersion(dir, SIDEBAR_ID)).toBe('3.3.1');
  });
});

describe('ensureSidebarInstalled', () => {
  it('installs into an empty directory with exactly the expected args (Scenario 12)', async () => {
    const h = harness();
    const result = await ensureSidebarInstalled(h.server, {
      extensionsDir: h.extensionsDir,
      embeddedDir: h.embeddedDir,
      env: h.env(),
      log: () => {},
    });
    expect(result).toEqual({ outcome: 'installed', version: EMBEDDED_VERSION, previousVersion: null });
    expect(h.runs()).toEqual([
      ['--install-extension', join(h.embeddedDir, IDE_EXTENSION_VSIX), '--force', '--extensions-dir', h.extensionsDir],
    ]);
    expect(statSync(h.extensionsDir).mode & 0o777).toBe(0o700);
  });

  it('skips without a subprocess when the embedded version is indexed (Scenario 13)', async () => {
    const h = harness();
    const opts = { extensionsDir: h.extensionsDir, embeddedDir: h.embeddedDir, env: h.env(), log: () => {} };
    await ensureSidebarInstalled(h.server, opts);
    expect(h.runs()).toHaveLength(1);

    const result = await ensureSidebarInstalled(h.server, opts);
    expect(result).toEqual({ outcome: 'skipped', version: EMBEDDED_VERSION, previousVersion: EMBEDDED_VERSION });
    expect(h.runs()).toHaveLength(1);
  });

  it.each(['3.3.3', '3.4.0'])('reinstalls with --force over indexed version %s (Scenario 14)', async (indexed) => {
    const h = harness();
    ensureIdeExtensionsDir(h.extensionsDir);
    writeIndex(h.extensionsDir, [indexEntry('other.extension', '2.0.0'), indexEntry(SIDEBAR_ID, indexed)]);

    const result = await ensureSidebarInstalled(h.server, {
      extensionsDir: h.extensionsDir,
      embeddedDir: h.embeddedDir,
      env: h.env(),
      log: () => {},
    });
    expect(result).toEqual({ outcome: 'installed', version: EMBEDDED_VERSION, previousVersion: indexed });
    expect(h.runs()).toHaveLength(1);
    expect(h.runs()[0]).toContain('--force');
    expect(readInstalledExtensionVersion(h.extensionsDir, SIDEBAR_ID)).toBe(EMBEDDED_VERSION);
    expect(readInstalledExtensionVersion(h.extensionsDir, 'other.extension')).toBe('2.0.0');
  });

  it('throws with stderr and the built-in hint when the install exits non-zero (Scenario 15)', async () => {
    const h = harness();
    const stderr = "Extension 'cluesmith.codev-vscode' is a built-in extension and not allowed to be updated";
    const error = await ensureSidebarInstalled(h.server, {
      extensionsDir: h.extensionsDir,
      embeddedDir: h.embeddedDir,
      env: h.env({ FAKE_EXIT: '1', FAKE_STDERR: stderr }),
      log: () => {},
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdeSidebarInstallError);
    const message = (error as Error).message;
    expect(message).toContain('exit code 1');
    expect(message).toContain(stderr);
    expect(message).toContain('bundles codev-vscode as a built-in');
  });

  it('throws when the install does not finish within the timeout (Scenario 15)', async () => {
    const h = harness();
    const started = Date.now();
    const error = await ensureSidebarInstalled(h.server, {
      extensionsDir: h.extensionsDir,
      embeddedDir: h.embeddedDir,
      env: h.env({ FAKE_HANG: '1' }),
      timeoutMs: 300,
      log: () => {},
    }).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(error).toBeInstanceOf(IdeSidebarInstallError);
    expect((error as Error).message).toContain('timed out after 0.3s');
    expect((error as Error).message).toContain('bundles codev-vscode as a built-in');
  });

  it('throws when the install succeeds but the index does not list the embedded version', async () => {
    const h = harness();
    const error = await ensureSidebarInstalled(h.server, {
      extensionsDir: h.extensionsDir,
      embeddedDir: h.embeddedDir,
      env: h.env({ FAKE_INSTALL_VERSION: 'none' }),
      log: () => {},
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdeSidebarInstallError);
    expect((error as Error).message).toContain('lists no version');
    expect((error as Error).message).not.toContain('built-in');
  });

  it('warns and returns missing-vsix without running the server (Scenario 16)', async () => {
    const h = harness();
    rmSync(join(h.embeddedDir, IDE_EXTENSION_VSIX));
    const log = vi.fn();
    const result = await ensureSidebarInstalled(h.server, {
      extensionsDir: h.extensionsDir,
      embeddedDir: h.embeddedDir,
      env: h.env(),
      log,
    });
    expect(result).toEqual({ outcome: 'missing-vsix', version: null, previousVersion: null });
    expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining('Embedded Codev sidebar not found'));
    expect(h.runs()).toEqual([]);
    expect(statSync(h.extensionsDir).isDirectory()).toBe(true);
  });

  it('refuses an unsafe extensions directory before running the server (Scenario 17)', async () => {
    const h = harness();
    symlinkSync(freshDir('elsewhere'), h.extensionsDir);
    await expect(
      ensureSidebarInstalled(h.server, {
        extensionsDir: h.extensionsDir,
        embeddedDir: h.embeddedDir,
        env: h.env(),
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(IdeExtensionsDirError);
    expect(h.runs()).toEqual([]);
  });

  it('defaults to the Tower-owned directory under AGENT_FARM_DIR', async () => {
    const h = harness();
    await ensureSidebarInstalled(h.server, { embeddedDir: h.embeddedDir, env: h.env(), log: () => {} });
    expect(h.runs()[0].at(-1)).toBe(getIdeExtensionsDir());
    expect(readInstalledExtensionVersion(getIdeExtensionsDir(), SIDEBAR_ID)).toBe(EMBEDDED_VERSION);
  });
});
