/**
 * #1494 — the Approve button relays the human's decision to the builder's
 * spawning architect instead of shelling out to `porch approve` itself.
 *
 * These tests pin the pure core of that change:
 *  - `decideApprovalRelay` — the four routing branches, provable without a Tower.
 *  - `buildRelayMessage`   — the message names gate, builder, artifact, provenance, and the command.
 *  - `interpretRelayResult`— relayed / held / failed, never "approved" (the `held` case is first-class).
 *
 * `approve.ts` imports `vscode` at module load, so we mock it even though the
 * functions under test never touch it (established `__tests__` pattern).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
  },
  commands: { executeCommand: vi.fn() },
}));

import {
  decideApprovalRelay,
  buildRelayMessage,
  interpretRelayResult,
} from '../commands/approve.js';

describe('decideApprovalRelay', () => {
  it('owner set and live → relay to that architect', () => {
    expect(decideApprovalRelay('vscode', ['main', 'vscode'])).toEqual({ kind: 'relay', architect: 'vscode' });
  });

  it('owner set but NOT live → refuse-offline (never reroute to another architect)', () => {
    expect(decideApprovalRelay('vscode', ['main'])).toEqual({ kind: 'refuse-offline', architect: 'vscode' });
  });

  it('owner set but no architect live at all → refuse-offline (the named owner is still the owner)', () => {
    expect(decideApprovalRelay('vscode', [])).toEqual({ kind: 'refuse-offline', architect: 'vscode' });
  });

  it('owner null but architects are live → refuse-unknown-owner (won\'t guess — avoids #1406)', () => {
    expect(decideApprovalRelay(null, ['main'])).toEqual({ kind: 'refuse-unknown-owner' });
  });

  it('owner null and no architect live → no-live-architect (nobody to relay to)', () => {
    expect(decideApprovalRelay(null, [])).toEqual({ kind: 'no-live-architect' });
  });

  it('empty-string owner is treated as null', () => {
    expect(decideApprovalRelay('', [])).toEqual({ kind: 'no-live-architect' });
    expect(decideApprovalRelay('', ['main'])).toEqual({ kind: 'refuse-unknown-owner' });
  });

  it('never routes to `main` as a fallback for a null owner (the #1406 hazard)', () => {
    // A null owner with `main` live must NOT relay to main — it must refuse.
    const d = decideApprovalRelay(null, ['main', 'vscode']);
    expect(d.kind).toBe('refuse-unknown-owner');
  });
});

describe('buildRelayMessage', () => {
  const msg = buildRelayMessage({ id: 'pir-1494', gateLabel: 'plan review', issueId: '1494' });

  it('is a short, human-style notice naming the gate, builder, issue, and VS Code provenance', () => {
    expect(msg).toBe('Human approved the plan review gate for pir-1494 (#1494) in VS Code.');
  });

  it('does NOT name porch or spell out a command (the architect passes it on)', () => {
    expect(msg).not.toContain('porch');
    expect(msg).not.toContain('--a-human-explicitly-approved-this');
  });

  it('omits the issue ref when no issue id is known', () => {
    const m = buildRelayMessage({ id: 'pir-9', gateLabel: 'PR' });
    expect(m).toBe('Human approved the PR gate for pir-9 in VS Code.');
  });
});

describe('interpretRelayResult', () => {
  it('!ok → error, and says the gate is NOT approved', () => {
    const o = interpretRelayResult({ ok: false, error: 'Tower not running' }, 'vscode', 'plan review', '#1494');
    expect(o.kind).toBe('error');
    expect(o.message).toContain('Tower not running');
    expect(o.message).toContain('NOT approved');
  });

  it('held → held outcome, names the reason, and says NOT approved yet (first-class)', () => {
    const o = interpretRelayResult({ ok: true, held: true, reason: 'busy' }, 'vscode', 'plan review', '#1494');
    expect(o.kind).toBe('held');
    expect(o.message).toContain('busy');
    expect(o.message).toContain('NOT approved yet');
  });

  it('delivered → relayed (NOT "approved" — the architect passes it to the builder)', () => {
    const o = interpretRelayResult({ ok: true, delivered: true, held: false }, 'vscode', 'plan review', '#1494');
    expect(o.kind).toBe('relayed');
    expect(o.message).toContain('pass it on to the builder');
    expect(o.message).not.toContain('approved.');
  });

  it('older Tower omitting held/delivered reads as relayed (back-compat)', () => {
    const o = interpretRelayResult({ ok: true }, 'vscode', 'plan review', '#1494');
    expect(o.kind).toBe('relayed');
  });
});
