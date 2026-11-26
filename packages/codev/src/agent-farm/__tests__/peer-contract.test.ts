/**
 * The wire contract module, layer A (Spec 1967, plan phase 1): the field rules, the code
 * point lists, the payload and its caps, R's steps 1 to 7 beyond what the shared vectors
 * express, the answers in both directions, S's refusal order, and the structural rule that
 * no other production file speaks the contract.
 *
 * Code points that are line terminators or controls are built with String.fromCodePoint,
 * never written into this file.
 */

import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PeerDiscoveredAddress, PeerStatement } from '@cluesmith/codev-types';
import {
  PEER_HEADER,
  EXCLUDED_CODE_POINTS,
  REMOTE_BODY_REMOVED_CODE_POINTS,
  SENDER_CHECK_ORDER,
  STATEMENT_FIELD_RULES,
  buildRelayRequestHeaders,
  classifyRelayAnswer,
  decodeBase64Url,
  decodeSessionSecret,
  encodeBase64Url,
  encodeDiscoveryAnswer,
  encodeMessagePayload,
  encodeQueryPayload,
  encodeReceiverAnswer,
  isWireAddress,
  normalizeRemoteBody,
  prepareRemoteBody,
  printableDetail,
  readMessagePayload,
  readQueryPayload,
  readRelayRequestHeaders,
  verifyRelayedRequest,
  type RelayCallResult,
} from '../peer/contract.js';

const cp = (codePoint: number) => String.fromCodePoint(codePoint);
const utf8 = (text: string) => new TextEncoder().encode(text);
const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');

const NOW = 1_764_100_000_500;
const SECRET = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
const RECEIVER = '01JDEVVM0000000000000000AA';
const WORKED_PAYLOAD =
  '{"sentAt":1764100000000,"to":{"workspace":"codev","kind":"architect","name":"local"},"from":{"workspace":"codev","kind":"architect","name":"main"},"body":"CI is green on the tunnel branch"}';

function statementFor(payload: Uint8Array, overrides: Partial<Record<keyof PeerStatement, unknown>> = {}) {
  return {
    v: 1,
    kind: 'message',
    toTowerId: RECEIVER,
    fromTowerId: '01JMBP000000000000000000AA',
    fromTowerSlug: 'ana-s-mbp',
    fromOwnerId: 'usr_ana',
    fromOwnerHandle: null,
    fromOwnerEmail: 'ana@example.com',
    sameOwner: true,
    requestId: '6f1c2a9e-3b4d-4c5e-8f60-718293a4b5c6',
    issuedAt: NOW - 377,
    statementId: 'AAECAwQFBgcICQoLDA0ODw',
    payloadSha256: createHash('sha256').update(payload).digest('hex'),
    ...overrides,
  };
}

/** A request as C would forward it: the statement and MAC computed with node:crypto. */
function forwarded(body: Uint8Array, statementText: string, secret: Uint8Array = SECRET) {
  return {
    statementHeader: Buffer.from(statementText, 'utf8').toString('base64url'),
    macHeader: createHmac('sha256', secret).update(statementText, 'utf8').digest('base64url'),
    body,
    sessionSecret: secret,
    receiverTowerId: RECEIVER,
    now: NOW,
  };
}

// ---------------------------------------------------------------------------
// The field rules and the code point lists
// ---------------------------------------------------------------------------

describe('statement field rules', () => {
  const inside: Record<keyof PeerStatement, unknown[]> = {
    v: [1, 2, 9007199254740991],
    kind: ['message', 'query'],
    toTowerId: ['a', 'A'.repeat(64), 'abc_-09'],
    fromTowerId: ['a', 'Z'.repeat(64)],
    fromTowerSlug: ['a', '9', 'a' + '-'.repeat(62), 'ana-s-mbp'],
    fromOwnerId: ['u', 'u'.repeat(64)],
    fromOwnerHandle: [null, 'a', 'a' + 'b'.repeat(62), 'ana-k'],
    fromOwnerEmail: ['a', 'a'.repeat(254), 'é'.repeat(127), `ana${cp(0x1f600)}@x.com`],
    sameOwner: [true, false],
    requestId: ['00000000-0000-0000-0000-000000000000', '6f1c2a9e-3b4d-4c5e-8f60-718293a4b5c6'],
    issuedAt: [1, 9007199254740991],
    statementId: ['AAECAwQFBgcICQoLDA0ODw', '-_-_-_-_-_-_-_-_-_-_-_'],
    payloadSha256: ['0'.repeat(64), 'f'.repeat(64)],
  };
  const outside: Record<keyof PeerStatement, unknown[]> = {
    v: [0, -1, 1.5, '1', null, 9007199254740992],
    kind: ['Message', '', 'queries', null],
    toTowerId: ['', 'A'.repeat(65), 'a.b', 'a b', 1],
    fromTowerId: ['', 'Z'.repeat(65), 'a+b'],
    fromTowerSlug: ['', 'A', '-a', 'a_b', 'a.b', 'a' + 'b'.repeat(63)],
    fromOwnerId: ['', 'u'.repeat(65), 'u/a'],
    fromOwnerHandle: ['', '1a', '-a', 'A', 'a' + 'b'.repeat(63), undefined],
    fromOwnerEmail: ['', 'a'.repeat(255), 'é'.repeat(127) + 'a', 42, `a${String.fromCharCode(0xd800)}b`],
    sameOwner: ['true', 1, null],
    requestId: ['6F1C2A9E-3B4D-4C5E-8F60-718293A4B5C6', '6f1c2a9e3b4d4c5e8f60718293a4b5c6', 'g'.repeat(8) + '-0000-0000-0000-000000000000'],
    issuedAt: [0, -1, 1.5, '1', 9007199254740992],
    statementId: ['A'.repeat(21), 'A'.repeat(23), 'AAECAwQFBgcICQoLDA0O+w', 'AAECAwQFBgcICQoLDA0O=='],
    payloadSha256: ['F'.repeat(64), '0'.repeat(63), '0'.repeat(65), 'g'.repeat(64)],
  };

  it('has a rule for exactly the statement fields of section 5, in its order', () => {
    expect(Object.keys(STATEMENT_FIELD_RULES)).toEqual([
      'v',
      'kind',
      'toTowerId',
      'fromTowerId',
      'fromTowerSlug',
      'fromOwnerId',
      'fromOwnerHandle',
      'fromOwnerEmail',
      'sameOwner',
      'requestId',
      'issuedAt',
      'statementId',
      'payloadSha256',
    ]);
  });

  for (const field of Object.keys(inside) as Array<keyof PeerStatement>) {
    it(`${field}: accepts values just inside its rule and refuses values just outside`, () => {
      for (const value of inside[field]) expect(STATEMENT_FIELD_RULES[field](value), String(value)).toBe(true);
      for (const value of outside[field]) expect(STATEMENT_FIELD_RULES[field](value), String(value)).toBe(false);
    });
  }
});

