/**
 * Issue #1982 — `codev update` reported CLAUDE.md and AGENTS.md as conflicts on a project
 * nobody had edited, and wrote `.codev-new` copies byte-identical to them: `copyRootFiles`
 * treated any existing root doc as a conflict, comparing nothing. Its `--dry-run` also
 * printed hot-tier, cold-tier and managed-block lines the real run did not.
 *
 * A root doc is now compared with the template as the managed-block refresh would leave
 * both; and a dry run computes the same result as the real run, writing nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from '../commands/init.js';
import { update, type UpdateResult } from '../commands/update.js';
import { HOT_BLOCK_BEGIN, HOT_BLOCK_END } from '../lib/managed-block.js';

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

const ROOT_DOCS = ['CLAUDE.md', 'AGENTS.md'];

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

describe('issue #1982 — codev update on root docs', () => {
  let originalCwd: string;
  let baseDir: string;
  let projectDir: string;
  let logged: string[];

  const read = (rel: string): string => fs.readFileSync(path.join(projectDir, rel), 'utf-8');
  const write = (rel: string, content: string): void => fs.writeFileSync(path.join(projectDir, rel), content);

  /** Run update in agent mode and return its result with the lines it logged. */
  async function runUpdate(options: { dryRun?: boolean } = {}): Promise<{ result: UpdateResult; report: string[] }> {
    logged = [];
    const result = await update({ agent: true, ...options });
    expect(result.error).toBeUndefined();
    return { result, report: logged };
  }

  beforeEach(async () => {
    originalCwd = process.cwd();
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugfix-1982-'));
    logged = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '));
    });
    process.chdir(baseDir);
    await init('fresh', { yes: true });
    projectDir = path.join(baseDir, 'fresh');
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('init then update on an untouched project: zero conflicts, zero .codev-new, docs unchanged', async () => {
    const before = ROOT_DOCS.map(read);

    const { result, report } = await runUpdate();

    expect(result.rootConflicts).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(codevNewFiles(projectDir)).toEqual([]);
    expect(ROOT_DOCS.map(read)).toEqual(before);
    expect(report).toContain('  Already up to date!');
  });

  it('an edit outside the managed block is one conflict, and the edit is kept', async () => {
    const template = read('CLAUDE.md');
    const edited = `${template}\n## Our house rules\n\nMY_RULE\n`;
    write('CLAUDE.md', edited);

    const { result } = await runUpdate();

    expect(result.rootConflicts.map((c) => c.file)).toEqual(['CLAUDE.md']);
    expect(result.conflicts).toEqual([]);
    expect(read('CLAUDE.md')).toBe(edited);
    expect(read('CLAUDE.md.codev-new')).toBe(template);
    expect(codevNewFiles(projectDir)).toEqual(['CLAUDE.md.codev-new']);
  });

  it('an edit inside the managed block is regenerated and reported as a block refresh, never a conflict', async () => {
    const template = read('CLAUDE.md');
    write('CLAUDE.md', template.replace(HOT_BLOCK_END, `MY_LINE_INSIDE_THE_BLOCK\n${HOT_BLOCK_END}`));

    const { result, report } = await runUpdate();

    expect(result.rootConflicts).toEqual([]);
    expect(codevNewFiles(projectDir)).toEqual([]);
    expect(read('CLAUDE.md')).toBe(template);
    expect(report).toContain('  ~ (hot-tier block refreshed) CLAUDE.md');
  });

  it('a doc whose managed block is missing altogether is not a conflict; the block is put back', async () => {
    const template = read('AGENTS.md');
    const begin = template.indexOf(HOT_BLOCK_BEGIN);
    const end = template.indexOf(HOT_BLOCK_END) + HOT_BLOCK_END.length;
    // The block and the blank line after it, as in a doc written before Spec 987.
    write('AGENTS.md', template.slice(0, begin) + template.slice(end + 2));

    const { result, report } = await runUpdate();

    expect(result.rootConflicts).toEqual([]);
    expect(codevNewFiles(projectDir)).toEqual([]);
    expect(read('AGENTS.md')).toBe(template);
    expect(report).toContain('  ~ (hot-tier block refreshed) AGENTS.md');
  });

  it('removes a leftover .codev-new that holds exactly the template, beside an up-to-date doc', async () => {
    const template = read('CLAUDE.md');
    write('CLAUDE.md.codev-new', template);
    write('AGENTS.md.codev-new', 'an earlier version, not yet merged\n');

    const { result, report } = await runUpdate();

    expect(result.rootConflicts).toEqual([]);
    expect(codevNewFiles(projectDir)).toEqual(['AGENTS.md.codev-new']);
    expect(read('AGENTS.md.codev-new')).toBe('an earlier version, not yet merged\n');
    expect(report).toContain('  - (removed, nothing left to merge) CLAUDE.md.codev-new');
  });

  it('a checkout whose directory is not the name init saw is still up to date; its leftover is resolved', async () => {
    const before = ROOT_DOCS.map(read);
    // A leftover this bug wrote while the checkout still had init's name.
    write('CLAUDE.md.codev-new', before[0]);
    process.chdir(baseDir);
    const renamed = path.join(baseDir, 'cloned-elsewhere');
    fs.renameSync(projectDir, renamed);
    projectDir = renamed;
    process.chdir(projectDir);

    const { result } = await runUpdate();

    expect(result.rootConflicts).toEqual([]);
    expect(codevNewFiles(projectDir)).toEqual([]);
    expect(ROOT_DOCS.map(read)).toEqual(before);
  });

  it('a CRLF checkout of an unedited doc is up to date', async () => {
    const crlf = read('CLAUDE.md').replace(/\n/g, '\r\n');
    write('CLAUDE.md', crlf);

    const { result } = await runUpdate();

    expect(result.rootConflicts).toEqual([]);
    expect(codevNewFiles(projectDir)).toEqual([]);
  });

  it('an edited skill is still kept, with its new version as .codev-new beside it', async () => {
    const skill = path.join('.claude', 'skills', 'arch-init', 'SKILL.md');
    const shipped = read(skill);
    const edited = `${shipped}\nMY_SKILL_NOTE\n`;
    write(skill, edited);

    const { result } = await runUpdate();

    expect(result.rootConflicts).toEqual([]);
    expect(result.conflicts.map((c) => c.file)).toEqual([skill.split(path.sep).join('/')]);
    expect(read(skill)).toBe(edited);
    expect(read(`${skill}.codev-new`)).toBe(shipped);
  });

  // The limit #1982 pinned here is lifted by #1985: root docs now have a history of every
  // shipped version (SHIPPED_ROOT_DOC_HASHES), as skills do, so an unedited doc an older
  // release wrote is replaced. A doc that is no shipped version is still the adopter's.
  it('an unedited doc from an older release is replaced; a doc that is no shipped version stays a conflict', async () => {
    const current = read('CLAUDE.md');
    const lastSection = current.lastIndexOf('\n## ');
    expect(lastSection).toBeGreaterThan(current.indexOf(HOT_BLOCK_END));
    // The current template less its last section: no release shipped it.
    const notShipped = `${current.slice(0, lastSection)}\n`;
    write('CLAUDE.md', notShipped);
    // AGENTS.md as v3.3.4's init wrote it for this project, from the template in git history.
    const fixture = fileURLToPath(new URL('./fixtures/root-doc-templates/v3.3.4.AGENTS.md.template', import.meta.url));
    const currentAgents = read('AGENTS.md');
    write('AGENTS.md', fs.readFileSync(fixture, 'utf-8').split('{{PROJECT_NAME}}').join('fresh'));

    const { result } = await runUpdate();

    expect(result.rootConflicts.map((c) => c.file)).toEqual(['CLAUDE.md']);
    expect(read('CLAUDE.md')).toBe(notShipped);
    expect(read('CLAUDE.md.codev-new')).toBe(current);
    expect(result.updated).toEqual(['AGENTS.md']);
    expect(read('AGENTS.md')).toBe(currentAgents);
    expect(codevNewFiles(projectDir)).toEqual(['CLAUDE.md.codev-new']);
  });

  describe('--dry-run reports exactly what the real run then does, on the same project', () => {
    const DRY_RUN_FOOTER = ['', 'Dry run complete. Run without --dry-run to apply changes.'];

    /** The report with its dry-run-only lines dropped and its preview wording made plain. */
    const asRealRun = (report: string[]): string[] => {
      expect(report.slice(-DRY_RUN_FOOTER.length)).toEqual(DRY_RUN_FOOTER);
      return report
        .slice(0, -DRY_RUN_FOOTER.length)
        .filter((line) => line !== '(dry run - no files will be changed)')
        .map((line) => line.replace(/would be /g, ''));
    };

    const scenarios: Array<[string, () => void]> = [
      ['an untouched project', () => {}],
      ['a project edited outside and inside the managed block', () => {
        write('CLAUDE.md', `${read('CLAUDE.md')}\nMY_RULE\n`);
        write('AGENTS.md', read('AGENTS.md').replace(HOT_BLOCK_END, `MY_LINE\n${HOT_BLOCK_END}`));
      }],
      ['a project with a leftover .codev-new beside an up-to-date doc', () => {
        write('CLAUDE.md.codev-new', read('CLAUDE.md'));
      }],
      ['a project missing one hot file, the cold files and AGENTS.md', () => {
        fs.rmSync(path.join(projectDir, 'codev', 'resources', 'lessons-critical.md'));
        fs.rmSync(path.join(projectDir, 'codev', 'resources', 'arch.md'));
        fs.rmSync(path.join(projectDir, 'codev', 'resources', 'lessons-learned.md'));
        fs.rmSync(path.join(projectDir, 'AGENTS.md'));
      }],
    ];

    it.each(scenarios)('%s', async (_name, prepare) => {
      prepare();

      const dry = await runUpdate({ dryRun: true });
      const real = await runUpdate();

      expect(asRealRun(dry.report)).toEqual(real.report);
      for (const key of ['newFiles', 'updated', 'conflicts', 'rootConflicts'] as const) {
        expect(dry.result[key], key).toEqual(real.result[key]);
      }
    });
  });
});
