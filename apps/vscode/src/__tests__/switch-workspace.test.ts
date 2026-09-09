/**
 * Unit tests for the Tower switch/activate command logic. The side effects are injected, so the
 * decision tree — switch vs activate, adopt-confirm-before-write, rate-limit reporting, refresh +
 * open ordering — is tested directly; and the quick-pick builder is pure. Mocks only the tiny slice
 * of `vscode` the module touches at import.
 */

import { describe, it, expect, vi } from 'vitest';
import type { OverviewData } from '@cluesmith/codev-types';
import type { TowerWorkspace } from '@cluesmith/codev-sdk/tower-client';
import { deriveAttention } from '@cluesmith/codev-sdk/builder-helpers';
import type { FleetEntry } from '../views/tower-cache.js';

vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1, Default: 0 },
}));

const { openOrActivateWorkspace, activationErrorMessage, buildWorkspacePicks } = await import('../commands/switch-workspace.js');
type WorkspaceActionDeps = Parameters<typeof openOrActivateWorkspace>[0];

function stubDeps(over: Partial<WorkspaceActionDeps> = {}): WorkspaceActionDeps {
  return {
    runCommand: vi.fn(async () => undefined),
    activate: vi.fn(async () => ({ ok: true })),
    isAdopted: vi.fn(() => true),
    confirmAdopt: vi.fn(async () => true),
    notify: vi.fn(),
    notifyError: vi.fn(),
    refresh: vi.fn(async () => undefined),
    ...over,
  };
}

describe('openOrActivateWorkspace', () => {
  it('switches to an active workspace via codev.focusWorkspaceWindow, without activating', async () => {
    const deps = stubDeps();
    await openOrActivateWorkspace(deps, { path: '/w/a', active: true, name: 'a' });
    expect(deps.runCommand).toHaveBeenCalledWith('codev.focusWorkspaceWindow', '/w/a');
    expect(deps.activate).not.toHaveBeenCalled();
  });

  it('activates an already-adopted dormant workspace without an adopt prompt, then opens it', async () => {
    const deps = stubDeps({ isAdopted: vi.fn(() => true) });
    await openOrActivateWorkspace(deps, { path: '/w/d', active: false, name: 'd' });
    expect(deps.confirmAdopt).not.toHaveBeenCalled();
    expect(deps.activate).toHaveBeenCalledWith('/w/d');
    expect(deps.refresh).toHaveBeenCalled();
    expect(deps.runCommand).toHaveBeenCalledWith('codev.focusWorkspaceWindow', '/w/d');
  });

  it('confirms before adopting a non-Codev directory, and aborts if declined', async () => {
    const deps = stubDeps({ isAdopted: vi.fn(() => false), confirmAdopt: vi.fn(async () => false) });
    await openOrActivateWorkspace(deps, { path: '/w/new', active: false, name: 'new' });
    expect(deps.confirmAdopt).toHaveBeenCalled();
    expect(deps.activate).not.toHaveBeenCalled();
    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  it('activates after an accepted adopt confirmation and reports the adopt', async () => {
    const deps = stubDeps({ isAdopted: vi.fn(() => false), confirmAdopt: vi.fn(async () => true), activate: vi.fn(async () => ({ ok: true, adopted: true })) });
    await openOrActivateWorkspace(deps, { path: '/w/new', active: false, name: 'new' });
    expect(deps.activate).toHaveBeenCalledWith('/w/new');
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining('new'));
    expect(deps.runCommand).toHaveBeenCalledWith('codev.focusWorkspaceWindow', '/w/new');
  });

  it('reports a rate-limited activation and does not open a window', async () => {
    const deps = stubDeps({ activate: vi.fn(async () => ({ ok: false, error: 'Too many activations, try again later' })) });
    await openOrActivateWorkspace(deps, { path: '/w/d', active: false, name: 'd' });
    expect(deps.notifyError).toHaveBeenCalledWith(expect.stringContaining('Too many'));
    expect(deps.runCommand).not.toHaveBeenCalled();
  });
});

describe('activationErrorMessage', () => {
  it('recognises the rate-limit case', () => {
    expect(activationErrorMessage('a', 'Too many activations')).toMatch(/wait a moment/i);
    expect(activationErrorMessage('a', 'HTTP 429')).toMatch(/wait a moment/i);
  });
  it('passes through other errors and handles a missing error', () => {
    expect(activationErrorMessage('a', 'boom')).toContain('boom');
    expect(activationErrorMessage('a')).toBe("Couldn't activate a.");
  });
});

// --- buildWorkspacePicks ---

function wsRow(path: string, name: string, active: boolean): TowerWorkspace {
  return { path, name, active, proxyUrl: '', terminals: active ? 1 : 0 };
}
function blocked(): OverviewData {
  return { builders: [{ id: 'b0', issueId: null, issueTitle: null, phase: 'plan', blocked: 'plan review', blockedGate: 'plan-approval', blockedSince: '2026-09-01T10:00:00Z', prReady: false, lastDataAt: null }], backlog: [], pendingPRs: [], recentlyClosed: [], architects: [], heldCount: 0, mailboxEscalated: false, queuedFeedback: {}, feedbackMode: 'forward' } as unknown as OverviewData;
}
function quiet(): OverviewData {
  return { builders: [], backlog: [], pendingPRs: [], recentlyClosed: [], architects: [], heldCount: 0, mailboxEscalated: false, queuedFeedback: {}, feedbackMode: 'forward' } as unknown as OverviewData;
}
function entry(ws: TowerWorkspace, overview: OverviewData | null): FleetEntry {
  return { workspace: ws, attention: deriveAttention(overview) };
}

describe('buildWorkspacePicks', () => {
  it('orders active by urgency, marks current, and groups dormant behind a separator', () => {
    const fleet = [
      entry(wsRow('/w/quiet', 'quiet', true), quiet()),
      entry(wsRow('/w/gate', 'gate', true), blocked()),
      entry(wsRow('/w/sleepy', 'sleepy', false), null),
    ];
    const picks = buildWorkspacePicks(fleet, '/w/quiet');
    expect(picks.map((p) => p.label)).toEqual(['gate', 'quiet', 'Dormant', 'sleepy']);
    // current marked
    expect(picks.find((p) => p.label === 'quiet')!.description).toContain('current');
    // gate annotated
    expect(picks.find((p) => p.label === 'gate')!.description).toContain('plan review');
    // separator row
    expect(picks.find((p) => p.label === 'Dormant')!.kind).toBe(-1);
    // dormant target carries its path and active:false
    expect(picks.find((p) => p.label === 'sleepy')!.target).toEqual({ path: '/w/sleepy', active: false, name: 'sleepy' });
  });

  it('omits the dormant separator when every workspace is active', () => {
    const fleet = [entry(wsRow('/w/a', 'a', true), quiet())];
    const picks = buildWorkspacePicks(fleet, null);
    expect(picks.map((p) => p.label)).toEqual(['a']);
  });
});