describe('the code point lists', () => {
  const inRanges = (ranges: readonly (readonly [number, number])[], codePoint: number) =>
    ranges.some(([first, last]) => codePoint >= first && codePoint <= last);

  it('lists the excluded code points of section 5, one entry per line of the contract', () => {
    expect(EXCLUDED_CODE_POINTS).toEqual([
      [0x0000, 0x001f],
      [0x007f, 0x009f],
      [0x00ad, 0x00ad],
      [0x061c, 0x061c],
      [0x180e, 0x180e],
      [0x200b, 0x200f],
      [0x2028, 0x2029],
      [0x202a, 0x202e],
      [0x2060, 0x2064],
      [0x2066, 0x2069],
      [0xfeff, 0xfeff],
    ]);
  });

  it("is Decision 7's removals plus tab, line feed, U+2028 and U+2029, and nothing else", () => {
    const kept = new Set([0x09, 0x0a, 0x2028, 0x2029]);
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const excluded = inRanges(EXCLUDED_CODE_POINTS, codePoint);
      const removed = inRanges(REMOTE_BODY_REMOVED_CODE_POINTS, codePoint);
      if (kept.has(codePoint)) {
        expect(excluded && !removed, codePoint.toString(16)).toBe(true);
      } else if (excluded !== removed) {
        throw new Error(`U+${codePoint.toString(16)}: excluded ${excluded}, removed ${removed}`);
      }
    }
  });

  it('refuses an email containing any excluded code point, and accepts every other', () => {
    for (let codePoint = 0; codePoint <= 0xffff; codePoint++) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const verdict = STATEMENT_FIELD_RULES.fromOwnerEmail(`ana${cp(codePoint)}@example.com`);
      if (verdict === inRanges(EXCLUDED_CODE_POINTS, codePoint)) {
        throw new Error(`U+${codePoint.toString(16)}: rule says ${verdict}`);
      }
    }
  });
});

