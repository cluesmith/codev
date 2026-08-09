import { describe, it, expect, afterEach } from 'vitest';
import { getWorkspaceTerminals } from '../servers/tower-terminals.js';
import { resolveAgentForSession } from '../servers/mailbox-wiring.js';
import type { WorkspaceTerminals } from '../servers/tower-types.js';

/**
 * Spec 1313 Phase 5 — the reverse map behind the fast triggers.
 *
 * A submit/quiescence signal carries only the emitting session's id, but delivery is
 * keyed on the canonical agent the mailbox row is addressed to. `resolveAgentForSession`
 * turns the id back into `{ workspacePath, toAgent }` (the inverse of
 * resolveLiveSessionForAgent) so a coalesced drain can be scheduled for the right mail.
 */
describe('resolveAgentForSession (Spec 1313 Phase 5)', () => {
  afterEach(() => getWorkspaceTerminals().clear());

  function seed(): void {
    const a: WorkspaceTerminals = {
      architects: new Map([['main', 'tid-arch']]),
      builders: new Map([['spir-1', 'tid-b1']]),
      shells: new Map([['shell-x', 'tid-sh']]),
      fileTabs: new Map(),
    };
    const b: WorkspaceTerminals = {
      architects: new Map(),
      builders: new Map([['spir-2', 'tid-b2']]),
      shells: new Map(),
      fileTabs: new Map(),
    };
    getWorkspaceTerminals().set('/ws/a', a);
    getWorkspaceTerminals().set('/ws/b', b);
  }

  it('maps a builder terminal id to its (workspace, agent), across workspaces', () => {
    seed();
    expect(resolveAgentForSession('tid-b1')).toEqual({ workspacePath: '/ws/a', toAgent: 'spir-1' });
    expect(resolveAgentForSession('tid-b2')).toEqual({ workspacePath: '/ws/b', toAgent: 'spir-2' });
  });

  it('maps an architect terminal id to its name (the canonical agent identity)', () => {
    seed();
    expect(resolveAgentForSession('tid-arch')).toEqual({ workspacePath: '/ws/a', toAgent: 'main' });
  });

  it('maps a shell terminal id too', () => {
    seed();
    expect(resolveAgentForSession('tid-sh')).toEqual({ workspacePath: '/ws/a', toAgent: 'shell-x' });
  });

  it('returns null for an id that belongs to no registered agent (unknown / torn down)', () => {
    seed();
    expect(resolveAgentForSession('tid-unknown')).toBeNull();
  });

  it('returns null when the registry is empty', () => {
    expect(resolveAgentForSession('anything')).toBeNull();
  });
});
