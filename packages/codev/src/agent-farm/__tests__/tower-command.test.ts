import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/config.js', () => ({
  getConfig: vi.fn(() => ({ serversDir: '/tmp/codev-test-servers' })),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    header: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    kv: vi.fn(),
    blank: vi.fn(),
  },
  fatal: vi.fn((message: string) => {
    throw new Error(message);
  }),
}));

vi.mock('../lib/tower-client.js', () => ({
  DEFAULT_TOWER_PORT: 4100,
  AGENT_FARM_DIR: '/tmp/codev-test-agent-farm',
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(),
    execSync: vi.fn(() => {
      throw new Error('no process on port');
    }),
  };
});

describe('tower command lifecycle options', () => {
  it('waits for tower start readiness by default', async () => {
    const { shouldWaitForTowerStart } = await import('../commands/tower.js');

    expect(shouldWaitForTowerStart()).toBe(true);
    expect(shouldWaitForTowerStart({ wait: undefined })).toBe(true);
    expect(shouldWaitForTowerStart({ wait: false })).toBe(false);
  });
});
