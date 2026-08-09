import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_HARNESS,
  CODEX_HARNESS,
  OPENCODE_HARNESS,
  KIMI_HARNESS,
  KIMI_AGENT_FILE,
  buildKimiAgentFile,
  buildCustomHarnessProvider,
  validateCustomHarnessConfig,
  resolveHarness,
  detectHarnessFromCommand,
  isRetiredHarness,
  getRetirement,
  getBuiltinHarness,
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

    it('inherited Object keys are not providers — throws Unknown harness, never a bogus provider (#1338)', () => {
      // `harnessName` is user-controlled (config `shell.builderHarness` / a builder
      // launch script). A bare `BUILTIN_HARNESSES[name]` for an inherited Object
      // member returns a truthy value (`Object` for 'constructor', a function for
      // 'toString'/'hasOwnProperty', `Object.prototype` for '__proto__'), which the
      // pre-#1338 `if (builtin) return builtin` handed back as a bogus provider that
      // TypeErrors at the first buildRoleInjection. The own-property guard makes
      // these fail closed with the generic "Unknown harness" error instead.
      for (const protoKey of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
        const r = resolveResult(() => resolveHarness(protoKey));
        expect(r.returned, `${protoKey} must not resolve to a provider`).toBeUndefined();
        expect(r.threw?.message, `${protoKey} must throw Unknown harness`).toMatch(/Unknown harness/);
      }
    });
  });

  // ===========================================================================
  // getBuiltinHarness (own-property accessor — #1338)
  // ===========================================================================

  describe('getBuiltinHarness', () => {
    it('returns the provider for each built-in name', () => {
      expect(getBuiltinHarness('claude')).toBe(CLAUDE_HARNESS);
      expect(getBuiltinHarness('codex')).toBe(CODEX_HARNESS);
      expect(getBuiltinHarness('opencode')).toBe(OPENCODE_HARNESS);
    });

    it('returns undefined for an unknown name', () => {
      expect(getBuiltinHarness('nonexistent')).toBeUndefined();
    });

    it('returns undefined for inherited Object keys (the footgun the guard closes)', () => {
      // Mirrors isRetiredHarness's own-property check: these must never resolve to
      // Object.prototype members even though `BUILTIN_HARNESSES[key]` would be truthy.
      for (const protoKey of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
        expect(getBuiltinHarness(protoKey)).toBeUndefined();
      }
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

    // Issue #1201: recognizing `kimi` kills the #1062 unrecognized-command
    // fallthrough to the claude harness for this CLI.
    it('detects kimi', () => {
      expect(detectHarnessFromCommand('kimi')).toBe('kimi');
    });

    it('detects kimi from full path', () => {
      expect(detectHarnessFromCommand('/home/user/.kimi-code/bin/kimi')).toBe('kimi');
    });

    it('detects kimi with flags', () => {
      expect(detectHarnessFromCommand('kimi --yolo')).toBe('kimi');
    });
  });

  // ===========================================================================
  // KIMI_HARNESS (Issue #1201 — builder-only, seed-session bootstrap)
  // ===========================================================================

  describe('KIMI_HARNESS', () => {
    it('resolveHarness("kimi") returns the kimi provider', () => {
      expect(resolveHarness('kimi')).toBe(KIMI_HARNESS);
    });

    it('resolveHarness auto-detects kimi from the command string', () => {
      expect(resolveHarness(undefined, undefined, 'kimi')).toBe(KIMI_HARNESS);
    });

    it('buildRoleInjection throws (kimi is builder-only — architect fence)', () => {
      expect(() => KIMI_HARNESS.buildRoleInjection(ROLE_CONTENT, ROLE_FILE)).toThrow(/builder shell/);
      expect(() => KIMI_HARNESS.buildRoleInjection(ROLE_CONTENT, ROLE_FILE)).toThrow(/architect/);
    });

    // The pivot (PR #1203 re-integration): the role rides `--agent-file`, a real
    // kimi 0.31.0+ flag, pointed at a file written next to `.builder-role.md`.
    // It replaced a seed-session bootstrap that delivered the role as a user turn.
    it('buildScriptRoleInjection points --agent-file at the worktree agent file', () => {
      const { fragment, env } = KIMI_HARNESS.buildScriptRoleInjection(ROLE_CONTENT, ROLE_FILE);
      expect(fragment).toBe(`--agent-file '/tmp/workspace/${KIMI_AGENT_FILE}'`);
      expect(env).toEqual({});
    });

    it('the agent file extends kimi\'s own system prompt rather than replacing it', () => {
      const body = buildKimiAgentFile('ROLE BODY');
      // ${base_prompt} is the load-bearing token: it interpolates kimi's default
      // system prompt, so the role is additive (the --append-system-prompt analogue).
      // Without it the builder silently loses kimi's tool-use and safety preamble.
      expect(body).toContain('${base_prompt}');
      expect(body).toContain('ROLE BODY');
      expect(body.indexOf('${base_prompt}')).toBeLessThan(body.indexOf('ROLE BODY'));
      // Frontmatter is required by kimi's agent-definition format.
      expect(body.startsWith('---\n')).toBe(true);
      expect(body).toMatch(/^name:\s*\S+/m);
    });

    it('getWorktreeFiles writes the agent file only when there is a role', () => {
      const withRole = KIMI_HARNESS.getWorktreeFiles!(ROLE_CONTENT);
      expect(withRole).toEqual([
        { relativePath: KIMI_AGENT_FILE, content: buildKimiAgentFile(ROLE_CONTENT) },
      ]);
      // No marker file any more: pacing reads the harness out of the generated
      // .builder-start.sh, so nothing has to remember to write a breadcrumb.
      expect(KIMI_HARNESS.getWorktreeFiles!(null)).toEqual([]);
    });

    // The architect stored-UUID contract needs newSessionArgs (mint-and-pin),
    // which Kimi cannot satisfy — no session block means architects on kimi
    // never persist/resume (they fail earlier at buildRoleInjection anyway).
    it('has no session capability', () => {
      expect(KIMI_HARNESS.session).toBeUndefined();
    });

    it('declares message pacing with a longer Enter delay', () => {
      expect(KIMI_HARNESS.messagePacing?.enterDelayMs).toBeGreaterThanOrEqual(1000);
    });

    describe('buildBuilderLaunchScript', () => {
      const ROLE_FRAGMENT = `--agent-file '/tmp/wt/${KIMI_AGENT_FILE}'`;
      const ctxBase = { worktreePath: '/tmp/wt', baseCmd: 'kimi', roleFragment: ROLE_FRAGMENT };
      const taskCtx = { ...ctxBase, taskFile: '/tmp/wt/.builder-prompt.txt', builderId: 'pir-1201' };
      const bareCtx = { ...ctxBase, roleFragment: '', taskFile: null };

      it('task-carrying: role via --agent-file, task via the mailbox — never a positional prompt', () => {
        const script = KIMI_HARNESS.buildBuilderLaunchScript!(taskCtx);
        expect(script).toContain(ROLE_FRAGMENT);
        expect(script).toContain('--yolo');
        // kimi takes no positional prompt, so the task rides the Spec 1313 mailbox
        // and the render gate delivers it onto a verified-empty composer.
        expect(script).toContain("afx send 'pir-1201'");
        expect(script).toContain('/tmp/wt/.builder-prompt.txt');
        // The #929/#1062 regression class: never claude-shaped flags, and never a
        // prompt appended as an argument (kimi exits 1 on both). Scoped to the lines
        // that actually INVOKE kimi — the script's prose mentions `afx spawn --resume`,
        // and a whole-script substring guard would trip on that instead of on a real
        // mis-injection.
        const kimiInvocations = script.split('\n').filter((l) => /^\s*kimi(\s|$)/.test(l));
        expect(kimiInvocations.length).toBeGreaterThan(0);
        for (const line of kimiInvocations) {
          expect(line).not.toContain('--append-system-prompt');
          expect(line).not.toContain('--resume');
          expect(line).not.toContain('$(cat');
        }
      });

      it('task-carrying: queues the task on a FRESH launch only, never on a resume', () => {
        const script = KIMI_HARNESS.buildBuilderLaunchScript!(taskCtx);
        const fresh = script.indexOf('codev_launch_fresh() {');
        const resume = script.indexOf('codev_launch_resume() {');
        const queueCall = script.indexOf('codev_queue_task\n', fresh);
        expect(fresh).toBeGreaterThan(-1);
        expect(resume).toBeGreaterThan(-1);
        // The only invocation of the queue helper sits inside the fresh branch, so a
        // resumed conversation is never re-fed a task it has already been working on.
        expect(queueCall).toBeGreaterThan(fresh);
        expect(queueCall).toBeLessThan(resume);
      });

      // THE guard this design exists for (verified live on 0.34.0): `kimi -c` with
      // nothing to continue does NOT fail — it prints "No sessions to continue…" and
      // starts a fresh session that never saw --agent-file, i.e. a ROLELESS builder.
      // Every path to `-c` must therefore be gated on a proven-existing session, and
      // the gate must fail CLOSED to the role-carrying launch.
      it('never reaches -c without proving a session exists (the roleless-fallback guard)', () => {
        const script = KIMI_HARNESS.buildBuilderLaunchScript!(taskCtx);
        expect(script).toContain('codev_has_session');
        // Entry selects resume only under the probe...
        expect(script).toMatch(/if codev_has_session; then\n\s*codev_launch=codev_launch_resume\n\s*else\n\s*codev_launch=codev_launch_fresh/);
        // ...and so does the crash path; its else-branch is fresh, not resume.
        expect(script).toMatch(/elif codev_has_session; then[\s\S]*?codev_launch=codev_launch_resume\n\s*else\n[\s\S]*?codev_launch=codev_launch_fresh/);
        // `-c` appears ONLY inside codev_launch_resume, which only the probe selects.
        const resumeBody = script.slice(
          script.indexOf('codev_launch_resume() {'),
          script.indexOf('}', script.indexOf('codev_launch_resume() {')),
        );
        expect(resumeBody).toContain('-c');
        expect(script.match(/(^|\s)-c(\s|$)/gm)!.length).toBe(1);
        // The probe itself must fail closed: its last act on any error is exit 1
        // (→ "no session" → fresh), never exit 0.
        expect(script).toContain('process.exit(1)');
      });

      it('bare shape (no role, no task): the plain loop every session-less harness gets', () => {
        const script = KIMI_HARNESS.buildBuilderLaunchScript!(bareCtx);
        expect(script).toContain('kimi --yolo');
        expect(script).toContain('while true');
        // Nothing to pin and nothing to queue, so none of the state machine appears.
        expect(script).not.toContain('codev_has_session');
        expect(script).not.toContain('afx send');
        expect(script).not.toContain('-c');
      });

      // Pacing depends on this: `resolvePacingForSession` recovers the harness by
      // reading .builder-start.sh and matching the command in COMMAND POSITION. If a
      // refactor ever moved `kimi` off the start of its own line (or behind a `while`
      // on the same line), pacing would silently fall back to the 80ms default and
      // every `afx send` to this builder would be typed but never submitted.
      it.each([
        ['task-carrying', taskCtx],
        ['bare', bareCtx],
      ] as const)('%s shape puts kimi in command position on its own line', (_name, ctx) => {
        const script = KIMI_HARNESS.buildBuilderLaunchScript!(ctx);
        expect(script.split('\n').some((l) => /^\s*kimi(\s|$)/.test(l))).toBe(true);
      });

      // Bugfix #1241 / PR #1244: Kimi's provider-owned loops share the exit-code-gated
      // tail — a deliberate exit 0 gates the relaunch on a keypress instead of blindly
      // respawning; crashes keep the auto-restart.
      it.each([
        ['task-carrying', taskCtx],
        ['bare', bareCtx],
      ] as const)('%s shape does not auto-restart on exit 0', (_name, ctx) => {
        const script = KIMI_HARNESS.buildBuilderLaunchScript!(ctx);
        expect(script).toContain('status=$?');
        expect(script).toContain('if [ "$status" -eq 0 ]; then');
        expect(script).toContain('Press Enter to relaunch');
        expect(script).toContain('read -r || exit 0');
      });

      // #1267/#1317: a clean exit relaunches FRESH (new conversation), matching
      // claude's prompt-on-fresh semantics — which for kimi means re-queuing the task.
      it('task-carrying: a clean exit relaunches fresh, not resumed', () => {
        const script = KIMI_HARNESS.buildBuilderLaunchScript!(taskCtx);
        const cleanExit = script.indexOf('if [ "$status" -eq 0 ]; then');
        const afterClean = script.slice(cleanExit, script.indexOf('fi', cleanExit));
        expect(afterClean).toContain('codev_launch=codev_launch_fresh');
        expect(afterClean).not.toContain('codev_launch_resume');
      });

      it('warns loudly but non-fatally when the task cannot be queued', () => {
        const script = KIMI_HARNESS.buildBuilderLaunchScript!(taskCtx);
        // A missing afx / down Tower must not stop the builder from starting — it
        // surfaces a recovery command instead. `return 0` keeps the launch going.
        expect(script).toContain('WARNING');
        expect(script).toContain('is Tower running?');
        expect(script).toContain('return 0');
      });

      it('does not duplicate --yolo when the user already passed it', () => {
        const script = KIMI_HARNESS.buildBuilderLaunchScript!({
          ...bareCtx, baseCmd: 'kimi --yolo',
        });
        expect(script.match(/--yolo/g)!.length).toBeGreaterThan(0);
        expect(script).not.toContain('--yolo --yolo');
      });
    });

    /**
     * The crash-resume guard, executed for real rather than pattern-matched.
     *
     * `kimi -c` does NOT fail with nothing to continue — it starts a fresh session
     * that never saw `--agent-file`, i.e. a silently ROLELESS builder (#929 hazard
     * class, verified live on 0.34.0). The launch loop therefore only takes `-c`
     * when this inlined `node -e` probe says a session exists for this cwd.
     *
     * The probe is a hand-written store scan living inside a bash heredoc, where a
     * type checker cannot reach it and the store's shape has already drifted once
     * (`workDir` → `cwd` in 0.33.0). So it is extracted from the generated script and
     * RUN against fixture stores, and its verdict is checked against the TypeScript
     * discovery it mirrors — if the two ever disagree, this fails instead of a
     * builder silently losing its role in the field.
     */
    describe('the inlined crash-resume session probe (KIMI_HAS_SESSION_PROBE)', () => {
      let fakeHome: string;
      let worktree: string;

      beforeEach(() => {
        fakeHome = mkdtempSync(join(tmpdir(), 'kimi-probe-'));
        worktree = join(fakeHome, 'worktree');
        mkdirSync(worktree, { recursive: true });
      });

      afterEach(() => rmSync(fakeHome, { recursive: true, force: true }));

      /** The exact `node -e '<probe>'` snippet the generated script would run. */
      function extractProbe(): string {
        const script = KIMI_HARNESS.buildBuilderLaunchScript!({
          worktreePath: worktree, baseCmd: 'kimi', roleFragment: '--agent-file x',
          taskFile: '/tmp/wt/.builder-prompt.txt', builderId: 'pir-1201',
        });
        const m = script.match(/node -e '([^']*)'/);
        expect(m, 'the launch script must still inline a node probe').not.toBeNull();
        return m![1];
      }

      /** Run the probe exactly as the script does; true ⇔ exit 0 ⇔ "a session exists". */
      function runProbe(cwd: string): boolean {
        const res = spawnSync(process.execPath, ['-e', extractProbe(), cwd], {
          env: { ...process.env, KIMI_CODE_HOME: join(fakeHome, '.kimi-code') },
        });
        return res.status === 0;
      }

      function writeStoreSession(sessionId: string, state: Record<string, unknown>): void {
        const dir = join(fakeHome, '.kimi-code', 'sessions', 'wd_x_000000000000', sessionId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'state.json'), JSON.stringify(state), 'utf-8');
      }

      // THE regression the whole guard exists for.
      it('an EMPTY store reports no session, so the loop launches fresh WITH the role', () => {
        expect(runProbe(worktree)).toBe(false);
        // And the TypeScript discovery agrees — one answer, two implementations.
        expect(KIMI_HARNESS.buildResume!(worktree, { homeDir: fakeHome })).toBeNull();
      });

      it('a session recorded for this cwd reports true (v2 `cwd` shape)', () => {
        writeStoreSession('session_here', { id: 'session_here', version: 2, cwd: worktree, updatedAt: 1 });
        expect(runProbe(worktree)).toBe(true);
        expect(KIMI_HARNESS.buildResume!(worktree, { homeDir: fakeHome })?.sessionId).toBe('session_here');
      });

      it('tolerates the v1 `workDir` shape exactly as readStateJson does', () => {
        writeStoreSession('session_v1', { workDir: worktree, updatedAt: '2026-07-18T10:00:00Z' });
        expect(runProbe(worktree)).toBe(true);
        expect(KIMI_HARNESS.buildResume!(worktree, { homeDir: fakeHome })?.sessionId).toBe('session_v1');
      });

      it('a session for ANOTHER directory reports no session (never inherits a stranger\'s conversation)', () => {
        writeStoreSession('session_elsewhere', { cwd: '/some/other/dir', updatedAt: 1 });
        expect(runProbe(worktree)).toBe(false);
        expect(KIMI_HARNESS.buildResume!(worktree, { homeDir: fakeHome })).toBeNull();
      });

      it('fails CLOSED on a malformed store — a corrupt state.json must not authorize -c', () => {
        writeStoreSession('session_junk', {});
        writeFileSync(
          join(fakeHome, '.kimi-code', 'sessions', 'wd_x_000000000000', 'session_junk', 'state.json'),
          '{ not json',
          'utf-8',
        );
        expect(runProbe(worktree)).toBe(false);
      });

      it('fails CLOSED when the store does not exist at all', () => {
        rmSync(join(fakeHome, '.kimi-code'), { recursive: true, force: true });
        expect(runProbe(worktree)).toBe(false);
      });
    });

    describe('buildResume', () => {
      let fakeHome: string;
      let worktree: string;

      beforeEach(() => {
        fakeHome = mkdtempSync(join(tmpdir(), 'kimi-harness-'));
        worktree = join(fakeHome, 'worktree');
        mkdirSync(worktree, { recursive: true });
      });

      afterEach(() => {
        rmSync(fakeHome, { recursive: true, force: true });
      });

      // v2 store shape (kimi 0.33.0+): `cwd` (was `workDir`) and epoch-ms timestamps
      // (were ISO strings). Discovery tolerates both; these fixtures use the current one.
      function writeStoreSession(sessionId: string, cwd: string, updatedAt: number): void {
        const dir = join(fakeHome, '.kimi-code', 'sessions', 'wd_x_000000000000', sessionId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'state.json'),
          JSON.stringify({ id: sessionId, version: 2, cwd, updatedAt }),
          'utf-8',
        );
      }

      it('null when no store session exists for this worktree → fresh-with-role launch', () => {
        expect(KIMI_HARNESS.buildResume!(worktree, { homeDir: fakeHome })).toBeNull();
      });

      // The pivot shrank discovery to a single question — does a conversation exist for
      // exactly this worktree? — and the ANSWER, not the id, is what the script uses:
      // the relaunch runs the DOCUMENTED cwd-scoped `-c`, so no undocumented session id
      // is ever baked into generated bash. The id still rides the return value because
      // callers log it and spawn.ts reads null as "nothing to resume".
      it('resumes with the documented cwd-scoped -c, never an undocumented -S <id>', () => {
        writeStoreSession('session_abc-123', worktree, 1_760_000_000_000);
        const resume = KIMI_HARNESS.buildResume!(worktree, { homeDir: fakeHome });
        expect(resume).toEqual({
          sessionId: 'session_abc-123',
          args: ['-c'],
          scriptFragment: '-c',
        });
      });

      it('store scan picks the newest session recorded for exactly this worktree', () => {
        writeStoreSession('session_older', worktree, 1_750_000_000_000);
        writeStoreSession('session_newest', worktree, 1_760_000_000_000);
        writeStoreSession('session_other-dir', '/elsewhere', 1_770_000_000_000);
        const resume = KIMI_HARNESS.buildResume!(worktree, { homeDir: fakeHome });
        expect(resume?.sessionId).toBe('session_newest');
      });

      // #1145: a session recorded for a DIFFERENT cwd must never be resumed here, or a
      // builder inherits an unrelated conversation.
      it('ignores sessions recorded for another directory', () => {
        writeStoreSession('session_elsewhere', '/some/other/worktree', 1_760_000_000_000);
        expect(KIMI_HARNESS.buildResume!(worktree, { homeDir: fakeHome })).toBeNull();
      });

      // #929-class regression, harness angle: a stale CLAUDE jsonl for this
      // worktree must never surface through the kimi harness — kimi reads
      // only its own store.
      it('ignores a stale Claude jsonl for the same worktree (never yields --resume <claude-uuid>)', () => {
        const claudeDir = join(fakeHome, '.claude', 'projects', worktree.replace(/[/.]/g, '-'));
        mkdirSync(claudeDir, { recursive: true });
        writeFileSync(join(claudeDir, 'stale-claude-uuid.jsonl'), '{}', 'utf-8');
        expect(KIMI_HARNESS.buildResume!(worktree, { homeDir: fakeHome })).toBeNull();
      });
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
