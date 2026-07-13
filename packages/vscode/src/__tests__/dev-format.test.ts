import { describe, it, expect } from 'vitest';
import { formatUptime, extractDevPort, formatTargetName } from '../views/dev-format.js';

describe('formatUptime', () => {
  it('renders sub-minute durations as seconds', () => {
    expect(formatUptime(0)).toBe('0s');
    expect(formatUptime(5_000)).toBe('5s');
    expect(formatUptime(59_000)).toBe('59s');
  });

  it('renders minutes with zero-padded seconds', () => {
    expect(formatUptime(60_000)).toBe('1m 00s');
    expect(formatUptime(272_000)).toBe('4m 32s');
    expect(formatUptime(3_599_000)).toBe('59m 59s');
  });

  it('rolls over into hours with zero-padded minutes', () => {
    expect(formatUptime(3_600_000)).toBe('1h 00m');
    expect(formatUptime(3_900_000)).toBe('1h 05m');
    expect(formatUptime(90_000_000)).toBe('25h 00m');
  });

  it('clamps negative durations to 0s', () => {
    expect(formatUptime(-1_000)).toBe('0s');
  });
});

describe('extractDevPort', () => {
  it('returns null when no config', () => {
    expect(extractDevPort(null)).toBeNull();
    expect(extractDevPort(undefined)).toBeNull();
    expect(extractDevPort({})).toBeNull();
  });

  it('reads the port from the first devUrls entry', () => {
    expect(extractDevPort({ devUrls: [{ url: 'http://localhost:3000/' }] })).toBe(3000);
    expect(extractDevPort({
      devUrls: [{ url: 'http://localhost/' }, { url: 'http://localhost:5173' }],
    })).toBe(5173);
  });

  it('falls back to a port mentioned in devCommand', () => {
    expect(extractDevPort({ devCommand: 'next dev --port 3001' })).toBe(3001);
    expect(extractDevPort({ devCommand: 'vite -p 5174' })).toBe(5174);
    expect(extractDevPort({ devCommand: 'PORT=4000 npm run dev' })).toBe(4000);
    expect(extractDevPort({ devCommand: 'serve :8080' })).toBe(8080);
  });

  it('prefers devUrls over devCommand', () => {
    expect(extractDevPort({
      devUrls: [{ url: 'http://localhost:3000' }],
      devCommand: 'next dev --port 9999',
    })).toBe(3000);
  });

  it('returns null for an unparseable url and a portless command', () => {
    expect(extractDevPort({ devUrls: [{ url: 'not a url' }], devCommand: 'pnpm dev' })).toBeNull();
  });

  it('rejects out-of-range ports', () => {
    expect(extractDevPort({ devCommand: 'run --port 99999' })).toBeNull();
  });
});

describe('formatTargetName', () => {
  it('passes through already-friendly ids', () => {
    expect(formatTargetName('main')).toBe('main');
    expect(formatTargetName('pir-809')).toBe('pir-809');
  });

  it('strips the canonical builder- role prefix', () => {
    expect(formatTargetName('builder-pir-809')).toBe('pir-809');
    expect(formatTargetName('builder-spir-42')).toBe('spir-42');
  });
});
