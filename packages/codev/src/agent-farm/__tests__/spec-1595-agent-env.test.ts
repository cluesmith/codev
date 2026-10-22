/**
 * Spec 1595: the launch-environment variables the lifecycle reporter reads.
 *
 * `CODEV_ARCHITECT_WORKSPACE` is identity, so `sanitizeAgentEnv` strips it like
 * the builder worktree: a Tower started from an architect's shell must not hand
 * that identity on. `CODEV_TOWER_PORT` is not stripped, because Tower overwrites
 * it on the final env of every session it creates (`withTowerPort`).
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_TOWER_PORT } from '@cluesmith/codev-sdk/constants';
import {
  ARCHITECT_WORKSPACE_ENV,
  TOWER_PORT_ENV,
  sanitizeAgentEnv,
  withTowerPort,
} from '../../lib/agent-env.js';

describe('Spec 1595 agent env', () => {
  it('names the variables', () => {
    expect(ARCHITECT_WORKSPACE_ENV).toBe('CODEV_ARCHITECT_WORKSPACE');
    expect(TOWER_PORT_ENV).toBe('CODEV_TOWER_PORT');
  });

  it('sanitizeAgentEnv strips CODEV_ARCHITECT_WORKSPACE and keeps CODEV_TOWER_PORT', () => {
    const out = sanitizeAgentEnv({
      PATH: '/usr/bin',
      CODEV_ARCHITECT_WORKSPACE: '/repo',
      CODEV_ARCHITECT_NAME: 'main',
      CODEV_TOWER_PORT: '4100',
    });
    expect(out).toEqual({ PATH: '/usr/bin', CODEV_ARCHITECT_NAME: 'main', CODEV_TOWER_PORT: '4100' });
  });

  it('withTowerPort overwrites an inherited port and leaves the rest', () => {
    expect(withTowerPort({ PATH: '/usr/bin', CODEV_TOWER_PORT: '1' }, 4242))
      .toEqual({ PATH: '/usr/bin', CODEV_TOWER_PORT: '4242' });
  });

  it('withTowerPort defaults to DEFAULT_TOWER_PORT only when no port is known', () => {
    expect(withTowerPort({}, undefined)).toEqual({ CODEV_TOWER_PORT: String(DEFAULT_TOWER_PORT) });
  });
});
