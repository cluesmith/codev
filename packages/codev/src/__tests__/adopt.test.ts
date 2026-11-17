/**
 * Tests for codev adopt command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

// Mock readline to avoid interactive prompts
vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_prompt: string, callback: (answer: string) => void) => {
      callback('y'); // Default yes for tests
    }),
    close: vi.fn(),
  })),
}));

// Mock child_process spawn to avoid launching Claude. adopt awaits the merge session, so the
// fake child exits right away; execFileSync stays real for the repository checks.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(() => ({
      on: vi.fn((event: string, handler: (code: number, signal: null) => void) => {
        if (event === 'exit') queueMicrotask(() => handler(0, null));
      }),
      stdout: null,
      stderr: null,
    })),
  };
});

// Mock chalk for cleaner test output
vi.mock('chalk', () => ({
  default: {
    bold: (s: string) => s,
    green: Object.assign((s: string) => s, { bold: (s: string) => s }),
    yellow: (s: string) => s,
    red: (s: string) => s,
    blue: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
  },
}));

// Mock process.exit to prevent tests from exiting
vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
  throw new Error(`process.exit(${code})`);
});

describe('adopt command', () => {
  const testBaseDir = path.join(tmpdir(), `codev-adopt-test-${Date.now()}`);
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    fs.mkdirSync(testBaseDir, { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true });
    }
  });

  describe('adopt function', () => {
    it('should add codev to existing project with --yes flag', async () => {
      const projectDir = path.join(testBaseDir, 'existing-project');
      fs.mkdirSync(projectDir, { recursive: true });

      // Create some existing files to simulate an existing project
      fs.writeFileSync(path.join(projectDir, 'package.json'), '{}');

      process.chdir(projectDir);

      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true });

      // Verify codev structure was created
      expect(fs.existsSync(path.join(projectDir, 'codev'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'CLAUDE.md'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'AGENTS.md'))).toBe(true);

      // Verify user data directories
      expect(fs.existsSync(path.join(projectDir, 'codev', 'specs'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'codev', 'plans'))).toBe(true);

      // Issue #1012: cold-tier governance files are bootstrapped.
      expect(fs.existsSync(path.join(projectDir, 'codev', 'resources', 'arch.md'))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, 'codev', 'resources', 'lessons-learned.md'))).toBe(true);
    });

    it('adds missing Codex skills without overwriting an existing customized skill', async () => {
      const projectDir = path.join(testBaseDir, 'codex-skills-project');
      const customized = path.join(projectDir, '.codex', 'skills', 'arch-init');
      fs.mkdirSync(customized, { recursive: true });
      fs.writeFileSync(path.join(customized, 'SKILL.md'), 'user-customized codex skill');

      process.chdir(projectDir);

      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true });

      expect(fs.readFileSync(path.join(customized, 'SKILL.md'), 'utf-8')).toBe(
        'user-customized codex skill'
      );
      expect(
        fs.existsSync(path.join(projectDir, '.codex', 'skills', 'afx', 'SKILL.md'))
      ).toBe(true);
      // Spec 1307
      expect(
        fs.existsSync(path.join(projectDir, '.codex', 'skills', 'arch-save', 'SKILL.md'))
      ).toBe(true);
    });

    it('should throw error if codev directory already exists', async () => {
      const projectDir = path.join(testBaseDir, 'has-codev');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      process.chdir(projectDir);

      const { adopt } = await import('../commands/adopt.js');
      await expect(adopt({ yes: true })).rejects.toThrow(/already exists/);
    });

    it('should create .codev-new for existing CLAUDE.md', async () => {
      const projectDir = path.join(testBaseDir, 'has-claude');
      fs.mkdirSync(projectDir, { recursive: true });

      const originalContent = '# My Custom CLAUDE.md';
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), originalContent);

      process.chdir(projectDir);

      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true });

      // Verify CLAUDE.md was not overwritten
      const content = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toBe(originalContent);

      // Verify .codev-new was created for merge
      expect(fs.existsSync(path.join(projectDir, 'CLAUDE.md.codev-new'))).toBe(true);
    });

    it('should update .gitignore if it exists', async () => {
      const projectDir = path.join(testBaseDir, 'has-gitignore');
      fs.mkdirSync(projectDir, { recursive: true });

      fs.writeFileSync(path.join(projectDir, '.gitignore'), 'node_modules/\n');

      process.chdir(projectDir);

      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true });

      const gitignore = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('node_modules/');
      expect(gitignore).toContain('.agent-farm/');
      // Regression for issue #880
      expect(gitignore).toContain('.architect-role.md');
    });

    it('should create .gitignore if it does not exist', async () => {
      const projectDir = path.join(testBaseDir, 'no-gitignore');
      fs.mkdirSync(projectDir, { recursive: true });

      process.chdir(projectDir);

      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true });

      expect(fs.existsSync(path.join(projectDir, '.gitignore'))).toBe(true);
      const gitignore = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('.agent-farm/');
      // Regression for issue #880
      expect(gitignore).toContain('.architect-role.md');
    });

    // Regression for issue #880: adopt must self-heal a partial Codev block.
    // Earlier behavior short-circuited on a `.agent-farm/` sentinel and left
    // newer entries (like `.architect-role.md`) missing.
    it('should backfill .architect-role.md when partial Codev block already present (issue #880)', async () => {
      const projectDir = path.join(testBaseDir, 'partial-gitignore');
      fs.mkdirSync(projectDir, { recursive: true });

      fs.writeFileSync(
        path.join(projectDir, '.gitignore'),
        'node_modules/\n.agent-farm/\n.consult/\n.builders/\n'
      );

      process.chdir(projectDir);

      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true });

      const gitignore = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('.architect-role.md');
      expect(gitignore).toContain('node_modules/');
      expect((gitignore.match(/\.agent-farm\//g) || []).length).toBe(1);
    });
  });

  describe('conflict detection', () => {
    it('should detect CLAUDE.md conflict and create .codev-new', async () => {
      const projectDir = path.join(testBaseDir, 'conflict-test');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Existing');

      process.chdir(projectDir);

      // The adopt function should proceed but create .codev-new for the conflicting file
      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true });

      // CLAUDE.md should be preserved
      const content = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toBe('# Existing');

      // .codev-new should be created for merge
      expect(fs.existsSync(path.join(projectDir, 'CLAUDE.md.codev-new'))).toBe(true);
    });
  });

  // Spec 1797: the governance-doc bootstrap offer at the end of adopt.
  describe('bootstrap offer', () => {
    const DRAFT_QUESTION = 'Draft the governance docs from this codebase now?';
    const CURATED: Record<string, string> = {
      'arch-critical.md': '# Critical facts\n\n- The API talks to the queue only.\n',
      'lessons-critical.md': '# Critical lessons\n\n- Never retry a payment.\n',
      'arch.md': '# Architecture\n\n## Services\n\nThe API and the worker.\n',
      'lessons-learned.md': '# Lessons\n\n## Payments\n\nNever retry a payment.\n',
    };

    let output: string[];

    beforeEach(() => {
      output = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        output.push(args.join(' '));
      });
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        output.push(args.join(' '));
      });
    });

    function makeProject(name: string, files: Record<string, string> = { 'package.json': '{}' }): string {
      const projectDir = path.join(testBaseDir, name);
      fs.mkdirSync(projectDir, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(projectDir, rel), content);
      }
      process.chdir(projectDir);
      return process.cwd();
    }

    function writeCuratedDocs(root: string): void {
      for (const [name, content] of Object.entries(CURATED)) {
        fs.writeFileSync(path.join(root, 'codev', 'resources', name), content);
      }
    }

    function hintPrinted(): boolean {
      return output.some(line => line.includes('codev bootstrap-docs'));
    }

    it('-y never launches the pass and lists the command on a non-empty repo', async () => {
      makeProject('bootstrap-yes');
      const confirm = vi.fn(async () => true);
      const runBootstrap = vi.fn(async () => 0);

      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true }, { confirm, runBootstrap });

      expect(confirm).not.toHaveBeenCalled();
      expect(runBootstrap).not.toHaveBeenCalled();
      expect(hintPrinted()).toBe(true);
    });

    it('an empty repo gets neither the offer nor the hint', async () => {
      makeProject('bootstrap-empty', {});
      const confirm = vi.fn(async () => true);
      const runBootstrap = vi.fn(async () => 0);

      const { adopt } = await import('../commands/adopt.js');
      await adopt({}, { confirm, runBootstrap });

      expect(confirm.mock.calls.map(call => call[0])).not.toContain(DRAFT_QUESTION);
      expect(runBootstrap).not.toHaveBeenCalled();
      expect(hintPrinted()).toBe(false);
    });

    it('-y on an empty repo prints no hint', async () => {
      makeProject('bootstrap-empty-yes', {});
      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true }, { runBootstrap: vi.fn(async () => 0) });
      expect(hintPrinted()).toBe(false);
    });

    it('declining the offer launches nothing and lists the command', async () => {
      makeProject('bootstrap-decline');
      const confirm = vi.fn(async (question: string) => question !== DRAFT_QUESTION);
      const runBootstrap = vi.fn(async () => 0);

      const { adopt } = await import('../commands/adopt.js');
      await adopt({}, { confirm, runBootstrap });

      expect(confirm).toHaveBeenCalledWith(DRAFT_QUESTION, false);
      expect(runBootstrap).not.toHaveBeenCalled();
      expect(hintPrinted()).toBe(true);
    });

    it('accepting runs the pass and drops the hint once the docs are drafted; a failing pass does not fail adopt', async () => {
      const root = makeProject('bootstrap-accept');
      const confirm = vi.fn(async () => true);
      const runBootstrap = vi.fn(async (at: string) => {
        writeCuratedDocs(at);
        return 1;
      });

      const { adopt } = await import('../commands/adopt.js');
      const exitCodeBefore = process.exitCode;
      await expect(adopt({}, { confirm, runBootstrap })).resolves.toBeUndefined();

      expect(runBootstrap).toHaveBeenCalledWith(root);
      // Adoption succeeded: the pass's non-zero exit is reported, not propagated.
      expect(process.exitCode).toBe(exitCodeBefore);
      expect(output.some(line => line.includes('Codev is adopted. The bootstrap pass reported problems'))).toBe(true);
      expect(hintPrinted()).toBe(false);
      // Next steps come last, after the pass.
      const nextSteps = output.findIndex(line => line.includes('Next steps:'));
      expect(nextSteps).toBeGreaterThan(-1);
      expect(output.slice(nextSteps).some(line => line.includes('afx spawn'))).toBe(true);
    });

    it('with a CLAUDE.md conflict, the offer comes only after the merge session has exited', async () => {
      const root = makeProject('bootstrap-conflict', { 'package.json': '{}', 'CLAUDE.md': '# Mine' });
      const events: string[] = [];
      const confirm = vi.fn(async (question: string) => {
        events.push(`confirm:${question}`);
        return question !== 'Allow AI agents to run commands without confirmation prompts?';
      });
      const runMergeSession = vi.fn(async (_prompt: string, cwd: string) => {
        events.push(`merge-start:${cwd === root}`);
        await new Promise(resolve => setTimeout(resolve, 20));
        events.push('merge-exit');
        return { code: 0, signal: null };
      });
      const runBootstrap = vi.fn(async () => {
        events.push('bootstrap');
        return 0;
      });

      const { adopt } = await import('../commands/adopt.js');
      await adopt({}, { confirm, runMergeSession, runBootstrap });

      expect(events.indexOf('merge-start:true')).toBeGreaterThan(-1);
      expect(events.indexOf('merge-exit')).toBeLessThan(events.indexOf(`confirm:${DRAFT_QUESTION}`));
      expect(events.indexOf(`confirm:${DRAFT_QUESTION}`)).toBeLessThan(events.indexOf('bootstrap'));
    });

    it('-y with a conflict does not wait on the merge session, which launches after Next steps', async () => {
      makeProject('bootstrap-conflict-yes', { 'package.json': '{}', 'CLAUDE.md': '# Mine' });
      let mergeStartedAt = -1;
      let finishMerge: (() => void) | undefined;
      const runMergeSession = vi.fn(() => {
        mergeStartedAt = output.length;
        return new Promise<{ code: number; signal: null }>(resolve => {
          finishMerge = () => resolve({ code: 0, signal: null });
        });
      });

      const { adopt } = await import('../commands/adopt.js');
      await adopt({ yes: true }, { runMergeSession, runBootstrap: vi.fn(async () => 0) });

      expect(runMergeSession).toHaveBeenCalledTimes(1);
      expect(output.findIndex(line => line.includes('Next steps:'))).toBeLessThan(mergeStartedAt);
      finishMerge?.();
    });

    it('a merge session that cannot launch prints the manual merge steps and still offers the pass', async () => {
      makeProject('bootstrap-merge-error', { 'package.json': '{}', 'CLAUDE.md': '# Mine' });
      const confirm = vi.fn(async (question: string) => question !== DRAFT_QUESTION);
      const runMergeSession = vi.fn(async () => ({ code: null, signal: null, error: 'spawn claude ENOENT' }));

      const { adopt } = await import('../commands/adopt.js');
      await adopt({}, { confirm, runMergeSession, runBootstrap: vi.fn(async () => 0) });

      expect(output.some(line => line.includes('spawn claude ENOENT'))).toBe(true);
      expect(output.some(line => line.includes('CLAUDE.md ← CLAUDE.md.codev-new'))).toBe(true);
      expect(confirm).toHaveBeenCalledWith(DRAFT_QUESTION, false);
    });
  });
});