describe("Decision 7's normalisation of a remote body", () => {
  it('turns CR LF, a lone CR, U+2028 and U+2029 into one line feed each, before removing', () => {
    const text = `a\r\nb\rc${cp(0x2028)}d${cp(0x2029)}e\nf`;
    expect(normalizeRemoteBody(text)).toBe('a\nb\nc\nd\ne\nf');
    // A CR is turned into a line feed before the removal of C0 controls could drop it.
    expect(normalizeRemoteBody('x\ry')).toBe('x\ny');
  });

  it('removes every listed code point and keeps tab, line feed and everything else', () => {
    for (const [first, last] of REMOTE_BODY_REMOVED_CODE_POINTS) {
      for (let codePoint = first; codePoint <= last; codePoint++) {
        if (codePoint === 0x0d) continue; // a CR becomes a line feed first
        expect(normalizeRemoteBody(`a${cp(codePoint)}b`), codePoint.toString(16)).toBe('ab');
      }
    }
    const keep = `tab\there\nline é 例 ${cp(0x1f600)} ${cp(0x00a0)} ${cp(0x2010)} ${cp(0x2065)}`;
    expect(normalizeRemoteBody(keep)).toBe(keep);
  });

  it('is idempotent and leaves nothing it removes', () => {
    let seed = 1967;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const alphabet = [0x0, 0x9, 0xa, 0xd, 0x1b, 0x41, 0x7f, 0x85, 0xad, 0x200d, 0x2028, 0x2029, 0x202e, 0x2066, 0xfeff, 0x1f600];
    for (let run = 0; run < 200; run++) {
      const text = Array.from({ length: 40 }, () => cp(alphabet[Math.floor(random() * alphabet.length)])).join('');
      const once = normalizeRemoteBody(text);
      expect(normalizeRemoteBody(once)).toBe(once);
      for (const char of once) {
        const codePoint = char.codePointAt(0)!;
        const removed = REMOTE_BODY_REMOVED_CODE_POINTS.some(([first, last]) => codePoint >= first && codePoint <= last);
        expect(removed || codePoint === 0x2028 || codePoint === 0x2029).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// base64url, the secret
// ---------------------------------------------------------------------------

describe('base64url and the session secret', () => {
  it('round-trips bytes without padding', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = new Uint8Array(Array.from({ length }, (_, i) => (i * 37 + 250) % 256));
      const text = encodeBase64Url(bytes);
      expect(text).not.toMatch(/[=+/]/);
      expect(decodeBase64Url(text)).toEqual(bytes);
    }
  });

  it('refuses padding, other alphabets, impossible lengths and non-canonical spellings', () => {
    expect(decodeBase64Url('AAE=')).toBeNull();
    expect(decodeBase64Url('AA+/')).toBeNull();
    expect(decodeBase64Url('AA A')).toBeNull();
    expect(decodeBase64Url('AAAAA')).toBeNull();
    // "AB" spells the byte 0x00 with a non-zero trailing bit; only "AA" is canonical.
    expect(decodeBase64Url('AA')).toEqual(new Uint8Array([0]));
    expect(decodeBase64Url('AB')).toBeNull();
  });

  it('takes a 32-byte secret and nothing else', () => {
    expect(decodeSessionSecret(encodeBase64Url(SECRET))).toEqual(SECRET);
    expect(decodeSessionSecret(encodeBase64Url(SECRET.subarray(0, 31)))).toBeNull();
    expect(decodeSessionSecret(encodeBase64Url(new Uint8Array(33)))).toBeNull();
    expect(decodeSessionSecret(`${encodeBase64Url(SECRET)}=`)).toBeNull();
    expect(decodeSessionSecret(undefined)).toBeNull();
    expect(decodeSessionSecret(42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R's steps 1 to 7, beyond the vectors
// ---------------------------------------------------------------------------

describe("R's checks, steps 1 to 7", () => {
  const body = utf8(WORKED_PAYLOAD);
  const goodStatement = JSON.stringify(statementFor(body));

  it('verifies a well-formed request and returns the statement', () => {
    const result = verifyRelayedRequest(forwarded(body, goodStatement));
    expect(result.verdict).toBe('verified');
    if (result.verdict === 'verified') expect(result.statement.fromTowerSlug).toBe('ana-s-mbp');
  });

  it('step 1: needs both headers, once each, and a body within the cap', () => {
    const request = forwarded(body, goodStatement);
    expect(verifyRelayedRequest({ ...request, statementHeader: undefined })).toEqual({ verdict: 'not-verified', step: 1 });
    expect(verifyRelayedRequest({ ...request, macHeader: undefined })).toEqual({ verdict: 'not-verified', step: 1 });
    expect(verifyRelayedRequest({ ...request, macHeader: [request.macHeader, request.macHeader] })).toEqual({
      verdict: 'not-verified',
      step: 1,
    });

    const atCap = new Uint8Array(102_400).fill(0x20);
    expect(verifyRelayedRequest(forwarded(atCap, JSON.stringify(statementFor(atCap)))).verdict).toBe('verified');
    const overCap = new Uint8Array(102_401).fill(0x20);
    expect(verifyRelayedRequest(forwarded(overCap, JSON.stringify(statementFor(overCap))))).toEqual({
      verdict: 'not-verified',
      step: 1,
    });
  });

  it('step 2: a session without a secret verifies nothing', () => {
    expect(verifyRelayedRequest({ ...forwarded(body, goodStatement), sessionSecret: null })).toEqual({
      verdict: 'not-verified',
      step: 2,
    });
  });

  it('tells a record the sending Tower only once the MAC has verified, and only a value that fits its rule', () => {
    const badSlug = verifyRelayedRequest(forwarded(body, JSON.stringify(statementFor(body, { fromTowerSlug: 'A' }))));
    expect(badSlug).toEqual({ verdict: 'not-verified', step: 4, fromTowerId: '01JMBP000000000000000000AA' });

    const badId = verifyRelayedRequest(forwarded(body, JSON.stringify(statementFor(body, { fromTowerId: 'a b' }))));
    expect(badId).toEqual({ verdict: 'not-verified', step: 4, fromTowerId: null });

    const otherVersion = verifyRelayedRequest(forwarded(body, JSON.stringify(statementFor(body, { v: 2 }))));
    expect(otherVersion).toEqual({
      verdict: 'refused',
      step: 3,
      reason: 'unsupported-version',
      supported: [1],
      fromTowerId: '01JMBP000000000000000000AA',
    });

    const wrongTower = verifyRelayedRequest({ ...forwarded(body, goodStatement), receiverTowerId: 'other' });
    expect(wrongTower.verdict).toBe('not-verified');
    if (wrongTower.verdict === 'not-verified' && wrongTower.step === 5) {
      expect(wrongTower.statement.requestId).toBe('6f1c2a9e-3b4d-4c5e-8f60-718293a4b5c6');
    } else {
      throw new Error('expected step 5');
    }
  });

  it('step 4: refuses a key given twice, at any depth of the statement', () => {
    const nested = goodStatement.replace('}', ',"extra":{"a":1,"a":2}}');
    expect(verifyRelayedRequest(forwarded(body, nested))).toMatchObject({ verdict: 'not-verified', step: 4 });
    const repeated = goodStatement.replace('"sameOwner":true', '"sameOwner":true,"sameOwner":true');
    expect(verifyRelayedRequest(forwarded(body, repeated))).toMatchObject({ verdict: 'not-verified', step: 4 });
    // The same name in two different objects is not a repetition.
    const separate = goodStatement.replace('}', ',"x":{"v":1},"y":[{"v":1},{"v":2}]}');
    expect(verifyRelayedRequest(forwarded(body, separate)).verdict).toBe('verified');
  });

  it('step 3: statement bytes that are not UTF-8, or start with a byte-order mark, are not a JSON object', () => {
    const invalidUtf8 = new Uint8Array([...utf8(goodStatement.slice(0, -1)), 0xff, 0x7d]);
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(goodStatement)]);
    for (const bytes of [invalidUtf8, withBom]) {
      const request = {
        statementHeader: Buffer.from(bytes).toString('base64url'),
        macHeader: createHmac('sha256', SECRET).update(bytes).digest('base64url'),
        body,
        sessionSecret: SECRET,
        receiverTowerId: RECEIVER,
        now: NOW,
      };
      expect(verifyRelayedRequest(request)).toMatchObject({ verdict: 'refused', step: 3, reason: 'unsupported-version' });
    }
  });
});

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

describe('the payload', () => {
  const longest = (kind: 'architect' | 'id') => {
    // The longest address whose text form fits stage 1's 512 characters.
    const workspace = 'w'.repeat(250);
    const name = 'n'.repeat(kind === 'id' ? 512 - 251 : 512 - 261);
    return kind === 'id' ? { workspace, kind, name } : { workspace, kind, name };
  };

  it('encodes the worked message to the worked payload bytes', () => {
    const encoded = encodeMessagePayload({
      sentAt: 1_764_100_000_000,
      to: { workspace: 'codev', kind: 'architect', name: 'local' },
      from: { workspace: 'codev', kind: 'architect', name: 'main' },
      body: 'CI is green on the tunnel branch',
    });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(Buffer.from(encoded.bytes).toString('utf8')).toBe(WORKED_PAYLOAD);
    expect(encoded.sha256).toBe('25d8ef538f7d24c01101821a3073a10ac254fccd0968d4c2117682e47a2d0be3');
  });

  it('writes non-ASCII as literal UTF-8, never as a \\u escape', () => {
    const body = `é 例 ${cp(0x1f600)}`;
    const encoded = encodeMessagePayload({ sentAt: 1, to: { workspace: 'w', kind: 'architect' }, from: null, body });
    if (!encoded.ok) throw new Error('refused');
    const json = Buffer.from(encoded.bytes).toString('utf8');
    expect(json).toContain(body);
    expect(json).not.toContain('\\u');
  });

  it.each([
    ['characters JSON escapes (")', '"'],
    ['characters JSON escapes (\\)', '\\'],
    ['tabs', '\t'],
    ['line feeds', '\n'],
    ['4-byte emoji', cp(0x1f600)],
  ])('a 48 KiB body of %s fits the payload cap with the longest addresses', (_label, unit) => {
    const body = unit.repeat(49_152 / byteLength(unit));
    expect(byteLength(body)).toBe(49_152);
    const encoded = encodeMessagePayload({
      sentAt: 9007199254740991,
      to: longest('architect'),
      from: longest('id'),
      body,
    });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.bytes.length).toBeLessThanOrEqual(102_400);
    const read = readMessagePayload(encoded.bytes, 9007199254740991);
    expect(read).toEqual({
      ok: true,
      payload: { sentAt: 9007199254740991, to: longest('architect'), from: longest('id'), body },
    });
  });

  it('measures the cap after normalisation, and refuses a body one byte over it', () => {
    expect(prepareRemoteBody('a'.repeat(49_152))).toEqual({ ok: true, body: 'a'.repeat(49_152), bytes: 49_152 });
    expect(prepareRemoteBody('a'.repeat(49_153))).toEqual({ ok: false, reason: 'too-large' });
    expect(prepareRemoteBody('\r\n'.repeat(49_152))).toMatchObject({ ok: true, bytes: 49_152 });
  });

  it('refuses a body with a lone surrogate, at S and at R', () => {
    const lone = `a${String.fromCharCode(0xd800)}b`;
    expect(prepareRemoteBody(lone)).toEqual({ ok: false, reason: 'malformed' });
    expect(encodeMessagePayload({ sentAt: 1, to: { workspace: 'w', kind: 'architect' }, from: null, body: lone })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    const escaped = WORKED_PAYLOAD.replace('CI is green', 'CI \\ud800 is green');
    expect(readMessagePayload(utf8(escaped), NOW)).toEqual({ ok: false, reason: 'malformed' });
    const pair = WORKED_PAYLOAD.replace('CI is green', 'CI \\ud83d\\ude00 is green');
    expect(readMessagePayload(utf8(pair), NOW).ok).toBe(true);
  });

  describe("R's step 12 for a message", () => {
    const sentAt = 1_764_100_000_000;
    const payload = (overrides: Record<string, unknown>) =>
      utf8(
        JSON.stringify({
          sentAt,
          to: { workspace: 'codev', kind: 'architect', name: 'local' },
          from: { workspace: 'codev', kind: 'id', name: 'builder-spir-1940' },
          body: 'hello',
          ...overrides,
        }),
      );

    it('reads a payload that fits, ignoring unknown fields, and returns fresh addresses', () => {
      const result = readMessagePayload(payload({ extra: 1, from: null }), NOW);
      expect(result).toEqual({
        ok: true,
        payload: { sentAt, to: { workspace: 'codev', kind: 'architect', name: 'local' }, from: null, body: 'hello' },
      });
      const withoutWorkspace = readMessagePayload(payload({ from: { kind: 'architect' } }), NOW);
      expect(withoutWorkspace).toMatchObject({ ok: true, payload: { from: { kind: 'architect' } } });
    });

    it.each([
      ['to without a workspace', { to: { kind: 'architect' } }],
      ['to naming a Tower', { to: { tower: 'mbp', workspace: 'codev', kind: 'architect' } }],
      ['to naming an owner', { to: { owner: 'ana', workspace: 'codev', kind: 'architect' } }],
      ['to of an unknown kind', { to: { workspace: 'codev', kind: 'shell', name: 'shell-1' } }],
      ['to an id without a name', { to: { workspace: 'codev', kind: 'id' } }],
      ['to with an upper-case component', { to: { workspace: 'Codev', kind: 'architect' } }],
      ['to with a null name', { to: { workspace: 'codev', kind: 'architect', name: null } }],
      ['to whose text form is too long', { to: { workspace: 'w'.repeat(300), kind: 'id', name: 'n'.repeat(300) } }],
      ['to that has no text form', { to: { workspace: 'architect', kind: 'architect' } }],
      ['from as a string', { from: 'codev:architect' }],
      ['from of an unknown kind', { from: { kind: 'human' } }],
      ['sentAt missing', { sentAt: undefined }],
      ['sentAt negative', { sentAt: -1 }],
      ['sentAt with a fraction', { sentAt: sentAt + 0.5 }],
      ['body missing', { body: undefined }],
      ['body not a string', { body: ['hello'] }],
    ])('refuses %s as malformed', (_label, overrides) => {
      expect(readMessagePayload(payload(overrides), NOW)).toEqual({ ok: false, reason: 'malformed' });
    });

    it('refuses bytes that are not a JSON object, not UTF-8, or repeat a key', () => {
      for (const bytes of [
        utf8('[]'),
        utf8('not json'),
        new Uint8Array([0xc3, 0x28]),
        new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(WORKED_PAYLOAD)]),
        utf8(WORKED_PAYLOAD.replace('"body"', '"body":"x","body"')),
        utf8(WORKED_PAYLOAD.replace('"name":"local"', '"name":"local","name":"main"')),
      ]) {
        expect(readMessagePayload(bytes, NOW)).toEqual({ ok: false, reason: 'malformed' });
      }
    });

    it('applies the clock: at most 5 minutes ahead, at most 30 days old, both inclusive', () => {
      const day = 86_400_000;
      expect(readMessagePayload(payload({ sentAt: NOW + 300_000 }), NOW).ok).toBe(true);
      expect(readMessagePayload(payload({ sentAt: NOW + 300_001 }), NOW)).toEqual({ ok: false, reason: 'clock-skew' });
      expect(readMessagePayload(payload({ sentAt: NOW - 30 * day }), NOW).ok).toBe(true);
      expect(readMessagePayload(payload({ sentAt: NOW - 30 * day - 1 }), NOW)).toEqual({ ok: false, reason: 'expired' });
    });

    it('checks the body size last, after the field rules and the clock', () => {
      const big = 'a'.repeat(49_153);
      expect(readMessagePayload(payload({ body: 'a'.repeat(49_152) }), NOW).ok).toBe(true);
      expect(readMessagePayload(payload({ body: big }), NOW)).toEqual({ ok: false, reason: 'too-large' });
      expect(readMessagePayload(payload({ body: big, sentAt: NOW - 31 * 86_400_000 }), NOW)).toEqual({
        ok: false,
        reason: 'expired',
      });
      expect(readMessagePayload(payload({ body: big, to: { kind: 'architect' } }), NOW)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    });
  });

  it("R's step 12 for a query", () => {
    const encoded = encodeQueryPayload(NOW);
    if (!encoded.ok) throw new Error('refused');
    expect(Buffer.from(encoded.bytes).toString('utf8')).toBe(`{"sentAt":${NOW},"what":"addresses"}`);
    expect(readQueryPayload(encoded.bytes, NOW)).toEqual({ ok: true, payload: { sentAt: NOW, what: 'addresses' } });
    expect(readQueryPayload(utf8(`{"sentAt":${NOW},"what":"agents"}`), NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(readQueryPayload(utf8(`{"what":"addresses"}`), NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(readQueryPayload(utf8(`{"sentAt":${NOW + 300_001},"what":"addresses"}`), NOW)).toEqual({
      ok: false,
      reason: 'clock-skew',
    });
  });

  it('accepts only addresses a payload may carry', () => {
    expect(isWireAddress({ workspace: 'codev', kind: 'architect' })).toBe(true);
    expect(isWireAddress({ workspace: 'codev', kind: 'id', name: 'builder-spir-1940' })).toBe(true);
    expect(isWireAddress({ kind: 'architect' })).toBe(false);
    expect(isWireAddress({ workspace: 'codev', kind: 'id', name: 'arch' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The relay call's headers
// ---------------------------------------------------------------------------

describe("the relay call's headers", () => {
  const request = { kind: 'message' as const, toTowerId: RECEIVER, requestId: '6f1c2a9e-3b4d-4c5e-8f60-718293a4b5c6' };

  it('builds the four headers and reads them back', () => {
    const headers = buildRelayRequestHeaders(request);
    expect(headers).toEqual({
      'content-type': 'application/json',
      [PEER_HEADER.version]: '1',
      [PEER_HEADER.kind]: 'message',
      [PEER_HEADER.to]: RECEIVER,
      [PEER_HEADER.requestId]: request.requestId,
    });
    expect(readRelayRequestHeaders(headers)).toEqual({ ok: true, version: 1, ...request });
  });

  it('refuses a request id that is not a canonical lower-case UUID', () => {
    expect(() => buildRelayRequestHeaders({ ...request, requestId: request.requestId.toUpperCase() })).toThrow();
    const headers = { ...buildRelayRequestHeaders(request), [PEER_HEADER.requestId]: request.requestId.toUpperCase() };
    expect(readRelayRequestHeaders(headers)).toEqual({ ok: false, reason: 'malformed' });
  });

  it("reads them as C's step 2 does", () => {
    const headers = buildRelayRequestHeaders(request);
    expect(readRelayRequestHeaders({ ...headers, [PEER_HEADER.kind]: 'answer' })).toEqual({ ok: false, reason: 'malformed' });
    expect(readRelayRequestHeaders({ ...headers, 'content-encoding': 'identity' })).toEqual({ ok: false, reason: 'malformed' });
    expect(readRelayRequestHeaders({ ...headers, [PEER_HEADER.to]: undefined })).toEqual({ ok: false, reason: 'malformed' });
    expect(readRelayRequestHeaders({ ...headers, [PEER_HEADER.version]: '2' })).toEqual({
      ok: false,
      reason: 'unsupported-version',
    });
  });
});

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

function answered(status: number, body: unknown, outcomeHeader?: string, contentType = 'application/json'): RelayCallResult {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const outcome =
    outcomeHeader ?? (typeof body === 'object' && body !== null ? String((body as { outcome?: unknown }).outcome) : undefined);
  return { answered: true, status, contentType, outcomeHeader: outcome, body: utf8(text) };
}

function encodedAsCall(encoded: { status: number; headers: Record<string, string>; body: Uint8Array }): RelayCallResult {
  return {
    answered: true,
    status: encoded.status,
    contentType: encoded.headers['content-type'],
    outcomeHeader: encoded.headers[PEER_HEADER.outcome],
    body: encoded.body,
  };
}

const message = { kind: 'message' as const, relayStated: true };
const query = { kind: 'query' as const, relayStated: true };

describe("answers as R writes them", () => {
  it('encodes an answer with v, the outcome header and the JSON media type', () => {
    const encoded = encodeReceiverAnswer({ outcome: 'held', reason: 'busy' });
    expect(encoded.status).toBe(200);
    expect(encoded.headers).toEqual({ 'content-type': 'application/json', [PEER_HEADER.outcome]: 'held' });
    expect(JSON.parse(Buffer.from(encoded.body).toString('utf8'))).toEqual({ v: 1, outcome: 'held', reason: 'busy' });
    expect(classifyRelayAnswer(encodedAsCall(encoded), message)).toMatchObject({
      decidedBy: 'receiver',
      outcome: 'held',
      reason: 'busy',
    });
  });

  it('caps detail at 500 characters without splitting a character', () => {
    const encoded = encodeReceiverAnswer({ outcome: 'refused', reason: 'no-grant', detail: cp(0x1f600).repeat(600) });
    const detail = (JSON.parse(Buffer.from(encoded.body).toString('utf8')) as { detail: string }).detail;
    expect(Array.from(detail)).toHaveLength(500);
    expect(detail).toBe(cp(0x1f600).repeat(500));
  });

  it('keeps every discovery address when they fit', () => {
    const addresses: PeerDiscoveredAddress[] = [
      { address: { workspace: 'codev', kind: 'architect', name: 'local' }, live: true },
      { address: { workspace: 'codev', kind: 'id', name: 'builder-spir-1940' }, live: false },
    ];
    const encoded = encodeDiscoveryAnswer(addresses);
    expect(JSON.parse(Buffer.from(encoded.body).toString('utf8'))).toEqual({
      v: 1,
      outcome: 'answered',
      truncated: false,
      addresses,
    });
    expect(classifyRelayAnswer(encodedAsCall(encoded), query)).toMatchObject({
      decidedBy: 'receiver',
      outcome: 'answered',
      answer: { addresses, truncated: false },
    });
  });

  it('leaves out a discovery address that does not fit the address rules, and copies only known fields', () => {
    const encoded = encodeDiscoveryAnswer([
      { address: { workspace: 'Codev', kind: 'architect' }, live: true },
      { address: { workspace: 'codev', kind: 'id', name: 'arch' }, live: true },
      { address: { workspace: 'codev', kind: 'architect', extra: 'x' } as PeerDiscoveredAddress['address'], live: false },
    ]);
    expect(JSON.parse(Buffer.from(encoded.body).toString('utf8'))).toEqual({
      v: 1,
      outcome: 'answered',
      truncated: false,
      addresses: [{ address: { workspace: 'codev', kind: 'architect' }, live: false }],
    });
  });

  it('trims discovery addresses to the 65 536-byte answer, keeping as many as fit, in order', () => {
    const addresses: PeerDiscoveredAddress[] = Array.from({ length: 2_000 }, (_, i) => ({
      address: { workspace: `workspace-${i}`, kind: 'id', name: `builder-spir-${i}-${'x'.repeat(i % 7)}` },
      live: i % 2 === 0,
    }));
    const encoded = encodeDiscoveryAnswer(addresses);
    expect(encoded.body.length).toBeLessThanOrEqual(65_536);
    const answer = JSON.parse(Buffer.from(encoded.body).toString('utf8')) as { truncated: boolean; addresses: unknown[] };
    expect(answer.truncated).toBe(true);
    expect(answer.addresses).toEqual(addresses.slice(0, answer.addresses.length));
    // One more would not have fitted.
    const oneMore = JSON.stringify({ ...answer, addresses: addresses.slice(0, answer.addresses.length + 1) });
    expect(byteLength(oneMore)).toBeGreaterThan(65_536);
    expect(classifyRelayAnswer(encodedAsCall(encoded), query)).toMatchObject({ outcome: 'answered' });
  });
});

describe('answers as S reads them: who decided, and what', () => {
  /** Section 6's table of C's answers. */
  const cloudRows: Array<[number, 'refused' | 'unavailable', string, Record<string, unknown>?]> = [
    [400, 'refused', 'malformed'],
    [400, 'refused', 'unsupported-version', { supported: [1] }],
    [401, 'refused', 'unauthenticated'],
    [404, 'refused', 'unknown-tower'],
    [409, 'refused', 'peer-unsupported'],
    [413, 'refused', 'too-large'],
    [429, 'refused', 'rate-limited', { retryAfterSec: 20 }],
    [429, 'refused', 'rate-limited'],
    [500, 'unavailable', 'cloud-error'],
    [502, 'unavailable', 'tower-error'],
    [503, 'unavailable', 'tower-offline'],
    [504, 'unavailable', 'no-answer'],
  ];
  const statusesWithoutBody = [301, 400, 401, 403, 404, 409, 413, 429, 500, 502, 503, 504];

  for (const relayStated of [false, true]) {
    for (const kind of ['message', 'query'] as const) {
      const context = { kind, relayStated };
      const when = `${kind}, relay ${relayStated ? 'stated' : 'never stated'}`;

      it(`${when}: each of C's statuses with the body is C's decision, as section 6's table says`, () => {
        for (const [status, outcome, reason, extra] of cloudRows) {
          const body = { v: 1, outcome, reason, ...extra };
          const result = classifyRelayAnswer(answered(status, body), context);
          expect(result, `${status} ${reason}`).toEqual({
            decidedBy: 'cloud',
            status,
            outcome,
            reason,
            answer: body,
          });
        }
      });

      it(`${when}: each status without the body is held, except a bare 404 before a relay is stated`, () => {
        for (const status of statusesWithoutBody) {
          for (const call of [
            answered(status, '<html>Not Found</html>', undefined, 'text/html'),
            answered(status, { error: 'nope' }),
            answered(status, ''),
          ]) {
            const result = classifyRelayAnswer(call, context);
            const expected =
              !relayStated && status === 404
                ? { decidedBy: 'none', status, outcome: 'refused', reason: 'no-relay', answer: null }
                : { decidedBy: 'none', status, outcome: 'unavailable', reason: 'cloud-unreachable', answer: null };
            expect(result, String(status)).toEqual(expected);
          }
        }
      });

      it(`${when}: no answer at all is held as cloud unreachable`, () => {
        expect(classifyRelayAnswer({ answered: false }, context)).toEqual({
          decidedBy: 'none',
          status: null,
          outcome: 'unavailable',
          reason: 'cloud-unreachable',
          answer: null,
        });
      });

      it(`${when}: a 200 that does not fit the shape is treated as tower-error`, () => {
        const good = kind === 'message' ? { v: 1, outcome: 'delivered' } : { v: 1, outcome: 'answered', truncated: false, addresses: [] };
        for (const call of [
          answered(200, good, 'held'),
          answered(200, good, undefined, 'text/plain'),
          answered(200, { ...good, v: 2 }),
          answered(200, { ...good, v: '1' }),
          answered(200, { v: 1, outcome: 'refused' }),
          answered(200, { v: 1, outcome: 'refused', reason: 'no-such-reason' }),
          answered(200, { v: 1, outcome: 'refused', reason: 'unsupported-version' }),
          answered(200, { v: 1, outcome: 'unavailable', reason: 'tower-offline' }),
          answered(200, { ...good, detail: 42 }),
          answered(200, { ...good, duplicate: 'yes' }),
          answered(200, { v: 1, outcome: 'refused', reason: 'rate-limited', retryAfterSec: -1 }),
          answered(200, kind === 'message' ? { v: 1, outcome: 'answered', truncated: false, addresses: [] } : { v: 1, outcome: 'held', reason: 'busy' }),
          answered(200, '{"v":1,"outcome":"delivered","outcome":"delivered"}', 'delivered'),
          answered(200, 'not json', 'delivered'),
          answered(200, { ...good, padding: 'x'.repeat(65_536) }),
        ]) {
          expect(classifyRelayAnswer(call, context), Buffer.from((call as { body: Uint8Array }).body).toString().slice(0, 80)).toEqual({
            decidedBy: 'none',
            status: 200,
            outcome: 'unavailable',
            reason: 'tower-error',
            answer: null,
          });
        }
      });
    }
  }

  it("reads each of R's message answers, with and without duplicate", () => {
    const answers = [
      { v: 1, outcome: 'delivered' },
      { v: 1, outcome: 'delivered', duplicate: true },
      ...['busy', 'no-profile', 'no-live-pty', 'held-for-release'].map((reason) => ({ v: 1, outcome: 'held', reason })),
      { v: 1, outcome: 'held', reason: 'busy', duplicate: true },
      ...[
        'remote-off',
        'no-grant',
        'no-such-agent',
        'not-addressable',
        'too-large',
        'expired',
        'clock-skew',
        'mismatch',
        'dismissed',
        'malformed',
      ].map((reason) => ({ v: 1, outcome: 'refused', reason, detail: 'for a person' })),
      { v: 1, outcome: 'refused', reason: 'rate-limited', retryAfterSec: 12 },
      { v: 1, outcome: 'refused', reason: 'unsupported-version', supported: [1, 2] },
      { v: 1, outcome: 'refused', reason: 'dismissed', duplicate: true },
      { v: 1, outcome: 'not-verified' },
    ];
    for (const relayStated of [false, true]) {
      for (const body of answers) {
        const result = classifyRelayAnswer(answered(200, body), { kind: 'message', relayStated });
        expect(result, JSON.stringify(body)).toEqual({
          decidedBy: 'receiver',
          status: 200,
          outcome: body.outcome,
          reason: 'reason' in body ? body.reason : null,
          answer: body,
        });
      }
    }
  });

  it('accepts the JSON media type with parameters, in any case', () => {
    const call = answered(200, { v: 1, outcome: 'delivered' }, undefined, 'Application/JSON; charset=utf-8');
    expect(classifyRelayAnswer(call, message).decidedBy).toBe('receiver');
  });

  it('drops unknown fields, and fields only a 200 carries when C answered', () => {
    const fromR = classifyRelayAnswer(answered(200, { v: 1, outcome: 'delivered', later: { x: 1 } }), message);
    expect(fromR.answer).toEqual({ v: 1, outcome: 'delivered' });
    const fromC = classifyRelayAnswer(
      answered(503, { v: 1, outcome: 'unavailable', reason: 'tower-offline', detail: 'x', duplicate: true, retryAfterSec: 3 }),
      message,
    );
    expect(fromC).toMatchObject({ decidedBy: 'cloud', answer: { v: 1, outcome: 'unavailable', reason: 'tower-offline' } });
    expect(fromC.answer).not.toHaveProperty('detail');
    expect(fromC.answer).not.toHaveProperty('retryAfterSec');
  });

  it("takes who decided from the status, never the body: C's status with R's outcome has no body", () => {
    expect(classifyRelayAnswer(answered(503, { v: 1, outcome: 'delivered' }), message)).toMatchObject({
      decidedBy: 'none',
      reason: 'cloud-unreachable',
    });
    expect(classifyRelayAnswer(answered(503, { v: 1, outcome: 'refused', reason: 'tower-offline' }), message)).toMatchObject({
      decidedBy: 'none',
      reason: 'cloud-unreachable',
    });
    expect(classifyRelayAnswer(answered(404, { v: 1, outcome: 'refused', reason: 'no-grant' }), { ...message, relayStated: false })).toMatchObject({
      decidedBy: 'none',
      reason: 'no-relay',
    });
  });

  it("refuses a C answer whose outcome header differs from its body", () => {
    const call = answered(404, { v: 1, outcome: 'refused', reason: 'unknown-tower' }, 'unavailable');
    expect(classifyRelayAnswer(call, message)).toMatchObject({ decidedBy: 'none', reason: 'cloud-unreachable' });
  });

  it('reads a discovery answer only for a query, and checks each address', () => {
    const body = {
      v: 1,
      outcome: 'answered',
      truncated: false,
      addresses: [{ address: { workspace: 'codev', kind: 'architect' }, live: true }],
    };
    expect(classifyRelayAnswer(answered(200, body), query).decidedBy).toBe('receiver');
    expect(classifyRelayAnswer(answered(200, body), message).reason).toBe('tower-error');
    const shell = { ...body, addresses: [{ address: { workspace: 'codev', kind: 'shell', name: 's' }, live: true }] };
    expect(classifyRelayAnswer(answered(200, shell), query).reason).toBe('tower-error');
    const noLive = { ...body, addresses: [{ address: { workspace: 'codev', kind: 'architect' } }] };
    expect(classifyRelayAnswer(answered(200, noLive), query).reason).toBe('tower-error');
  });

  it('makes a detail safe to print: no control or invisible characters, at most 500 characters', () => {
    const hostile = `ok${cp(0x1b)}[2J${cp(0x0a)}line${cp(0x2028)}${cp(0x202e)}rev${cp(0x200b)}`;
    expect(printableDetail(hostile)).toBe('ok[2Jlinerev');
    expect(Array.from(printableDetail(cp(0x1f600).repeat(700)))).toHaveLength(500);
  });
});

// ---------------------------------------------------------------------------
// S's refusal order
// ---------------------------------------------------------------------------

describe("S's refusal order", () => {
  it("lists S's checks in the contract's order (section 4, checks 0 to 9)", () => {
    expect(SENDER_CHECK_ORDER).toEqual([
      'address',
      'remote-off',
      'not-connected',
      'not-registered',
      'no-relay',
      'option-not-allowed',
      'too-large',
      'unknown-tower',
      'builder-rule',
      'rate-limited',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Structure: one production module speaks the contract
// ---------------------------------------------------------------------------

describe('structure: only contract.ts and peer-wire.ts speak the contract', () => {
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const allowed = new Set(['packages/codev/src/agent-farm/peer/contract.ts', 'packages/types/src/peer-wire.ts']);
  const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
  const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

  /**
   * Every production source file under packages/<name>/src and apps/<name>/src. Exempt,
   * by name: `__tests__/` directories and `*.test.*` / `*.spec.*` files, where the
   * stand-in for Codev Cloud and the tests that craft raw requests must write the
   * protocol themselves.
   */
  function productionSources(): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (['__tests__', 'node_modules', 'dist'].includes(entry.name)) continue;
          walk(join(dir, entry.name));
        } else if (SOURCE.test(entry.name) && !TEST_FILE.test(entry.name)) {
          files.push(join(dir, entry.name));
        }
      }
    };
    for (const top of ['packages', 'apps']) {
      for (const entry of readdirSync(join(repoRoot, top), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          walk(join(repoRoot, top, entry.name, 'src'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
    return files;
  }

  const HEADER_NAME = /x-codev-peer-/i;
  const CLOUD_STATUS = /\b(400|401|404|409|413|429|500|502|503|504)\b/;
  const CLOUD_REASON = /\b(cloud-error|tower-error|tower-offline|no-answer|peer-unsupported|unknown-tower|unauthenticated)\b/;

  /** A status of section 6's table within two lines of one of C's relay reasons. */
  function mapsStatusToOutcome(text: string): boolean {
    const lines = text.split('\n');
    return lines.some(
      (line, i) => CLOUD_STATUS.test(line) && lines.slice(Math.max(0, i - 2), i + 3).some((near) => CLOUD_REASON.test(near)),
    );
  }

  it('finds the mapping where it is, so the check below can fail', () => {
    const contract = readFileSync(join(repoRoot, 'packages/codev/src/agent-farm/peer/contract.ts'), 'utf8');
    expect(HEADER_NAME.test(contract)).toBe(true);
    expect(mapsStatusToOutcome(contract)).toBe(true);
    expect(mapsStatusToOutcome("case 503:\n  return { outcome: 'unavailable', reason: 'tower-offline' };")).toBe(true);
    expect(mapsStatusToOutcome("if (res.status === 404) return 'not found';")).toBe(false);
  });

  it('no other production file contains a contract header name or a status-to-outcome mapping', () => {
    const files = productionSources();
    expect(files.length).toBeGreaterThan(200);
    const offenders: string[] = [];
    for (const file of files) {
      const path = relative(repoRoot, file).split('\\').join('/');
      if (allowed.has(path)) continue;
      const text = readFileSync(file, 'utf8');
      if (HEADER_NAME.test(text)) offenders.push(`${path}: a contract header name`);
      if (mapsStatusToOutcome(text)) offenders.push(`${path}: a status-to-outcome mapping`);
    }
    expect(offenders).toEqual([]);
  });
});
