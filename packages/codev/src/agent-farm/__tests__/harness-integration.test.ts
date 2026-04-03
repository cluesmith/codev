/**
 * Integration tests for the agent harness system.
 *
 * Tests that all call sites (buildWorktreeLaunchScript, buildArchitectArgs)
 * produce correct output for each harness type: claude, codex, gemini, custom.
 *
 * @see codev/specs/591-af-workspace-failure-with-code.md (Test Scenarios 1–8)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CLAUDE_HARNESS,
  CODEX_HARNESS,
  GEMINI_HARNESS,
  resolveHarness,
  buildCustomHarnessProvider,
  shellEscapeSingleQuote,
  type CustomHarnessConfig,
} from '../utils/harness.js';

// Mock fs for buildWorktreeLaunchScript (it calls writeFileSync)
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
    symlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
  fatal: vi.fn((msg: string) => { throw new Error(msg); }),
}));

vi.mock('../utils/shell.js', () => ({
  run: vi.fn(async () => ({ stdout: '', stderr: '' })),
  commandExists: vi.fn(async () => true),
}));

vi.mock('../../lib/forge.js', () => ({
  executeForgeCommand: vi.fn().mockResolvedValue(null),
}));

// Mock harness resolution — default to Claude, tests can override via mockReturnValue
const mockGetBuilderHarness = vi.fn().mockReturnValue(CLAUDE_HARNESS);
const mockGetArchitectHarness = vi.fn().mockReturnValue(CLAUDE_HARNESS);
vi.mock('../utils/config.js', () => ({
  getBuilderHarness: (...args: unknown[]) => mockGetBuilderHarness(...args),
  getArchitectHarness: (...args: unknown[]) => mockGetArchitectHarness(...args),
}));

// Mock roles for buildArchitectArgs
const mockLoadRolePrompt = vi.fn();
vi.mock('../utils/roles.js', () => ({
  loadRolePrompt: (...args: unknown[]) => mockLoadRolePrompt(...args),
}));

const ROLE_CONTENT = '# Builder Role\n\nYou are a builder.';
const ROLE_FILE = '/tmp/workspace/.builder-role.md';
const WORKSPACE = '/tmp/workspace';

describe('harness integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Spec Test Scenario 1: Claude harness (regression)
  // ===========================================================================

  describe('claude harness', () => {
    it('buildRoleInjection returns --append-system-prompt with content', () => {
      const { args, env } = CLAUDE_HARNESS.buildRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(args).toEqual(['--append-system-prompt', ROLE_CONTENT]);
      expect(env).toEqual({});
    });

    it('buildScriptRoleInjection returns shell expansion with --append-system-prompt', () => {
      const { fragment, env } = CLAUDE_HARNESS.buildScriptRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(fragment).toContain('--append-system-prompt');
      expect(fragment).toContain("$(cat '");
      expect(fragment).toContain(ROLE_FILE);
      expect(env).toEqual({});
    });
  });

  // ===========================================================================
  // Spec Test Scenario 2: Codex harness
  // ===========================================================================

  describe('codex harness', () => {
    it('buildRoleInjection returns -c model_instructions_file=<path>', () => {
      const { args, env } = CODEX_HARNESS.buildRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(args).toEqual(['-c', `model_instructions_file=${ROLE_FILE}`]);
      expect(env).toEqual({});
    });

    it('buildScriptRoleInjection returns -c model_instructions_file=<path>', () => {
      const { fragment, env } = CODEX_HARNESS.buildScriptRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(fragment).toContain('model_instructions_file=');
      expect(fragment).toContain(ROLE_FILE);
      expect(env).toEqual({});
    });
  });

  // ===========================================================================
  // Spec Test Scenario 3: Gemini harness
  // ===========================================================================

  describe('gemini harness', () => {
    it('buildRoleInjection returns GEMINI_SYSTEM_MD env var', () => {
      const { args, env } = GEMINI_HARNESS.buildRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(args).toEqual([]);
      expect(env).toEqual({ GEMINI_SYSTEM_MD: ROLE_FILE });
    });

    it('buildScriptRoleInjection returns env with empty fragment', () => {
      const { fragment, env } = GEMINI_HARNESS.buildScriptRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(fragment).toBe('');
      expect(env).toEqual({ GEMINI_SYSTEM_MD: ROLE_FILE });
    });
  });

  // ===========================================================================
  // Spec Test Scenario 4: Unknown harness name
  // ===========================================================================

  describe('unknown harness', () => {
    it('throws descriptive error for unknown harness name', () => {
      expect(() => resolveHarness('nonexistent')).toThrow('Unknown harness "nonexistent"');
    });

    it('error message lists available harnesses', () => {
      try {
        resolveHarness('bad');
      } catch (e: unknown) {
        const msg = (e as Error).message;
        expect(msg).toContain('claude');
        expect(msg).toContain('codex');
        expect(msg).toContain('gemini');
      }
    });
  });

  // ===========================================================================
  // Spec Test Scenario 5: Custom harness with template expansion
  // ===========================================================================

  describe('custom harness', () => {
    const customConfig: CustomHarnessConfig = {
      roleArgs: ['--system', '${ROLE_FILE}'],
      roleEnv: { MY_INSTRUCTIONS: '${ROLE_FILE}' },
      roleScriptFragment: "--system '${ROLE_FILE}'",
      roleScriptEnv: { MY_INSTRUCTIONS: '${ROLE_FILE}' },
    };

    it('correctly expands ${ROLE_FILE} in all fields', () => {
      const provider = buildCustomHarnessProvider(customConfig);

      const spawn = provider.buildRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(spawn.args).toEqual(['--system', ROLE_FILE]);
      expect(spawn.env).toEqual({ MY_INSTRUCTIONS: ROLE_FILE });

      const script = provider.buildScriptRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(script.fragment).toBe(`--system '${ROLE_FILE}'`);
      expect(script.env).toEqual({ MY_INSTRUCTIONS: ROLE_FILE });
    });

    it('resolves via resolveHarness with custom harness map', () => {
      const customHarnesses: Record<string, CustomHarnessConfig> = {
        'my-agent': customConfig,
      };
      const provider = resolveHarness('my-agent', customHarnesses);
      const { args } = provider.buildRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(args).toEqual(['--system', ROLE_FILE]);
    });
  });

  // ===========================================================================
  // Spec Test Scenario 6: Default behavior (no harness set → claude)
  // ===========================================================================

  describe('default behavior', () => {
    it('resolves to claude when harnessName is undefined', () => {
      const provider = resolveHarness(undefined);
      expect(provider).toBe(CLAUDE_HARNESS);
    });
  });

  // ===========================================================================
  // Spec Test Scenario 7: No role provided — call-site integration
  // ===========================================================================

  describe('no role provided', () => {
    it('buildWorktreeLaunchScript produces script without role injection when role is null', async () => {
      const { buildWorktreeLaunchScript } = await import('../commands/spawn-worktree.js');
      const script = buildWorktreeLaunchScript('/tmp/worktree', 'codex', null);
      expect(script).toContain('codex');
      expect(script).not.toContain('--append-system-prompt');
      expect(script).not.toContain('model_instructions_file');
      expect(script).not.toContain('GEMINI_SYSTEM_MD');
    });

    it('buildArchitectArgs returns base args only when no role is loaded', async () => {
      mockLoadRolePrompt.mockReturnValue(null);
      const { buildArchitectArgs } = await import('../servers/tower-utils.js');
      const result = buildArchitectArgs(['--resume'], '/tmp/workspace');
      expect(result).toEqual({ args: ['--resume'], env: {} });
    });
  });

  // ===========================================================================
  // Spec Test Scenario 8: Call-site integration — real functions
  // ===========================================================================

  describe('call-site integration: buildWorktreeLaunchScript', () => {
    it('claude harness: script contains --append-system-prompt', async () => {
      mockGetBuilderHarness.mockReturnValue(CLAUDE_HARNESS);
      const { buildWorktreeLaunchScript } = await import('../commands/spawn-worktree.js');
      const role = { content: 'You are a builder at {PORT}', source: 'test' };
      const script = buildWorktreeLaunchScript('/tmp/worktree', 'claude', role, '/tmp/workspace');
      expect(script).toContain('--append-system-prompt');
      expect(script).toContain('.builder-role.md');
      expect(script).toContain('Agent exited');
      expect(script).not.toContain('Claude exited');
    });

    it('codex harness: script contains model_instructions_file', async () => {
      mockGetBuilderHarness.mockReturnValue(CODEX_HARNESS);
      const { buildWorktreeLaunchScript } = await import('../commands/spawn-worktree.js');
      const role = { content: 'You are a builder', source: 'test' };
      const script = buildWorktreeLaunchScript('/tmp/worktree', 'codex', role, '/tmp/workspace');
      expect(script).toContain('model_instructions_file=');
      expect(script).not.toContain('--append-system-prompt');
    });

    it('gemini harness: script contains GEMINI_SYSTEM_MD export', async () => {
      mockGetBuilderHarness.mockReturnValue(GEMINI_HARNESS);
      const { buildWorktreeLaunchScript } = await import('../commands/spawn-worktree.js');
      const role = { content: 'You are a builder', source: 'test' };
      const script = buildWorktreeLaunchScript('/tmp/worktree', 'gemini', role, '/tmp/workspace');
      expect(script).toContain("export GEMINI_SYSTEM_MD='");
      expect(script).not.toContain('--append-system-prompt');
    });
  });

  // ===========================================================================
  // Shell quoting safety
  // ===========================================================================

  describe('shell quoting', () => {
    it('escapes single quotes in file paths for claude script', () => {
      const pathWithQuote = "/Users/O'Neil/workspace/.builder-role.md";
      const { fragment } = CLAUDE_HARNESS.buildScriptRoleInjection(ROLE_CONTENT, pathWithQuote);
      // Should not have unescaped single quotes inside the $(cat '...')
      expect(fragment).toContain("O'\\''Neil");
    });

    it('escapes single quotes in file paths for codex script', () => {
      const pathWithQuote = "/Users/O'Neil/workspace/.builder-role.md";
      const { fragment } = CODEX_HARNESS.buildScriptRoleInjection(ROLE_CONTENT, pathWithQuote);
      expect(fragment).toContain("O'\\''Neil");
    });

    it('shellEscapeSingleQuote handles multiple quotes', () => {
      expect(shellEscapeSingleQuote("it's a 'test'")).toBe("it'\\''s a '\\''test'\\''");
    });
  });
});
