import { describe, it, expect } from 'vitest';
import { PORCH_VERSION } from '../version';

describe('PORCH_VERSION', () => {
  it('exports a semver-formatted string', () => {
    expect(PORCH_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is 1.0.0', () => {
    expect(PORCH_VERSION).toBe('1.0.0');
  });
});
