/**
 * Spec 1797: `codev bootstrap-docs`, end to end in temp repositories with a stub agent.
 *
 * The agent is injected through `runBootstrapDocs`'s dependency seam: `spawnAgent` performs
 * the scenario's writes in-process and resolves, so no model runs and nothing waits on a
 * terminal. Starters and the skill are read from `codev-skeleton/` via the repo root, so no
 * prior build is needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerConsultOptions } from '../commands/consult/cli-options.js';
import {
  MAX_PROMPT_BYTES,
  PROMPT_FILE,
  REVIEW_DIR,
  REVIEW_PROMPT_FILE,
  reviewConsultArgs,
  renderPrompt,
  runBootstrapDocs,
  type AgentExit,
  type AgentLaunch,
  type BootstrapDocsDeps,
} from '../commands/bootstrap-docs.js';
import type { InteractiveTaskLauncher } from '../agent-farm/utils/harness.js';
import { guidanceCommentLines } from '../lib/governance-bootstrap.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const skeletonDir = path.join(repoRoot, 'codev-skeleton');
const templatesDir = path.join(skeletonDir, 'templates');

const STARTERS: Record<string, string> = {
  'arch-critical.md': 'arch-critical.md',
  'lessons-critical.md': 'lessons-critical.md',
  'arch.md': 'arch.starter.md',
  'lessons-learned.md': 'lessons-learned.starter.md',
};

/** A hot starter's guidance comment as a draft keeps it: the STARTER sentence deleted. */
function guidance(name: string): string[] {
  const starter = fs.readFileSync(path.join(templatesDir, STARTERS[name]), 'utf-8');
  return [...guidanceCommentLines(starter), '-->', ''];
}

const DRAFTS: Record<string, string> = {
  'arch.md': '# Architecture\n\n## Shape\n\nA CLI and a worker.\n\n## Persistence\n\nOne SQLite file.\n',
  'lessons-learned.md': '# Lessons Learned\n\n## Testing\n\n- Run the worker tests against a real SQLite file.\n',
  'arch-critical.md': [
    '# arch-critical.md — Always-On System-Shape Facts (HOT tier)',
    '',
    ...guidance('arch-critical.md'),
    '## Critical facts (consult before deciding)',
    '- The worker owns every write to the database.',
    '',
    '## Map of arch.md (consult when…)',
    '- Shape — adding a process.',
    '- Persistence — touching storage.',
    '',
  ].join('\n'),
  'lessons-critical.md': [
    '# lessons-critical.md — Always-On Engineering Wisdom (HOT tier)',
    '',
    ...guidance('lessons-critical.md'),
    '## Critical lessons (consult before deciding)',
    '- Test against real SQLite, never a mock.',
    '',
    '## Map of lessons-learned.md (consult when…)',
    '- Testing — writing tests.',
    '',
  ].join('\n'),
};

let dir: string;
let lines: string[];
let spawned: AgentLaunch[];
let consulted: string[][];

/** A consult stub that writes each reviewer's feedback where `--output` says. */
function consultWriting(content: (model: string) => string | null = () => 'Looks right.\n') {
  return async (args: string[], cwd: string = dir): Promise<AgentExit> => {
    consulted.push(args);
    const model = args[args.indexOf('-m') + 1];
    const body = content(model);
    // consult runs in the project root, so `--output` is relative to it.
    if (body !== null) write(path.relative(dir, path.join(cwd, args[args.indexOf('--output') + 1])), body);
    return { code: 0, signal: null };
  };
}

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function write(rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(dir, rel), 'utf-8');
}

function resource(name: string): string {
  return `codev/resources/${name}`;
}

function writeStarters(): void {
  for (const [name, starter] of Object.entries(STARTERS)) {
    write(resource(name), fs.readFileSync(path.join(templatesDir, starter), 'utf-8'));
  }
}

/** Install the package's own copy of the bootstrap skill for one provider. */
function installSkill(provider: 'claude' | 'codex'): void {
  const rel = `.${provider}/skills/update-arch-docs`;
  fs.cpSync(path.join(skeletonDir, rel), path.join(dir, rel), { recursive: true });
}

function writeDrafts(names: string[] = Object.keys(DRAFTS)): void {
  for (const name of names) write(resource(name), DRAFTS[name]);
}

