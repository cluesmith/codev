import { describe, it, expect } from 'vitest';
import {
  CLAUDE_HARNESS,
  CODEX_HARNESS,
  OPENCODE_HARNESS,
  buildCustomHarnessProvider,
  validateCustomHarnessConfig,
  resolveHarness,
  detectHarnessFromCommand,
  isRetiredHarness,
  getRetirement,
  type CustomHarnessConfig,
} from '../utils/harness.js';

// Capture whether resolveHarness returned a provider or threw — lets a test
// assert a retired path returns NEITHER a provider NOR undefined (it throws).
function resolveResult(fn: () => unknown): { returned?: unknown; threw?: Error } {
  try {
    return { returned: fn() };
  } catch (e) {
    return { threw: e as Error };
  }
}

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

    // Issue #832: session capability (Claude pins/resumes a conversation by id).
    it('session.newSessionArgs returns --session-id <id>', () => {
      expect(CLAUDE_HARNESS.session?.newSessionArgs('abc')).toEqual(['--session-id', 'abc']);
    });

    it('session.resumeArgs returns --resume <id>', () => {
      expect(CLAUDE_HARNESS.session?.resumeArgs('abc')).toEqual(['--resume', 'abc']);
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

    // Issue #832: Codex has no resumable-session capability → no `session` block,
    // so architects on Codex spawn fresh and nothing is persisted.
    it('has no session capability', () => {
      expect(CODEX_HARNESS.session).toBeUndefined();
      expect(OPENCODE_HARNESS.session).toBeUndefined();
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
      const files = OPENCODE_HARNESS.getWorktreeFiles!(ROLE_CONTENT, ROLE_FILE, '/abs/wt');
      expect(files).toHaveLength(1);
      expect(files[0].relativePath).toBe('opencode.json');
      const parsed = JSON.parse(files[0].content);
      expect(parsed).toEqual({ instructions: ['.builder-role.md'] });
    });
  });

  describe('getWorktreeFiles', () => {
    it('CLAUDE_HARNESS installs the worktree write-guard (Issue #1018)', () => {
      const files = CLAUDE_HARNESS.getWorktreeFiles!(ROLE_CONTENT, ROLE_FILE, '/abs/wt');
      const relPaths = files.map((f) => f.relativePath).sort();
      expect(relPaths).toEqual(
        ['.claude/hooks/worktree-write-guard.cjs', '.claude/settings.local.json'].sort(),
      );
      const settings = files.find((f) => f.relativePath === '.claude/settings.local.json');
      const parsed = JSON.parse(settings!.content);
      expect(parsed.hooks.PreToolUse[0].matcher).toContain('Write');
    });

    it('CODEX_HARNESS does not have getWorktreeFiles', () => {
      expect(CODEX_HARNESS.getWorktreeFiles).toBeUndefined();
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

    it('explicit gemini fails closed with the retirement (never claude, never undefined)', () => {
      // Fail closed: a retired name resolves to NEITHER CLAUDE_HARNESS (the #929
      // silent-mismatch class) NOR undefined. Throwing is that guarantee.
      const r = resolveResult(() => resolveHarness('gemini'));
      expect(r.returned).toBeUndefined();
      expect(r.returned).not.toBe(CLAUDE_HARNESS);
      expect(r.threw?.message).toMatch(/retired/i);
      expect(r.threw?.message).toContain('2026-06-18');
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

    it('unrelated unknown name throws the generic error, not the retirement', () => {
      expect(() => resolveHarness('frobnicate')).toThrow('Unknown harness "frobnicate"');
      expect(() => resolveHarness('frobnicate')).not.toThrow(/retired/i);
    });

    it('the available-harnesses listing no longer includes gemini', () => {
      expect(() => resolveHarness('frobnicate')).toThrow(/claude/);
      expect(() => resolveHarness('frobnicate')).toThrow(/codex/);
      expect(() => resolveHarness('frobnicate')).toThrow(/opencode/);
      expect(() => resolveHarness('frobnicate')).not.toThrow(/gemini/);
    });

    it('explicit custom gemini resolves to the custom provider (retained-access escape hatch)', () => {
      // Mirrors the documented escape hatch (README) and the retired built-in GEMINI_HARNESS:
      // the Gemini CLI reads its system prompt from the GEMINI_SYSTEM_MD env var (empty args /
      // fragment), not a --system flag. Keeping the asserted shape identical to the documented one
      // prevents the docs from drifting back to a launch line the CLI would reject.
      const customHarnesses: Record<string, CustomHarnessConfig> = {
        gemini: {
          roleArgs: [],
          roleEnv: { GEMINI_SYSTEM_MD: '${ROLE_FILE}' },
          roleScriptFragment: '',
          roleScriptEnv: { GEMINI_SYSTEM_MD: '${ROLE_FILE}' },
        },
      };
      const provider = resolveHarness('gemini', customHarnesses);
      const spawn = provider.buildRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(spawn.args).toEqual([]);
      expect(spawn.env).toEqual({ GEMINI_SYSTEM_MD: ROLE_FILE });
      const script = provider.buildScriptRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(script.fragment).toBe('');
      expect(script.env).toEqual({ GEMINI_SYSTEM_MD: ROLE_FILE });
    });

    it('auto-detected gemini is retired even when a custom gemini exists', () => {
      // Auto-detection never consults custom harnesses, so a `gemini …` command
      // is retired regardless of a same-named custom definition.
      const customHarnesses: Record<string, CustomHarnessConfig> = {
        gemini: { roleArgs: [], roleScriptFragment: '' },
      };
      expect(() => resolveHarness(undefined, customHarnesses, 'gemini --yolo')).toThrow(/retired/i);
    });

    it('built-in harnesses are never shadowed by same-named custom harnesses', () => {
      const customHarnesses: Record<string, CustomHarnessConfig> = {
        claude: { roleArgs: ['x'], roleScriptFragment: 'x' },
        codex: { roleArgs: ['x'], roleScriptFragment: 'x' },
        opencode: { roleArgs: ['x'], roleScriptFragment: 'x' },
      };
      expect(resolveHarness('claude', customHarnesses)).toBe(CLAUDE_HARNESS);
      expect(resolveHarness('codex', customHarnesses)).toBe(CODEX_HARNESS);
      expect(resolveHarness('opencode', customHarnesses)).toBe(OPENCODE_HARNESS);
    });

    it('auto-detects codex from command string', () => {
      const provider = resolveHarness(undefined, undefined, 'codex');
      expect(provider).toBe(CODEX_HARNESS);
    });

    it('auto-detected gemini command fails closed with the retirement (never claude, never undefined)', () => {
      const r = resolveResult(() => resolveHarness(undefined, undefined, '/opt/homebrew/bin/gemini'));
      expect(r.returned).toBeUndefined();
      expect(r.returned).not.toBe(CLAUDE_HARNESS);
      expect(r.threw?.message).toMatch(/retired/i);
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
      const provider = resolveHarness('codex', undefined, 'claude');
      expect(provider).toBe(CODEX_HARNESS);
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

  // ===========================================================================
  // Retired harnesses (Issue #1338)
  // ===========================================================================

  describe('retired harnesses', () => {
    it('isRetiredHarness is true for gemini, false for supported and unknown names', () => {
      expect(isRetiredHarness('gemini')).toBe(true);
      expect(isRetiredHarness('claude')).toBe(false);
      expect(isRetiredHarness('codex')).toBe(false);
      expect(isRetiredHarness('opencode')).toBe(false);
      expect(isRetiredHarness('frobnicate')).toBe(false);
    });

    it('isRetiredHarness is not fooled by inherited Object.prototype keys', () => {
      expect(isRetiredHarness('constructor')).toBe(false);
      expect(isRetiredHarness('toString')).toBe(false);
      expect(isRetiredHarness('hasOwnProperty')).toBe(false);
    });

    it('getRetirement returns the gemini explanation and undefined otherwise', () => {
      const msg = getRetirement('gemini');
      expect(msg).toMatch(/retired/i);
      expect(msg).toContain('2026-06-18');
      expect(msg).toContain('claude');
      // The escape-hatch guidance names the EXPLICIT selector (#1338), matching the
      // README + doctor: a bare auto-detected `gemini` stays retired, so a custom
      // `gemini` def must be selected via shell.builderHarness / shell.architectHarness.
      expect(msg).toContain('shell.builderHarness');
      expect(msg).toContain('shell.architectHarness');
      expect(getRetirement('claude')).toBeUndefined();
      expect(getRetirement('frobnicate')).toBeUndefined();
      expect(getRetirement('constructor')).toBeUndefined();
    });
  });
});
