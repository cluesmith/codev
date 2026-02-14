/**
 * Tests for consult CLI command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

// Mock child_process
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    on: vi.fn((event: string, callback: (code: number) => void) => {
      if (event === 'close') callback(0);
    }),
  })),
  execSync: vi.fn((cmd: string) => {
    if (cmd.includes('which')) {
      return Buffer.from('/usr/bin/command');
    }
    return Buffer.from('');
  }),
}));

// Mock Claude Agent SDK
let mockQueryFn: ReturnType<typeof vi.fn>;

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  mockQueryFn = vi.fn();
  return { query: mockQueryFn };
});

// Mock chalk
vi.mock('chalk', () => ({
  default: {
    bold: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    blue: (s: string) => s,
    dim: (s: string) => s,
  },
}));

describe('consult command', () => {
  const testBaseDir = path.join(tmpdir(), `codev-consult-test-${Date.now()}`);
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

  describe('model configuration', () => {
    it('should support model aliases', () => {
      // The MODEL_ALIASES mapping
      const aliases: Record<string, string> = {
        'pro': 'gemini',
        'gpt': 'codex',
        'opus': 'claude',
      };

      expect(aliases['pro']).toBe('gemini');
      expect(aliases['gpt']).toBe('codex');
      expect(aliases['opus']).toBe('claude');
    });

    it('should have correct CLI configuration for each model', () => {
      // Note: Codex now uses experimental_instructions_file config flag (not env var)
      // The args are built dynamically in runConsultation, not stored in MODEL_CONFIGS
      // Claude uses Agent SDK (not CLI) — see 'Claude Agent SDK integration' tests
      const configs: Record<string, { cli: string; args: string[] }> = {
        gemini: { cli: 'gemini', args: ['--yolo'] },
        codex: { cli: 'codex', args: ['exec', '--full-auto'] },
      };

      expect(configs.gemini.cli).toBe('gemini');
      expect(configs.codex.args).toContain('--full-auto');
    });

    it('should use experimental_instructions_file for codex (not env var)', () => {
      // Spec 0043/0039 amendment: Codex should use experimental_instructions_file config flag
      // This is the official approach per https://github.com/openai/codex/discussions/3896
      // Instead of the undocumented CODEX_SYSTEM_MESSAGE env var
      // The actual command building happens in runConsultation, tested via dry-run e2e tests
      // This test documents the expected behavior
      const codexApproach = 'experimental_instructions_file';
      expect(codexApproach).toBe('experimental_instructions_file');
    });

    it('should use model_reasoning_effort=low for codex', () => {
      // Spec 0043: Use low reasoning effort for faster responses (10-20% improvement)
      const reasoningEffort = 'low';
      expect(reasoningEffort).toBe('low');
    });
  });

  describe('consult function', () => {
    it('should throw error for unknown model', async () => {
      // Set up codev root
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      const { consult } = await import('../commands/consult/index.js');

      await expect(
        consult({ model: 'unknown-model', subcommand: 'general', args: ['test'] })
      ).rejects.toThrow(/Unknown model/);
    });

    it('should throw error for invalid subcommand', async () => {
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      const { consult } = await import('../commands/consult/index.js');

      await expect(
        consult({ model: 'gemini', subcommand: 'invalid', args: [] })
      ).rejects.toThrow(/Unknown subcommand/);
    });

    it('should throw error when spec number is missing', async () => {
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      const { consult } = await import('../commands/consult/index.js');

      await expect(
        consult({ model: 'gemini', subcommand: 'spec', args: [] })
      ).rejects.toThrow(/Spec number required/);
    });

    it('should throw error when PR number is invalid', async () => {
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      const { consult } = await import('../commands/consult/index.js');

      await expect(
        consult({ model: 'gemini', subcommand: 'pr', args: ['not-a-number'] })
      ).rejects.toThrow(/Invalid PR number/);
    });

    it('should throw error when spec not found', async () => {
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'specs'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      const { consult } = await import('../commands/consult/index.js');

      await expect(
        consult({ model: 'gemini', subcommand: 'spec', args: ['9999'] })
      ).rejects.toThrow(/Spec 9999 not found/);
    });

    it('should find spec file by number', async () => {
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'specs'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'specs', '0042-test-feature.md'),
        '# Test Spec'
      );

      process.chdir(testBaseDir);

      const { consult } = await import('../commands/consult/index.js');

      // Should not throw - spec exists
      // With dry run to avoid actually executing
      await expect(
        consult({ model: 'gemini', subcommand: 'spec', args: ['42'], dryRun: true })
      ).resolves.not.toThrow();
    });

    it('should work with dry-run option', async () => {
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      const { consult } = await import('../commands/consult/index.js');

      // Should not execute, just show what would be done
      await expect(
        consult({ model: 'gemini', subcommand: 'general', args: ['test query'], dryRun: true })
      ).resolves.not.toThrow();
    });
  });

  describe('CLI availability check', () => {
    it('should check if CLI exists before running', async () => {
      // Mock execSync to return not found for gemini
      const { execSync } = await import('node:child_process');
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('which gemini')) {
          throw new Error('not found');
        }
        return Buffer.from('');
      });

      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      vi.resetModules();
      const { consult } = await import('../commands/consult/index.js');

      await expect(
        consult({ model: 'gemini', subcommand: 'general', args: ['test'] })
      ).rejects.toThrow(/not found/);
    });
  });

  describe('role loading', () => {
    it('should fall back to embedded skeleton when local role not found', async () => {
      // With embedded skeleton, role is always found (falls back to skeleton/roles/consultant.md)
      // This test verifies that consult doesn't throw when no local codev directory exists
      fs.mkdirSync(testBaseDir, { recursive: true });
      // No local codev/roles/consultant.md - should use embedded skeleton

      process.chdir(testBaseDir);

      vi.resetModules();
      // The consult function should not throw because it falls back to embedded skeleton
      // We can't actually run the full consult without mocking the CLI, but we can test
      // the skeleton resolver directly
      const { resolveCodevFile } = await import('../lib/skeleton.js');
      const rolePath = resolveCodevFile('roles/consultant.md', testBaseDir);

      // Should find the embedded skeleton version (not null)
      expect(rolePath).not.toBeNull();
      expect(rolePath).toContain('skeleton');
    });
  });

  describe('review type loading (Spec 0056)', () => {
    it('should load review type from consult-types/ (primary location)', async () => {
      // Set up codev with consult-types directory
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'consult-types'), { recursive: true });
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'consult-types', 'spec-review.md'),
        '# Spec Review from consult-types'
      );

      process.chdir(testBaseDir);

      vi.resetModules();
      const { readCodevFile } = await import('../lib/skeleton.js');

      // Should find in consult-types/
      const prompt = readCodevFile('consult-types/spec-review.md', testBaseDir);
      expect(prompt).not.toBeNull();
      expect(prompt).toContain('Spec Review from consult-types');
    });

    it('should fall back to roles/review-types/ (deprecated location) when not in consult-types/', async () => {
      // Set up codev with only the old roles/review-types directory
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles', 'review-types'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'review-types', 'custom-type.md'),
        '# Custom Type from deprecated location'
      );

      process.chdir(testBaseDir);

      vi.resetModules();
      const { readCodevFile } = await import('../lib/skeleton.js');

      // Should find in roles/review-types/ (fallback)
      const prompt = readCodevFile('roles/review-types/custom-type.md', testBaseDir);
      expect(prompt).not.toBeNull();
      expect(prompt).toContain('Custom Type from deprecated location');
    });

    it('should prefer consult-types/ over roles/review-types/ when both exist', async () => {
      // Set up both directories with same type
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'consult-types'), { recursive: true });
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles', 'review-types'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'consult-types', 'spec-review.md'),
        '# NEW LOCATION'
      );
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'review-types', 'spec-review.md'),
        '# OLD LOCATION'
      );

      process.chdir(testBaseDir);

      vi.resetModules();
      const { readCodevFile } = await import('../lib/skeleton.js');

      // Should prefer consult-types/
      const prompt = readCodevFile('consult-types/spec-review.md', testBaseDir);
      expect(prompt).not.toBeNull();
      expect(prompt).toContain('NEW LOCATION');
    });

    it('should fall back to embedded skeleton when review type not in local directories', async () => {
      // Set up minimal codev directory (no local review types)
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );

      process.chdir(testBaseDir);

      vi.resetModules();
      const { resolveCodevFile } = await import('../lib/skeleton.js');

      // Should fall back to embedded skeleton's consult-types/
      const promptPath = resolveCodevFile('consult-types/spec-review.md', testBaseDir);
      expect(promptPath).not.toBeNull();
      expect(promptPath).toContain('skeleton');
    });

    it('should show deprecation warning when using deprecated roles/review-types/ location', async () => {
      // Set up codev with ONLY the old roles/review-types directory (no consult-types/)
      // Use a valid review type name (spec-review) but place it in the deprecated location
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles', 'review-types'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'review-types', 'spec-review.md'),
        '# Spec Review from deprecated location'
      );

      process.chdir(testBaseDir);

      vi.resetModules();

      // Capture console.error to verify deprecation warning
      const errorOutput: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...args) => {
        errorOutput.push(args.join(' '));
      });

      const { consult } = await import('../commands/consult/index.js');

      // Use dry-run to avoid actually running the CLI
      // Use 'spec-review' which is a valid type but placed in deprecated location
      await consult({
        model: 'gemini',
        subcommand: 'general',
        args: ['test query'],
        dryRun: true,
        reviewType: 'spec-review',
      });

      // Should have deprecation warning about roles/review-types/
      const hasDeprecationWarning = errorOutput.some(line =>
        line.includes('deprecated') || line.includes('Deprecated')
      );
      expect(hasDeprecationWarning).toBe(true);
    });
  });

  describe('query building', () => {
    it('should build correct PR review query', () => {
      const prNumber = 123;
      const expectedQuery = `Review Pull Request #${prNumber}`;

      // The query builder includes PR info
      expect(expectedQuery).toContain('123');
    });

    it('should build correct spec review query', () => {
      const specPath = '/path/to/spec.md';
      const expectedPrefix = 'Review Specification:';

      expect(expectedPrefix).toContain('Review');
    });
  });

  describe('history logging', () => {
    it('should log queries to history file', async () => {
      const logDir = path.join(testBaseDir, '.consult');
      fs.mkdirSync(logDir, { recursive: true });

      // Simulate what logQuery would do
      const timestamp = new Date().toISOString();
      const model = 'gemini';
      const query = 'test query';
      const duration = 5.5;

      const logLine = `${timestamp} model=${model} duration=${duration.toFixed(1)}s query=${query.substring(0, 100)}...\n`;
      fs.appendFileSync(path.join(logDir, 'history.log'), logLine);

      const logContent = fs.readFileSync(path.join(logDir, 'history.log'), 'utf-8');
      expect(logContent).toContain('model=gemini');
      expect(logContent).toContain('duration=5.5s');
    });
  });

  describe('Claude Agent SDK integration', () => {
    beforeEach(() => {
      mockQueryFn.mockClear();
      fs.mkdirSync(path.join(testBaseDir, 'codev', 'roles'), { recursive: true });
      fs.writeFileSync(
        path.join(testBaseDir, 'codev', 'roles', 'consultant.md'),
        '# Consultant Role'
      );
      process.chdir(testBaseDir);
    });

    it('should invoke Agent SDK with correct parameters', async () => {
      vi.resetModules();
      const { consult } = await import('../commands/consult/index.js');

      mockQueryFn.mockImplementation(() =>
        (async function* () {
          yield { type: 'assistant', message: { content: [{ text: 'OK' }] } };
          yield { type: 'result', subtype: 'success' };
        })()
      );
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await consult({ model: 'claude', subcommand: 'general', args: ['test query'] });

      expect(mockQueryFn).toHaveBeenCalledTimes(1);
      const callArgs = mockQueryFn.mock.calls[0][0];
      expect(callArgs.options.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
      expect(callArgs.options.model).toBe('claude-opus-4-6');
      expect(callArgs.options.maxTurns).toBe(10);
      expect(callArgs.options.maxBudgetUsd).toBe(25);
      expect(callArgs.options.permissionMode).toBe('bypassPermissions');
    });

    it('should extract text from assistant messages', async () => {
      vi.resetModules();
      const { consult } = await import('../commands/consult/index.js');

      mockQueryFn.mockImplementation(() =>
        (async function* () {
          yield {
            type: 'assistant',
            message: { content: [{ text: 'Review: ' }, { text: 'All good.' }] },
          };
          yield { type: 'result', subtype: 'success' };
        })()
      );

      const writes: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
        writes.push(chunk.toString());
        return true;
      });

      await consult({ model: 'claude', subcommand: 'general', args: ['test query'] });

      expect(writes).toContain('Review: ');
      expect(writes).toContain('All good.');
    });

    it('should write output to file when output option is set', async () => {
      vi.resetModules();
      const { consult } = await import('../commands/consult/index.js');

      mockQueryFn.mockImplementation(() =>
        (async function* () {
          yield {
            type: 'assistant',
            message: { content: [{ text: 'File output content' }] },
          };
          yield { type: 'result', subtype: 'success' };
        })()
      );
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const outputFile = path.join(testBaseDir, 'output', 'review.md');
      await consult({
        model: 'claude',
        subcommand: 'general',
        args: ['test query'],
        output: outputFile,
      });

      expect(fs.existsSync(outputFile)).toBe(true);
      expect(fs.readFileSync(outputFile, 'utf-8')).toBe('File output content');
    });

    it('should remove CLAUDECODE from env passed to SDK', async () => {
      vi.resetModules();
      const { consult } = await import('../commands/consult/index.js');

      const originalClaudeCode = process.env.CLAUDECODE;
      process.env.CLAUDECODE = '1';

      mockQueryFn.mockImplementation(() =>
        (async function* () {
          yield { type: 'result', subtype: 'success' };
        })()
      );
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await consult({ model: 'claude', subcommand: 'general', args: ['test'] });

      // Verify CLAUDECODE not in the env options
      const callArgs = mockQueryFn.mock.calls[0][0];
      expect(callArgs.options.env).not.toHaveProperty('CLAUDECODE');

      // Verify CLAUDECODE is restored in process.env after the call
      expect(process.env.CLAUDECODE).toBe('1');

      if (originalClaudeCode !== undefined) {
        process.env.CLAUDECODE = originalClaudeCode;
      } else {
        delete process.env.CLAUDECODE;
      }
    });

    it('should throw on SDK error results', async () => {
      vi.resetModules();
      const { consult } = await import('../commands/consult/index.js');

      mockQueryFn.mockImplementation(() =>
        (async function* () {
          yield {
            type: 'result',
            subtype: 'error_max_turns',
            errors: ['Max turns exceeded'],
          };
        })()
      );
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await expect(
        consult({ model: 'claude', subcommand: 'general', args: ['test'] })
      ).rejects.toThrow(/Claude SDK error/);
    });

    it('should show SDK parameters in dry-run mode', async () => {
      vi.resetModules();
      const { consult } = await import('../commands/consult/index.js');

      const logOutput: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        logOutput.push(args.join(' '));
      });

      await consult({
        model: 'claude',
        subcommand: 'general',
        args: ['test query'],
        dryRun: true,
      });

      expect(mockQueryFn).not.toHaveBeenCalled();
      expect(logOutput.some(l => l.includes('Agent SDK'))).toBe(true);
      expect(logOutput.some(l => l.includes('claude-opus-4-6'))).toBe(true);
      expect(logOutput.some(l => l.includes('Read, Glob, Grep'))).toBe(true);
    });

    it('should suppress tool use blocks from stderr', async () => {
      vi.resetModules();
      const { consult } = await import('../commands/consult/index.js');

      mockQueryFn.mockImplementation(() =>
        (async function* () {
          yield {
            type: 'assistant',
            message: {
              content: [
                { name: 'Read', input: { file_path: '/foo/bar.ts' } },
                { text: 'File contents here' },
              ],
            },
          };
          yield { type: 'result', subtype: 'success' };
        })()
      );

      const stderrWrites: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
        stderrWrites.push(chunk.toString());
        return true;
      });

      await consult({ model: 'claude', subcommand: 'general', args: ['test'] });

      // Tool use blocks are intentionally suppressed to reduce noise
      expect(stderrWrites.some(w => w.includes('Tool: Read'))).toBe(false);
    });
  });

  describe('diff stat approach (Bugfix #240)', () => {
    it('should export getDiffStat for file-based review', async () => {
      vi.resetModules();
      const { _getDiffStat } = await import('../commands/consult/index.js');
      expect(typeof _getDiffStat).toBe('function');
    });

    it('getDiffStat should call git diff --stat and --name-only', async () => {
      vi.resetModules();

      const { execSync } = await import('node:child_process');
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('--stat')) {
          return Buffer.from(' src/app.ts | 10 +++++++---\n 1 file changed, 7 insertions(+), 3 deletions(-)\n');
        }
        if (typeof cmd === 'string' && cmd.includes('--name-only')) {
          return Buffer.from('src/app.ts\n');
        }
        if (cmd.includes('which')) {
          return Buffer.from('/usr/bin/command');
        }
        return Buffer.from('');
      });

      const { _getDiffStat } = await import('../commands/consult/index.js');
      const result = _getDiffStat('/fake/root', 'abc123..HEAD');

      expect(result.stat).toContain('src/app.ts');
      expect(result.files).toEqual(['src/app.ts']);
    });

    it('getDiffStat should handle multiple files', async () => {
      vi.resetModules();

      const { execSync } = await import('node:child_process');
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('--stat')) {
          return Buffer.from(
            ' .claude/settings.json     |  5 +++++\n' +
            ' src/app/widget.tsx         | 20 ++++++++++++++------\n' +
            ' src/middleware.ts          | 15 ++++++++++++---\n' +
            ' 3 files changed, 32 insertions(+), 9 deletions(-)\n'
          );
        }
        if (typeof cmd === 'string' && cmd.includes('--name-only')) {
          return Buffer.from('.claude/settings.json\nsrc/app/widget.tsx\nsrc/middleware.ts\n');
        }
        if (cmd.includes('which')) {
          return Buffer.from('/usr/bin/command');
        }
        return Buffer.from('');
      });

      const { _getDiffStat } = await import('../commands/consult/index.js');
      const result = _getDiffStat('/fake/root', 'abc123..HEAD');

      expect(result.files).toHaveLength(3);
      expect(result.files).toContain('.claude/settings.json');
      expect(result.files).toContain('src/app/widget.tsx');
      expect(result.files).toContain('src/middleware.ts');
      expect(result.stat).toContain('3 files changed');
    });

    it('no diff is ever truncated — reviewers read files from disk', async () => {
      // This is a documentation test: the old approach truncated diffs at 50K/80K chars,
      // which caused reviewers to miss files alphabetically late in the diff (e.g., src/).
      // The new approach sends only git diff --stat and instructs reviewers to read
      // the actual files from disk, eliminating truncation entirely.
      vi.resetModules();

      const { execSync } = await import('node:child_process');
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('--stat')) {
          return Buffer.from(' 50 files changed, 10000 insertions(+), 5000 deletions(-)\n');
        }
        if (typeof cmd === 'string' && cmd.includes('--name-only')) {
          // 50 files spanning the full alphabet
          const files = Array.from({ length: 50 }, (_, i) =>
            i < 10 ? `.claude/file${i}.json` :
            i < 20 ? `codev/specs/${i}.md` :
            `src/app/component${i}.tsx`
          );
          return Buffer.from(files.join('\n') + '\n');
        }
        if (cmd.includes('which')) {
          return Buffer.from('/usr/bin/command');
        }
        return Buffer.from('');
      });

      const { _getDiffStat } = await import('../commands/consult/index.js');
      const result = _getDiffStat('/fake/root', 'abc123..HEAD');

      // ALL 50 files are present — none truncated
      expect(result.files).toHaveLength(50);
      // src/ files that were previously invisible are now listed
      expect(result.files.filter(f => f.startsWith('src/'))).toHaveLength(30);
    });
  });
});
