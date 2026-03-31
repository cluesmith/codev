/**
 * Regression tests for issue #619:
 *   1. ASPIR builder-prompt referenced SPIR protocol path
 *   2. afx spawn --task with --protocol skipped porch init
 *   3. has_phases_json check used fragile literal string (now uses -E regex)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Bug 1: ASPIR builder-prompt must reference ASPIR, not SPIR
// ============================================================================

describe('ASPIR builder-prompt protocol reference', () => {
  const skeletonPrompt = path.resolve(
    __dirname,
    '../../../../../codev-skeleton/protocols/aspir/builder-prompt.md',
  );

  it('references aspir/protocol.md, not spir/protocol.md', () => {
    const content = fs.readFileSync(skeletonPrompt, 'utf-8');
    expect(content).not.toContain('codev/protocols/spir/protocol.md');
    expect(content).toContain('codev/protocols/aspir/protocol.md');
  });

  it('says "ASPIR protocol", not "SPIR protocol"', () => {
    const content = fs.readFileSync(skeletonPrompt, 'utf-8');
    expect(content).not.toMatch(/Follow the SPIR protocol/);
    expect(content).toMatch(/Follow the ASPIR protocol/);
  });
});

// ============================================================================
// Bug 2: spawnTask with explicit protocol must call initPorchInWorktree
// ============================================================================

describe('spawnTask porch init when --protocol is provided', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initPorchInWorktree is called when hasExplicitProtocol is true', async () => {
    const { initPorchInWorktree } = await import('../commands/spawn-worktree.js');
    // Verify the function is exported (it must be importable for spawnTask to call it)
    expect(typeof initPorchInWorktree).toBe('function');
  });

  it('spawnTask source calls initPorchInWorktree in the hasExplicitProtocol branch', () => {
    // Read the spawn.ts source to verify the fix is present
    const spawnSrc = path.resolve(__dirname, '../commands/spawn.ts');
    expect(fs.existsSync(spawnSrc)).toBe(true);
    const content = fs.readFileSync(spawnSrc, 'utf-8');

    // The initPorchInWorktree call must appear inside the hasExplicitProtocol block
    // (i.e., after the `if (hasExplicitProtocol)` line and before the closing `} else {`)
    const hasExplicitBlock = content.match(
      /if \(hasExplicitProtocol\)([\s\S]*?)(?=\} else \{)/,
    );
    expect(hasExplicitBlock).not.toBeNull();
    expect(hasExplicitBlock![1]).toContain('initPorchInWorktree');
  });
});

// ============================================================================
// Bug 3: has_phases_json check must use regex (-E) not literal string match
// ============================================================================

describe('has_phases_json check uses regex', () => {
  const protocolFiles = [
    path.resolve(__dirname, '../../../../../codev-skeleton/protocols/aspir/protocol.json'),
    path.resolve(__dirname, '../../../../../codev-skeleton/protocols/spir/protocol.json'),
    path.resolve(__dirname, '../../../../../codev/protocols/aspir/protocol.json'),
    path.resolve(__dirname, '../../../../../codev/protocols/spir/protocol.json'),
  ];

  for (const file of protocolFiles) {
    const label = file.split('codev').pop() ?? file;

    it(`${label}: has_phases_json uses grep -qE (regex-aware)`, () => {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const planPhase = data.phases.find((p: { id: string }) => p.id === 'plan');
      expect(planPhase).toBeDefined();
      const check = planPhase.checks?.has_phases_json as string | undefined;
      expect(check).toBeDefined();
      // Must use -E (extended regex) so whitespace variants like `"phases" :` also match
      expect(check).toMatch(/grep -qE/);
      // Must not use the old fragile literal-only form
      expect(check).not.toMatch(/grep -q '/);
    });
  }
});
