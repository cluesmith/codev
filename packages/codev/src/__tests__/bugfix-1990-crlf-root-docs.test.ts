/**
 * Issue #1990 — on a CR LF CLAUDE.md / AGENTS.md (a Windows checkout with core.autocrlf),
 * `codev update` wrote the managed block in LF, leaving the doc with mixed line endings: an
 * unedited doc, a doc missing its block, and an adopter's edited doc alike. `init` from a CR
 * LF skeleton (a package built on a Windows checkout) wrote a mixed doc the same way.
 *
 * The block now takes the line ending the doc uses outside it. Each test builds the skeleton's
 * root-doc templates in a stated line ending, so it holds whatever the checkout's endings are.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { init } from '../commands/init.js';
import { update, type UpdateResult } from '../commands/update.js';
import { HOT_BLOCK_BEGIN, HOT_BLOCK_END, ROOT_DOCS } from '../lib/managed-block.js';

const templates = vi.hoisted(() => ({ dir: '' }));

vi.mock('../lib/templates.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/templates.js')>();
  return { ...actual, getTemplatesDir: () => templates.dir };
});

// init shells out to `git init` and `codev doctor`; neither bears on the files compared here.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn((command: string, options?: object) => {
      if (command === 'git init' || command === 'codev doctor') return Buffer.from('');
      return actual.execSync(command, options);
    }),
  };
});

vi.mock('chalk', () => {
  const plain = () => (s: string) => s;
  return {
    default: {
      bold: plain(),
      green: Object.assign(plain(), { bold: plain() }),
      yellow: plain(),
      red: plain(),
      blue: plain(),
      dim: plain(),
      cyan: plain(),
    },
  };
});

const toLf = (s: string): string => s.replace(/\r\n/g, '\n');
const toCrlf = (s: string): string => s.replace(/\r?\n/g, '\r\n');
const bareLineFeeds = (s: string): number => (s.match(/(?<!\r)\n/g) ?? []).length;

describe('issue #1990 — root docs keep their CR LF line endings', () => {
  let skeletons: string;
  /** The package skeleton with its root-doc templates in LF (as published) or CR LF. */
  const skeleton: Record<'lf' | 'crlf', string> = { lf: '', crlf: '' };
  let originalCwd: string;
  let baseDir: string;
  let projectDir: string;

  const read = (rel: string): string => fs.readFileSync(path.join(projectDir, rel), 'utf-8');
  const write = (rel: string, content: string): void => fs.writeFileSync(path.join(projectDir, rel), content);

  async function runUpdate(): Promise<UpdateResult> {
    const result = await update({ agent: true });
    expect(result.error).toBeUndefined();
    return result;
  }

  /** A project `init` wrote from the `ending` skeleton; update then runs on the same one. */
  async function initFrom(ending: 'lf' | 'crlf'): Promise<void> {
    templates.dir = skeleton[ending];
    process.chdir(baseDir);
    await init('fresh', { yes: true });
    projectDir = path.join(baseDir, 'fresh');
    process.chdir(projectDir);
  }

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../lib/templates.js')>('../lib/templates.js');
    skeletons = fs.mkdtempSync(path.join(os.tmpdir(), 'bugfix-1990-skeletons-'));
    for (const [ending, convert] of [['lf', toLf], ['crlf', toCrlf]] as const) {
      skeleton[ending] = path.join(skeletons, ending);
      fs.cpSync(actual.getTemplatesDir(), skeleton[ending], { recursive: true });
      for (const doc of ROOT_DOCS) {
        const file = path.join(skeleton[ending], 'templates', doc);
        fs.writeFileSync(file, convert(fs.readFileSync(file, 'utf-8')));
      }
    }
  });

  afterAll(() => {
    fs.rmSync(skeletons, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugfix-1990-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  describe('the published package (LF templates) on a project whose docs are CR LF', () => {
    beforeEach(async () => {
      await initFrom('lf');
    });

    it('an unedited CR LF doc: no conflict, and not one byte changes', async () => {
      const docs = ROOT_DOCS.map((doc) => toCrlf(read(doc)));
      ROOT_DOCS.forEach((doc, i) => write(doc, docs[i]));

      const result = await runUpdate();

      expect(result.rootConflicts).toEqual([]);
      expect(ROOT_DOCS.map(read)).toEqual(docs);
    });

    it('a CR LF doc missing its block: no conflict, and the block is put back in CR LF', async () => {
      const template = read('AGENTS.md');
      const begin = template.indexOf(HOT_BLOCK_BEGIN);
      const end = template.indexOf(HOT_BLOCK_END) + HOT_BLOCK_END.length;
      write('AGENTS.md', toCrlf(template.slice(0, begin) + template.slice(end + 2)));

      const result = await runUpdate();

      expect(result.rootConflicts).toEqual([]);
      expect(read('AGENTS.md')).toBe(toCrlf(template));
    });

    it('a CR LF doc edited outside the block: one conflict, and the doc is kept byte for byte', async () => {
      const edited = toCrlf(`${read('CLAUDE.md')}\n## Our house rules\n\nMY_RULE\n`);
      write('CLAUDE.md', edited);

      const result = await runUpdate();

      expect(result.rootConflicts.map((c) => c.file)).toEqual(['CLAUDE.md']);
      expect(read('CLAUDE.md')).toBe(edited);
    });

    it('a CR LF doc an earlier update left mixed (LF block) is healed to CR LF', async () => {
      const template = read('CLAUDE.md');
      const begin = template.indexOf(HOT_BLOCK_BEGIN);
      const end = template.indexOf(HOT_BLOCK_END) + HOT_BLOCK_END.length;
      const mixed = toCrlf(template.slice(0, begin)) + template.slice(begin, end) + toCrlf(template.slice(end));
      expect(bareLineFeeds(mixed)).toBeGreaterThan(0);
      write('CLAUDE.md', mixed);

      const result = await runUpdate();

      expect(result.rootConflicts).toEqual([]);
      expect(read('CLAUDE.md')).toBe(toCrlf(template));
    });
  });

  describe('a CR LF checkout of the skeleton (a package built on Windows)', () => {
    beforeEach(async () => {
      await initFrom('crlf');
    });

    it('init writes each doc in CR LF throughout, the block included', () => {
      for (const doc of ROOT_DOCS) {
        expect(read(doc), doc).toContain(HOT_BLOCK_BEGIN);
        expect(bareLineFeeds(read(doc)), doc).toBe(0);
      }
    });

    it('update then finds nothing to do', async () => {
      const before = ROOT_DOCS.map(read);

      const result = await runUpdate();

      expect(result.rootConflicts).toEqual([]);
      expect(ROOT_DOCS.map(read)).toEqual(before);
    });

    it('an edit outside the block: .codev-new is the template exactly as init wrote the doc', async () => {
      const template = read('CLAUDE.md');
      write('CLAUDE.md', `${template}## Our house rules\r\n\r\nMY_RULE\r\n`);

      const result = await runUpdate();

      expect(result.rootConflicts.map((c) => c.file)).toEqual(['CLAUDE.md']);
      expect(read('CLAUDE.md.codev-new')).toBe(template);
    });
  });
});
