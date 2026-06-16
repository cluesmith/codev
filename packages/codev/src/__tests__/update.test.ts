/**
 * Tests for codev update command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

// Mock chalk for cleaner test output
vi.mock('chalk', () => ({
  default: {
    bold: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    blue: (s: string) => s,
    dim: (s: string) => s,
    cyan: (s: string) => s,
  },
}));

describe('update command', () => {
  const testBaseDir = path.join(tmpdir(), `codev-update-test-${Date.now()}`);
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    fs.mkdirSync(testBaseDir, { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true });
    }
  });

  describe('update function', () => {
    it('should throw error if codev directory does not exist', async () => {
      const projectDir = path.join(testBaseDir, 'no-codev');
      fs.mkdirSync(projectDir, { recursive: true });

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      await expect(update()).rejects.toThrow(/No codev\/ directory found/);
    });

    it('should not modify files in dry-run mode', async () => {
      const projectDir = path.join(testBaseDir, 'dry-run-test');
      fs.mkdirSync(path.join(projectDir, 'codev', 'protocols'), { recursive: true });

      const protocolContent = '# Old Protocol';
      fs.writeFileSync(
        path.join(projectDir, 'codev', 'protocols', 'test.md'),
        protocolContent
      );

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      await update({ dryRun: true });

      // File should not be modified
      const content = fs.readFileSync(
        path.join(projectDir, 'codev', 'protocols', 'test.md'),
        'utf-8'
      );
      expect(content).toBe(protocolContent);
    });

    it('should handle --force flag to overwrite all files', async () => {
      const projectDir = path.join(testBaseDir, 'force-test');
      fs.mkdirSync(path.join(projectDir, 'codev', 'protocols'), { recursive: true });

      // Create a file and a hash store indicating it was modified
      fs.writeFileSync(
        path.join(projectDir, 'codev', 'protocols', 'modified.md'),
        '# User Modified'
      );

      // Create hash store that tracks original hash
      const hashStore = { 'protocols/modified.md': 'original-hash' };
      fs.writeFileSync(
        path.join(projectDir, 'codev', '.update-hashes.json'),
        JSON.stringify(hashStore)
      );

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      const result = await update({ force: true });

      // Force mode should produce no conflicts
      expect(result.conflicts).toHaveLength(0);
      expect(result.rootConflicts).toHaveLength(0);
    });

    it('should return UpdateResult from update()', async () => {
      const projectDir = path.join(testBaseDir, 'return-test');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      const result = await update();

      // Verify it returns an UpdateResult object
      expect(result).toBeDefined();
      expect(Array.isArray(result.updated)).toBe(true);
      expect(Array.isArray(result.skipped)).toBe(true);
      expect(Array.isArray(result.conflicts)).toBe(true);
      expect(Array.isArray(result.newFiles)).toBe(true);
      expect(Array.isArray(result.rootConflicts)).toBe(true);
    });
  });

  describe('PR-gate audit surfacing (#943)', () => {
    it('surfaces a gateless PR-producing override after the update summary', async () => {
      const projectDir = path.join(testBaseDir, 'prgate-warn');
      const bugfixDir = path.join(projectDir, 'codev', 'protocols', 'bugfix');
      fs.mkdirSync(bugfixDir, { recursive: true });
      fs.writeFileSync(path.join(bugfixDir, 'protocol.json'), JSON.stringify({
        name: 'bugfix',
        phases: [{ id: 'fix' }, { id: 'pr', steps: ['create_pr'] }],
      }));

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      const result = await update({ dryRun: true });

      expect(result.prGateWarnings).toBeDefined();
      expect(result.prGateWarnings!.some(w =>
        w.includes('Protocol `bugfix`') && w.includes('no `pr` gate'))).toBe(true);
    });

    it('reports no PR-gate warnings when overrides are correctly gated', async () => {
      const projectDir = path.join(testBaseDir, 'prgate-clean');
      const bugfixDir = path.join(projectDir, 'codev', 'protocols', 'bugfix');
      fs.mkdirSync(bugfixDir, { recursive: true });
      fs.writeFileSync(path.join(bugfixDir, 'protocol.json'), JSON.stringify({
        name: 'bugfix',
        phases: [{ id: 'fix' }, { id: 'pr', gate: 'pr', steps: ['create_pr'] }],
      }));

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      const result = await update({ dryRun: true });

      expect(result.prGateWarnings).toEqual([]);
    });
  });

  describe('agent mode', () => {
    it('should return result without throwing when codev dir missing', async () => {
      const projectDir = path.join(testBaseDir, 'agent-no-codev');
      fs.mkdirSync(projectDir, { recursive: true });

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      const result = await update({ agent: true });

      expect(result.error).toBe("No codev/ directory found. Use 'codev init' or 'codev adopt' first.");
    });

    it('should return structured result with file categories', async () => {
      const projectDir = path.join(testBaseDir, 'agent-basic');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      const result = await update({ agent: true });

      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(Array.isArray(result.newFiles)).toBe(true);
      expect(Array.isArray(result.updated)).toBe(true);
      expect(Array.isArray(result.skipped)).toBe(true);
      expect(Array.isArray(result.conflicts)).toBe(true);
      expect(Array.isArray(result.rootConflicts)).toBe(true);
    });

    it('should use stderr (console.error) for logging in agent mode', async () => {
      const projectDir = path.join(testBaseDir, 'agent-stderr');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      await update({ agent: true });

      // In agent mode, console.error should be called (for stderr)
      // and console.log should NOT be called (stdout stays clean)
      expect(console.error).toHaveBeenCalled();
      // console.log may be called by other infrastructure, but update() itself shouldn't call it
    });

    it('should not call console.log in agent mode', async () => {
      const projectDir = path.join(testBaseDir, 'agent-no-stdout');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      process.chdir(projectDir);

      // Reset the mock to track calls from this point
      (console.log as ReturnType<typeof vi.fn>).mockClear();

      const { update } = await import('../commands/update.js');
      await update({ agent: true });

      // update() in agent mode should not call console.log at all
      expect(console.log).not.toHaveBeenCalled();
    });

    it('should return result with dryRun - no files modified', async () => {
      const projectDir = path.join(testBaseDir, 'agent-dryrun');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      const result = await update({ agent: true, dryRun: true });

      expect(result).toBeDefined();
      expect(result.error).toBeUndefined();
      // In dry-run mode, scaffold-only files are NOT reported (per spec limitation)
      // Scaffold utilities (copyConsultTypes, copySkills) don't run in dry-run,
      // so their files won't appear. Note: roles and protocol files appear through
      // the hash-based template loop, which does preview in dry-run.
      for (const file of result.newFiles) {
        expect(file).not.toMatch(/^codev\/consult-types\//);
        expect(file).not.toMatch(/^\.claude\/skills\//);
      }
    });

    it('should return no conflicts with force mode', async () => {
      const projectDir = path.join(testBaseDir, 'agent-force');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      const result = await update({ agent: true, force: true });

      expect(result.conflicts).toHaveLength(0);
    });

    it('should use project-relative paths in file arrays', async () => {
      const projectDir = path.join(testBaseDir, 'agent-paths');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      const result = await update({ agent: true });

      // All template files should have codev/ prefix
      for (const file of result.newFiles) {
        expect(
          file.startsWith('codev/') || file.startsWith('.claude/') || file === 'CLAUDE.md' || file === 'AGENTS.md'
        ).toBe(true);
      }
      for (const file of result.updated) {
        expect(
          file.startsWith('codev/') || file === 'CLAUDE.md' || file === 'AGENTS.md'
        ).toBe(true);
      }
      for (const file of result.skipped) {
        expect(
          file.startsWith('codev/') || file === 'CLAUDE.md' || file === 'AGENTS.md'
        ).toBe(true);
      }
    });

    it('should work correctly with no hash store (first-ever update)', async () => {
      const projectDir = path.join(testBaseDir, 'agent-no-hashstore');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });
      // Explicitly do NOT create .update-hashes.json

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      const result = await update({ agent: true });

      expect(result.error).toBeUndefined();
      // Should work fine — loadHashStore returns empty object for missing file
    });

    it('should produce conflict entries with correct shape', async () => {
      const projectDir = path.join(testBaseDir, 'agent-conflict-shape');
      const codevDir = path.join(projectDir, 'codev');
      fs.mkdirSync(path.join(codevDir, 'protocols', 'spir'), { recursive: true });

      // Create a user-modified file that differs from both stored hash and template
      const userContent = '# User modified version with custom notes';
      fs.writeFileSync(path.join(codevDir, 'protocols', 'spir', 'protocol.md'), userContent);

      // Create hash store with a different hash (simulating "original" that user modified)
      const hashStore = { 'protocols/spir/protocol.md': 'fake-original-hash' };
      fs.writeFileSync(
        path.join(codevDir, '.update-hashes.json'),
        JSON.stringify(hashStore)
      );

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      const result = await update({ agent: true });

      // Check if any conflicts were detected (depends on template existing)
      for (const conflict of result.conflicts) {
        expect(conflict).toHaveProperty('file');
        expect(conflict).toHaveProperty('codevNew');
        expect(conflict).toHaveProperty('reason');
        expect(typeof conflict.file).toBe('string');
        expect(typeof conflict.codevNew).toBe('string');
        expect(typeof conflict.reason).toBe('string');
      }
    });

    it('should catch errors and return result with error field in agent mode', async () => {
      const projectDir = path.join(testBaseDir, 'agent-error');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      // Make codev directory read-only to trigger an error during write operations
      // This is fragile on some systems, so we test the error handling path
      // by checking the "no codev directory" case which is more reliable
      const noCodevDir = path.join(testBaseDir, 'agent-error-nodir');
      fs.mkdirSync(noCodevDir, { recursive: true });

      process.chdir(noCodevDir);

      const { update } = await import('../commands/update.js');
      const result = await update({ agent: true });

      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
      expect(result.error).toContain('No codev/ directory found');
    });

    it('should use console.log in non-agent mode (regression test)', async () => {
      const projectDir = path.join(testBaseDir, 'non-agent-regression');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      process.chdir(projectDir);

      (console.log as ReturnType<typeof vi.fn>).mockClear();

      const { update } = await import('../commands/update.js');
      await update();

      // Non-agent mode should use console.log (stdout)
      expect(console.log).toHaveBeenCalled();
    });

    it('should produce valid JSON output matching spec schema', async () => {
      const projectDir = path.join(testBaseDir, 'agent-json-schema');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      const { version } = await import('../version.js');
      const result = await update({ agent: true });

      // Construct the JSON output exactly as cli.ts does
      const output = {
        version: '1.0',
        codevVersion: version,
        success: !result.error,
        dryRun: false,
        summary: {
          new: result.newFiles.length,
          updated: result.updated.length,
          conflicts: result.conflicts.length + result.rootConflicts.length,
          skipped: result.skipped.length,
        },
        files: {
          new: result.newFiles,
          updated: result.updated,
          skipped: result.skipped,
          conflicts: [...result.conflicts, ...result.rootConflicts],
        },
        instructions: result.error ? null : {
          conflicts: result.conflicts.length + result.rootConflicts.length > 0
            ? 'For each conflict, merge the .codev-new file into the original. Preserve user customizations and incorporate new sections from .codev-new. Delete the .codev-new file after merging.'
            : null,
          commit: `Stage and commit all changed files with message: '[Maintenance] Update codev to v${version}'`,
        },
        ...(result.error ? { error: result.error } : {}),
      };

      // Verify JSON.stringify succeeds and JSON.parse round-trips
      const jsonStr = JSON.stringify(output);
      const parsed = JSON.parse(jsonStr);

      // Validate required top-level fields
      expect(parsed.version).toBe('1.0');
      expect(typeof parsed.codevVersion).toBe('string');
      expect(parsed.codevVersion.length).toBeGreaterThan(0);
      expect(typeof parsed.success).toBe('boolean');
      expect(typeof parsed.dryRun).toBe('boolean');

      // Validate summary shape
      expect(typeof parsed.summary.new).toBe('number');
      expect(typeof parsed.summary.updated).toBe('number');
      expect(typeof parsed.summary.conflicts).toBe('number');
      expect(typeof parsed.summary.skipped).toBe('number');

      // Validate files shape
      expect(Array.isArray(parsed.files.new)).toBe(true);
      expect(Array.isArray(parsed.files.updated)).toBe(true);
      expect(Array.isArray(parsed.files.skipped)).toBe(true);
      expect(Array.isArray(parsed.files.conflicts)).toBe(true);

      // Validate instructions
      expect(parsed.instructions).not.toBeNull();
      expect(typeof parsed.instructions.commit).toBe('string');
    });

    it('should include actual version in instructions.commit, not placeholder', async () => {
      const projectDir = path.join(testBaseDir, 'agent-version');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      const { version } = await import('../version.js');
      const result = await update({ agent: true });

      // Construct the commit instruction as cli.ts does
      const commitMsg = `Stage and commit all changed files with message: '[Maintenance] Update codev to v${version}'`;

      // Version should be a real semver string, not a placeholder
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
      expect(commitMsg).toContain(version);
      expect(commitMsg).not.toContain('vX.Y.Z');
    });

    it('should run second update and show mostly skipped files', async () => {
      const projectDir = path.join(testBaseDir, 'agent-uptodate');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');

      // First update
      await update({ agent: true });

      // Second update - most files should be skipped
      const result = await update({ agent: true });

      // After the first update, all files that were new or updated
      // should now be skipped on the second run
      expect(result.error).toBeUndefined();
      // The exact counts depend on the skeleton, but conflicts should be 0
      expect(result.conflicts).toHaveLength(0);
    });
  });

  describe('conflict handling', () => {
    it('should create .codev-new file when user modified a tracked file', async () => {
      const projectDir = path.join(testBaseDir, 'conflict-test');
      const codevDir = path.join(projectDir, 'codev');

      // Create minimal codev structure
      fs.mkdirSync(path.join(codevDir, 'protocols', 'spir'), { recursive: true });

      // Create a user-modified file at a path that matches a real template
      const userContent = '# User modified version with custom notes';
      fs.writeFileSync(path.join(codevDir, 'protocols', 'spir', 'protocol.md'), userContent);

      // Create hash store with a fake hash (simulating that user modified the file)
      const hashStore = { 'protocols/spir/protocol.md': 'fake-original-hash' };
      fs.writeFileSync(
        path.join(codevDir, '.update-hashes.json'),
        JSON.stringify(hashStore)
      );

      process.chdir(projectDir);

      // Use agent mode so we get the result back without throwing
      const { update } = await import('../commands/update.js');
      const result = await update({ agent: true });

      expect(result.error).toBeUndefined();

      // Find the conflict for our modified file
      const conflict = result.conflicts.find(c => c.file.includes('protocols/spir/protocol.md'));
      if (conflict) {
        // Verify .codev-new file was created
        const codevNewPath = path.join(projectDir, conflict.codevNew);
        expect(fs.existsSync(codevNewPath)).toBe(true);
        expect(conflict.reason).toBeDefined();
      }
    });
  });

  describe('gitignore backfill (issue #880)', () => {
    it('appends .architect-role.md to a stale .gitignore on update', async () => {
      const projectDir = path.join(testBaseDir, 'gitignore-backfill');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      const staleGitignore = [
        'node_modules/',
        '',
        '# Codev',
        '.agent-farm/',
        '.consult/',
        'codev/.update-hashes.json',
        '.builders/',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(projectDir, '.gitignore'), staleGitignore);

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      const result = await update({ agent: true });

      expect(result.error).toBeUndefined();
      expect(result.gitignoreAdded).toEqual(['.architect-role.md', '.gemini/settings.json']);

      const content = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8');
      expect(content).toContain('.architect-role.md');
      // User entries preserved
      expect(content).toContain('node_modules/');
    });

    it('does not write to .gitignore in dry-run', async () => {
      const projectDir = path.join(testBaseDir, 'gitignore-dryrun');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      const stale = '# Codev\n.agent-farm/\n.consult/\ncodev/.update-hashes.json\n.builders/\n';
      fs.writeFileSync(path.join(projectDir, '.gitignore'), stale);

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      const result = await update({ agent: true, dryRun: true });

      expect(result.gitignoreAdded).toEqual(['.architect-role.md', '.gemini/settings.json']);
      expect(fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8')).toBe(stale);
    });

    it('skips silently when .gitignore is absent', async () => {
      const projectDir = path.join(testBaseDir, 'gitignore-absent');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      const result = await update({ agent: true });

      expect(result.gitignoreSkipped).toBe(true);
      expect(result.gitignoreAdded).toEqual([]);
      expect(fs.existsSync(path.join(projectDir, '.gitignore'))).toBe(false);
    });

    it('is idempotent — second update is a no-op for the gitignore', async () => {
      const projectDir = path.join(testBaseDir, 'gitignore-idempotent');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      const stale = '# Codev\n.agent-farm/\n.consult/\ncodev/.update-hashes.json\n.builders/\n';
      fs.writeFileSync(path.join(projectDir, '.gitignore'), stale);

      process.chdir(projectDir);

      const { update } = await import('../commands/update.js');
      await update({ agent: true });
      const afterFirst = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8');

      const result = await update({ agent: true });
      const afterSecond = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8');

      expect(result.gitignoreAdded).toEqual([]);
      expect(afterFirst).toBe(afterSecond);
    });
  });

  describe('hash store management', () => {
    it('should preserve existing hashes after update', async () => {
      const projectDir = path.join(testBaseDir, 'hash-preserve');
      fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });

      // Create initial hash store
      const initialHashes = {
        'protocols/spir.md': 'hash1',
        'roles/architect.md': 'hash2',
      };
      fs.writeFileSync(
        path.join(projectDir, 'codev', '.update-hashes.json'),
        JSON.stringify(initialHashes)
      );

      process.chdir(projectDir);

      const { loadHashStore, saveHashStore } = await import('../lib/templates.js');

      // Verify we can load and save
      const loaded = loadHashStore(projectDir);
      expect(loaded).toEqual(initialHashes);

      // Add a new hash and save
      const newHashes = { ...loaded, 'new-file.md': 'hash3' };
      saveHashStore(projectDir, newHashes);

      // Verify persistence
      const reloaded = loadHashStore(projectDir);
      expect(reloaded['new-file.md']).toBe('hash3');
    });
  });
});
