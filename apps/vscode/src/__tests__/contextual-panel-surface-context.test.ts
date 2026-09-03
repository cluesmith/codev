/**
 * Unit tests for the pure surface-context derivation and identity helpers (Phase 3).
 *
 * These exercise `deriveSurfaceContext` (independent-predicate collection, worktree builder scoping,
 * the multi-diff-vs-normal-tab distinction, terminal focus gating) and `surfaceIdentity` (including
 * the cross-builder transition) with plain inputs — no VS Code host.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveSurfaceContext,
  surfaceKey,
  type DeriveInputs,
  type TabInfo,
} from '../contextual-panel/surface-context.js';

function inputs(partial: Partial<DeriveInputs> & { tab: TabInfo }): DeriveInputs {
  return {
    focused: 'editor',
    lookupDiffBuilderId: () => undefined,
    ...partial,
  };
}

describe('deriveSurfaceContext — artifact predicate', () => {
  it('a text tab under codev/specs is an artifact', () => {
    const ctx = deriveSurfaceContext(
      inputs({ tab: { kind: 'text', uriPath: '/w/codev/specs/1049-x.md', uriFsPath: '/w/codev/specs/1049-x.md' } }),
    );
    expect(ctx).toEqual({ artifact: { resourcePath: '/w/codev/specs/1049-x.md' } });
  });

  it('the codev.markdownPreview custom editor is an artifact (activeTextEditor would be undefined)', () => {
    const ctx = deriveSurfaceContext(
      inputs({
        tab: { kind: 'custom', viewType: 'codev.markdownPreview', uriPath: '/w/codev/plans/x.md', uriFsPath: '/w/codev/plans/x.md' },
      }),
    );
    expect(ctx.artifact?.resourcePath).toBe('/w/codev/plans/x.md');
  });

  it('a worktree artifact carries its builderId from the .builders/<id>/ segment', () => {
    const ctx = deriveSurfaceContext(
      inputs({
        tab: { kind: 'text', uriPath: '/w/.builders/spir-1049/codev/specs/x.md', uriFsPath: '/w/.builders/spir-1049/codev/specs/x.md' },
      }),
    );
    expect(ctx.artifact).toEqual({ resourcePath: '/w/.builders/spir-1049/codev/specs/x.md', builderId: 'spir-1049' });
  });

  it('a non-artifact text file is no predicate', () => {
    expect(deriveSurfaceContext(inputs({ tab: { kind: 'text', uriPath: '/w/src/foo.ts', uriFsPath: '/w/src/foo.ts' } }))).toEqual({});
  });

  it('a custom editor that is not markdownPreview is not an artifact', () => {
    const ctx = deriveSurfaceContext(
      inputs({ tab: { kind: 'custom', viewType: 'other.editor', uriPath: '/w/codev/specs/x.md', uriFsPath: '/w/codev/specs/x.md' } }),
    );
    expect(ctx.artifact).toBeUndefined();
  });
});

describe('deriveSurfaceContext — builder-diff predicate', () => {
  it('a TabInputTextDiff resolves the builder from the modified (right) side via the registry', () => {
    const ctx = deriveSurfaceContext(
      inputs({
        tab: { kind: 'diff', modifiedFsPath: '/w/.builders/b/x.ts' },
        lookupDiffBuilderId: (p) => (p === '/w/.builders/b/x.ts' ? 'b' : undefined),
      }),
    );
    expect(ctx).toEqual({ builderDiff: { builderId: 'b' } });
  });

  it('the multi-file diff (unknown tab input) resolves the builder from the focused sub-file', () => {
    const ctx = deriveSurfaceContext(
      inputs({
        tab: { kind: 'other' },
        activeEditorFsPath: '/w/.builders/b/x.ts',
        lookupDiffBuilderId: (p) => (p === '/w/.builders/b/x.ts' ? 'b' : undefined),
      }),
    );
    expect(ctx.builderDiff).toEqual({ builderId: 'b' });
  });

  it('a registered builder file opened as a NORMAL text tab is NOT a diff', () => {
    const ctx = deriveSurfaceContext(
      inputs({
        tab: { kind: 'text', uriPath: '/w/.builders/b/x.ts', uriFsPath: '/w/.builders/b/x.ts' },
        activeEditorFsPath: '/w/.builders/b/x.ts',
        lookupDiffBuilderId: () => 'b', // registry would match, but the tab is a plain editor
      }),
    );
    expect(ctx.builderDiff).toBeUndefined();
  });

  it('a diff on a codev artifact emits BOTH builderDiff and artifact (independent predicates)', () => {
    const ctx = deriveSurfaceContext(
      inputs({
        tab: {
          kind: 'diff',
          modifiedPath: '/w/.builders/b/codev/specs/x.md',
          modifiedFsPath: '/w/.builders/b/codev/specs/x.md',
        },
        lookupDiffBuilderId: () => 'b',
      }),
    );
    // The resolver picks code-review (diff wins); the artifact predicate keeps Document Review navigable.
    expect(ctx.builderDiff).toEqual({ builderId: 'b' });
    expect(ctx.artifact).toEqual({ resourcePath: '/w/.builders/b/codev/specs/x.md', builderId: 'b' });
  });

  it('a diff on a NON-artifact file emits only builderDiff', () => {
    const ctx = deriveSurfaceContext(
      inputs({ tab: { kind: 'diff', modifiedPath: '/w/.builders/b/src/x.ts', modifiedFsPath: '/w/.builders/b/src/x.ts' }, lookupDiffBuilderId: () => 'b' }),
    );
    expect(ctx).toEqual({ builderDiff: { builderId: 'b' } });
  });
});

describe('deriveSurfaceContext — terminal predicate (focus-gated)', () => {
  it('present only when the terminal is the focused surface', () => {
    expect(deriveSurfaceContext(inputs({ tab: { kind: 'none' }, focused: 'terminal', activeTerminalBuilderId: 'b' }))).toEqual({
      builderTerminal: { builderId: 'b' },
    });
    expect(deriveSurfaceContext(inputs({ tab: { kind: 'none' }, focused: 'editor', activeTerminalBuilderId: 'b' }))).toEqual({});
  });
});

describe('surfaceKey — raw surface identity for transition detection', () => {
  it('distinguishes two ordinary files that both resolve to Attention', () => {
    const a = surfaceKey(inputs({ tab: { kind: 'text', uriPath: '/w/a.ts', uriFsPath: '/w/a.ts' } }));
    const b = surfaceKey(inputs({ tab: { kind: 'text', uriPath: '/w/b.ts', uriFsPath: '/w/b.ts' } }));
    expect(a).not.toBe(b);
  });

  it('is stable for the same file (a cursor move must not read as a transition)', () => {
    const key = () => surfaceKey(inputs({ tab: { kind: 'text', uriPath: '/w/a.ts', uriFsPath: '/w/a.ts' } }));
    expect(key()).toBe(key());
  });

  it("distinguishes a file's raw editor from its codev.markdownPreview (same path, different surface)", () => {
    const text = surfaceKey(inputs({ tab: { kind: 'text', uriPath: '/w/codev/specs/x.md', uriFsPath: '/w/codev/specs/x.md' } }));
    const custom = surfaceKey(
      inputs({ tab: { kind: 'custom', viewType: 'codev.markdownPreview', uriPath: '/w/codev/specs/x.md', uriFsPath: '/w/codev/specs/x.md' } }),
    );
    expect(text).not.toBe(custom);
  });

  it('distinguishes two different builder terminals', () => {
    const a = surfaceKey(inputs({ tab: { kind: 'none' }, focused: 'terminal', activeTerminalBuilderId: 'a' }));
    const b = surfaceKey(inputs({ tab: { kind: 'none' }, focused: 'terminal', activeTerminalBuilderId: 'b' }));
    expect(a).not.toBe(b);
  });

  it('changes when focus moves from an editor tab to a terminal', () => {
    const editor = surfaceKey(inputs({ tab: { kind: 'text', uriPath: '/w/a.ts', uriFsPath: '/w/a.ts' }, activeTerminalBuilderId: 'b' }));
    const terminal = surfaceKey(inputs({ tab: { kind: 'text', uriPath: '/w/a.ts', uriFsPath: '/w/a.ts' }, focused: 'terminal', activeTerminalBuilderId: 'b' }));
    expect(editor).not.toBe(terminal);
  });
});
