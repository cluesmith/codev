import { describe, it, expect, afterEach } from 'vitest';
import { readLocalKey } from '../node/local-key.js';

/**
 * The Node auth adapter honors `CODEV_TOWER_KEY` so a Node consumer (VS Code host,
 * Stream Deck plugin) can reach a Tower whose `local-key` file it does not share
 * (containerized / BRIDGE_MODE deployments). Kept in lockstep with the same
 * override in `@cluesmith/codev-core`'s auth module.
 */
describe('sdk/node readLocalKey CODEV_TOWER_KEY override', () => {
  const original = process.env.CODEV_TOWER_KEY;

  afterEach(() => {
    if (original === undefined) delete process.env.CODEV_TOWER_KEY;
    else process.env.CODEV_TOWER_KEY = original;
  });

  it('returns the env override when set', () => {
    const key = 'b'.repeat(64);
    process.env.CODEV_TOWER_KEY = key;
    expect(readLocalKey()).toBe(key);
  });

  it('trims and ignores an empty override', () => {
    const key = 'c'.repeat(64);
    process.env.CODEV_TOWER_KEY = `\t${key} `;
    expect(readLocalKey()).toBe(key);
    process.env.CODEV_TOWER_KEY = '  ';
    expect(readLocalKey()).not.toBe('  ');
  });
});
