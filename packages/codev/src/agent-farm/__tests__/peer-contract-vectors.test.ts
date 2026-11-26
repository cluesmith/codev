/**
 * The shared contract vectors (Spec 1967, Wire Contract section 11), run unchanged from
 * `packages/types/fixtures/peer-contract-vectors.json`. Codev Cloud runs a copy of the
 * same file, so the two halves cannot disagree about the HMAC, the hash or the field rules.
 *
 * Each case's HMAC-SHA-256 and SHA-256 are computed here with `node:crypto` directly and
 * compared with the file BEFORE the case goes through `peer/contract.ts`, so a misreading
 * of the contract in that module cannot also be mirrored in what checks it.
 */

import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeBase64Url, verifyRelayedRequest } from '../peer/contract.js';

interface VectorCase {
  name: string;
  secret: string;
  statement: string;
  mac: string;
  payload: string;
  receiverTowerId: string;
  receiverNow: number;
  verdict: 'verified' | 'not-verified' | 'refused';
  reason: string | null;
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../types/fixtures/peer-contract-vectors.json', import.meta.url)), 'utf8'),
) as { protocol: number; cases: VectorCase[] };

/** Node's own decoder: lenient, which is right for an independent check of the bytes. */
const bytesOf = (base64url: string) => Buffer.from(base64url, 'base64url');

const SPEC_WORKED = {
  secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  payload:
    '{"sentAt":1764100000000,"to":{"workspace":"codev","kind":"architect","name":"local"},"from":{"workspace":"codev","kind":"architect","name":"main"},"body":"CI is green on the tunnel branch"}',
  payloadSha256: '25d8ef538f7d24c01101821a3073a10ac254fccd0968d4c2117682e47a2d0be3',
  statement:
    '{"v":1,"kind":"message","toTowerId":"01JDEVVM0000000000000000AA","fromTowerId":"01JMBP000000000000000000AA","fromTowerSlug":"ana-s-mbp","fromOwnerId":"usr_ana","fromOwnerHandle":null,"fromOwnerEmail":"ana@example.com","sameOwner":true,"requestId":"6f1c2a9e-3b4d-4c5e-8f60-718293a4b5c6","issuedAt":1764100000123,"statementId":"AAECAwQFBgcICQoLDA0ODw","payloadSha256":"25d8ef538f7d24c01101821a3073a10ac254fccd0968d4c2117682e47a2d0be3"}',
  mac: 'FepqsXkRsyaZ7F0_Du5vpiP4TG9X7sEBEDm1AabkiMQ',
  receiverTowerId: '01JDEVVM0000000000000000AA',
  receiverNow: 1764100000500,
};

/** What node:crypto says of a case, independently of contract.ts. */
function independently(c: VectorCase): { macMatches: boolean; hashMatches: boolean } {
  const statement = bytesOf(c.statement.replace(/\+/g, '-').replace(/\//g, '_'));
  const mac = createHmac('sha256', bytesOf(c.secret)).update(statement).digest('base64url');
  const hash = createHash('sha256').update(bytesOf(c.payload)).digest('hex');
  let stated: unknown;
  try {
    stated = (JSON.parse(statement.toString('utf8')) as { payloadSha256?: unknown }).payloadSha256;
  } catch {
    stated = undefined;
  }
  return { macMatches: mac === c.mac, hashMatches: stated === hash };
}

describe('peer contract vectors: the shared file', () => {
  it('is protocol 1, with uniquely named cases', () => {
    expect(vectors.protocol).toBe(1);
    expect(vectors.cases.length).toBeGreaterThan(100);
    expect(new Set(vectors.cases.map((c) => c.name)).size).toBe(vectors.cases.length);
  });

  it('carries the worked case of section 11 byte for byte', () => {
    const worked = vectors.cases[0];
    expect(Buffer.from(worked.secret, 'base64url')).toEqual(Buffer.from(Array.from({ length: 32 }, (_, i) => i)));
    expect(worked.secret).toBe(SPEC_WORKED.secret);
    expect(bytesOf(worked.payload).toString('utf8')).toBe(SPEC_WORKED.payload);
    expect(createHash('sha256').update(SPEC_WORKED.payload, 'utf8').digest('hex')).toBe(SPEC_WORKED.payloadSha256);
    expect(bytesOf(worked.statement).toString('utf8')).toBe(SPEC_WORKED.statement);
    expect(bytesOf(worked.statement)).toHaveLength(433);
    expect(worked.statement).toHaveLength(578);
    expect(createHmac('sha256', bytesOf(SPEC_WORKED.secret)).update(SPEC_WORKED.statement, 'utf8').digest('base64url')).toBe(
      SPEC_WORKED.mac,
    );
    expect(worked.mac).toBe(SPEC_WORKED.mac);
    expect(worked.receiverTowerId).toBe(SPEC_WORKED.receiverTowerId);
    expect(worked.receiverNow).toBe(SPEC_WORKED.receiverNow);
    expect(worked.verdict).toBe('verified');
  });

  it('has a 32-byte secret in every case', () => {
    for (const c of vectors.cases) expect(bytesOf(c.secret), c.name).toHaveLength(32);
  });

  it('agrees with node:crypto: every verified case has a good MAC and hash, every refusal a good MAC', () => {
    let wrongMacs = 0;
    let wrongHashes = 0;
    for (const c of vectors.cases) {
      const { macMatches, hashMatches } = independently(c);
      if (c.verdict === 'verified') expect({ macMatches, hashMatches }, c.name).toEqual({ macMatches: true, hashMatches: true });
      if (c.verdict === 'refused') expect(macMatches, c.name).toBe(true);
      if (!macMatches) wrongMacs++;
      if (!hashMatches) wrongHashes++;
    }
    // The file exercises both failures the contract names: another secret, and an altered payload.
    expect(wrongMacs).toBeGreaterThan(0);
    expect(wrongHashes).toBeGreaterThan(0);
  });

  it('covers every verdict, and both refusals of steps 3 and 7', () => {
    const verdicts = new Set(vectors.cases.map((c) => `${c.verdict}:${c.reason}`));
    expect(verdicts).toEqual(
      new Set(['verified:null', 'not-verified:null', 'refused:unsupported-version', 'refused:clock-skew']),
    );
  });
});

describe('peer contract vectors: through contract.ts', () => {
  it.each(vectors.cases)('$name', (c) => {
    const secret = decodeBase64Url(c.secret);
    expect(secret).not.toBeNull();
    const result = verifyRelayedRequest({
      statementHeader: c.statement,
      macHeader: c.mac,
      body: bytesOf(c.payload),
      sessionSecret: secret,
      receiverTowerId: c.receiverTowerId,
      now: c.receiverNow,
    });
    expect({ verdict: result.verdict, reason: 'reason' in result ? result.reason : null }).toEqual({
      verdict: c.verdict,
      reason: c.reason,
    });
    // Where a case's name says which step decides it ("(step 6 before step 7)"), it is
    // decided there and not, by accident, at an earlier one.
    const named = /\(step (\d)/.exec(c.name);
    if (named) expect('step' in result ? result.step : null).toBe(Number(named[1]));
  });

  it('names the deciding step of every case that is not verified', () => {
    for (const c of vectors.cases) {
      if (c.verdict !== 'verified') expect(c.name, c.name).toMatch(/\(step \d/);
    }
  });
});
