/**
 * Unit tests for the contextual-panel mode resolver (Phase 1).
 *
 * Pure function, no VSCode host — every branch of the locked precedence, the applicability
 * matrix, the manual-selection override, and malformed-input degradation are exercised here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { resolveMode } from '../contextual-panel/resolver.js';
import type { ManualSelection, ModeKind, SurfaceContext } from '../contextual-panel/types.js';

const ALL_APPLICABLE: Record<ModeKind, boolean> = {
  'document-review': true,
  'code-review': true,
  'builder-inspector': true,
  'attention': true,
};

describe('resolveMode — contextual precedence (builderTerminal > builderDiff > artifact > attention)', () => {
  it('builder terminal → builder-inspector detail, builder in context', () => {
    const surface: SurfaceContext = { builderTerminal: { builderId: 'spir-1049' } };
    const d = resolveMode(surface, null);
    expect(d.kind).toBe('builder-inspector');
    expect(d.level).toBe('detail');
    expect(d.context).toEqual({ builderId: 'spir-1049' });
  });

  it('builder diff → code-review detail, builder in context', () => {
    const surface: SurfaceContext = { builderDiff: { builderId: 'bugfix-1408' } };
    const d = resolveMode(surface, null);
    expect(d.kind).toBe('code-review');
    expect(d.level).toBe('detail');
    expect(d.context).toEqual({ builderId: 'bugfix-1408' });
  });

  it('plain artifact (no builder) → document-review detail, resourcePath in context', () => {
    const surface: SurfaceContext = { artifact: { resourcePath: 'codev/specs/1049-x.md' } };
    const d = resolveMode(surface, null);
    expect(d.kind).toBe('document-review');
    expect(d.level).toBe('detail');
    expect(d.context).toEqual({ resourcePath: 'codev/specs/1049-x.md' });
  });

  it('no matching surface → attention summary', () => {
    const d = resolveMode({}, null);
    expect(d.kind).toBe('attention');
    expect(d.level).toBe('summary');
    expect(d.context).toEqual({});
  });

  it('overlap: artifact opened inside a builder diff → code-review (diff wins over artifact)', () => {
    const surface: SurfaceContext = {
      artifact: { resourcePath: '.builders/spir-1049/codev/specs/1049-x.md', builderId: 'spir-1049' },
      builderDiff: { builderId: 'spir-1049' },
    };
    const d = resolveMode(surface, null);
    expect(d.kind).toBe('code-review');
    expect(d.level).toBe('detail');
  });

  it('overlap: terminal + diff + artifact all present → builder-inspector (terminal wins)', () => {
    const surface: SurfaceContext = {
      artifact: { resourcePath: 'codev/specs/1049-x.md' },
      builderDiff: { builderId: 'a' },
      builderTerminal: { builderId: 'b' },
    };
    const d = resolveMode(surface, null);
    expect(d.kind).toBe('builder-inspector');
    expect(d.context).toEqual({ builderId: 'b' });
  });
});

describe('resolveMode — worktree artifact carries a builder (architect note A2)', () => {
  it('worktree artifact → document-review detail AND the builder rides in context', () => {
    const surface: SurfaceContext = {
      artifact: { resourcePath: '.builders/spir-1049/codev/plans/1049-x.md', builderId: 'spir-1049' },
    };
    const d = resolveMode(surface, null);
    expect(d.kind).toBe('document-review');
    expect(d.level).toBe('detail');
    expect(d.context).toEqual({
      resourcePath: '.builders/spir-1049/codev/plans/1049-x.md',
      builderId: 'spir-1049',
    });
    // Builder-scoped modes remain applicable (navigable) with that builder in scope.
    expect(d.applicability['code-review']).toBe(true);
    expect(d.applicability['builder-inspector']).toBe(true);
  });

  it('clicking Code Review while viewing a worktree artifact scopes to that builder (A2 realized)', () => {
    const surface: SurfaceContext = {
      artifact: { resourcePath: '.builders/spir-1049/codev/specs/x.md', builderId: 'spir-1049' },
    };
    const d = resolveMode(surface, { mode: 'code-review' });
    expect(d.kind).toBe('code-review');
    expect(d.level).toBe('detail'); // that builder's detail, not the generic summary
    expect(d.context).toEqual({ builderId: 'spir-1049' });
  });

  it('clicking Builder Inspector while viewing a worktree artifact scopes to that builder (A2 realized)', () => {
    const surface: SurfaceContext = {
      artifact: { resourcePath: '.builders/spir-1049/codev/specs/x.md', builderId: 'spir-1049' },
    };
    const d = resolveMode(surface, { mode: 'builder-inspector' });
    expect(d.kind).toBe('builder-inspector');
    expect(d.level).toBe('detail');
    expect(d.context).toEqual({ builderId: 'spir-1049' });
  });

  it('clicking Code Review on a plain (non-worktree) artifact has no builder in scope → summary', () => {
    const surface: SurfaceContext = { artifact: { resourcePath: 'codev/specs/x.md' } };
    const d = resolveMode(surface, { mode: 'code-review' });
    expect(d.level).toBe('summary');
    expect(d.context).toEqual({});
  });
});

describe('resolveMode — applicability matrix (drives greyed pills)', () => {
  it('no artifact → document-review NOT applicable; others always applicable', () => {
    const d = resolveMode({ builderTerminal: { builderId: 'a' } }, null);
    expect(d.applicability).toEqual({
      'document-review': false,
      'code-review': true,
      'builder-inspector': true,
      'attention': true,
    });
  });

  it('artifact present → all four applicable', () => {
    const d = resolveMode({ artifact: { resourcePath: 'codev/reviews/1049-x.md' } }, null);
    expect(d.applicability).toEqual(ALL_APPLICABLE);
  });

  it('empty surface → only Document Review is inapplicable', () => {
    const d = resolveMode({}, null);
    expect(d.applicability['document-review']).toBe(false);
    expect(d.applicability['code-review']).toBe(true);
    expect(d.applicability['builder-inspector']).toBe(true);
    expect(d.applicability['attention']).toBe(true);
  });
});

describe('resolveMode — manual selection overrides context', () => {
  it('selecting attention over an artifact surface → attention summary (applicability still from surface)', () => {
    const surface: SurfaceContext = { artifact: { resourcePath: 'codev/specs/1049-x.md' } };
    const d = resolveMode(surface, { mode: 'attention' });
    expect(d.kind).toBe('attention');
    expect(d.level).toBe('summary');
    expect(d.applicability['document-review']).toBe(true); // surface still supports it
  });

  it('selecting code-review with no builder → summary (cross-builder list)', () => {
    const d = resolveMode({}, { mode: 'code-review' });
    expect(d.kind).toBe('code-review');
    expect(d.level).toBe('summary');
    expect(d.context).toEqual({});
  });

  it('drilling into a builder from code-review summary → that builder detail', () => {
    const selection: ManualSelection = { mode: 'code-review', builderId: 'spir-1049' };
    const d = resolveMode({}, selection);
    expect(d.kind).toBe('code-review');
    expect(d.level).toBe('detail');
    expect(d.context).toEqual({ builderId: 'spir-1049' });
  });

  it('drilling into a builder from builder-inspector summary → that builder detail', () => {
    const d = resolveMode({}, { mode: 'builder-inspector', builderId: 'bugfix-1408' });
    expect(d.kind).toBe('builder-inspector');
    expect(d.level).toBe('detail');
    expect(d.context).toEqual({ builderId: 'bugfix-1408' });
  });

  it('selecting document-review with an artifact → detail keyed by the artifact path', () => {
    const surface: SurfaceContext = { artifact: { resourcePath: 'codev/specs/1049-x.md' } };
    const d = resolveMode(surface, { mode: 'document-review' });
    expect(d.kind).toBe('document-review');
    expect(d.level).toBe('detail');
    expect(d.context).toEqual({ resourcePath: 'codev/specs/1049-x.md' });
  });

  it('selecting document-review with NO artifact is ignored (mode inapplicable) → contextual fallback', () => {
    const d = resolveMode({}, { mode: 'document-review' });
    expect(d.kind).toBe('attention'); // selection dropped, nothing else matches
  });

  it('an invalid selection mode is ignored → contextual resolution', () => {
    const surface: SurfaceContext = { builderDiff: { builderId: 'a' } };
    const d = resolveMode(surface, { mode: 'not-a-mode' as ModeKind });
    expect(d.kind).toBe('code-review');
  });
});

describe('resolveMode — never emits {document-review, summary}', () => {
  it('contextual document-review is detail', () => {
    const d = resolveMode({ artifact: { resourcePath: 'codev/specs/1049-x.md' } }, null);
    expect(d.kind).toBe('document-review');
    expect(d.level).toBe('detail');
  });

  it('selected document-review is detail', () => {
    const d = resolveMode(
      { artifact: { resourcePath: 'codev/specs/1049-x.md' } },
      { mode: 'document-review', builderId: 'spir-1049' },
    );
    expect(d.kind).toBe('document-review');
    expect(d.level).not.toBe('summary');
  });
});

describe('resolveMode — malformed/empty input degrades to attention (never throws)', () => {
  it('null surface and null selection → attention', () => {
    const d = resolveMode(null, null);
    expect(d.kind).toBe('attention');
  });

  it('undefined surface and undefined selection → attention', () => {
    const d = resolveMode(undefined, undefined);
    expect(d.kind).toBe('attention');
  });

  it('empty artifact resourcePath is treated as absent → attention', () => {
    const d = resolveMode({ artifact: { resourcePath: '' } }, null);
    expect(d.kind).toBe('attention');
    expect(d.applicability['document-review']).toBe(false);
  });

  it('builderDiff missing its builderId is treated as absent → attention', () => {
    const d = resolveMode({ builderDiff: {} as { builderId: string } }, null);
    expect(d.kind).toBe('attention');
  });

  it('does not throw on assorted malformed inputs (surface and selection)', () => {
    const surfaces: unknown[] = [
      null,
      undefined,
      {},
      { artifact: null },
      { builderTerminal: { builderId: 42 } },
      { artifact: { resourcePath: 123 } },
    ];
    const selections: unknown[] = [
      null,
      { mode: 'code-review' },
      { mode: 'code-review', builderId: 42 },
      { mode: 'not-a-mode' },
      { builderId: 'x' },
      42,
    ];
    for (const surface of surfaces) {
      for (const selection of selections) {
        expect(() => resolveMode(surface as SurfaceContext, selection as ManualSelection)).not.toThrow();
      }
    }
  });
});

describe('resolveMode — enforced purity (no host imports / no I/O)', () => {
  it('resolver.ts imports nothing but its own types (spec: O(1), no fs/network)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../contextual-panel/resolver.ts', import.meta.url)),
      'utf8',
    );
    const importSpecifiers = [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(importSpecifiers).toEqual(['./types.js']);
    expect(src).not.toMatch(/from\s+['"]vscode['"]/);
    expect(src).not.toMatch(/from\s+['"]node:/);
  });
});