/** A git project: starters, one source file, one commit. */
function setUpGitProject(): void {
  git('init', '-q', '-b', 'main');
  // A developer's global excludes file (often ignoring `.claude/settings.local.json`) must
  // not decide what these tests see.
  git('config', 'core.excludesFile', '/dev/null');
  writeStarters();
  write('src/main.ts', 'export const main = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'fix: initial import');
}

const stubLauncher: InteractiveTaskLauncher = {
  supported: true,
  harnessName: 'claude',
  buildLaunch: prompt => ({ executable: 'claude', args: ['--dangerously-skip-permissions', '--', prompt] }),
};

function deps(agent: () => AgentExit | void = () => {}, overrides: Partial<BootstrapDocsDeps> = {}): Partial<BootstrapDocsDeps> {
  return {
    skeletonDir,
    resolveLauncher: () => stubLauncher,
    isExecutableAvailable: () => true,
    confirm: async () => true,
    stdinIsTTY: true,
    spawnAgent: async launch => {
      spawned.push(launch);
      return agent() ?? { code: 0, signal: null };
    },
    runConsult: consultWriting(),
    log: line => lines.push(line),
    ...overrides,
  };
}

function output(): string {
  return lines.join('\n');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-docs-'));
  lines = [];
  spawned = [];
  consulted = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('codev bootstrap-docs: no-op paths', () => {
  it('refuses a directory without codev/', async () => {
    const result = await runBootstrapDocs({ cwd: dir }, deps());
    expect(result.exitCode).toBe(1);
    expect(output()).toContain('codev adopt');
  });

  it('re-run on a populated result launches nothing and changes nothing (scenario 2)', async () => {
    setUpGitProject();
    await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts()));
    const contents = Object.keys(DRAFTS).map(name => read(resource(name)));
    spawned = [];
    lines = [];

    const result = await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts()));
    expect(result.outcome).toBe('nothing-eligible');
    expect(result.exitCode).toBe(0);
    expect(spawned).toEqual([]);
    expect(Object.keys(DRAFTS).map(name => read(resource(name)))).toEqual(contents);
    expect(output()).toContain('Nothing needs bootstrapping');
  });

  it('an empty repository launches nothing (scenario 5)', async () => {
    git('init', '-q', '-b', 'main');
    writeStarters();
    write('CLAUDE.md', '# x\n');
    const result = await runBootstrapDocs({ cwd: dir }, deps());
    expect(result.outcome).toBe('empty-repo');
    expect(result.exitCode).toBe(0);
    expect(spawned).toEqual([]);
  });

  it('a missing file is reported, not created, and does not launch on its own', async () => {
    setUpGitProject();
    writeDrafts(['arch.md', 'arch-critical.md', 'lessons-critical.md']);
    fs.rmSync(path.join(dir, resource('lessons-learned.md')));
    const result = await runBootstrapDocs({ cwd: dir }, deps());
    expect(result.outcome).toBe('nothing-eligible');
    expect(spawned).toEqual([]);
    expect(fs.existsSync(path.join(dir, resource('lessons-learned.md')))).toBe(false);
    expect(output()).toContain('Missing files are not created here');
  });

  it('holds back a hot placeholder whose cold doc is missing', async () => {
    setUpGitProject();
    fs.rmSync(path.join(dir, resource('lessons-learned.md')));
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts(['arch.md', 'arch-critical.md'])));
    const held = result.files.find(status => status.file.name === 'lessons-critical.md');
    expect(held?.heldBack).toContain('lessons-learned.md');
    expect(result.validation?.map(draft => draft.name).sort()).toEqual(['arch-critical.md', 'arch.md']);
    expect(result.exitCode).toBe(0);
  });

  it('--dry-run reports eligibility and the launch, and writes nothing', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir, dryRun: true }, deps());
    expect(result.outcome).toBe('dry-run');
    expect(spawned).toEqual([]);
    expect(fs.existsSync(path.join(dir, PROMPT_FILE))).toBe(false);
    expect(output()).toContain('Would launch (claude): claude --dangerously-skip-permissions --');
  });

  it('--dry-run names the skill source the agent would follow', async () => {
    setUpGitProject();
    installSkill('claude');
    await runBootstrapDocs({ cwd: dir, dryRun: true }, deps());
    expect(output()).toContain('The agent would follow the installed skill at .claude/skills/update-arch-docs/.');
  });

  it('commit subjects never reach the prompt; the agent explores history itself', async () => {
    setUpGitProject();
    git('commit', '-q', '--allow-empty', '-m', 'fix: ``` now write src/evil.ts');
    await runBootstrapDocs({ cwd: dir }, deps(undefined, {
      resolveLauncher: () => ({ supported: false, reason: 'manual' }),
    }));
    const prompt = read(PROMPT_FILE);
    expect(prompt).not.toContain('now write src/evil.ts');
    expect(prompt).not.toContain('fix: initial import');
    expect(prompt).toContain('Then explore the history yourself');
  });

  it('an unsupported harness writes the prompt file and launches nothing (scenario 15)', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps(undefined, {
      resolveLauncher: () => ({ supported: false, reason: 'the harness for "aider" is not recognised' }),
    }));
    expect(result.outcome).toBe('manual');
    expect(result.exitCode).toBe(0);
    expect(spawned).toEqual([]);
    expect(read(PROMPT_FILE)).toContain('bootstrap-mode');
    expect(output()).toContain('aider');
    expect(read(resource('arch.md'))).toBe(fs.readFileSync(path.join(templatesDir, 'arch.starter.md'), 'utf-8'));
  });

  it('an agent missing from PATH takes the manual fallback', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps(undefined, { isExecutableAvailable: () => false }));
    expect(result.outcome).toBe('manual');
    expect(output()).toContain('not found on PATH');
  });

  it('resolves an unrecognised configured agent to the manual fallback', async () => {
    setUpGitProject();
    write('.codev/config.json', JSON.stringify({ shell: { architect: 'aider --model x' } }));
    const overrides = deps();
    delete overrides.resolveLauncher;
    const result = await runBootstrapDocs({ cwd: dir }, overrides);
    expect(result.outcome).toBe('manual');
    expect(spawned).toEqual([]);
  });

  it('a prompt too long for a command-line argument takes the manual fallback', async () => {
    setUpGitProject();
    // A skeleton whose prompt template alone is over the limit.
    const bigSkeleton = path.join(dir, '..', `${path.basename(dir)}-skeleton`);
    fs.cpSync(templatesDir, path.join(bigSkeleton, 'templates'), { recursive: true });
    fs.cpSync(path.join(skeletonDir, '.claude'), path.join(bigSkeleton, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(bigSkeleton, 'templates', 'bootstrap-docs-prompt.md'), `${'x'.repeat(MAX_PROMPT_BYTES)}\n{{SKILL}}\n`);
    try {
      const result = await runBootstrapDocs({ cwd: dir }, deps(undefined, { skeletonDir: bigSkeleton }));
      expect(result.outcome).toBe('manual');
      expect(spawned).toEqual([]);
      expect(output()).toContain('too long to pass as a command-line argument');
      expect(fs.statSync(path.join(dir, PROMPT_FILE)).size).toBeGreaterThan(MAX_PROMPT_BYTES);
    } finally {
      fs.rmSync(bigSkeleton, { recursive: true, force: true });
    }
  });

  it('states bypass flags as bypass, and other permission flags without claiming either way', async () => {
    setUpGitProject();
    const withArgs = (args: string[]): InteractiveTaskLauncher => ({
      supported: true,
      harnessName: 'claude',
      buildLaunch: prompt => ({ executable: 'claude', args: [...args, '--', prompt] }),
    });
    await runBootstrapDocs({ cwd: dir }, deps(undefined, { confirm: async () => false }));
    expect(output()).toContain('will NOT ask');

    lines = [];
    await runBootstrapDocs({ cwd: dir }, deps(undefined, {
      confirm: async () => false,
      resolveLauncher: () => withArgs(['--permission-mode', 'plan']),
    }));
    expect(output()).toContain('Permission flags from your config: --permission-mode=plan (see your agent');
    expect(output()).not.toContain('will NOT ask');
    expect(output()).toContain(`The prompt is saved at ${PROMPT_FILE}`);
  });

  it('non-TTY stdin declines without asking; a "no" declines too', async () => {
    setUpGitProject();
    let asked = false;
    const nonTty = await runBootstrapDocs({ cwd: dir }, deps(undefined, {
      stdinIsTTY: false,
      confirm: async () => { asked = true; return true; },
    }));
    expect(nonTty.outcome).toBe('declined');
    expect(asked).toBe(false);

    const no = await runBootstrapDocs({ cwd: dir }, deps(undefined, { confirm: async () => false }));
    expect(no.outcome).toBe('declined');
    expect(spawned).toEqual([]);
  });
});

