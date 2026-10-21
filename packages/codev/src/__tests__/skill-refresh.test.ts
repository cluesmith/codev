/**
 * Issue #1811: `codev update` refreshes unedited shipped skills and offers an edited one's
 * new version as `.codev-new`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifySkill,
  hashSkillDir,
  hashSkillFiles,
  refreshSkills,
} from '../lib/skill-refresh.js';
import { SHIPPED_SKILL_HASHES } from '../lib/shipped-skill-hashes.js';
import { SKILL_PROVIDERS } from '../lib/scaffold.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

let base: string;
let skeleton: string;
let project: string;

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(project, rel), 'utf-8');
}

const OLD = '# demo\n\nVersion one.\n';
const NEW = '# demo\n\nVersion two.\n';
const OLD_HASH = hashSkillFiles([{ path: 'SKILL.md', content: OLD }]);
const HISTORY = { '.claude/skills/demo': [OLD_HASH] };

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-refresh-'));
  skeleton = path.join(base, 'skeleton');
  project = path.join(base, 'project');
  write(skeleton, '.claude/skills/demo/SKILL.md', NEW);
  fs.mkdirSync(project, { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('skill hashing', () => {
  it('ignores line endings, a pending .codev-new and .DS_Store', () => {
    write(project, 'a/SKILL.md', NEW);
    write(project, 'b/SKILL.md', NEW.replace(/\n/g, '\r\n'));
    write(project, 'b/SKILL.md.codev-new', 'pending');
    write(project, 'b/.DS_Store', 'finder');
    expect(hashSkillDir(path.join(project, 'b'))).toBe(hashSkillDir(path.join(project, 'a')));
  });

  it('a symlinked skill directory is not a directory', () => {
    write(base, 'elsewhere/SKILL.md', NEW);
    fs.mkdirSync(path.join(project, '.claude/skills'), { recursive: true });
    fs.symlinkSync(path.join(base, 'elsewhere'), path.join(project, '.claude/skills/demo'));
    expect(classifySkill(path.join(project, '.claude/skills/demo'), path.join(skeleton, '.claude/skills/demo'), '.claude/skills/demo'))
      .toBe('not-regular');
  });

  it.skipIf(process.getuid?.() === 0)('an unreadable skill directory is not-regular, not a thrown update', () => {
    write(project, '.claude/skills/demo/SKILL.md', NEW);
    const locked = path.join(project, '.claude/skills/demo');
    fs.chmodSync(locked, 0o000);
    try {
      expect(classifySkill(locked, path.join(skeleton, '.claude/skills/demo'), '.claude/skills/demo')).toBe('not-regular');
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});

describe('refreshSkills', () => {
  it('adds a missing skill', () => {
    const result = refreshSkills(project, skeleton, { history: HISTORY });
    expect(result.added).toEqual(['.claude/skills/demo/']);
    expect(read('.claude/skills/demo/SKILL.md')).toBe(NEW);
  });

  it('fills an empty skill folder, or one holding only .DS_Store, as a missing skill', () => {
    fs.mkdirSync(path.join(project, '.claude/skills/demo'), { recursive: true });
    expect(classifySkill(path.join(project, '.claude/skills/demo'), path.join(skeleton, '.claude/skills/demo'), '.claude/skills/demo', HISTORY))
      .toBe('missing');
    write(project, '.claude/skills/demo/.DS_Store', 'finder');
    const result = refreshSkills(project, skeleton, { history: HISTORY });
    expect(result).toMatchObject({ added: ['.claude/skills/demo/'], conflicts: [] });
    expect(read('.claude/skills/demo/SKILL.md')).toBe(NEW);
    expect(fs.existsSync(path.join(project, '.claude/skills/demo/SKILL.md.codev-new'))).toBe(false);
  });

  it('leaves an up-to-date skill alone', () => {
    write(project, '.claude/skills/demo/SKILL.md', NEW);
    const result = refreshSkills(project, skeleton, { history: HISTORY });
    expect(result).toMatchObject({ added: [], updated: [], conflicts: [] });
  });

  it('replaces an unedited older version, keeping a pending .codev-new', () => {
    write(project, '.claude/skills/demo/SKILL.md', OLD);
    write(project, '.claude/skills/demo/SKILL.md.codev-new', 'pending');
    const result = refreshSkills(project, skeleton, { history: HISTORY });
    expect(result.updated).toEqual(['.claude/skills/demo/']);
    expect(read('.claude/skills/demo/SKILL.md')).toBe(NEW);
    expect(read('.claude/skills/demo/SKILL.md.codev-new')).toBe('pending');
  });

  it('a shipped version that dropped a file loses that file on replace', () => {
    write(project, '.claude/skills/demo/SKILL.md', OLD);
    write(project, '.claude/skills/demo/extra.md', 'old helper');
    const history = {
      '.claude/skills/demo': [hashSkillFiles([{ path: 'SKILL.md', content: OLD }, { path: 'extra.md', content: 'old helper' }])],
    };
    refreshSkills(project, skeleton, { history });
    expect(fs.existsSync(path.join(project, '.claude/skills/demo/extra.md'))).toBe(false);
  });

  it('keeps an edited skill and writes the new version beside it, on every run', () => {
    write(project, '.claude/skills/demo/SKILL.md', `${OLD}My own rule.\n`);
    for (let run = 0; run < 2; run++) {
      const result = refreshSkills(project, skeleton, { history: HISTORY });
      expect(result.conflicts).toEqual(['.claude/skills/demo/SKILL.md']);
      expect(read('.claude/skills/demo/SKILL.md')).toBe(`${OLD}My own rule.\n`);
      expect(read('.claude/skills/demo/SKILL.md.codev-new')).toBe(NEW);
    }
  });

  it('an edited skill gets .codev-new only for the files that differ', () => {
    write(skeleton, '.claude/skills/demo/helper.md', 'helper\n');
    write(project, '.claude/skills/demo/SKILL.md', 'mine\n');
    write(project, '.claude/skills/demo/helper.md', 'helper\n');
    const result = refreshSkills(project, skeleton, { history: HISTORY });
    expect(result.conflicts).toEqual(['.claude/skills/demo/SKILL.md']);
    expect(fs.existsSync(path.join(project, '.claude/skills/demo/helper.md.codev-new'))).toBe(false);
  });

  it('--force overwrites an edited skill\'s packaged files and keeps files the package does not ship', () => {
    write(project, '.claude/skills/demo/SKILL.md', 'mine\n');
    write(project, '.claude/skills/demo/my-notes.md', 'my own file\n');
    const result = refreshSkills(project, skeleton, { history: HISTORY, force: true });
    expect(result.updated).toEqual(['.claude/skills/demo/']);
    expect(read('.claude/skills/demo/SKILL.md')).toBe(NEW);
    expect(read('.claude/skills/demo/my-notes.md')).toBe('my own file\n');
  });

  it('an edited skill drops a .codev-new once that file matches the package again', () => {
    write(skeleton, '.claude/skills/demo/helper.md', 'helper\n');
    write(project, '.claude/skills/demo/SKILL.md', 'mine\n');
    write(project, '.claude/skills/demo/helper.md', 'helper\n');
    write(project, '.claude/skills/demo/helper.md.codev-new', 'helper\n');
    refreshSkills(project, skeleton, { history: HISTORY });
    expect(fs.existsSync(path.join(project, '.claude/skills/demo/helper.md.codev-new'))).toBe(false);
    expect(read('.claude/skills/demo/SKILL.md.codev-new')).toBe(NEW);
  });

  it('a file the package adds to an edited skill arrives only as .codev-new', () => {
    write(skeleton, '.claude/skills/demo/added.md', 'new helper\n');
    write(project, '.claude/skills/demo/SKILL.md', 'mine\n');
    const result = refreshSkills(project, skeleton, { history: HISTORY });
    expect(result.conflicts).toContain('.claude/skills/demo/added.md');
    expect(fs.existsSync(path.join(project, '.claude/skills/demo/added.md'))).toBe(false);
    expect(read('.claude/skills/demo/added.md.codev-new')).toBe('new helper\n');
  });

  it('never writes through a symlinked skill directory', () => {
    write(base, 'elsewhere/SKILL.md', OLD);
    fs.mkdirSync(path.join(project, '.claude/skills'), { recursive: true });
    fs.symlinkSync(path.join(base, 'elsewhere'), path.join(project, '.claude/skills/demo'));
    const result = refreshSkills(project, skeleton, { history: HISTORY });
    expect(result.notRegular).toEqual(['.claude/skills/demo/']);
    expect(fs.readFileSync(path.join(base, 'elsewhere/SKILL.md'), 'utf-8')).toBe(OLD);
    expect(fs.readdirSync(path.join(base, 'elsewhere'))).toEqual(['SKILL.md']);
  });
});

describe('refreshSkills: symlinks and pending copies', () => {
  it('an edited skill holding a symlinked subdirectory is left alone, nothing written through it', () => {
    write(skeleton, '.claude/skills/demo/sub/ref.md', 'packaged\n');
    write(project, '.claude/skills/demo/SKILL.md', 'mine\n');
    fs.mkdirSync(path.join(base, 'outside'));
    fs.symlinkSync(path.join(base, 'outside'), path.join(project, '.claude/skills/demo/sub'));
    const result = refreshSkills(project, skeleton, { history: HISTORY });
    expect(result.notRegular).toEqual(['.claude/skills/demo/']);
    expect(result.conflicts).toEqual([]);
    expect(fs.readdirSync(path.join(base, 'outside'))).toEqual([]);
    expect(fs.existsSync(path.join(project, '.claude/skills/demo/SKILL.md.codev-new'))).toBe(false);
  });

  it('a symlinked skills root is left alone, even for missing skills', () => {
    fs.mkdirSync(path.join(base, 'shared-skills'));
    fs.mkdirSync(path.join(project, '.claude'));
    fs.symlinkSync(path.join(base, 'shared-skills'), path.join(project, '.claude/skills'));
    const result = refreshSkills(project, skeleton, { history: HISTORY });
    expect(result.notRegular).toEqual(['.claude/skills/']);
    expect(result.added).toEqual([]);
    expect(fs.readdirSync(path.join(base, 'shared-skills'))).toEqual([]);
  });

  it('an edited skill whose pending .codev-new is a symlink is left alone, nothing written through it', () => {
    write(project, '.claude/skills/demo/SKILL.md', 'mine\n');
    write(base, 'outside.md', 'outside\n');
    fs.symlinkSync(path.join(base, 'outside.md'), path.join(project, '.claude/skills/demo/SKILL.md.codev-new'));
    const result = refreshSkills(project, skeleton, { history: HISTORY });
    expect(result.notRegular).toEqual(['.claude/skills/demo/']);
    expect(fs.readFileSync(path.join(base, 'outside.md'), 'utf-8')).toBe('outside\n');
  });

  it('a symlinked provider directory (.claude) is left alone too', () => {
    fs.mkdirSync(path.join(base, 'shared-claude'));
    fs.symlinkSync(path.join(base, 'shared-claude'), path.join(project, '.claude'));
    const result = refreshSkills(project, skeleton, { history: HISTORY });
    expect(result.notRegular).toEqual(['.claude/']);
    expect(fs.readdirSync(path.join(base, 'shared-claude'))).toEqual([]);
  });

  it('removes a .codev-new the skill has caught up with, on replace and when current', () => {
    write(project, '.claude/skills/demo/SKILL.md', OLD);
    write(project, '.claude/skills/demo/SKILL.md.codev-new', NEW);
    refreshSkills(project, skeleton, { history: HISTORY });
    expect(fs.existsSync(path.join(project, '.claude/skills/demo/SKILL.md.codev-new'))).toBe(false);

    write(project, '.claude/skills/demo/SKILL.md.codev-new', NEW);
    refreshSkills(project, skeleton, { history: HISTORY });
    expect(fs.existsSync(path.join(project, '.claude/skills/demo/SKILL.md.codev-new'))).toBe(false);
  });
});

describe('refreshSkills: dry run', () => {
  function snapshot(): string[] {
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        out.push(`${rel}${entry.name}`);
        if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full, `${rel}${entry.name}/`);
      }
    };
    walk(project, '');
    return out.sort();
  }

  it('reports missing, shipped, edited and not-regular skills exactly as a real run, writing nothing', () => {
    write(skeleton, '.claude/skills/older/SKILL.md', NEW);
    write(skeleton, '.claude/skills/mine/SKILL.md', NEW);
    write(skeleton, '.claude/skills/linked/SKILL.md', NEW);
    write(project, '.claude/skills/older/SKILL.md', OLD);
    write(project, '.claude/skills/mine/SKILL.md', 'mine\n');
    write(base, 'elsewhere/SKILL.md', OLD);
    fs.symlinkSync(path.join(base, 'elsewhere'), path.join(project, '.claude/skills/linked'));
    const history = { '.claude/skills/older': [OLD_HASH] };
    const before = snapshot();

    const preview = refreshSkills(project, skeleton, { history, dryRun: true });
    expect(snapshot()).toEqual(before);
    expect(preview).toEqual({
      added: ['.claude/skills/demo/'],
      updated: ['.claude/skills/older/'],
      conflicts: ['.claude/skills/mine/SKILL.md'],
      notRegular: ['.claude/skills/linked/'],
    });
    expect(refreshSkills(project, skeleton, { history })).toEqual(preview);
  });

  it('previews --force without writing', () => {
    write(project, '.claude/skills/demo/SKILL.md', 'mine\n');
    const preview = refreshSkills(project, skeleton, { history: HISTORY, force: true, dryRun: true });
    expect(preview.updated).toEqual(['.claude/skills/demo/']);
    expect(read('.claude/skills/demo/SKILL.md')).toBe('mine\n');
  });

  it('does not create a missing skills root', () => {
    refreshSkills(project, skeleton, { history: HISTORY, dryRun: true });
    expect(fs.existsSync(path.join(project, '.claude'))).toBe(false);
  });
});

describe('shipped skill history', () => {
  it('lists the current version of every shipped skill', () => {
    for (const provider of SKILL_PROVIDERS) {
      const skillsDir = path.join(repoRoot, 'codev-skeleton', `.${provider}`, 'skills');
      for (const name of fs.readdirSync(skillsDir)) {
        const key = `.${provider}/skills/${name}`;
        const hash = hashSkillDir(path.join(skillsDir, name));
        expect(
          SHIPPED_SKILL_HASHES[key] ?? [],
          `${key} changed: regenerate the history with \`pnpm --filter @cluesmith/codev generate-skill-hashes\``,
        ).toContain(hash);
      }
    }
  });
});
