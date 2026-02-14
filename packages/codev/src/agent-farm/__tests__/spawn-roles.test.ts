/**
 * Unit tests for spawn-roles.ts (Spec 0105 Phase 7)
 *
 * Tests: template rendering, prompt building, resume notice generation,
 * protocol role loading, protocol resolution, and mode resolution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderTemplate, buildPromptFromTemplate, buildResumeNotice, resolveMode } from '../commands/spawn-roles.js';
import type { TemplateContext } from '../commands/spawn-roles.js';

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
        projectRoot: '/project',
        buildersDir: '/project/.builders',
        stateFile: '/project/.builders/state.json',
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
      expect(resolveMode({ issue: 42 }, protocol)).toBe('strict');
    });

    it('defaults to strict for spec mode', () => {
      expect(resolveMode({ project: '0001' }, null)).toBe('strict');
    });

    it('defaults to soft for other modes', () => {
      expect(resolveMode({ issue: 42 }, null)).toBe('soft');
      expect(resolveMode({ task: 'fix' }, null)).toBe('soft');
    });

    it('explicit flag overrides protocol default', () => {
      const protocol = { defaults: { mode: 'strict' as const } };
      expect(resolveMode({ soft: true }, protocol)).toBe('soft');
    });
  });
});