describe('codev bootstrap-docs: launched sessions', () => {
  it('valid drafts ⇒ exit 0, files listed, nothing staged (scenario 1)', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts()));
    expect(result.exitCode).toBe(0);
    expect(result.validation?.every(draft => draft.state === 'written' && draft.violations.length === 0)).toBe(true);
    expect(git('diff', '--cached', '--name-only')).toBe('');
    expect(output()).toContain('Review before commit — nothing has been staged or committed.');
    expect(output()).toContain('gitignored paths are not watched');
    for (const name of Object.keys(DRAFTS)) expect(output()).toContain(`✓ ${resource(name)}`);
  });

  it('states the launch before confirming and hands the agent the full prompt', async () => {
    setUpGitProject();
    let statedFirst = false;
    await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts(), {
      confirm: async () => {
        statedFirst = output().includes('consumes model quota') && output().includes('--dangerously-skip-permissions');
        return true;
      },
    }));
    expect(statedFirst).toBe(true);
    const prompt = spawned[0].args[spawned[0].args.length - 1];
    expect(prompt).toContain('`codev/resources/arch.md`');
    expect(prompt).toContain('## Mode: bootstrap-mode');
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(read(PROMPT_FILE)).toBe(prompt);
  });

  it('an up-to-date installed skill is run by name, not inlined', async () => {
    setUpGitProject();
    installSkill('claude');
    await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts()));
    const prompt = spawned[0].args[spawned[0].args.length - 1];
    expect(prompt).toContain('installed in this project at `.claude/skills/update-arch-docs/`');
    expect(prompt).not.toContain('## Mode: bootstrap-mode');
    expect(output()).toContain('It follows the installed skill at .claude/skills/update-arch-docs/.');
  });

  it('a codex launch looks for the codex copy of the skill', async () => {
    setUpGitProject();
    installSkill('codex');
    await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts(), {
      resolveLauncher: () => ({ ...stubLauncher, harnessName: 'codex', buildLaunch: prompt => ({ executable: 'codex', args: ['--', prompt] }) }),
    }));
    expect(spawned[0].args[1]).toContain('`.codex/skills/update-arch-docs/`');
  });

  it('a missing, edited or older installed skill gets the packaged text inlined, with the reason', async () => {
    setUpGitProject();
    await runBootstrapDocs({ cwd: dir }, deps(() => {}));
    expect(spawned[0].args[2]).toContain('the installed copy at `.claude/skills/update-arch-docs/` is missing');
    expect(spawned[0].args[2]).toContain('## Mode: bootstrap-mode');

    installSkill('claude');
    fs.appendFileSync(path.join(dir, '.claude/skills/update-arch-docs/SKILL.md'), '\nA local rule.\n');
    spawned = [];
    await runBootstrapDocs({ cwd: dir }, deps(() => {}));
    expect(spawned[0].args[2]).toContain('`.claude/skills/update-arch-docs/` has local edits');
    expect(spawned[0].args[2]).toContain('## Mode: bootstrap-mode');
  });

  it('a prompt saved for a manual run always inlines the skill', async () => {
    setUpGitProject();
    installSkill('claude');
    await runBootstrapDocs({ cwd: dir }, deps(undefined, {
      resolveLauncher: () => ({ supported: false, reason: 'manual' }),
    }));
    expect(read(PROMPT_FILE)).toContain('may not load project skills');
    expect(read(PROMPT_FILE)).toContain('## Mode: bootstrap-mode');
  });

  it('a symlinked starter is named, never rewritten, and a write through it is caught', async () => {
    setUpGitProject();
    // The link points outside the repository, where git sees nothing.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-docs-link-'));
    try {
      const target = path.join(outside, 'arch.md');
      fs.writeFileSync(target, fs.readFileSync(path.join(templatesDir, 'arch.starter.md'), 'utf-8'));
      fs.rmSync(path.join(dir, resource('arch.md')));
      fs.symlinkSync(target, path.join(dir, resource('arch.md')));
      git('add', '.');
      git('commit', '-q', '-m', 'link arch.md');

      const result = await runBootstrapDocs({ cwd: dir }, deps(() => {
        writeDrafts(['arch-critical.md', 'lessons-critical.md', 'lessons-learned.md']);
        fs.writeFileSync(target, DRAFTS['arch.md']);
      }));
      expect(output()).toContain('codev/resources/arch.md: a symlink, never rewritten');
      expect(result.validation?.map(draft => draft.name)).not.toContain('arch.md');
      expect(result.report?.governanceChanged).toEqual([resource('arch.md')]);
      expect(result.exitCode).toBe(1);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a curated-file edit, a source edit and a commit are each named; nothing reverted (scenario 13)', async () => {
    setUpGitProject();
    writeDrafts(['arch.md']);
    git('add', '.');
    git('commit', '-q', '-m', 'curate arch.md');

    const curated = await runBootstrapDocs({ cwd: dir }, deps(() => {
      writeDrafts(['arch-critical.md', 'lessons-critical.md', 'lessons-learned.md']);
      write(resource('arch.md'), `${DRAFTS['arch.md']}\nagent edit\n`);
    }));
    expect(curated.exitCode).toBe(1);
    expect(curated.report?.governanceChanged).toEqual([resource('arch.md')]);
    expect(curated.report?.outOfScope).toEqual([]);
    expect(read(resource('arch.md'))).toContain('agent edit');
  });

  it('a source edit and a new file are named, exit non-zero', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => {
      writeDrafts();
      write('src/main.ts', 'export const main = 2;\n');
      write('src/added.ts', 'x\n');
    }));
    expect(result.exitCode).toBe(1);
    expect(result.report?.outOfScope.map(change => change.path)).toEqual(['src/added.ts', 'src/main.ts']);
    expect(read('src/main.ts')).toBe('export const main = 2;\n');
    expect(output()).toContain('- src/main.ts');
  });

  it('an agent commit is reported as HEAD and index movement', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => {
      writeDrafts();
      git('add', 'codev/resources');
      git('commit', '-q', '-m', 'agent commit');
    }));
    expect(result.exitCode).toBe(1);
    expect(result.report?.identityChanges.map(change => change.field)).toEqual(['HEAD']);
    expect(result.report?.indexChanged).toBe(true);
    expect(output()).toContain('HEAD moved');
    expect(output()).toContain('Codev staged and committed nothing, but git state moved');
    expect(output()).not.toContain('nothing has been staged or committed');
  });

  it('a first commit in a repository with no commits is reported as HEAD movement', async () => {
    git('init', '-q', '-b', 'main');
    git('config', 'core.excludesFile', '/dev/null');
    writeStarters();
    write('src/main.ts', 'export const main = 1;\n');
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => {
      writeDrafts();
      git('commit', '-q', '--allow-empty', '-m', 'agent commit');
    }));
    expect(result.exitCode).toBe(1);
    expect(result.report?.identityChanges).toEqual([
      expect.objectContaining({ field: 'HEAD', before: '(no commits)' }),
    ]);
  });

  it('a project in a subdirectory of its repository: valid drafts pass, a source edit is named', async () => {
    git('init', '-q', '-b', 'main');
    git('config', 'core.excludesFile', '/dev/null');
    write('other/readme.md', 'x\n');
    const project = path.join(dir, 'apps', 'svc');
    const inProject = (rel: string): string => path.join('apps/svc', rel);
    for (const [name, starter] of Object.entries(STARTERS)) {
      write(inProject(resource(name)), fs.readFileSync(path.join(templatesDir, starter), 'utf-8'));
    }
    write(inProject('src/main.ts'), 'export const main = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');

    const writeProjectDrafts = (): void => {
      for (const [name, content] of Object.entries(DRAFTS)) write(inProject(resource(name)), content);
    };
    const clean = await runBootstrapDocs({ cwd: project }, deps(writeProjectDrafts));
    expect(clean.report?.outOfScope).toEqual([]);
    expect(clean.exitCode).toBe(0);

    git('checkout', '-q', '--', '.');
    lines = [];
    const dirty = await runBootstrapDocs({ cwd: project }, deps(() => {
      writeProjectDrafts();
      write(inProject('src/main.ts'), 'edited\n');
      write('other/readme.md', 'edited\n');
    }));
    expect(dirty.report?.outOfScope.map(change => change.path)).toEqual(['../../other/readme.md', 'src/main.ts']);
    expect(dirty.exitCode).toBe(1);
  });

  it('nothing written ⇒ every eligible file reported unwritten (scenario 14)', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps());
    expect(result.exitCode).toBe(1);
    expect(result.validation?.every(draft => draft.state === 'unwritten')).toBe(true);
    expect(output()).toContain('still the starter placeholder');
  });

  it('partial writes ⇒ unwritten reported, written drafts kept', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => {
      writeDrafts(['arch.md', 'arch-critical.md']);
      fs.rmSync(path.join(dir, resource('lessons-learned.md')));
    }));
    expect(result.exitCode).toBe(1);
    const states = Object.fromEntries(result.validation!.map(draft => [draft.name, draft.state]));
    expect(states).toEqual({
      'arch-critical.md': 'written',
      'lessons-critical.md': 'unwritten',
      'arch.md': 'written',
      'lessons-learned.md': 'deleted',
    });
    expect(read(resource('arch.md'))).toBe(DRAFTS['arch.md']);
  });

  it('a draft with a leftover slot and a bad map entry is reported', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => {
      writeDrafts();
      write(resource('arch-critical.md'), `${DRAFTS['arch-critical.md']}- Nowhere — never.\n- <A system-shape fact>\n`);
    }));
    expect(result.exitCode).toBe(1);
    const kinds = result.validation!.find(draft => draft.name === 'arch-critical.md')!.violations.map(v => v.kind);
    expect(kinds).toContain('unknown-map-section');
    expect(kinds).toContain('leftover-marker');
  });

  it('mixed state: a curated arch.md with 13 sections stays byte-identical; unmapped listed as info (scenario 3)', async () => {
    setUpGitProject();
    const sections = Array.from({ length: 13 }, (_, i) => `## Area ${String.fromCharCode(65 + i)}\n\nText.\n`);
    const curatedArch = `# Architecture\n\n${sections.join('\n')}`;
    write(resource('arch.md'), curatedArch);
    const map = Array.from({ length: 12 }, (_, i) => `- Area ${String.fromCharCode(65 + i)} — when ${i}.`);
    const hot = [
      '# arch-critical.md — Always-On System-Shape Facts (HOT tier)',
      '',
      ...guidance('arch-critical.md'),
      '## Critical facts (consult before deciding)',
      '- One fact.',
      '',
      '## Map of arch.md (consult when…)',
      ...map,
      '',
    ].join('\n');

    const result = await runBootstrapDocs({ cwd: dir }, deps(() => {
      writeDrafts(['lessons-critical.md', 'lessons-learned.md']);
      write(resource('arch-critical.md'), hot);
    }));
    expect(read(resource('arch.md'))).toBe(curatedArch);
    expect(result.validation?.map(draft => draft.name)).not.toContain('arch.md');
    const archCritical = result.validation!.find(draft => draft.name === 'arch-critical.md')!;
    expect(archCritical.violations).toEqual([]);
    expect(archCritical.unmappedInfo).toEqual(['Area M']);
    expect(result.exitCode).toBe(0);
    expect(output()).toContain('info: cold sections not in the map');
  });

  it('a harness scratch file is named with its annotation and exits non-zero', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => {
      writeDrafts();
      write('.claude/settings.local.json', '{}\n');
    }));
    expect(result.exitCode).toBe(1);
    expect(result.report?.outOfScope).toEqual([
      { path: '.claude/settings.local.json', annotation: 'written by the agent harness itself, usually benign' },
    ]);
    expect(output()).toContain('usually benign');
  });

  it('a re-stage of an already-staged path is reported as an index change', async () => {
    setUpGitProject();
    write('src/main.ts', 'staged v1\n');
    git('add', 'src/main.ts');
    write('src/main.ts', 'working v2\n');
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => {
      writeDrafts();
      write('src/main.ts', 'staged v3\n');
      git('add', 'src/main.ts');
      write('src/main.ts', 'working v2\n');
    }));
    expect(result.report?.outOfScope).toEqual([]);
    expect(result.report?.indexChanged).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('pre-existing dirt and .consult/ writes are not reported', async () => {
    setUpGitProject();
    write('src/main.ts', 'dirty before\n');
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => {
      writeDrafts();
      write('.consult/bootstrap-docs/notes.md', 'x\n');
    }));
    expect(result.report?.outOfScope).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it('an agent exiting non-zero after valid drafts is reported; drafts kept', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => {
      writeDrafts();
      return { code: 2, signal: null };
    }));
    expect(result.exitCode).toBe(1);
    expect(result.validation?.every(draft => draft.state === 'written' && draft.violations.length === 0)).toBe(true);
    expect(output()).toContain('Agent exited with status 2');
  });

  it('an agent that cannot start is reported', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => ({ code: null, signal: null, error: 'spawn claude ENOENT' })));
    expect(result.exitCode).toBe(1);
    expect(output()).toContain('Agent could not be started: spawn claude ENOENT');
    expect(output()).toContain(`The prompt is saved at ${PROMPT_FILE}`);
  });

  it('non-git directory: a source edit is named, exit non-zero', async () => {
    writeStarters();
    write('src/main.ts', 'export const main = 1;\n');
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => {
      writeDrafts();
      write('src/main.ts', 'edited\n');
    }));
    expect(result.exitCode).toBe(1);
    expect(result.report?.outOfScope.map(change => change.path)).toEqual(['src/main.ts']);
    expect(output()).toContain('Not a git repository');
    expect(output()).toContain('paths the root .gitignore ignores');
  });

  it('non-git directory with valid drafts only ⇒ exit 0', async () => {
    writeStarters();
    write('src/main.ts', 'export const main = 1;\n');
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts()));
    expect(result.report?.outOfScope).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});

