/**
 * Issue #1985 — `codev update` called an unedited CLAUDE.md / AGENTS.md a conflict when an
 * older release wrote it and the template has since changed outside the managed block.
 * SHIPPED_ROOT_DOC_HASHES now lists every shipped version of each template, hashed in the
 * form `rootDocHashForm` gives (LF, block emptied, project name put back to the
 * placeholder); a doc whose hash is listed is replaced, as an unedited skill is (#1811).
 *
 * The fixtures are the templates as tagged releases shipped them, copied from git:
 *   v1.1.0  packages/codev/templates/{CLAUDE,AGENTS}.md    (before the managed block)
 *   v3.1.5  codev-skeleton/templates/{CLAUDE,AGENTS}.md    (the last before the block)
 *   v3.3.4  codev-skeleton/templates/{CLAUDE,AGENTS}.md    (with the block)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from '../commands/init.js';
import { update, type UpdateResult } from '../commands/update.js';
import { HOT_BLOCK_BEGIN, ROOT_DOCS, syncHotContextBlock, withEmptyHotBlock } from '../lib/managed-block.js';
import { hashRootDocForm, PROJECT_NAME_PLACEHOLDER, rootDocHashForm } from '../lib/scaffold.js';
import { getTemplatesDir } from '../lib/templates.js';
import { SHIPPED_ROOT_DOC_HASHES } from '../lib/shipped-root-doc-hashes.js';

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

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const FIXTURES = path.join(here, 'fixtures', 'root-doc-templates');
const VERSIONS = ['v1.1.0', 'v3.1.5', 'v3.3.4'] as const;
const PRE_BLOCK_VERSIONS = ['v1.1.0', 'v3.1.5'] as const;
type Doc = (typeof ROOT_DOCS)[number];

/**
 * A doc as `init` of `version` wrote it for `projectName`. Read with LF line endings, as git
 * stores and the release shipped it: a Windows checkout turns the fixture into CRLF.
 */
function shipped(version: string, doc: Doc, projectName = 'fresh'): string {
  const template = fs.readFileSync(path.join(FIXTURES, `${version}.${doc}.template`), 'utf-8').replace(/\r\n/g, '\n');
  return template.split(PROJECT_NAME_PLACEHOLDER).join(projectName);
}

/** The template update writes as `.codev-new`: the package skeleton's, under `projectName`. */
function packageTemplate(doc: Doc, projectName: string): string {
  const template = fs.readFileSync(path.join(getTemplatesDir(), 'templates', doc), 'utf-8');
  return template.split(PROJECT_NAME_PLACEHOLDER).join(projectName);
}

/** A doc's first line, in either line ending. */
const firstLine = (doc: string): string => doc.split(/\r?\n/, 1)[0];

function currentTemplate(templatesDir: string, doc: Doc): string {
  return fs.readFileSync(path.join(templatesDir, doc), 'utf-8');
}

function isListed(doc: Doc, content: string, template: string): boolean {
  const parsed = rootDocHashForm(content, template);
  return parsed !== null && (SHIPPED_ROOT_DOC_HASHES[doc] ?? []).includes(hashRootDocForm(parsed.form));
}

function codevNewFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.codev-new')) found.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return found.sort();
}

