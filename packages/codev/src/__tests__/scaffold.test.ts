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
  copyProjectlist,
  copyProjectlistArchive,
  copyResourceTemplates,
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
      path.join(mockSkeletonDir, 'templates', 'projectlist.md'),
      '# Project List\n\nTemplate content'
    );
    fs.writeFileSync(
      path.join(mockSkeletonDir, 'templates', 'projectlist-archive.md'),
      '# Archive\n\nArchive template'
    );
    fs.writeFileSync(
      path.join(mockSkeletonDir, 'templates', 'lessons-learned.md'),
      '# Lessons Learned\n\nLessons template'
    );
    fs.writeFileSync(
      path.join(mockSkeletonDir, 'templates', 'arch.md'),
      '# Architecture\n\nArch template'
    );
    fs.writeFileSync(
      path.join(mockSkeletonDir, 'templates', 'CLAUDE.md'),
      '# {{PROJECT_NAME}} Instructions\n\nClaude template'
    );
    fs.writeFileSync(
      path.join(mockSkeletonDir, 'templates', 'AGENTS.md'),
      '# {{PROJECT_NAME}} Instructions\n\nAgents template'
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

  describe('copyProjectlist', () => {
    it('should copy projectlist.md from skeleton template', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(path.join(targetDir, 'codev'), { recursive: true });

      const result = copyProjectlist(targetDir, mockSkeletonDir);

      expect(result.copied).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'codev', 'projectlist.md'))).toBe(true);
      expect(fs.readFileSync(path.join(targetDir, 'codev', 'projectlist.md'), 'utf-8')).toContain('Template content');
    });

    it('should use inline fallback when template not found', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(path.join(targetDir, 'codev'), { recursive: true });
      const emptySkeletonDir = path.join(tempDir, 'empty-skeleton');
      fs.mkdirSync(path.join(emptySkeletonDir, 'templates'), { recursive: true });

      const result = copyProjectlist(targetDir, emptySkeletonDir);

      expect(result.copied).toBe(true);
      expect(result.usedFallback).toBe(true);
      const content = fs.readFileSync(path.join(targetDir, 'codev', 'projectlist.md'), 'utf-8');
      expect(content).toContain('# Project List');
      expect(content).toContain('projects:');
    });

    it('should skip if file exists and skipExisting is true', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(path.join(targetDir, 'codev'), { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'codev', 'projectlist.md'), 'existing');

      const result = copyProjectlist(targetDir, mockSkeletonDir, { skipExisting: true });

      expect(result.copied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(fs.readFileSync(path.join(targetDir, 'codev', 'projectlist.md'), 'utf-8')).toBe('existing');
    });
  });

  describe('copyProjectlistArchive', () => {
    it('should copy projectlist-archive.md from skeleton template', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(path.join(targetDir, 'codev'), { recursive: true });

      const result = copyProjectlistArchive(targetDir, mockSkeletonDir);

      expect(result.copied).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'codev', 'projectlist-archive.md'))).toBe(true);
    });

    it('should return not copied if template not found', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(path.join(targetDir, 'codev'), { recursive: true });
      const emptySkeletonDir = path.join(tempDir, 'empty-skeleton');
      fs.mkdirSync(path.join(emptySkeletonDir, 'templates'), { recursive: true });

      const result = copyProjectlistArchive(targetDir, emptySkeletonDir);

      expect(result.copied).toBe(false);
      expect(result.templateNotFound).toBe(true);
    });
  });

  describe('copyResourceTemplates', () => {
    it('should copy lessons-learned.md and arch.md', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(targetDir, { recursive: true });

      const result = copyResourceTemplates(targetDir, mockSkeletonDir);

      expect(result.copied).toContain('lessons-learned.md');
      expect(result.copied).toContain('arch.md');
      expect(fs.existsSync(path.join(targetDir, 'codev', 'resources', 'lessons-learned.md'))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'codev', 'resources', 'arch.md'))).toBe(true);
    });

    it('should skip existing files in adopt mode', () => {
      const targetDir = path.join(tempDir, 'project');
      fs.mkdirSync(path.join(targetDir, 'codev', 'resources'), { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'codev', 'resources', 'arch.md'), 'existing');

      const result = copyResourceTemplates(targetDir, mockSkeletonDir, { skipExisting: true });

      expect(result.copied).toContain('lessons-learned.md');
      expect(result.skipped).toContain('arch.md');
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
});
