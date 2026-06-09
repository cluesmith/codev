/**
 * Unit tests for spawn-roles.ts (Spec 0105 Phase 7)
 *
 * Tests: template rendering, prompt building, resume notice generation,
 * protocol role loading, protocol resolution, and mode resolution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renderTemplate,
  buildPromptFromTemplate,
  buildResumeNotice,
  resolveMode,
  findSpecFile,
  validateProtocol,
  loadProtocol,
  loadProtocolRole,
} from '../commands/spawn-roles.js';
import type { TemplateContext } from '../commands/spawn-roles.js';
import { logger } from '../utils/logger.js'; // mocked below; vi.fn()s for assertions

// Mock dependencies
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
  fatal: vi.fn((msg: string) => { throw new Error(msg); }),
}));

vi.mock('../utils/roles.js', () => ({
  loadRolePrompt: vi.fn(() => ({ content: 'builder role', source: 'codev' })),
}));

// Hoisted shared state for the skeleton mock (vi.mock factories are hoisted, so
// we use vi.hoisted to make this state available before the factory runs).
const skeletonMock = vi.hoisted(() => ({ root: '' as string }));

vi.mock('../../lib/skeleton.js', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  // Mirrors the real four-tier resolver: .codev/ → codev/ → cache → skeleton.
  // The cache tier is omitted (irrelevant to these tests).
  const resolveCodevFile = (relativePath: string, workspaceRoot?: string): string | null => {
    const root = workspaceRoot || process.cwd();
    const overridePath = path.join(root, '.codev', relativePath);
    if (fs.existsSync(overridePath)) return overridePath;
    const localPath = path.join(root, 'codev', relativePath);
    if (fs.existsSync(localPath)) return localPath;
    if (skeletonMock.root) {
      const skeletonPath = path.join(skeletonMock.root, relativePath);
      if (fs.existsSync(skeletonPath)) return skeletonPath;
    }
    return null;
  };
  // Mirror of the real resolveCodevIncludes, using the mocked resolver.
  const resolveCodevIncludes = (content: string, workspaceRoot?: string, depth = 0): string => {
    if (depth > 5) return content;
    return content.replace(/\{\{>\s*([^}\s]+)\s*\}\}/g, (_m, rel: string) => {
      const resolved = resolveCodevFile(rel, workspaceRoot);
      if (!resolved) return '';
      return resolveCodevIncludes(fs.readFileSync(resolved, 'utf-8'), workspaceRoot, depth + 1);
    });
  };
  return {
    resolveCodevFile,
    resolveCodevIncludes,
    getSkeletonDir: (): string => skeletonMock.root,
  };
});

// We need fs mocks for findSpecFile tests but must preserve real behavior for other tests.
// Use spyOn approach within the findSpecFile describe block instead.

describe('spawn-roles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Template Rendering
  // =========================================================================

  describe('renderTemplate', () => {
    it('substitutes simple variables', () => {
      const template = 'Hello {{protocol_name}} in {{mode}} mode';
      const context: TemplateContext = {
        protocol_name: 'SPIR',
        mode: 'strict',
        mode_soft: false,
        mode_strict: true,
        input_description: 'test',
      };
      const result = renderTemplate(template, context);
      expect(result).toBe('Hello SPIR in strict mode');
    });

    it('substitutes nested object properties', () => {
      const template = 'Spec at {{spec.path}}';
      const context: TemplateContext = {
        protocol_name: 'SPIR',
        mode: 'strict',
        mode_soft: false,
        mode_strict: true,
        input_description: 'test',
        spec: { path: 'codev/specs/0001.md', name: '0001' },
      };
      const result = renderTemplate(template, context);
      expect(result).toBe('Spec at codev/specs/0001.md');
    });

    it('handles {{#if}} blocks with truthy values', () => {
      const template = '{{#if spec}}Has spec{{/if}}';
      const context: TemplateContext = {
        protocol_name: 'SPIR',
        mode: 'strict',
        mode_soft: false,
        mode_strict: true,
        input_description: 'test',
        spec: { path: 'codev/specs/0001.md', name: '0001' },
      };
      const result = renderTemplate(template, context);
      expect(result).toContain('Has spec');
    });

    it('removes {{#if}} blocks with falsy values', () => {
      const template = 'before{{#if spec}}Has spec{{/if}}after';
      const context: TemplateContext = {
        protocol_name: 'SPIR',
        mode: 'strict',
        mode_soft: false,
        mode_strict: true,
        input_description: 'test',
      };
      const result = renderTemplate(template, context);
      expect(result).not.toContain('Has spec');
      expect(result).toContain('beforeafter');
    });

    it('replaces undefined variables with empty string', () => {
      const template = 'project: {{project_id}}';
      const context: TemplateContext = {
        protocol_name: 'SPIR',
        mode: 'strict',
        mode_soft: false,
        mode_strict: true,
        input_description: 'test',
      };
      const result = renderTemplate(template, context);
      expect(result).toBe('project:');
    });
  });

  // =========================================================================
  // Build Prompt From Template
  // =========================================================================

  describe('buildPromptFromTemplate', () => {
    it('falls back to inline prompt when no template file exists', () => {
      // Config with non-existent protocols dir
      const config = {
        codevDir: '/nonexistent/codev',
        workspaceRoot: '/workspace',
        buildersDir: '/workspace/.builders',
        stateFile: '/workspace/.builders/state.json',
      };
      const context: TemplateContext = {
        protocol_name: 'SPIR',
        mode: 'strict',
        mode_soft: false,
        mode_strict: true,
        input_description: 'a feature',
      };
      const result = buildPromptFromTemplate(config, 'spir', context);
      expect(result).toContain('SPIR Builder (strict mode)');
      expect(result).toContain('a feature');
      expect(result).toContain('STRICT');
    });
  });

  // =========================================================================
  // Resume Notice
  // =========================================================================

  describe('buildResumeNotice', () => {
    it('generates resume notice with porch instructions', () => {
      const notice = buildResumeNotice('0042');
      expect(notice).toContain('RESUME SESSION');
      expect(notice).toContain('porch next');
      expect(notice).toContain('resumed');
    });
  });

  // =========================================================================
  // Mode Resolution
  // =========================================================================

  describe('resolveMode', () => {
    it('returns strict when --strict flag is set', () => {
      expect(resolveMode({ strict: true }, null)).toBe('strict');
    });

    it('returns soft when --soft flag is set', () => {
      expect(resolveMode({ soft: true }, null)).toBe('soft');
    });

    it('throws when both --strict and --soft are set', () => {
      expect(() => resolveMode({ strict: true, soft: true }, null)).toThrow('mutually exclusive');
    });

    it('uses protocol default mode when no flags', () => {
      const protocol = { defaults: { mode: 'strict' as const } };
      expect(resolveMode({ issueNumber: 42, protocol: 'spir' }, protocol)).toBe('strict');
    });

    it('defaults to strict for issue-based non-bugfix spawns', () => {
      expect(resolveMode({ issueNumber: 1, protocol: 'spir' }, null)).toBe('strict');
    });

    it('defaults to soft for bugfix and other modes', () => {
      expect(resolveMode({ issueNumber: 42, protocol: 'bugfix' }, null)).toBe('soft');
      expect(resolveMode({ task: 'fix' }, null)).toBe('soft');
    });

    it('explicit flag overrides protocol default', () => {
      const protocol = { defaults: { mode: 'strict' as const } };
      expect(resolveMode({ soft: true }, protocol)).toBe('soft');
    });
  });

  // =========================================================================
  // findSpecFile — zero-padded ID matching
  // =========================================================================

  describe('findSpecFile', () => {
    let tmpDir: string;

    beforeEach(async () => {
      const os = await import('node:os');
      const fs = await import('node:fs');
      const path = await import('node:path');
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-roles-test-'));
      fs.mkdirSync(path.join(tmpDir, 'specs'), { recursive: true });
    });

    it('matches exact ID prefix (e.g., "0076" → "0076-feature.md")', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.writeFileSync(path.join(tmpDir, 'specs', '0076-feature.md'), '');
      const result = await findSpecFile(tmpDir, '0076');
      expect(result).toBe(path.join(tmpDir, 'specs', '0076-feature.md'));
    });

    it('matches stripped ID to zero-padded file (e.g., "76" → "0076-feature.md")', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.writeFileSync(path.join(tmpDir, 'specs', '0076-feature.md'), '');
      const result = await findSpecFile(tmpDir, '76');
      expect(result).toBe(path.join(tmpDir, 'specs', '0076-feature.md'));
    });

    it('matches non-padded ID to non-padded file (e.g., "42" → "42-bugfix.md")', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.writeFileSync(path.join(tmpDir, 'specs', '42-bugfix.md'), '');
      const result = await findSpecFile(tmpDir, '42');
      expect(result).toBe(path.join(tmpDir, 'specs', '42-bugfix.md'));
    });

    it('returns null when no spec matches', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.writeFileSync(path.join(tmpDir, 'specs', '0099-other.md'), '');
      const result = await findSpecFile(tmpDir, '76');
      expect(result).toBeNull();
    });

    it('returns null when specs directory does not exist', async () => {
      const result = await findSpecFile('/nonexistent-codev-dir', '76');
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // Skeleton Fallback (Issue #706)
  //
  // v3-cleaned projects don't carry a local codev/protocols/ directory. The
  // resolver must fall back to the bundled skeleton in those cases — the
  // hardcoded resolve(config.codevDir, 'protocols', ...) lookups previously
  // failed with "Protocol not found".
  // =========================================================================
  describe('skeleton fallback (issue #706)', () => {
    let workspaceRoot: string;
    let skeletonRoot: string;
    let codevDir: string;

    function makeConfig() {
      return {
        workspaceRoot,
        codevDir,
        buildersDir: `${workspaceRoot}/.builders`,
        stateDir: `${workspaceRoot}/.builders/state`,
        templatesDir: '',
        serversDir: '',
        bundledRolesDir: '',
        terminalBackend: 'node-pty' as const,
      };
    }

    beforeEach(async () => {
      const os = await import('node:os');
      const fs = await import('node:fs');
      const path = await import('node:path');

      workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-roles-ws-'));
      skeletonRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-roles-skel-'));
      // Simulate a v3-cleaned project: codev/ exists but protocols/ does not.
      codevDir = path.join(workspaceRoot, 'codev');
      fs.mkdirSync(codevDir, { recursive: true });

      // Skeleton has spir/ and bugfix/ protocols.
      fs.mkdirSync(path.join(skeletonRoot, 'protocols', 'spir'), { recursive: true });
      fs.writeFileSync(
        path.join(skeletonRoot, 'protocols', 'spir', 'protocol.json'),
        JSON.stringify({ name: 'spir', version: '1', phases: [] }),
      );
      fs.writeFileSync(
        path.join(skeletonRoot, 'protocols', 'spir', 'role.md'),
        '# SPIR builder role',
      );
      fs.writeFileSync(
        path.join(skeletonRoot, 'protocols', 'spir', 'builder-prompt.md'),
        // #1011: the {{protocol_reference}} placeholder is filled fresh at spawn
        // from protocol.md (and its {{> ...}} includes). Unconditional — every
        // shipped protocol ships a protocol.md (guarded by the completeness test
        // below), so there is no {{#if}} guard.
        '# {{protocol_name}} prompt for {{input_description}}\n' +
          '## Protocol Reference (full text)\n{{protocol_reference}}\n',
      );
      fs.mkdirSync(path.join(skeletonRoot, 'protocols', 'bugfix'), { recursive: true });
      fs.writeFileSync(
        path.join(skeletonRoot, 'protocols', 'bugfix', 'protocol.json'),
        JSON.stringify({ name: 'bugfix', phases: [] }),
      );

      skeletonMock.root = skeletonRoot;
    });

    it('validateProtocol succeeds when protocol exists only in skeleton', () => {
      // Local codev/protocols/ does not exist (v3-cleaned project).
      expect(() => validateProtocol(makeConfig(), 'spir')).not.toThrow();
    });

    it('validateProtocol lists skeleton protocols when local dir is empty', () => {
      expect(() => validateProtocol(makeConfig(), 'bogus')).toThrow(
        /Protocol not found: bogus[\s\S]*Available protocols:[\s\S]*spir/,
      );
    });

    it('validateProtocol warns (non-fatally) when a protocol has protocol.json but no protocol.md (issue #1011)', () => {
      // The beforeEach creates spir/ with protocol.json but no protocol.md.
      expect(() => validateProtocol(makeConfig(), 'spir')).not.toThrow(); // non-fatal
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no protocol.md'));
    });

    it('validateProtocol does NOT warn when protocol.md is present', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.writeFileSync(path.join(skeletonRoot, 'protocols', 'spir', 'protocol.md'), '# SPIR');
      validateProtocol(makeConfig(), 'spir');
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('loadProtocol falls back to skeleton', () => {
      const protocol = loadProtocol(makeConfig(), 'spir');
      expect(protocol).toEqual({ name: 'spir', version: '1', phases: [] });
    });

    it('loadProtocolRole falls back to skeleton', () => {
      const role = loadProtocolRole(makeConfig(), 'spir');
      expect(role).toEqual({ content: '# SPIR builder role', source: 'protocol' });
    });

    it('buildPromptFromTemplate uses skeleton template when local is missing', () => {
      const ctx: TemplateContext = {
        protocol_name: 'SPIR',
        mode: 'strict',
        mode_soft: false,
        mode_strict: true,
        input_description: 'a v3 feature',
      };
      const prompt = buildPromptFromTemplate(makeConfig(), 'spir', ctx);
      expect(prompt).toContain('SPIR prompt for a v3 feature');
    });

    it('fills {{protocol_reference}} with protocol.md content fresh at delivery (issue #1011)', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.writeFileSync(
        path.join(skeletonRoot, 'protocols', 'spir', 'protocol.md'),
        '# SPIR Protocol\n\nMETA_DOC_SENTINEL: gate semantics and when-to-use guidance.',
      );

      const ctx: TemplateContext = {
        protocol_name: 'SPIR',
        mode: 'strict',
        mode_soft: false,
        mode_strict: true,
        input_description: 'a v3 feature',
      };
      const prompt = buildPromptFromTemplate(makeConfig(), 'spir', ctx);

      // Still carries the rendered builder-prompt template...
      expect(prompt).toContain('SPIR prompt for a v3 feature');
      // ...plus the protocol meta-doc, substituted into the {{protocol_reference}}
      // placeholder under the template's delimiter heading (read fresh, not committed).
      expect(prompt).toContain('## Protocol Reference (full text)');
      expect(prompt).toContain('META_DOC_SENTINEL: gate semantics and when-to-use guidance.');
    });

    it('resolves {{> ...}} template includes inside protocol.md fresh at delivery (issue #1011)', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      // protocol.md references a template via an include directive rather than a
      // committed copy — the resolver reads the template fresh, so it can't drift.
      fs.mkdirSync(path.join(skeletonRoot, 'protocols', 'spir', 'templates'), { recursive: true });
      fs.writeFileSync(
        path.join(skeletonRoot, 'protocols', 'spir', 'templates', 'plan.md'),
        'TEMPLATE_SENTINEL: the canonical plan template body.',
      );
      fs.writeFileSync(
        path.join(skeletonRoot, 'protocols', 'spir', 'protocol.md'),
        '# SPIR Protocol\n\nUse the template below:\n\n{{> protocols/spir/templates/plan.md}}\n',
      );

      const ctx: TemplateContext = {
        protocol_name: 'SPIR',
        mode: 'strict',
        mode_soft: false,
        mode_strict: true,
        input_description: 'a v3 feature',
      };
      const prompt = buildPromptFromTemplate(makeConfig(), 'spir', ctx);

      // The include directive is gone (resolved), replaced by the template body.
      expect(prompt).not.toContain('{{> protocols/spir/templates/plan.md}}');
      expect(prompt).toContain('TEMPLATE_SENTINEL: the canonical plan template body.');
    });

    it('builds the prompt without error when protocol.md is absent (issue #1011)', () => {
      // The skeleton-fallback beforeEach creates spir/ with no protocol.md. The
      // reference is now unconditional (no {{#if}} guard), so {{protocol_reference}}
      // resolves to empty rather than the prompt omitting the section — the build
      // must still succeed without error. (Shipped protocols can't hit this: the
      // completeness test guarantees every shipped protocol has a protocol.md.)
      const ctx: TemplateContext = {
        protocol_name: 'SPIR',
        mode: 'strict',
        mode_soft: false,
        mode_strict: true,
        input_description: 'a v3 feature',
      };
      const prompt = buildPromptFromTemplate(makeConfig(), 'spir', ctx);

      expect(prompt).toContain('SPIR prompt for a v3 feature');
      expect(prompt).not.toContain('{{protocol_reference}}'); // placeholder resolved (to empty), not left raw
    });

    it('local codev/protocols/ takes precedence over skeleton', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const localProtocolDir = path.join(codevDir, 'protocols', 'spir');
      fs.mkdirSync(localProtocolDir, { recursive: true });
      fs.writeFileSync(
        path.join(localProtocolDir, 'protocol.json'),
        JSON.stringify({ name: 'spir-local', phases: [] }),
      );

      const protocol = loadProtocol(makeConfig(), 'spir');
      expect(protocol).toEqual({ name: 'spir-local', phases: [] });
    });
  });
});
