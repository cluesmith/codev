import { describe, it, expect } from 'vitest';
import { encodeWorkspacePath, decodeWorkspacePath } from '../workspace.js';

/**
 * The codec replaced `Buffer.toString('base64url')` with a dependency-free
 * implementation (issue #1189). The wire format is load-bearing: Tower decodes
 * these segments server-side with Buffer, so every case asserts byte-exact
 * parity with Node's own base64url, not just round-tripping.
 */

const CASES = [
  '/Users/amr/repos/cluesmith/codev',
  '/work/with spaces/and-dashes_underscores',
  '/tmp/x', // length % 3 === 2 tail
  '/tmp/xy', // length % 3 === 0
  '/tmp', // length % 3 === 1 tail
  '', // empty path
  '/ünïcödé/路径/🚀', // multibyte UTF-8
];

describe('workspace path codec', () => {
  it('matches Buffer base64url byte-for-byte on every case', () => {
    for (const path of CASES) {
      expect(encodeWorkspacePath(path)).toBe(Buffer.from(path).toString('base64url'));
    }
  });

  it('round-trips every case', () => {
    for (const path of CASES) {
      expect(decodeWorkspacePath(encodeWorkspacePath(path))).toBe(path);
    }
  });

  it('decodes Buffer-encoded input (server-side compatibility)', () => {
    for (const path of CASES) {
      expect(decodeWorkspacePath(Buffer.from(path).toString('base64url'))).toBe(path);
    }
  });

  it('tolerates padded base64 input', () => {
    const padded = Buffer.from('/tmp/x').toString('base64'); // standard alphabet + padding
    const urlSafe = padded.replace(/\+/g, '-').replace(/\//g, '_');
    expect(decodeWorkspacePath(urlSafe)).toBe('/tmp/x');
  });

  it('rejects characters outside the base64url alphabet', () => {
    expect(() => decodeWorkspacePath('abc$def')).toThrow(/Invalid base64url/);
  });
});
