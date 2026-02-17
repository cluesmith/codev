/**
 * Tests for scaffold utilities
 * Extracted from init.ts and adopt.ts to eliminate duplication
 * (Maintenance Run 0004)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createUserDirs,
  copyConsultTypes,
  copyResourceTemplates,
  copyRoles,
  copyRootFiles,
  createGitignore,
  updateGitignore,
  CODEV_GITIGNORE_ENTRIES,
} from '../lib/scaffold.js';

describe('Scaffold Utilities', () => {
  let tempDir: string;
  let mockSkeletonDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-test-'));
    mockSkeletonDir = path.join(tempDir, 'skeleton');

    // Create mock skeleton templates
    fs.mkdirSync(path.join(mockSkeletonDir, 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(mockSkeletonDir, 'templates', 'lessons-learned.md'),
      '# Lessons Learned\n\nLessons template'
    );
    fs.writeFileSync(
      path.join(mockSkeletonDir, 'templates', 'arch.md'),
      '# Architecture\n\nArch template'
    );
    fs.writeFileSync(
      path.join(mockSkeletonDir, 'templates', 'cheatsheet.md'),
      '# Codev Cheatsheet\n\nCheatsheet template'
    );
    fs.writeFileSync(
      path.join(mockSkeletonDir, 'templates', 'lifecycle.md'),
      '# Lifecycle\n\nLifecycle template'
    );
    fs.writeFileSync(
      path.join(mockSkeletonDir, 'templates', 'CLAUDE.md'),
      '# {{PROJECT_NAME}} Instructions\n\nClaude template'
    );
    fs.writeFileSync(
      path.join(mockSkeletonDir, 'templates', 'AGENTS.md'),
      '# {{PROJECT_NAME}} Instructions\n\nAgents template'
    );

    // Create mock consult-types directory (only integration-review remains in shared dir;
    // protocol-specific types moved to per-protocol dirs in Spec 325)
    fs.mkdirSync(path.join(mockSkeletonDir, 'consult-types'), { recursive: true });
    fs.writeFileSync(
      path.join(mockSkeletonDir, 'consult-types', 'integration-review.md'),
      '# Integration Review\n\nIntegration review prompt'
    );

    // Create mock roles directory
    fs.mkdirSync(path.join(mockSkeletonDir, 'roles'), { recursive: true });
    fs.writeFileSync(
      path.join(mockSkeletonDir, 'roles', 'architect.md'),
      '# Architect Role\n\nArchitect prompt'
    );
    fs.writeFileSync(
      path.join(mockSkeletonDir, 'roles', 'builder.md'),
      '# Builder Role\n\nBuilder prompt'
    );
    fs.writeFileSync(
      path.join(mockSkeletonDir, 'roles', 'consultant.md'),
      '# Consultant Role\n\nConsultant prompt'
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('createUserDirs', () => {
    it('should create specs, plans, reviews directories with .gitkeep', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });

      const result = createUserDirs(targetDir);

      expect(result.created).toEqual(['specs', 'plans', 'reviews']);
      expect(fs.existsSync(path.join(targetDir, 'codev', 'specs', '.gitkeep'))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'codev', 'plans', '.gitkeep'))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'codev', 'reviews', '.gitkeep'))).toBe(true);
    });

    it('should skip existing directories in adopt mode', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(path.join(targetDir, 'codev', 'specs'), { recursive: true });

      const result = createUserDirs(targetDir, { skipExisting: true });

      expect(result.created).toEqual(['plans', 'reviews']);
      expect(result.skipped).toEqual(['specs']);
    });

    it('should not skip existing directories in init mode', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(path.join(targetDir, 'codev', 'specs'), { recursive: true });

      const result = createUserDirs(targetDir, { skipExisting: false });

      expect(result.created).toEqual(['specs', 'plans', 'reviews']);
    });
  });

  describe('copyConsultTypes', () => {
    it('should copy all .md files from consult-types directory', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });

      const result = copyConsultTypes(targetDir, mockSkeletonDir);

      expect(result.copied).toContain('integration-review.md');
      expect(result.directoryCreated).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'codev', 'consult-types', 'integration-review.md'))).toBe(true);
    });

    it('should skip existing files in adopt mode', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(path.join(targetDir, 'codev', 'consult-types'), { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'codev', 'consult-types', 'integration-review.md'), 'custom content');

      const result = copyConsultTypes(targetDir, mockSkeletonDir, { skipExisting: true });

      expect(result.skipped).toContain('integration-review.md');
      expect(result.directoryCreated).toBe(false);
      // Verify existing file was not overwritten
      expect(fs.readFileSync(path.join(targetDir, 'codev', 'consult-types', 'integration-review.md'), 'utf-8')).toBe('custom content');
    });

    it('should handle missing source directory gracefully', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });
      const emptySkeletonDir = path.join(tempDir, 'empty-skeleton');
      fs.mkdirSync(emptySkeletonDir, { recursive: true });

      const result = copyConsultTypes(targetDir, emptySkeletonDir);

      expect(result.copied).toEqual([]);
      expect(result.directoryCreated).toBe(true);
      // Directory should still be created even if source is missing
      expect(fs.existsSync(path.join(targetDir, 'codev', 'consult-types'))).toBe(true);
    });
  });

  // Regression test for issue #266: codev init does not copy roles/
  describe('copyRoles', () => {
    it('should copy all .md files from roles directory', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });

      const result = copyRoles(targetDir, mockSkeletonDir);

      expect(result.copied).toContain('architect.md');
      expect(result.copied).toContain('builder.md');
      expect(result.copied).toContain('consultant.md');
      expect(result.directoryCreated).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'codev', 'roles', 'architect.md'))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'codev', 'roles', 'builder.md'))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'codev', 'roles', 'consultant.md'))).toBe(true);
    });

    it('should skip existing files in adopt mode', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(path.join(targetDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'codev', 'roles', 'architect.md'), 'custom content');

      const result = copyRoles(targetDir, mockSkeletonDir, { skipExisting: true });

      expect(result.copied).toContain('builder.md');
      expect(result.copied).toContain('consultant.md');
      expect(result.skipped).toContain('architect.md');
      expect(result.directoryCreated).toBe(false);
      // Verify existing file was not overwritten
      expect(fs.readFileSync(path.join(targetDir, 'codev', 'roles', 'architect.md'), 'utf-8')).toBe('custom content');
    });

    it('should handle missing source directory gracefully', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });
      const emptySkeletonDir = path.join(tempDir, 'empty-skeleton');
      fs.mkdirSync(emptySkeletonDir, { recursive: true });

      const result = copyRoles(targetDir, emptySkeletonDir);

      expect(result.copied).toEqual([]);
      expect(result.directoryCreated).toBe(true);
      // Directory should still be created even if source is missing
      expect(fs.existsSync(path.join(targetDir, 'codev', 'roles'))).toBe(true);
    });
  });

  describe('copyResourceTemplates', () => {
    it('should copy lessons-learned.md, arch.md, cheatsheet.md, and lifecycle.md', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });

      const result = copyResourceTemplates(targetDir, mockSkeletonDir);

      expect(result.copied).toContain('lessons-learned.md');
      expect(result.copied).toContain('arch.md');
      expect(result.copied).toContain('cheatsheet.md');
      expect(result.copied).toContain('lifecycle.md');
      expect(fs.existsSync(path.join(targetDir, 'codev', 'resources', 'lessons-learned.md'))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'codev', 'resources', 'arch.md'))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'codev', 'resources', 'cheatsheet.md'))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'codev', 'resources', 'lifecycle.md'))).toBe(true);
    });

    it('should skip existing files in adopt mode', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(path.join(targetDir, 'codev', 'resources'), { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'codev', 'resources', 'arch.md'), 'existing');

      const result = copyResourceTemplates(targetDir, mockSkeletonDir, { skipExisting: true });

      expect(result.copied).toContain('lessons-learned.md');
      expect(result.copied).toContain('cheatsheet.md');
      expect(result.copied).toContain('lifecycle.md');
      expect(result.skipped).toContain('arch.md');
    });

    // Regression test for issue #130: cheatsheet.md missing after codev adopt
    it('should copy cheatsheet.md for dashboard documentation links (issue #130)', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });

      const result = copyResourceTemplates(targetDir, mockSkeletonDir);

      // cheatsheet.md is linked from dashboard info header - must be copied
      expect(result.copied).toContain('cheatsheet.md');
      const cheatsheetPath = path.join(targetDir, 'codev', 'resources', 'cheatsheet.md');
      expect(fs.existsSync(cheatsheetPath)).toBe(true);
    });
  });

  describe('copyRootFiles', () => {
    it('should copy CLAUDE.md and AGENTS.md with project name substitution', () => {
      const targetDir = path.join(tempDir, 'my-project');
      fs.mkdirSync(targetDir, { recursive: true });

      const result = copyRootFiles(targetDir, mockSkeletonDir, 'my-project');

      expect(result.copied).toContain('CLAUDE.md');
      expect(result.copied).toContain('AGENTS.md');

      const claudeContent = fs.readFileSync(path.join(targetDir, 'CLAUDE.md'), 'utf-8');
      expect(claudeContent).toContain('# my-project Instructions');
      expect(claudeContent).not.toContain('{{PROJECT_NAME}}');
    });

    it('should create .codev-new files for conflicts in adopt mode', () => {
      const targetDir = path.join(tempDir, 'my-project');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'CLAUDE.md'), 'existing content');

      const result = copyRootFiles(targetDir, mockSkeletonDir, 'my-project', { handleConflicts: true });

      expect(result.conflicts).toContain('CLAUDE.md');
      expect(fs.existsSync(path.join(targetDir, 'CLAUDE.md.codev-new'))).toBe(true);
      expect(fs.readFileSync(path.join(targetDir, 'CLAUDE.md'), 'utf-8')).toBe('existing content');
    });
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

    it('should not duplicate entries if already present', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, '.gitignore'), '.agent-farm/\n');

      const result = updateGitignore(targetDir);

      expect(result.updated).toBe(false);
      expect(result.alreadyPresent).toBe(true);
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
  });

  // Regression: Spec 0126 — projectlist.md should no longer be created by init/adopt
  describe('projectlist removal (Spec 0126)', () => {
    it('init no longer references projectlist', async () => {
      const initSource = fs.readFileSync(
        path.resolve(__dirname, '..', 'commands', 'init.ts'),
        'utf-8'
      );
      expect(initSource).not.toContain('copyProjectlist');
      expect(initSource).not.toContain('copyProjectlistArchive');
    });

    it('scaffold no longer exports copyProjectlist', async () => {
      const scaffoldSource = fs.readFileSync(
        path.resolve(__dirname, '..', 'lib', 'scaffold.ts'),
        'utf-8'
      );
      expect(scaffoldSource).not.toContain('copyProjectlist');
      expect(scaffoldSource).not.toContain('copyProjectlistArchive');
    });
  });
});