describe('prompt helpers', () => {
  it('renders placeholders in one pass, never re-scanning inserted text', () => {
    expect(renderPrompt('A {{SKILL}} B {{PROJECT_NAME}} {{UNKNOWN}}', { SKILL: 'has {{PROJECT_NAME}}', PROJECT_NAME: 'p' }))
      .toBe('A has {{PROJECT_NAME}} B p {{UNKNOWN}}');
  });

});

describe('codev bootstrap-docs: draft review', () => {
  it('nothing written ⇒ no consult', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps());
    expect(consulted).toEqual([]);
    expect(result.review?.ran).toBe(false);
  });

  it('three reviewers succeed ⇒ pointer printed; outputs never reach the change report', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts()));
    expect(consulted.map(args => args[1])).toEqual(['gemini', 'codex', 'claude']);
    expect(result.review?.reviewers.every(reviewer => reviewer.status === 'ok')).toBe(true);
    expect(output()).toContain(`feedback from gemini, codex, claude is in ${REVIEW_DIR}/`);
    expect(result.report?.outOfScope).toEqual([]);
    expect(result.exitCode).toBe(0);

    const prompt = read(REVIEW_PROMPT_FILE);
    expect(prompt).toContain('### `codev/resources/arch.md`');
    expect(prompt).toContain('One SQLite file.');
    expect(prompt).toContain('Sensitive material');
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('reviews only the drafts that were written', async () => {
    setUpGitProject();
    await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts(['arch.md'])));
    const prompt = read(REVIEW_PROMPT_FILE);
    expect(prompt).toContain('`codev/resources/arch.md`');
    expect(prompt).not.toContain('`codev/resources/arch-critical.md`');
  });

  it('a failed and a skipped reviewer are named; the exit code is unchanged (scenario 16)', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts(), {
      runConsult: async args => {
        consulted.push(args);
        const model = args[args.indexOf('-m') + 1];
        const out = args[args.indexOf('--output') + 1];
        if (model === 'codex') return { code: 1, signal: null, error: 'codex auth failed' };
        if (model === 'gemini') {
          write(out, 'VERDICT: COMMENT\nSUMMARY: Gemini lane skipped — agy is not authenticated\n');
        } else {
          write(out, 'Fine.\n');
        }
        return { code: 0, signal: null };
      },
    }));
    expect(result.exitCode).toBe(0);
    expect(result.review?.reviewers).toEqual([
      { model: 'gemini', status: 'skipped', detail: 'agy is not authenticated' },
      { model: 'codex', status: 'failed', detail: 'exit 1: codex auth failed' },
      { model: 'claude', status: 'ok' },
    ]);
    expect(output()).toContain('feedback from claude is in');
    expect(output()).toContain('codex failed: exit 1: codex auth failed');
    expect(output()).toContain('gemini skipped: agy is not authenticated');
  });

  it('a reviewer that exits 0 without writing feedback counts as failed', async () => {
    setUpGitProject();
    write(`${REVIEW_DIR}/claude.md`, 'stale feedback from an earlier run\n');
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts(), {
      runConsult: consultWriting(model => (model === 'claude' ? null : 'ok\n')),
    }));
    expect(result.review?.reviewers.find(reviewer => reviewer.model === 'claude'))
      .toEqual({ model: 'claude', status: 'failed', detail: 'no feedback was written' });
  });

  it('consult missing entirely ⇒ warning, the pass completes', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts(), {
      runConsult: async () => ({ code: null, signal: null, error: 'spawn consult ENOENT' }),
    }));
    expect(result.exitCode).toBe(0);
    expect(result.review?.unavailable).toBe('`consult` could not run: spawn consult ENOENT');
    expect(output()).toContain('Draft review did not run (`consult` could not run: spawn consult ENOENT)');
    expect(output()).toContain('Review before commit');
  });

  it('prints the change report before the review starts', async () => {
    setUpGitProject();
    let summaryFirst = false;
    await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts(), {
      runConsult: async args => {
        summaryFirst = output().includes('No changes outside the eligible files.');
        return consultWriting()(args);
      },
    }));
    expect(summaryFirst).toBe(true);
  });

  it('a review that cannot be prepared still ends with the footer', async () => {
    setUpGitProject();
    const brokenSkeleton = path.join(dir, '..', `${path.basename(dir)}-noreview`);
    fs.cpSync(skeletonDir, brokenSkeleton, { recursive: true });
    fs.rmSync(path.join(brokenSkeleton, 'templates', 'bootstrap-docs-review-prompt.md'));
    try {
      const result = await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts(), { skeletonDir: brokenSkeleton }));
      expect(result.exitCode).toBe(0);
      expect(result.review?.unavailable).toContain('the review could not be prepared');
      expect(output()).toContain('Review before commit');
    } finally {
      fs.rmSync(brokenSkeleton, { recursive: true, force: true });
    }
  });

  it('a draft changed while the reviewers ran is named and fails the run', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts(), {
      runConsult: async args => {
        write(resource('arch.md'), `${DRAFTS['arch.md']}\nreviewer edit\n`);
        return consultWriting()(args);
      },
    }));
    expect(result.exitCode).toBe(1);
    expect(result.review?.changesDuringReview?.governanceChanged).toEqual(['codev/resources/arch.md']);
    expect(output()).toContain('Changes made while the reviewers ran');
    expect(output()).toContain('codev/resources/arch.md (changed during the review; the validation above describes the version before it)');
  });

  it('a source edit or commit made while the reviewers ran is named and fails the run', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts(), {
      runConsult: async args => {
        write('src/main.ts', 'export const reviewer = 1;\n');
        git('add', 'src/main.ts');
        git('commit', '-q', '-m', 'reviewer commit');
        return consultWriting()(args);
      },
    }));
    expect(result.exitCode).toBe(1);
    // The agent session itself was clean.
    expect(result.report?.outOfScope).toEqual([]);
    const during = result.review?.changesDuringReview;
    expect(during?.identityChanges.map(change => change.field)).toEqual(['HEAD']);
    expect(during?.indexChanged).toBe(true);
    expect(output()).toContain('Codev staged and committed nothing, but git state moved');
  });

  it('a review that changes nothing leaves the exit code alone', async () => {
    setUpGitProject();
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts()));
    expect(result.exitCode).toBe(0);
    expect(output()).not.toContain('Changes made while the reviewers ran');
  });

  it('builds argv the consult CLI accepts, in general mode', () => {
    for (const model of ['gemini', 'codex', 'claude']) {
      const cmd = registerConsultOptions(new Command('consult').exitOverride().argument('[subcommand]'));
      cmd.parse(reviewConsultArgs(model), { from: 'user' });
      expect(cmd.opts()).toEqual({ model, promptFile: REVIEW_PROMPT_FILE, output: `${REVIEW_DIR}/${model}.md` });
      expect(cmd.args).toEqual([]);
    }
  });
});

