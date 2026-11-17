/**
 * `isForwardAuthorized` — the single authorization seam for the IDE forward
 * (Issue #1668 §D2). Runs the real function against the real key check; the
 * only mock is the local-key source.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'node:http';

const TEST_KEY = 'a'.repeat(64);

vi.mock('@cluesmith/codev-core/auth', () => ({
  ensureLocalKey: vi.fn(() => TEST_KEY),
  readLocalKey: vi.fn(() => TEST_KEY),
}));

import { isForwardAuthorized, resetExpectedKeyCache } from '../utils/server-utils.js';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';

function req(headers: Record<string, string>): http.IncomingMessage {
  return { headers, method: 'GET', url: '/ide/' } as unknown as http.IncomingMessage;
}

describe('isForwardAuthorized', () => {
  beforeEach(() => {
    resetExpectedKeyCache();
    (ensureLocalKey as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => TEST_KEY);
  });

  it('accepts a loopback Host with the valid key in the codev-tower-key header', () => {
    expect(isForwardAuthorized(req({ host: 'localhost:4100', 'codev-tower-key': TEST_KEY }))).toBe(true);
  });

  it('accepts the legacy codev-web-key header (dual-accept)', () => {
    expect(isForwardAuthorized(req({ host: '127.0.0.1:4100', 'codev-web-key': TEST_KEY }))).toBe(true);
  });

  it('rejects a forged key', () => {
    expect(isForwardAuthorized(req({ host: 'localhost', 'codev-tower-key': 'wrong-key' }))).toBe(false);
  });

  it('rejects a missing key', () => {
    expect(isForwardAuthorized(req({ host: 'localhost' }))).toBe(false);
  });

  it('rejects a disallowed Host even with the valid key (DNS-rebinding guard)', () => {
    expect(isForwardAuthorized(req({ host: 'evil.example.com', 'codev-tower-key': TEST_KEY }))).toBe(false);
  });

  it('fails closed when no local key is readable', () => {
    (ensureLocalKey as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('~/.agent-farm is unwritable');
    });
    resetExpectedKeyCache();
    expect(isForwardAuthorized(req({ host: 'localhost', 'codev-tower-key': TEST_KEY }))).toBe(false);
  });
});
