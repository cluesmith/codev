import { describe, it, expect } from 'vitest';
import {
  CLAUDE_HARNESS,
  CODEX_HARNESS,
  GEMINI_HARNESS,
  buildCustomHarnessProvider,
  validateCustomHarnessConfig,
  resolveHarness,
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
  });
});
