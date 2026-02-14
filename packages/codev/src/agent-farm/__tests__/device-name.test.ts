/**
 * Tests for device name normalization and validation (Spec 0107)
 */

import { describe, it, expect } from 'vitest';
import { normalizeDeviceName, validateDeviceName } from '../lib/device-name.js';

describe('normalizeDeviceName', () => {
  it('trims whitespace', () => {
    expect(normalizeDeviceName('  my-tower  ')).toBe('my-tower');
  });

  it('converts to lowercase', () => {
    expect(normalizeDeviceName('My-Tower')).toBe('my-tower');
  });

  it('replaces spaces with hyphens', () => {
    expect(normalizeDeviceName('my tower name')).toBe('my-tower-name');
  });

  it('replaces underscores with hyphens', () => {
    expect(normalizeDeviceName('my_tower_name')).toBe('my-tower-name');
  });

  it('strips invalid characters', () => {
    expect(normalizeDeviceName('my@tower!name#123')).toBe('mytowername123');
  });

  it('handles consecutive spaces/underscores as single hyphen', () => {
    expect(normalizeDeviceName('my   tower___name')).toBe('my-tower-name');
  });

  it('returns empty string for all-invalid input', () => {
    expect(normalizeDeviceName('!!!@@@###')).toBe('');
  });

  it('handles mixed case with special chars', () => {
    expect(normalizeDeviceName('  My Work_Station (v2)  ')).toBe('my-work-station-v2');
  });
});

describe('validateDeviceName', () => {
  it('accepts valid simple names', () => {
    expect(validateDeviceName('my-tower')).toEqual({ valid: true });
  });

  it('accepts single character', () => {
    expect(validateDeviceName('a')).toEqual({ valid: true });
  });

  it('accepts alphanumeric only', () => {
    expect(validateDeviceName('mytower123')).toEqual({ valid: true });
  });

  it('accepts name starting and ending with digits', () => {
    expect(validateDeviceName('1tower2')).toEqual({ valid: true });
  });

  it('rejects empty string', () => {
    const result = validateDeviceName('');
    expect(result.valid).toBe(false);
  });

  it('rejects name starting with hyphen', () => {
    const result = validateDeviceName('-my-tower');
    expect(result.valid).toBe(false);
  });

  it('rejects name ending with hyphen', () => {
    const result = validateDeviceName('my-tower-');
    expect(result.valid).toBe(false);
  });

  it('rejects all-hyphens', () => {
    const result = validateDeviceName('---');
    expect(result.valid).toBe(false);
  });

  it('rejects names longer than 63 characters', () => {
    const longName = 'a'.repeat(64);
    const result = validateDeviceName(longName);
    expect(result.valid).toBe(false);
  });

  it('accepts names exactly 63 characters', () => {
    const name = 'a'.repeat(63);
    expect(validateDeviceName(name)).toEqual({ valid: true });
  });
});
