import { describe, it, expect } from 'vitest';
import {
  CLAUDE_HARNESS,
  CODEX_HARNESS,
  GEMINI_HARNESS,
  OPENCODE_HARNESS,
  buildCustomHarnessProvider,
  validateCustomHarnessConfig,
  resolveHarness,
  detectHarnessFromCommand,
  type CustomHarnessConfig,
} from '../utils/harness.js';

describe('harness', () => {
  const ROLE_CONTENT = '# Role\n\nYou are an architect.';
  const ROLE_FILE = '/tmp/workspace/.builder-role.md';

  // ===========================================================================
  // Built-in providers: buildRoleInjection
  // ===========================================================================

  describe('CLAUDE_HARNESS', () => {
    it('buildRoleInjection returns --append-system-prompt with content', () => {
      const result = CLAUDE_HARNESS.buildRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(result.args).toEqual(['--append-system-prompt', ROLE_CONTENT]);
      expect(result.env).toEqual({});
    });

    it('buildScriptRoleInjection returns shell expansion fragment', () => {
      const result = CLAUDE_HARNESS.buildScriptRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(result.fragment).toContain('--append-system-prompt');
      expect(result.fragment).toContain("$(cat '");
      expect(result.fragment).toContain(ROLE_FILE);
      expect(result.env).toEqual({});
    });
  });

  describe('CODEX_HARNESS', () => {
    it('buildRoleInjection returns -c model_instructions_file=<path>', () => {
      const result = CODEX_HARNESS.buildRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(result.args).toEqual(['-c', `model_instructions_file=${ROLE_FILE}`]);
      expect(result.env).toEqual({});
    });

    it('buildScriptRoleInjection returns -c model_instructions_file=<path>', () => {
      const result = CODEX_HARNESS.buildScriptRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(result.fragment).toBe(`-c model_instructions_file='${ROLE_FILE}'`);
      expect(result.env).toEqual({});
    });
  });

  describe('GEMINI_HARNESS', () => {
    it('buildRoleInjection returns GEMINI_SYSTEM_MD env var', () => {
      const result = GEMINI_HARNESS.buildRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(result.args).toEqual([]);
      expect(result.env).toEqual({ GEMINI_SYSTEM_MD: ROLE_FILE });
    });

    it('buildScriptRoleInjection returns env with empty fragment', () => {
      const result = GEMINI_HARNESS.buildScriptRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(result.fragment).toBe('');
      expect(result.env).toEqual({ GEMINI_SYSTEM_MD: ROLE_FILE });
    });
  });

  describe('OPENCODE_HARNESS', () => {
    it('buildRoleInjection throws (architect use unsupported)', () => {
      expect(() => OPENCODE_HARNESS.buildRoleInjection(ROLE_CONTENT, ROLE_FILE))
        .toThrow('OpenCode is only supported as a builder shell');
    });

    it('buildScriptRoleInjection returns empty fragment and env', () => {
      const result = OPENCODE_HARNESS.buildScriptRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(result.fragment).toBe('');
      expect(result.env).toEqual({});
    });

    it('getWorktreeFiles returns opencode.json with instructions', () => {
      const files = OPENCODE_HARNESS.getWorktreeFiles!(ROLE_CONTENT, ROLE_FILE);
      expect(files).toHaveLength(1);
      expect(files[0].relativePath).toBe('opencode.json');
      const parsed = JSON.parse(files[0].content);
      expect(parsed).toEqual({ instructions: ['.builder-role.md'] });
    });
  });

  describe('getWorktreeFiles backward compatibility', () => {
    it('CLAUDE_HARNESS does not have getWorktreeFiles', () => {
      expect(CLAUDE_HARNESS.getWorktreeFiles).toBeUndefined();
    });

    it('CODEX_HARNESS does not have getWorktreeFiles', () => {
      expect(CODEX_HARNESS.getWorktreeFiles).toBeUndefined();
    });

    it('GEMINI_HARNESS does not have getWorktreeFiles', () => {
      expect(GEMINI_HARNESS.getWorktreeFiles).toBeUndefined();
    });
  });

  // ===========================================================================
  // Custom harness provider
  // ===========================================================================

  describe('buildCustomHarnessProvider', () => {
    it('expands ${ROLE_FILE} in roleArgs', () => {
      const config: CustomHarnessConfig = {
        roleArgs: ['--system', '${ROLE_FILE}'],
        roleScriptFragment: "--system '${ROLE_FILE}'",
      };
      const provider = buildCustomHarnessProvider(config);
      const result = provider.buildRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(result.args).toEqual(['--system', ROLE_FILE]);
    });

    it('expands ${ROLE_CONTENT} in roleArgs', () => {
      const config: CustomHarnessConfig = {
        roleArgs: ['--system-prompt', '${ROLE_CONTENT}'],
        roleScriptFragment: '',
      };
      const provider = buildCustomHarnessProvider(config);
      const result = provider.buildRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(result.args).toEqual(['--system-prompt', ROLE_CONTENT]);
    });

    it('expands template vars in roleEnv', () => {
      const config: CustomHarnessConfig = {
        roleArgs: [],
        roleEnv: { MY_ROLE: '${ROLE_FILE}' },
        roleScriptFragment: '',
      };
      const provider = buildCustomHarnessProvider(config);
      const result = provider.buildRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(result.env).toEqual({ MY_ROLE: ROLE_FILE });
    });

    it('expands template vars in roleScriptFragment', () => {
      const config: CustomHarnessConfig = {
        roleArgs: [],
        roleScriptFragment: "--system '${ROLE_FILE}'",
      };
      const provider = buildCustomHarnessProvider(config);
      const result = provider.buildScriptRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(result.fragment).toBe(`--system '${ROLE_FILE}'`);
    });

    it('expands template vars in roleScriptEnv', () => {
      const config: CustomHarnessConfig = {
        roleArgs: [],
        roleScriptFragment: '',
        roleScriptEnv: { AGENT_ROLE: '${ROLE_FILE}' },
      };
      const provider = buildCustomHarnessProvider(config);
      const result = provider.buildScriptRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(result.env).toEqual({ AGENT_ROLE: ROLE_FILE });
    });

    it('leaves unknown template vars unexpanded', () => {
      const config: CustomHarnessConfig = {
        roleArgs: ['${UNKNOWN_VAR}'],
        roleScriptFragment: '${UNKNOWN_VAR}',
      };
      const provider = buildCustomHarnessProvider(config);
      const result = provider.buildRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(result.args).toEqual(['${UNKNOWN_VAR}']);
    });
  });

  // ===========================================================================
  // Validation
  // ===========================================================================

  describe('validateCustomHarnessConfig', () => {
    it('accepts valid config', () => {
      const result = validateCustomHarnessConfig('test', {
        roleArgs: ['--system', '${ROLE_FILE}'],
        roleScriptFragment: "--system '${ROLE_FILE}'",
      });
      expect(result.roleArgs).toEqual(['--system', '${ROLE_FILE}']);
    });

    it('rejects non-object', () => {
      expect(() => validateCustomHarnessConfig('test', 'string')).toThrow('expected an object');
    });

    it('rejects missing roleArgs', () => {
      expect(() => validateCustomHarnessConfig('test', {
        roleScriptFragment: '',
      })).toThrow('missing required field "roleArgs"');
    });

    it('rejects non-string-array roleArgs', () => {
      expect(() => validateCustomHarnessConfig('test', {
        roleArgs: [1, 2],
        roleScriptFragment: '',
      })).toThrow('"roleArgs" must contain only strings');
    });

    it('rejects missing roleScriptFragment', () => {
      expect(() => validateCustomHarnessConfig('test', {
        roleArgs: [],
      })).toThrow('missing required field "roleScriptFragment"');
    });

    it('rejects non-object roleEnv', () => {
      expect(() => validateCustomHarnessConfig('test', {
        roleArgs: [],
        roleScriptFragment: '',
        roleEnv: 'not-an-object',
      })).toThrow('"roleEnv" must be an object');
    });

    it('rejects non-string roleEnv values', () => {
      expect(() => validateCustomHarnessConfig('test', {
        roleArgs: [],
        roleScriptFragment: '',
        roleEnv: { GOOD: 'ok', BAD: 123 },
      })).toThrow('"roleEnv.BAD" must be a string');
    });

    it('rejects non-string roleScriptEnv values', () => {
      expect(() => validateCustomHarnessConfig('test', {
        roleArgs: [],
        roleScriptFragment: '',
        roleScriptEnv: { KEY: true },
      })).toThrow('"roleScriptEnv.KEY" must be a string');
    });
  });

  // ===========================================================================
  // Resolution
  // ===========================================================================

  describe('resolveHarness', () => {
    it('defaults to claude when harnessName is undefined', () => {
      const provider = resolveHarness(undefined);
      expect(provider).toBe(CLAUDE_HARNESS);
    });

    it('resolves built-in claude', () => {
      const provider = resolveHarness('claude');
      expect(provider).toBe(CLAUDE_HARNESS);
    });

    it('resolves built-in codex', () => {
      const provider = resolveHarness('codex');
      expect(provider).toBe(CODEX_HARNESS);
    });

    it('resolves built-in gemini', () => {
      const provider = resolveHarness('gemini');
      expect(provider).toBe(GEMINI_HARNESS);
    });

    it('resolves built-in opencode', () => {
      const provider = resolveHarness('opencode');
      expect(provider).toBe(OPENCODE_HARNESS);
    });

    it('resolves custom harness from config', () => {
      const customHarnesses: Record<string, CustomHarnessConfig> = {
        'my-agent': {
          roleArgs: ['--system', '${ROLE_FILE}'],
          roleScriptFragment: "--system '${ROLE_FILE}'",
        },
      };
      const provider = resolveHarness('my-agent', customHarnesses);
      const result = provider.buildRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(result.args).toEqual(['--system', ROLE_FILE]);
    });

    it('throws for unknown harness name', () => {
      expect(() => resolveHarness('nonexistent')).toThrow('Unknown harness "nonexistent"');
    });

    it('error message lists available harnesses', () => {
      const customHarnesses: Record<string, CustomHarnessConfig> = {
        'my-agent': {
          roleArgs: [],
          roleScriptFragment: '',
        },
      };
      expect(() => resolveHarness('bad', customHarnesses)).toThrow('my-agent');
    });

    it('auto-detects codex from command string', () => {
      const provider = resolveHarness(undefined, undefined, 'codex');
      expect(provider).toBe(CODEX_HARNESS);
    });

    it('auto-detects gemini from full path', () => {
      const provider = resolveHarness(undefined, undefined, '/opt/homebrew/bin/gemini');
      expect(provider).toBe(GEMINI_HARNESS);
    });

    it('auto-detects claude from command with flags', () => {
      const provider = resolveHarness(undefined, undefined, 'claude --dangerously-skip-permissions');
      expect(provider).toBe(CLAUDE_HARNESS);
    });

    it('auto-detects opencode from command', () => {
      const provider = resolveHarness(undefined, undefined, 'opencode run');
      expect(provider).toBe(OPENCODE_HARNESS);
    });

    it('explicit harnessName takes priority over auto-detection', () => {
      const provider = resolveHarness('gemini', undefined, 'codex');
      expect(provider).toBe(GEMINI_HARNESS);
    });

    it('falls back to claude for unknown command', () => {
      const provider = resolveHarness(undefined, undefined, 'my-custom-agent');
      expect(provider).toBe(CLAUDE_HARNESS);
    });
  });

  // ===========================================================================
  // Auto-detection
  // ===========================================================================

  describe('detectHarnessFromCommand', () => {
    it('detects claude', () => {
      expect(detectHarnessFromCommand('claude')).toBe('claude');
    });

    it('detects codex', () => {
      expect(detectHarnessFromCommand('codex')).toBe('codex');
    });

    it('detects gemini', () => {
      expect(detectHarnessFromCommand('gemini')).toBe('gemini');
    });

    it('detects opencode', () => {
      expect(detectHarnessFromCommand('opencode')).toBe('opencode');
    });

    it('detects opencode with run subcommand', () => {
      expect(detectHarnessFromCommand('opencode run')).toBe('opencode');
    });

    it('detects opencode from full path', () => {
      expect(detectHarnessFromCommand('/usr/local/bin/opencode')).toBe('opencode');
    });

    it('detects opencode with model flags', () => {
      expect(detectHarnessFromCommand('opencode run --model anthropic/claude-sonnet')).toBe('opencode');
    });

    it('detects from full path', () => {
      expect(detectHarnessFromCommand('/opt/homebrew/bin/codex')).toBe('codex');
    });

    it('detects from command with flags', () => {
      expect(detectHarnessFromCommand('codex exec --full-auto')).toBe('codex');
    });

    it('returns undefined for unknown command', () => {
      expect(detectHarnessFromCommand('my-custom-agent')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(detectHarnessFromCommand('')).toBeUndefined();
    });
  });
});
