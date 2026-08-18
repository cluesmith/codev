/**
 * E2E-only harness: authenticate the test suites' HTTP calls to the local Tower.
 *
 * Tower now enforces request authentication (advisory GHSA-xvjp-7748-v88v):
 * every non-public route requires the shared local key (`~/.agent-farm/local-key`)
 * presented as the `codev-tower-key` header. The integration suites spin up a real
 * Tower and hit it with plain `fetch`, so without a key every non-public call 401s.
 *
 * Rather than thread the header through the ~90 `fetch` call sites, wrap global
 * `fetch` once to inject it for loopback Tower requests. A call that already carries
 * the header, or targets a non-loopback host, passes through untouched — so a suite
 * that wants to exercise the rejection path can still opt out by setting its own
 * (empty/wrong) header. WebSocket auth is carried separately via
 * `towerWsProtocols()` in helpers/tower-test-utils.ts.
 */

import { ensureLocalKey } from '@cluesmith/codev-core/auth';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';

const realFetch = globalThis.fetch;

function isLoopbackTower(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

globalThis.fetch = function patchedFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): ReturnType<typeof fetch> {
  let url: string | null = null;
  if (typeof input === 'string') url = input;
  else if (input instanceof URL) url = input.href;

  if (url && isLoopbackTower(url)) {
    const headers = new Headers(init?.headers);
    if (!headers.has(TOWER_KEY_HEADER)) {
      headers.set(TOWER_KEY_HEADER, ensureLocalKey());
      return realFetch(input, { ...init, headers });
    }
  }
  return realFetch(input, init);
} as typeof fetch;
