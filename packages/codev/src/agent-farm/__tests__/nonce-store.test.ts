/**
 * Tests for nonce store module (Spec 0107 Phase 1)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createPendingRegistration,
  consumePendingRegistration,
  clearPendingRegistrations,
} from '../lib/nonce-store.js';

describe('nonce-store', () => {
  beforeEach(() => {
    clearPendingRegistrations();
    vi.restoreAllMocks();
  });

  describe('createPendingRegistration', () => {
    it('returns a UUID nonce', () => {
      const nonce = createPendingRegistration('my-tower', 'https://cloud.codevos.ai');
      expect(nonce).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('generates unique nonces for each call', () => {
      const nonce1 = createPendingRegistration('tower-1', 'https://cloud.codevos.ai');
      const nonce2 = createPendingRegistration('tower-2', 'https://cloud.codevos.ai');
      expect(nonce1).not.toBe(nonce2);
    });
  });

  describe('consumePendingRegistration', () => {
    it('returns the registration data for a valid nonce', () => {
      const nonce = createPendingRegistration('my-tower', 'https://cloud.codevos.ai');
      const result = consumePendingRegistration(nonce);
      expect(result).not.toBeNull();
      expect(result!.nonce).toBe(nonce);
      expect(result!.name).toBe('my-tower');
      expect(result!.serverUrl).toBe('https://cloud.codevos.ai');
      expect(result!.createdAt).toBeGreaterThan(0);
    });

    it('returns null for an unknown nonce', () => {
      const result = consumePendingRegistration('nonexistent-nonce');
      expect(result).toBeNull();
    });

    it('is single-use: second consume returns null', () => {
      const nonce = createPendingRegistration('my-tower', 'https://cloud.codevos.ai');
      const first = consumePendingRegistration(nonce);
      expect(first).not.toBeNull();

      const second = consumePendingRegistration(nonce);
      expect(second).toBeNull();
    });

    it('returns null for expired nonces (>5 minutes)', () => {
      const nonce = createPendingRegistration('my-tower', 'https://cloud.codevos.ai');

      // Advance time by 5 minutes + 1 second
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60 * 1000 + 1000);

      const result = consumePendingRegistration(nonce);
      expect(result).toBeNull();
    });

    it('returns data for non-expired nonces (<5 minutes)', () => {
      const nonce = createPendingRegistration('my-tower', 'https://cloud.codevos.ai');

      // Advance time by 4 minutes
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 4 * 60 * 1000);

      const result = consumePendingRegistration(nonce);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('my-tower');
    });
  });

  describe('cleanup on create', () => {
    it('removes expired entries when creating new ones', () => {
      const oldNonce = createPendingRegistration('old-tower', 'https://cloud.codevos.ai');

      // Advance time past expiry
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000);

      // Creating a new registration triggers cleanup
      const newNonce = createPendingRegistration('new-tower', 'https://cloud.codevos.ai');

      // Old nonce should be gone
      vi.restoreAllMocks();
      expect(consumePendingRegistration(oldNonce)).toBeNull();

      // New nonce should work (but we need to handle that it was created with mocked time)
      // The new nonce was created with the mocked time, so we need to advance real time past that
      // Actually, since we restored mocks, Date.now() is real again. The new entry's createdAt
      // was set to the mocked value (6 min in the future), so it won't be expired yet.
      expect(consumePendingRegistration(newNonce)).not.toBeNull();
    });
  });
});