describe('issue #1985 — codev update on root docs from an older release', () => {
  let originalCwd: string;
  let baseDir: string;
  let projectDir: string;
  let logged: string[];
  /** The docs as a fresh init writes them for 'fresh': what a replaced doc must equal. */
  let fresh: Record<Doc, string>;

  const read = (rel: string): string => fs.readFileSync(path.join(projectDir, rel), 'utf-8');
  const write = (rel: string, content: string): void => fs.writeFileSync(path.join(projectDir, rel), content);
  const holdVersion = (version: string): void => {
    for (const doc of ROOT_DOCS) write(doc, shipped(version, doc));
  };

  async function runUpdate(options: { dryRun?: boolean } = {}): Promise<{ result: UpdateResult; report: string[] }> {
    logged = [];
    const result = await update({ agent: true, ...options });
    expect(result.error).toBeUndefined();
    return { result, report: logged };
  }

  async function initProject(name: string): Promise<string> {
    process.chdir(baseDir);
    await init(name, { yes: true });
    return path.join(baseDir, name);
  }

  beforeEach(async () => {
    originalCwd = process.cwd();
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-1985-'));
    logged = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '));
    });
    projectDir = await initProject('fresh');
    process.chdir(projectDir);
    fresh = { 'CLAUDE.md': read('CLAUDE.md'), 'AGENTS.md': read('AGENTS.md') };
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it.each(VERSIONS)('%s, unedited: replaced as init writes it, zero conflicts, zero .codev-new', async (version) => {
    holdVersion(version);
    expect(read('CLAUDE.md')).not.toBe(fresh['CLAUDE.md']);

    const { result, report } = await runUpdate();

    expect(result.rootConflicts).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(codevNewFiles(projectDir)).toEqual([]);
    expect(result.updated).toEqual(['CLAUDE.md', 'AGENTS.md']);
    expect(report).toContain('  ~ (updated) CLAUDE.md');
    expect(report).toContain('  ~ (updated) AGENTS.md');
    for (const doc of ROOT_DOCS) expect(read(doc), doc).toBe(fresh[doc]);
  });

  it.each(VERSIONS)('%s with one line added outside the block: a conflict, and the line is kept', async (version) => {
    holdVersion(version);
    const edited = `${shipped(version, 'CLAUDE.md')}\nMY_RULE\n`;
    write('CLAUDE.md', edited);

    const { result } = await runUpdate();

    expect(result.rootConflicts.map((c) => c.file)).toEqual(['CLAUDE.md']);
    expect(result.updated).toEqual(['AGENTS.md']);
    // Only the managed block may change (a pre-block doc gets one); everything else is kept.
    expect(withEmptyHotBlock(read('CLAUDE.md'))).toBe(withEmptyHotBlock(edited));
    // In the doc's line ending, LF here, whatever the checkout's templates use (#1990).
    expect(read('CLAUDE.md.codev-new')).toBe(packageTemplate('CLAUDE.md', 'fresh').replace(/\r\n/g, '\n'));
    expect(read('AGENTS.md')).toBe(fresh['AGENTS.md']);
  });

  describe('a version from before the managed block hashes the same with or without the block a later update put in', () => {
    it.each(PRE_BLOCK_VERSIONS)('%s', (version) => {
      const templatesDir = path.join(repoRoot, 'codev-skeleton', 'templates');
      for (const doc of ROOT_DOCS) {
        const asShipped = shipped(version, doc);
        expect(asShipped).not.toContain(HOT_BLOCK_BEGIN);
        // The adopter's later update put the live block in, with the real refresh.
        write(doc, asShipped);
        expect(syncHotContextBlock(projectDir)).toContain(doc);
        const withBlock = read(doc);
        expect(withBlock).toContain(HOT_BLOCK_BEGIN);

        const template = currentTemplate(templatesDir, doc);
        expect(rootDocHashForm(withBlock, template)).toEqual(rootDocHashForm(asShipped, template));
        expect(isListed(doc, asShipped, template), `${version} ${doc} as shipped`).toBe(true);
        expect(isListed(doc, withBlock, template), `${version} ${doc} with the block`).toBe(true);
      }
    });

    it.each(PRE_BLOCK_VERSIONS)('%s with the block put in is replaced as init writes it', async (version) => {
      holdVersion(version);
      syncHotContextBlock(projectDir);

      const { result } = await runUpdate();

      expect(result.rootConflicts).toEqual([]);
      expect(codevNewFiles(projectDir)).toEqual([]);
      for (const doc of ROOT_DOCS) expect(read(doc), doc).toBe(fresh[doc]);
    });
  });

  it('a project name other than the directory name, holding " - ", in CRLF: replaced as init writes it for that name', async () => {
    const name = 'legacy app - v2';
    const named = await initProject(name);
    const expected = ROOT_DOCS.map((doc) => fs.readFileSync(path.join(named, doc), 'utf-8'));
    process.chdir(projectDir);
    for (const doc of ROOT_DOCS) write(doc, shipped('v3.1.5', doc, name).replace(/\n/g, '\r\n'));

    const { result } = await runUpdate();

    expect(result.rootConflicts).toEqual([]);
    expect(result.updated).toEqual(['CLAUDE.md', 'AGENTS.md']);
    expect(codevNewFiles(projectDir)).toEqual([]);
    expect(ROOT_DOCS.map(read)).toEqual(expected);
    expect(firstLine(read('CLAUDE.md'))).toBe('# legacy app - v2 - Claude Code Instructions');
  });

  it('a "$" in the project name is written literally, by init and by a replacement', async () => {
    const name = 'cash$&flow';
    const named = await initProject(name);
    const heading = `# ${name} - Claude Code Instructions`;
    expect(firstLine(fs.readFileSync(path.join(named, 'CLAUDE.md'), 'utf-8'))).toBe(heading);
    process.chdir(projectDir);
    write('CLAUDE.md', shipped('v1.1.0', 'CLAUDE.md', name));

    const { result } = await runUpdate();

    expect(result.updated).toEqual(['CLAUDE.md']);
    expect(read('CLAUDE.md')).toBe(fs.readFileSync(path.join(named, 'CLAUDE.md'), 'utf-8'));
  });

  it('a doc whose first line is not the template heading is a conflict, and is kept', async () => {
    holdVersion('v3.3.4');
    const old = shipped('v3.3.4', 'CLAUDE.md');
    const retitled = old.replace('# fresh - Claude Code Instructions\n', '# fresh - Our Instructions\n');
    const prefaced = `Read me first.\n${shipped('v3.3.4', 'AGENTS.md')}`;
    expect(retitled).not.toBe(old);
    write('CLAUDE.md', retitled);
    write('AGENTS.md', prefaced);

    const { result } = await runUpdate();

    expect(result.rootConflicts.map((c) => c.file)).toEqual(['CLAUDE.md', 'AGENTS.md']);
    expect(result.updated).toEqual([]);
    expect(read('CLAUDE.md')).toBe(retitled);
    expect(read('AGENTS.md').startsWith('Read me first.\n')).toBe(true);
  });

  it.each([
    ['a line in the middle', (lines: string[]) => Math.floor(lines.length / 2)],
    ['the last line', (lines: string[]) => lines.length - 2],
  ])('an old version with %s changed is a conflict, and the line is kept', async (_where, pick) => {
    holdVersion('v3.3.4');
    const lines = shipped('v3.3.4', 'CLAUDE.md').split('\n');
    const at = pick(lines);
    expect(lines[at]).not.toBe('');
    lines[at] = `${lines[at]} (our change)`;
    const edited = lines.join('\n');
    write('CLAUDE.md', edited);

    const { result } = await runUpdate();

    expect(result.rootConflicts.map((c) => c.file)).toEqual(['CLAUDE.md']);
    expect(withEmptyHotBlock(read('CLAUDE.md'))).toBe(withEmptyHotBlock(edited));
    expect(read('CLAUDE.md')).toContain('(our change)');
  });

  // Replacement never writes through a symlink. The block refresh still writes its block
  // into a symlinked doc's target, as it has since Spec 987; this change leaves that alone.
  it('never replaces a symlinked doc: one linking to an old version stays a conflict, its target not replaced', async () => {
    holdVersion('v3.3.4');
    const old = shipped('v3.3.4', 'CLAUDE.md');
    fs.rmSync(path.join(projectDir, 'CLAUDE.md'));
    fs.writeFileSync(path.join(baseDir, 'shared-CLAUDE.md'), old);
    fs.symlinkSync(path.join(baseDir, 'shared-CLAUDE.md'), path.join(projectDir, 'CLAUDE.md'));

    const { result } = await runUpdate();

    expect(result.rootConflicts.map((c) => c.file)).toEqual(['CLAUDE.md']);
    expect(fs.lstatSync(path.join(projectDir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(withEmptyHotBlock(fs.readFileSync(path.join(baseDir, 'shared-CLAUDE.md'), 'utf-8'))).toBe(withEmptyHotBlock(old));
  });

  it('a leftover .codev-new that is a shipped version is removed beside a replaced or up-to-date doc; an edited one stays', async () => {
    write('CLAUDE.md', shipped('v1.1.0', 'CLAUDE.md'));
    write('CLAUDE.md.codev-new', shipped('v3.1.5', 'CLAUDE.md'));
    write('AGENTS.md.codev-new', shipped('v3.3.4', 'AGENTS.md'));

    const { result, report } = await runUpdate();

    expect(result.rootConflicts).toEqual([]);
    expect(codevNewFiles(projectDir)).toEqual([]);
    expect(report).toContain('  - (removed, nothing left to merge) CLAUDE.md.codev-new');
    expect(report).toContain('  - (removed, nothing left to merge) AGENTS.md.codev-new');

    const merging = `${shipped('v3.3.4', 'AGENTS.md')}\nMY_MERGE_NOTE\n`;
    write('CLAUDE.md', shipped('v3.1.5', 'CLAUDE.md'));
    write('AGENTS.md.codev-new', merging);

    await runUpdate();

    expect(read('CLAUDE.md')).toBe(fresh['CLAUDE.md']);
    expect(codevNewFiles(projectDir)).toEqual(['AGENTS.md.codev-new']);
    expect(read('AGENTS.md.codev-new')).toBe(merging);
  });

  describe('--dry-run reports exactly what the real run then does', () => {
    const DRY_RUN_FOOTER = ['', 'Dry run complete. Run without --dry-run to apply changes.'];
    const asRealRun = (report: string[]): string[] => {
      expect(report.slice(-DRY_RUN_FOOTER.length)).toEqual(DRY_RUN_FOOTER);
      return report
        .slice(0, -DRY_RUN_FOOTER.length)
        .filter((line) => line !== '(dry run - no files will be changed)')
        .map((line) => line.replace(/would be /g, ''));
    };

    it.each(VERSIONS)('on a project holding %s', async (version) => {
      holdVersion(version);
      const before = ROOT_DOCS.map(read);

      const dry = await runUpdate({ dryRun: true });
      expect(ROOT_DOCS.map(read)).toEqual(before);
      const real = await runUpdate();

      expect(asRealRun(dry.report)).toEqual(real.report);
      for (const key of ['newFiles', 'updated', 'conflicts', 'rootConflicts'] as const) {
        expect(dry.result[key], key).toEqual(real.result[key]);
      }
    });
  });
});

describe('shipped root-doc history', () => {
  /** The root docs whose template in `templatesDir` is not in SHIPPED_ROOT_DOC_HASHES. */
  const unlisted = (templatesDir: string): Doc[] =>
    ROOT_DOCS.filter((doc) => {
      const template = currentTemplate(templatesDir, doc);
      return !isListed(doc, template, template);
    });

  it('lists the current version of each root-doc template', () => {
    expect(
      unlisted(path.join(repoRoot, 'codev-skeleton', 'templates')),
      'a root-doc template changed: regenerate the history with `pnpm --filter @cluesmith/codev generate-skill-hashes`',
    ).toEqual([]);
  });

  it('fails for a template changed without regenerating', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-1985-templates-'));
    try {
      for (const doc of ROOT_DOCS) {
        fs.copyFileSync(path.join(repoRoot, 'codev-skeleton', 'templates', doc), path.join(dir, doc));
      }
      fs.appendFileSync(path.join(dir, 'CLAUDE.md'), '\n## A section added without regenerating\n');
      expect(unlisted(dir)).toEqual(['CLAUDE.md']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
