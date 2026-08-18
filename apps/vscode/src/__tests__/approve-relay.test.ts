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
  const msg = buildRelayMessage({
    id: 'pir-1494',
    gate: 'plan-approval',
    gateLabel: 'plan review',
    issueRef: '#1494',
    issueTitle: 'relay approvals through the architect',
    worktreePath: '/repo/.builders/pir-1494',
  });

  it('names the gate, the builder, the issue, and the human-click provenance', () => {
    expect(msg).toContain('plan review');
    expect(msg).toContain('pir-1494');
    expect(msg).toContain('#1494');
    expect(msg).toContain('relay approvals through the architect');
    expect(msg).toContain('clicking Approve in VS Code');
  });

  it('carries the exact command including the human-approval flag', () => {
    expect(msg).toContain('porch approve pir-1494 plan-approval --a-human-explicitly-approved-this');
  });

  it('names a gate-appropriate artifact and the worktree', () => {
    expect(msg).toContain('codev/plans/');
    expect(msg).toContain('/repo/.builders/pir-1494');
  });

  it('omits the worktree line when no path is known', () => {
    const m = buildRelayMessage({ id: 'x', gate: 'pr', gateLabel: 'PR', issueRef: 'x' });
    expect(m).not.toContain('Worktree:');
    expect(m).toContain('the open PR');
  });
});

describe('interpretRelayResult', () => {
  it('!ok → error, and says the gate is NOT approved', () => {
    const o = interpretRelayResult({ ok: false, error: 'Tower not running' }, 'vscode', 'plan review', '#1494');
    expect(o.kind).toBe('error');
    expect(o.message).toContain('Tower not running');
    expect(o.message).toContain('NOT approved');
  });

  it('held → held outcome, names the reason, and says NOT yet approved (first-class)', () => {
    const o = interpretRelayResult({ ok: true, held: true, reason: 'busy' }, 'vscode', 'plan review', '#1494');
    expect(o.kind).toBe('held');
    expect(o.message).toContain('busy');
    expect(o.message).toContain('NOT yet approved');
  });

  it('delivered → relayed (NOT "approved" — the architect still runs the command)', () => {
    const o = interpretRelayResult({ ok: true, delivered: true, held: false }, 'vscode', 'plan review', '#1494');
    expect(o.kind).toBe('relayed');
    expect(o.message).toContain('relayed');
    expect(o.message).toContain('they will run porch approve');
  });

  it('older Tower omitting held/delivered reads as relayed (back-compat)', () => {
    const o = interpretRelayResult({ ok: true }, 'vscode', 'plan review', '#1494');
    expect(o.kind).toBe('relayed');
  });
});
