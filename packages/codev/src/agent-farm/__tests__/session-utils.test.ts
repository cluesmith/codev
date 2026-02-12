/**
 * Tests for shared session-naming utilities (Spec 0099 Phase 5)
 */

import { describe, it, expect } from 'vitest';
import { getBuilderSessionName } from '../utils/session.js';
import type { Config } from '../types.js';

function makeConfig(projectRoot: string): Config {
  return {
    projectRoot,
    codevDir: `${projectRoot}/codev`,
    stateDir: `${projectRoot}/.agent-farm`,
    buildersDir: `${projectRoot}/.builders`,
  } as Config;
}

describe('getBuilderSessionName', () => {
  it('should return builder-{basename}-{id}', () => {
    const config = makeConfig('/home/user/my-project');
    expect(getBuilderSessionName(config, '0042')).toBe('builder-my-project-0042');
  });

  it('should use only the basename of projectRoot', () => {
    const config = makeConfig('/deeply/nested/path/to/repo');
    expect(getBuilderSessionName(config, 'bugfix-99')).toBe('builder-repo-bugfix-99');
  });

  it('should handle single-segment project paths', () => {
    const config = makeConfig('/project');
    expect(getBuilderSessionName(config, '0001')).toBe('builder-project-0001');
  });
});
