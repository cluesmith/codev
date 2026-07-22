/**
 * Tests for gitignore management utilities.
 *
 * Split out of `scaffold.test.ts` in issue #882 when the gitignore helpers
 * moved to their own module.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  createGitignore,
  updateGitignore,
  backfillGitignore,
  auditStateFileIgnore,
  CODEV_GITIGNORE_ENTRIES,
} from '../lib/gitignore.js';

describe('Gitignore Utilities', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('createGitignore', () => {
    it('should create .gitignore with codev entries', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });

      createGitignore(targetDir);

      const content = fs.readFileSync(path.join(targetDir, '.gitignore'), 'utf-8');
      expect(content).toContain('.agent-farm/');
      expect(content).toContain('.consult/');
      expect(content).toContain('.builders/');
    });

    // Regression for issue #880: .architect-role.md must be ignored from day one
    it('should include .architect-role.md (issue #880)', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });

      createGitignore(targetDir);

      const content = fs.readFileSync(path.join(targetDir, '.gitignore'), 'utf-8');
      expect(content).toContain('.architect-role.md');
    });
  });

  describe('updateGitignore', () => {
    it('should append codev entries to existing .gitignore', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, '.gitignore'), 'node_modules/\n');

      const result = updateGitignore(targetDir);

      expect(result.updated).toBe(true);
      const content = fs.readFileSync(path.join(targetDir, '.gitignore'), 'utf-8');
      expect(content).toContain('node_modules/');
      expect(content).toContain('.agent-farm/');
    });

    it('should report alreadyPresent when the full block is already present', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, '.gitignore'), CODEV_GITIGNORE_ENTRIES);

      const result = updateGitignore(targetDir);

      expect(result.updated).toBe(false);
      expect(result.alreadyPresent).toBe(true);
    });

    // Regression for issue #880: adopt against a partial Codev block must self-heal.
    // Previously, updateGitignore short-circuited on a `.agent-farm/` sentinel, which
    // meant projects that ignored `.agent-farm/` but lacked `.architect-role.md` were
    // left unhealed.
    it('should backfill missing entries when block is partial (issue #880)', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, '.gitignore'),
        'node_modules/\n.agent-farm/\n.consult/\n'
      );

      const result = updateGitignore(targetDir);

      expect(result.updated).toBe(true);
      expect(result.alreadyPresent).toBe(false);
      const content = fs.readFileSync(path.join(targetDir, '.gitignore'), 'utf-8');
      expect(content).toContain('.architect-role.md');
      expect(content).toContain('.builders/');
      // Existing entries preserved, no duplicates
      expect(content).toContain('node_modules/');
      expect((content.match(/\.agent-farm\//g) || []).length).toBe(1);
      expect((content.match(/\.consult\//g) || []).length).toBe(1);
    });

    it('should create .gitignore if it does not exist', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });

      const result = updateGitignore(targetDir);

      expect(result.created).toBe(true);
      expect(fs.existsSync(path.join(targetDir, '.gitignore'))).toBe(true);
    });
  });

  describe('CODEV_GITIGNORE_ENTRIES', () => {
    it('should contain expected entries', () => {
      expect(CODEV_GITIGNORE_ENTRIES).toContain('.agent-farm/');
      expect(CODEV_GITIGNORE_ENTRIES).toContain('.consult/');
      expect(CODEV_GITIGNORE_ENTRIES).toContain('.builders/');
    });

    // Regression for issue #880
    it('should contain .architect-role.md (issue #880)', () => {
      expect(CODEV_GITIGNORE_ENTRIES).toContain('.architect-role.md');
    });

    // Regression for issue #1192: architect state files are per-person and
    // ignored; builder thread files stay versioned. The negation must come
    // AFTER the ignore rule (gitignore last-match-wins).
    it('should ignore architect state files but keep thread files, in that order (issue #1192)', () => {
      expect(CODEV_GITIGNORE_ENTRIES).toContain('codev/state/*.md');
      expect(CODEV_GITIGNORE_ENTRIES).toContain('!codev/state/*_thread.md');
      expect(CODEV_GITIGNORE_ENTRIES.indexOf('codev/state/*.md')).toBeLessThan(
        CODEV_GITIGNORE_ENTRIES.indexOf('!codev/state/*_thread.md')
      );
    });
  });

  describe('backfillGitignore (issue #880)', () => {
    it('appends missing entries under a dated Codev header', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, '.gitignore'),
        '# Codev\n.agent-farm/\n.consult/\ncodev/.update-hashes.json\n.builders/\n'
      );

      const result = backfillGitignore(targetDir, CODEV_GITIGNORE_ENTRIES, { today: new Date('2026-05-27') });

      expect(result.skipped).toBe(false);
      expect(result.added).toEqual(['.architect-role.md', 'codev/state/*.md', '!codev/state/*_thread.md']);
      expect(result.alreadyPresent).toEqual(
        expect.arrayContaining(['.agent-farm/', '.consult/', 'codev/.update-hashes.json', '.builders/'])
      );

      const content = fs.readFileSync(path.join(targetDir, '.gitignore'), 'utf-8');
      expect(content).toContain('# Codev (added by codev update 2026-05-27)');
      expect(content).toContain('.architect-role.md');
    });

    it('is idempotent — second run after a clean state is a no-op', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, '.gitignore'), CODEV_GITIGNORE_ENTRIES);

      const result = backfillGitignore(targetDir, CODEV_GITIGNORE_ENTRIES);

      expect(result.added).toEqual([]);
      expect(result.alreadyPresent.length).toBeGreaterThan(0);

      const contentAfter = fs.readFileSync(path.join(targetDir, '.gitignore'), 'utf-8');
      expect(contentAfter).toBe(CODEV_GITIGNORE_ENTRIES);
    });

    it('preserves custom user entries verbatim', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });
      const userGitignore = [
        '# my project',
        'node_modules/',
        'dist/',
        '.env.local',
        '',
        '# Codev',
        '.agent-farm/',
        '.consult/',
        'codev/.update-hashes.json',
        '.builders/',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(targetDir, '.gitignore'), userGitignore);

      backfillGitignore(targetDir, CODEV_GITIGNORE_ENTRIES, { today: new Date('2026-05-27') });

      const content = fs.readFileSync(path.join(targetDir, '.gitignore'), 'utf-8');
      expect(content.startsWith(userGitignore)).toBe(true);
      expect(content).toContain('.architect-role.md');
      // Custom entries untouched
      expect(content).toContain('# my project');
      expect(content).toContain('.env.local');
    });

    it('skips silently when no .gitignore exists', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });

      const result = backfillGitignore(targetDir, CODEV_GITIGNORE_ENTRIES);

      expect(result.skipped).toBe(true);
      expect(result.added).toEqual([]);
      expect(fs.existsSync(path.join(targetDir, '.gitignore'))).toBe(false);
    });

    it('does not write in dry-run mode', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });
      const original = '# Codev\n.agent-farm/\n.consult/\ncodev/.update-hashes.json\n.builders/\n';
      fs.writeFileSync(path.join(targetDir, '.gitignore'), original);

      const result = backfillGitignore(targetDir, CODEV_GITIGNORE_ENTRIES, { dryRun: true });

      expect(result.added).toEqual(['.architect-role.md', 'codev/state/*.md', '!codev/state/*_thread.md']);
      expect(fs.readFileSync(path.join(targetDir, '.gitignore'), 'utf-8')).toBe(original);
    });

    it('does not duplicate when invoked twice in a row', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, '.gitignore'),
        '# Codev\n.agent-farm/\n.consult/\ncodev/.update-hashes.json\n.builders/\n'
      );

      backfillGitignore(targetDir, CODEV_GITIGNORE_ENTRIES, { today: new Date('2026-05-27') });
      const afterFirst = fs.readFileSync(path.join(targetDir, '.gitignore'), 'utf-8');
      backfillGitignore(targetDir, CODEV_GITIGNORE_ENTRIES, { today: new Date('2026-05-28') });
      const afterSecond = fs.readFileSync(path.join(targetDir, '.gitignore'), 'utf-8');

      expect(afterFirst).toBe(afterSecond);
      // Only one occurrence of .architect-role.md
      expect(afterSecond.match(/\.architect-role\.md/g) || []).toHaveLength(1);
    });

    // Regression for issue #1192: a pre-#1192 install gains the state-file
    // rule pair (and only that) from `codev update`, in ignore-then-negate order.
    it('backfills the state-file rule pair for pre-#1192 installs (issue #1192)', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, '.gitignore'),
        '# Codev\n.agent-farm/\n.consult/\ncodev/.update-hashes.json\n.builders/\n.architect-role.md\n'
      );

      const result = backfillGitignore(targetDir, CODEV_GITIGNORE_ENTRIES, { today: new Date('2026-07-19') });

      expect(result.added).toEqual(['codev/state/*.md', '!codev/state/*_thread.md']);

      const content = fs.readFileSync(path.join(targetDir, '.gitignore'), 'utf-8');
      expect(content.indexOf('codev/state/*.md')).toBeLessThan(
        content.indexOf('!codev/state/*_thread.md')
      );
    });
  });

  function gitInit(dir: string): void {
    execFileSync('git', ['init', '-q'], { cwd: dir });
  }

  function checkIgnoreStatus(dir: string, file: string): number {
    try {
      execFileSync('git', ['check-ignore', '-q', file], { cwd: dir });
      return 0;
    } catch (err) {
      return (err as { status: number }).status;
    }
  }

  // End-to-end validity of the rule pair (issue #1192): prove git actually
  // produces the intended split, not just that the text is present.
  describe('state-file split against real git (issue #1192)', () => {
    it('ignores architect state files but not builder thread files', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });
      gitInit(targetDir);
      createGitignore(targetDir);

      expect(checkIgnoreStatus(targetDir, 'codev/state/main.md')).toBe(0);
      expect(checkIgnoreStatus(targetDir, 'codev/state/pir-42_thread.md')).not.toBe(0);
    });
  });

  describe('auditStateFileIgnore (issue #1192)', () => {
    it('warns when architect state files are not ignored', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });
      gitInit(targetDir);

      const warnings = auditStateFileIgnore(targetDir);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('not gitignored');
    });

    it('reports nothing when the rule pair is in place', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });
      gitInit(targetDir);
      createGitignore(targetDir);

      expect(auditStateFileIgnore(targetDir)).toEqual([]);
    });

    it('warns when a later rule shadows the thread-file negation', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });
      gitInit(targetDir);
      // Negation before the ignore rule: last-match-wins re-ignores thread files
      fs.writeFileSync(
        path.join(targetDir, '.gitignore'),
        '!codev/state/*_thread.md\ncodev/state/*.md\n'
      );

      const warnings = auditStateFileIgnore(targetDir);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('must stay versioned');
    });

    it('warns per architect state file already tracked by git', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });
      gitInit(targetDir);
      createGitignore(targetDir);
      fs.mkdirSync(path.join(targetDir, 'codev', 'state'), { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'codev', 'state', 'main.md'), '# main architect\n');
      fs.writeFileSync(path.join(targetDir, 'codev', 'state', 'pir-42_thread.md'), '# thread\n');
      execFileSync('git', ['add', '-f', 'codev/state/main.md', 'codev/state/pir-42_thread.md'], {
        cwd: targetDir,
      });

      const warnings = auditStateFileIgnore(targetDir);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('codev/state/main.md');
      expect(warnings[0]).toContain('git rm --cached');
    });

    it('returns no findings outside a git repository', () => {
      const targetDir = path.join(tempDir, 'plain-dir');
      fs.mkdirSync(targetDir, { recursive: true });

      expect(auditStateFileIgnore(targetDir)).toEqual([]);
    });
  });
});
