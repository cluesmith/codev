/**
 * In-memory nonce store for OAuth registration state management.
 *
 * Bridges the gap between OAuth initiation (POST /api/tunnel/connect)
 * and completion (GET /api/tunnel/connect/callback) by storing
 * pending registration data keyed by a single-use nonce.
 */

import { randomUUID } from 'node:crypto';

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface PendingRegistration {
  nonce: string;
  name: string;
  serverUrl: string;
  createdAt: number;
}

const pendingRegistrations = new Map<string, PendingRegistration>();

/**
 * Create a pending registration with a unique nonce.
 * Runs cleanup of expired entries on each call.
 */
export function createPendingRegistration(name: string, serverUrl: string): string {
  cleanupExpired();

  const nonce = randomUUID();
  pendingRegistrations.set(nonce, {
    nonce,
    name,
    serverUrl,
    createdAt: Date.now(),
  });

  return nonce;
}

/**
 * Consume a pending registration by nonce (single-use).
 * Returns the registration data and deletes it, or null if not found/expired.
 */
export function consumePendingRegistration(nonce: string): PendingRegistration | null {
  const entry = pendingRegistrations.get(nonce);
  if (!entry) return null;

  // Check expiry
  if (Date.now() - entry.createdAt > NONCE_TTL_MS) {
    pendingRegistrations.delete(nonce);
    return null;
  }

  // Single-use: delete after consumption
  pendingRegistrations.delete(nonce);
  return entry;
}

/**
 * Remove all expired entries from the store.
 */
function cleanupExpired(): void {
  const now = Date.now();
  for (const [nonce, entry] of pendingRegistrations) {
    if (now - entry.createdAt > NONCE_TTL_MS) {
      pendingRegistrations.delete(nonce);
    }
  }
}

/**
 * Clear all pending registrations. Used for testing.
 */
export function clearPendingRegistrations(): void {
  pendingRegistrations.clear();
}
