/**
 * Issue #1869: the header-free `/ide` forward cookie for a local browser.
 *
 * Runs the REAL auth seam (`decideForwardAuthorization` / `isForwardAuthorized`
 * / `isRequestAllowed`) against the real key check; the only mock is the
 * local-key source. Covers the cookie branch, its cross-port Origin guard (the
 * security review's M1), the unchanged header branch (tunnel/cloud), and the
 * live derivation (M4).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type http from 'node:http';
import { createHmac } from 'node:crypto';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

vi.mock('@cluesmith/codev-core/auth', () => ({
  ensureLocalKey: vi.fn(() => KEY_A),
  readLocalKey: vi.fn(() => KEY_A),
}));

import {
  IDE_FORWARD_COOKIE,
  cookieValue,
  decideForwardAuthorization,
  ideForwardCookieValue,
  ideForwardSetCookie,
  isForwardAuthorized,
  isRequestAllowed,
  isSameOriginForwardRequest,
  resetExpectedKeyCache,
} from '../utils/server-utils.js';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';

const keyMock = ensureLocalKey as unknown as ReturnType<typeof vi.fn>;

function expectedCookieFor(key: string): string {
  return createHmac('sha256', key).update('codev-ide-forward/v1').digest('hex');
}

const VALID = expectedCookieFor(KEY_A);

function req(headers: Record<string, string | string[]>, url = '/ide/?folder=%2Fw', method = 'GET'): http.IncomingMessage {
  return { method, url, headers: { host: 'localhost:4100', ...headers } } as unknown as http.IncomingMessage;
}

function withCookie(extra: Record<string, string> = {}, cookie = `${IDE_FORWARD_COOKIE}=${VALID}`): http.IncomingMessage {
  return req({ cookie, ...extra });
}

beforeEach(() => {
  resetExpectedKeyCache();
  keyMock.mockReset();
  keyMock.mockReturnValue(KEY_A);
  delete process.env.CODEV_TOWER_ALLOWED_ORIGINS;
});

describe('forward cookie derivation (M4)', () => {
  it('is HMAC-SHA256(localKey, versioned purpose), never the key itself', () => {
    expect(ideForwardCookieValue()).toBe(VALID);
    expect(ideForwardCookieValue()).not.toContain(KEY_A);
  });

  it('is derived live: a key change plus cache reset changes it and refuses the old cookie', () => {
    expect(isForwardAuthorized(withCookie())).toBe(true);
    keyMock.mockReturnValue(KEY_B);
    resetExpectedKeyCache();
    expect(ideForwardCookieValue()).toBe(expectedCookieFor(KEY_B));
    expect(isForwardAuthorized(withCookie())).toBe(false);
  });

  it('fails closed when the key is unavailable', () => {
    keyMock.mockImplementation(() => {
      throw new Error('unwritable');
    });
    resetExpectedKeyCache();
    expect(ideForwardCookieValue()).toBeNull();
    expect(ideForwardSetCookie()).toBeNull();
    expect(isForwardAuthorized(withCookie())).toBe(false);
  });

  it('Set-Cookie is HttpOnly, SameSite=Strict, Path=/ide, without Secure or Max-Age', () => {
    const header = ideForwardSetCookie();
    expect(header).toBe(`${IDE_FORWARD_COOKIE}=${VALID}; Path=/ide; HttpOnly; SameSite=Strict`);
  });
});

describe('cookieValue', () => {
  it('reads the named cookie among others, in any position', () => {
    expect(cookieValue(`${IDE_FORWARD_COOKIE}=v1`, IDE_FORWARD_COOKIE)).toBe('v1');
    expect(cookieValue(`a=1; ${IDE_FORWARD_COOKIE}=v2; b=2`, IDE_FORWARD_COOKIE)).toBe('v2');
    expect(cookieValue(['a=1', `${IDE_FORWARD_COOKIE}=v3`], IDE_FORWARD_COOKIE)).toBe('v3');
  });

  it('matches the exact name only', () => {
    expect(cookieValue(`${IDE_FORWARD_COOKIE}2=x`, IDE_FORWARD_COOKIE)).toBeNull();
    expect(cookieValue(`x${IDE_FORWARD_COOKIE}=x`, IDE_FORWARD_COOKIE)).toBeNull();
  });

  it('returns null for absent or empty values', () => {
    expect(cookieValue(undefined, IDE_FORWARD_COOKIE)).toBeNull();
    expect(cookieValue(`${IDE_FORWARD_COOKIE}=`, IDE_FORWARD_COOKIE)).toBeNull();
  });
});

describe('cookie branch of the forward seam', () => {
  it('accepts a valid cookie with no header and no Origin (top-level navigation)', () => {
    expect(decideForwardAuthorization(withCookie())).toEqual({ allowed: true, via: 'cookie' });
  });

  it('accepts a valid cookie among other cookies, including vscode-tkn', () => {
    expect(isForwardAuthorized(withCookie({}, `vscode-tkn=t; ${IDE_FORWARD_COOKIE}=${VALID}; other=1`))).toBe(true);
  });

  it('rejects a wrong, empty, or prefix-named cookie', () => {
    expect(isForwardAuthorized(withCookie({}, `${IDE_FORWARD_COOKIE}=${'0'.repeat(64)}`))).toBe(false);
    expect(isForwardAuthorized(withCookie({}, `${IDE_FORWARD_COOKIE}=`))).toBe(false);
    expect(isForwardAuthorized(withCookie({}, `${IDE_FORWARD_COOKIE}2=${VALID}`))).toBe(false);
  });

  it('rejects the raw key presented as the cookie', () => {
    expect(isForwardAuthorized(withCookie({}, `${IDE_FORWARD_COOKIE}=${KEY_A}`))).toBe(false);
  });

  it('rejects a valid cookie under a rebound Host, before reading the cookie', () => {
    const decision = decideForwardAuthorization(req({ host: 'evil.example', cookie: `${IDE_FORWARD_COOKIE}=${VALID}` }));
    expect(decision.allowed).toBe(false);
  });

  it('rejects a bare request with neither header nor cookie', () => {
    expect(decideForwardAuthorization(req({}))).toEqual({ allowed: false, reason: 'missing or invalid credential' });
  });
});

describe('cross-port guard on the cookie branch (M1)', () => {
  it('refuses a cookie-bearing request from another localhost port', () => {
    const decision = decideForwardAuthorization(withCookie({ origin: 'http://localhost:3000' }));
    expect(decision).toEqual({ allowed: false, reason: 'forward cookie refused: cross-origin request' });
  });

  it('refuses Sec-Fetch-Site same-site and cross-site', () => {
    expect(isForwardAuthorized(withCookie({ 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(isForwardAuthorized(withCookie({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('allows Sec-Fetch-Site same-origin and none', () => {
    expect(isForwardAuthorized(withCookie({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isForwardAuthorized(withCookie({ 'sec-fetch-site': 'none' }))).toBe(true);
  });

  it('allows an Origin equal to the request Host (http and https)', () => {
    expect(isForwardAuthorized(withCookie({ origin: 'http://localhost:4100' }))).toBe(true);
    expect(isForwardAuthorized(withCookie({ origin: 'https://localhost:4100' }))).toBe(true);
  });

  it('refuses another loopback alias (127.0.0.1 vs localhost) and the literal "null" origin', () => {
    expect(isForwardAuthorized(withCookie({ origin: 'http://127.0.0.1:4100' }))).toBe(false);
    expect(isForwardAuthorized(withCookie({ origin: 'null' }))).toBe(false);
  });

  it('allows an Origin listed in CODEV_TOWER_ALLOWED_ORIGINS', () => {
    process.env.CODEV_TOWER_ALLOWED_ORIGINS = 'https://proxy.example.com';
    expect(isForwardAuthorized(withCookie({ origin: 'https://proxy.example.com' }))).toBe(true);
    expect(isForwardAuthorized(withCookie({ origin: 'https://other.example.com' }))).toBe(false);
  });

  it('refuses when Origin passes but Sec-Fetch-Site says same-site', () => {
    expect(isForwardAuthorized(withCookie({ origin: 'http://localhost:4100', 'sec-fetch-site': 'same-site' }))).toBe(false);
  });

  it('is a pure predicate over Origin and Sec-Fetch-Site', () => {
    expect(isSameOriginForwardRequest(req({}))).toBe(true);
    expect(isSameOriginForwardRequest(req({ origin: 'http://localhost:9999' }))).toBe(false);
  });
});

describe('header branch is unchanged (tunnel / cloud)', () => {
  it('a tunnel-stamped header passes with a cloud Origin and Sec-Fetch-Site cross-site', () => {
    const decision = decideForwardAuthorization(
      req({
        'codev-tower-key': KEY_A,
        'x-codev-tunnel-proxy': '1',
        origin: 'https://cloud.codevos.ai',
        'sec-fetch-site': 'cross-site',
      }),
    );
    expect(decision).toEqual({ allowed: true, via: 'header' });
  });

  it('the legacy header still passes', () => {
    expect(isForwardAuthorized(req({ 'codev-web-key': KEY_A }))).toBe(true);
  });

  it('a wrong header falls through to a valid same-origin cookie', () => {
    expect(isForwardAuthorized(withCookie({ 'codev-tower-key': 'wrong' }))).toBe(true);
  });
});

describe('isRequestAllowed delegates only /ide* to the forward seam', () => {
  it('allows /ide/ and /ide with the cookie, and refuses them bare', () => {
    expect(isRequestAllowed(withCookie())).toBe(true);
    expect(isRequestAllowed(req({ cookie: `${IDE_FORWARD_COOKIE}=${VALID}` }, '/ide'))).toBe(true);
    expect(isRequestAllowed(req({}))).toBe(false);
  });

  it('refuses the cookie on every non-/ide route', () => {
    for (const url of ['/api/state', '/api/ide', '/api/ide/session', '/api/terminals', '/ideas', '/workspace/x/api/state']) {
      expect(isRequestAllowed(req({ cookie: `${IDE_FORWARD_COOKIE}=${VALID}` }, url, 'POST'))).toBe(false);
    }
  });

  it('refuses a cross-port cookie request at the HTTP choke point too', () => {
    expect(isRequestAllowed(withCookie({ origin: 'http://localhost:3000' }))).toBe(false);
  });
});
