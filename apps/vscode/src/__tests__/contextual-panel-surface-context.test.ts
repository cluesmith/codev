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
  surfaceIdentity,
  type DeriveInputs,
  type TabInfo,
} from '../contextual-panel/surface-context.js';
import type { ModeDescriptor, ModeKind } from '../contextual-panel/types.js';

function inputs(partial: Partial<DeriveInputs> & { tab: TabInfo }): DeriveInputs {
  return {
    focused: 'editor',
    lookupDiffBuilderId: () => undefined,
    ...partial,
  };
}

const ALL_APPLICABLE: Record<ModeKind, boolean> = {
  'document-review': true,
  'code-review': true,
  'builder-inspector': true,
  'attention': true,
};

function descriptor(kind: ModeKind, builderId?: string, resourcePath?: string): ModeDescriptor {
  return { kind, level: 'detail', context: { builderId, resourcePath }, applicability: ALL_APPLICABLE };
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

  it('a diff tab on a codev artifact path yields only builderDiff (precedence handled by the resolver)', () => {
    const ctx = deriveSurfaceContext(
      inputs({ tab: { kind: 'diff', modifiedFsPath: '/w/.builders/b/codev/specs/x.md' }, lookupDiffBuilderId: () => 'b' }),
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

describe('surfaceIdentity', () => {
  it('differs when builderId changes at the same kind (cross-builder transition, #1497 guard)', () => {
    expect(surfaceIdentity(descriptor('builder-inspector', 'a'))).not.toBe(surfaceIdentity(descriptor('builder-inspector', 'b')));
  });

  it('is stable when nothing changes', () => {
    expect(surfaceIdentity(descriptor('code-review', 'a'))).toBe(surfaceIdentity(descriptor('code-review', 'a')));
  });

  it('differs when the kind changes', () => {
    expect(surfaceIdentity(descriptor('attention'))).not.toBe(surfaceIdentity(descriptor('document-review', undefined, '/x.md')));
  });
});