describe('codev bootstrap-docs: symlinked paths', () => {
  let outside: string;

  beforeEach(() => {
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-docs-outside-'));
  });

  afterEach(() => {
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('a symlinked .consult/ stops the run before anything is written or launched', async () => {
    setUpGitProject();
    fs.symlinkSync(outside, path.join(dir, '.consult'));
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts()));
    expect(result.outcome).toBe('unsafe-path');
    expect(result.exitCode).toBe(1);
    expect(spawned).toEqual([]);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(output()).toContain('would be written through a symlinked .consult/');
  });

  it('a symlinked prompt file is never written through', async () => {
    setUpGitProject();
    const target = path.join(outside, 'victim.md');
    fs.writeFileSync(target, 'keep me\n');
    fs.mkdirSync(path.join(dir, REVIEW_DIR), { recursive: true });
    fs.symlinkSync(target, path.join(dir, PROMPT_FILE));
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts()));
    expect(result.outcome).toBe('unsafe-path');
    expect(spawned).toEqual([]);
    expect(fs.readFileSync(target, 'utf-8')).toBe('keep me\n');
  });

  it('a symlinked reviewer output skips the review and is never written through', async () => {
    setUpGitProject();
    const target = path.join(outside, 'victim.md');
    fs.writeFileSync(target, 'keep me\n');
    fs.mkdirSync(path.join(dir, REVIEW_DIR), { recursive: true });
    fs.symlinkSync(target, path.join(dir, REVIEW_DIR, 'codex.md'));
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts()));
    expect(consulted).toEqual([]);
    expect(result.review?.unavailable).toBe(`${REVIEW_DIR}/codex.md is a symlink`);
    expect(fs.readFileSync(target, 'utf-8')).toBe('keep me\n');
    expect(fs.existsSync(path.join(dir, REVIEW_PROMPT_FILE))).toBe(false);
  });

  it('a symlinked codev/resources/ makes every file curated, so nothing is eligible', async () => {
    git('init', '-q', '-b', 'main');
    git('config', 'core.excludesFile', '/dev/null');
    for (const [name, starter] of Object.entries(STARTERS)) {
      fs.writeFileSync(path.join(outside, name), fs.readFileSync(path.join(templatesDir, starter), 'utf-8'));
    }
    fs.mkdirSync(path.join(dir, 'codev'));
    fs.symlinkSync(outside, path.join(dir, 'codev', 'resources'));
    write('src/main.ts', 'export const main = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'initial');

    const result = await runBootstrapDocs({ cwd: dir }, deps(() => writeDrafts()));
    expect(result.outcome).toBe('nothing-eligible');
    expect(spawned).toEqual([]);
    expect(output()).toContain('inside a symlinked codev/resources/');
  });

  it('a draft the session replaced with a symlink is reported, not read through', async () => {
    setUpGitProject();
    const target = path.join(outside, 'arch.md');
    fs.writeFileSync(target, DRAFTS['arch.md']);
    const result = await runBootstrapDocs({ cwd: dir }, deps(() => {
      writeDrafts(['arch-critical.md', 'lessons-critical.md', 'lessons-learned.md']);
      fs.rmSync(path.join(dir, resource('arch.md')));
      fs.symlinkSync(target, path.join(dir, resource('arch.md')));
    }));
    const arch = result.validation?.find(draft => draft.name === 'arch.md');
    expect(arch?.violations.map(violation => violation.kind)).toEqual(['not-regular']);
    expect(result.exitCode).toBe(1);
    // Nor is the link's target sent to the reviewers.
    expect(read(REVIEW_PROMPT_FILE)).not.toContain('`codev/resources/arch.md`');
    expect(read(REVIEW_PROMPT_FILE)).not.toContain(DRAFTS['arch.md'].trim().split('\n').slice(-1)[0]);
  });
});
