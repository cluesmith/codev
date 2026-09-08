import { describe, it, expect, afterEach } from 'vitest';
import { readLocalKey, ensureLocalKey } from '../auth.js';

/**
 * The `CODEV_TOWER_KEY` env override is the supported way for a client (or Tower)
 * to use an explicit shared key instead of the on-disk `local-key` file — the
 * migration path for BRIDGE_MODE / containerized deployments where the client and
 * Tower do not share the file.
 */
describe('CODEV_TOWER_KEY override', () => {
  const original = process.env.CODEV_TOWER_KEY;
  const OVERRIDE = 'a'.repeat(64);

  afterEach(() => {
    if (original === undefined) delete process.env.CODEV_TOWER_KEY;
    else process.env.CODEV_TOWER_KEY = original;
  });

  it('readLocalKey returns the env override when set', () => {
    process.env.CODEV_TOWER_KEY = OVERRIDE;
    expect(readLocalKey()).toBe(OVERRIDE);
  });

  it('ensureLocalKey returns the env override (never generating/reading a file)', () => {
    process.env.CODEV_TOWER_KEY = OVERRIDE;
    expect(ensureLocalKey()).toBe(OVERRIDE);
  });

  it('trims surrounding whitespace on the override', () => {
    process.env.CODEV_TOWER_KEY = `  ${OVERRIDE}\n`;
    expect(readLocalKey()).toBe(OVERRIDE);
  });

  it('an empty/whitespace override is ignored (falls through to the file)', () => {
    process.env.CODEV_TOWER_KEY = '   ';
    expect(readLocalKey()).not.toBe('   ');
  });
});
