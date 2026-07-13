/**
 * Unit coverage for `hasRunnableDevCommand` (#975).
 *
 * This helper is the single source of truth for "is there a runnable
 * worktree.devCommand" across two surfaces: the `codev.hasDevCommand`
 * context key (gates the builder-row Run/Stop Dev menu) and the
 * Workspace view's Start-row visibility. The critical case is the empty
 * string: `ResolvedWorktreeConfig.devCommand` is typed `string | null`, so
 * `""` is reachable, and it must be treated as absent (matching
 * dev-shared.ts's `if (!devCommand)` runnability gate) — not as a present
 * command that errors on click.
 */

import { describe, it, expect } from 'vitest';
import type { ResolvedWorktreeConfig } from '@cluesmith/codev-types';
import { hasRunnableDevCommand } from '../load-worktree-config.js';

/** Minimal config stub — only `devCommand` matters to the helper. */
function cfg(devCommand: string | null): ResolvedWorktreeConfig {
  return { devCommand } as ResolvedWorktreeConfig;
}

describe('hasRunnableDevCommand', () => {
  it('returns false for a null config (Tower unreachable / not activated)', () => {
    expect(hasRunnableDevCommand(null)).toBe(false);
  });

  it('returns false when devCommand is null', () => {
    expect(hasRunnableDevCommand(cfg(null))).toBe(false);
  });

  it('returns false for an empty-string devCommand', () => {
    expect(hasRunnableDevCommand(cfg(''))).toBe(false);
  });

  it('returns false for a whitespace-only devCommand', () => {
    expect(hasRunnableDevCommand(cfg('   '))).toBe(false);
  });

  it('returns true for a real devCommand', () => {
    expect(hasRunnableDevCommand(cfg('pnpm dev'))).toBe(true);
  });

  it('returns true even when the command has surrounding whitespace', () => {
    expect(hasRunnableDevCommand(cfg('  pnpm dev  '))).toBe(true);
  });
});
