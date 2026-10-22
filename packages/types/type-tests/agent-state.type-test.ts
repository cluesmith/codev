/**
 * Compile-time guard for the agent-state contract (Spec 1595, phase 1).
 *
 * Never executed or shipped; checked by `check-types:tests` (see
 * canvas-command.type-test.ts for why it lives outside `src/`).
 *
 * What it protects: Constraint 13. `agentState` (and `ArchitectState.lastDataAt`) are
 * optional and nullable, so an older Tower paired with a newer client, or the reverse,
 * keeps compiling and working. Making either field required breaks this file.
 */

import type {
  AgentLifecycleEvent,
  AgentState,
  ArchitectState,
  OverviewBuilder,
  ServedAgentState,
} from '../src/index.js';

type BuilderBase = Omit<OverviewBuilder, 'agentState'>;
declare const base: BuilderBase;

const absent: OverviewBuilder = base;
const nulled: OverviewBuilder = { ...base, agentState: null };

declare const served: ServedAgentState;
const present: OverviewBuilder = { ...base, agentState: served };

const architectBare: ArchitectState = { name: 'main', port: 0, pid: 0 };
const architectNulled: ArchitectState = { name: 'main', port: 0, pid: 0, agentState: null, lastDataAt: null };

// The five served states, exhaustively: adding one breaks this map until it is classified.
const servedStates: Record<AgentState, true> = {
  'working': true,
  'needs-input': true,
  'idle': true,
  'blocked': true,
  'dead': true,
};

// Both identity forms are accepted; a cwd field is not part of the contract.
const builderEvent: AgentLifecycleEvent = {
  agent: { kind: 'builder', worktreePath: '/w/.builders/x' },
  sessionId: 's',
  event: 'turn-started',
  at: 0,
};
const architectEvent: AgentLifecycleEvent = {
  agent: { kind: 'architect', workspacePath: '/w', name: 'main' },
  sessionId: 's',
  event: 'needs-input',
  at: 0,
  needsInput: { kind: 'permission', tool: 'Bash', summary: 'pnpm test' },
};

export { absent, nulled, present, architectBare, architectNulled, servedStates, builderEvent, architectEvent };
