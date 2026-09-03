/**
 * Unit tests for the contextual-panel mode resolver.
 *
 * Pure function, no VSCode host, no navigation: `resolveMode(surface) → ModeDescriptor` by the locked
 * precedence. Every branch, the precedence overlap, and malformed-input degradation are exercised,
 * plus a source-scan purity guard.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { resolveMode } from '../contextual-panel/resolver.js';
import type { SurfaceContext } from '../contextual-panel/types.js';

describe('resolveMode — precedence (builderTerminal > builderDiff > artifact > attention)', () => {
  it('builder terminal → builder-inspector, builder in context', () => {
    const d = resolveMode({ builderTerminal: { builderId: 'spir-1049' } });
    expect(d.kind).toBe('builder-inspector');
    expect(d.context).toEqual({ builderId: 'spir-1049' });
  });

  it('builder diff → code-review, builder in context', () => {
    const d = resolveMode({ builderDiff: { builderId: 'bugfix-1408' } });
    expect(d.kind).toBe('code-review');
    expect(d.context).toEqual({ builderId: 'bugfix-1408' });
  });

  it('plain artifact → document-review with resourcePath', () => {
    const d = resolveMode({ artifact: { resourcePath: 'codev/specs/1049-x.md' } });
    expect(d.kind).toBe('document-review');
    expect(d.context).toEqual({ resourcePath: 'codev/specs/1049-x.md' });
  });

  it('worktree artifact → document-review carries the builder id', () => {
    const d = resolveMode({ artifact: { resourcePath: '.builders/spir-1049/codev/specs/x.md', builderId: 'spir-1049' } });
    expect(d.kind).toBe('document-review');
    expect(d.context).toEqual({ resourcePath: '.builders/spir-1049/codev/specs/x.md', builderId: 'spir-1049' });
  });

  it('no surface → attention fallback', () => {
    const d = resolveMode({});
    expect(d.kind).toBe('attention');
    expect(d.context).toEqual({});
  });

  it('overlap: artifact inside a builder diff → code-review (diff wins)', () => {
    const surface: SurfaceContext = {
      artifact: { resourcePath: '.builders/spir-1049/codev/specs/x.md', builderId: 'spir-1049' },
      builderDiff: { builderId: 'spir-1049' },
    };
    expect(resolveMode(surface).kind).toBe('code-review');
  });

  it('overlap: terminal + diff + artifact → builder-inspector (terminal wins)', () => {
    const d = resolveMode({
      artifact: { resourcePath: 'codev/specs/x.md' },
      builderDiff: { builderId: 'a' },
      builderTerminal: { builderId: 'b' },
    });
    expect(d.kind).toBe('builder-inspector');
    expect(d.context).toEqual({ builderId: 'b' });
  });
});

describe('resolveMode — malformed/empty input degrades to attention (never throws)', () => {
  it('null / undefined → attention', () => {
    expect(resolveMode(null).kind).toBe('attention');
    expect(resolveMode(undefined).kind).toBe('attention');
  });

  it('empty artifact resourcePath is treated as absent → attention', () => {
    expect(resolveMode({ artifact: { resourcePath: '' } }).kind).toBe('attention');
  });

  it('builderDiff missing its builderId is treated as absent → attention', () => {
    expect(resolveMode({ builderDiff: {} as { builderId: string } }).kind).toBe('attention');
  });

  it('does not throw on assorted malformed inputs', () => {
    const cases: unknown[] = [null, undefined, {}, { artifact: null }, { builderTerminal: { builderId: 42 } }, { artifact: { resourcePath: 123 } }];
    for (const surface of cases) {
      expect(() => resolveMode(surface as SurfaceContext)).not.toThrow();
    }
  });
});

describe('resolveMode — enforced purity (no host imports / no I/O)', () => {
  it('resolver.ts imports nothing but its own types', () => {
    const src = readFileSync(fileURLToPath(new URL('../contextual-panel/resolver.ts', import.meta.url)), 'utf8');
    const specifiers = [
      ...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
      ...src.matchAll(/\bimport\s+['"]([^'"]+)['"]/g),
      ...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...src.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);
    expect(specifiers).toEqual(['./types.js']);
    expect(src).not.toMatch(/from\s+['"]vscode['"]/);
    expect(src).not.toMatch(/from\s+['"]node:/);
  });
});
