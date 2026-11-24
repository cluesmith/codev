/**
 * Address conformance (Spec 1940, phase 1): packages/codev (the CLI and Tower) reads and writes addresses through its own
 * import of `@cluesmith/codev-sdk/address`, against the one shared table in
 * `packages/types/fixtures/address-cases.json`. The SDK's own `address.test.ts` and the
 * other consumer run the same table, so the CLI, Tower and the VS Code extension cannot
 * disagree about what an address means.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentAddress, AddressReader, AddressParseErrorCode } from '@cluesmith/codev-types';
import { completeAddress, formatAddress, parseAddress } from '@cluesmith/codev-sdk/address';

interface ParseCase { note: string; input: string; address?: AgentAddress; error?: AddressParseErrorCode }
interface FormatCase { note: string; address: AgentAddress; reader: AddressReader; text: string }

const table = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../types/fixtures/address-cases.json', import.meta.url)), 'utf8'),
) as { parse: ParseCase[]; format: FormatCase[] };

describe('address conformance: the shared table', () => {
  it('is loaded', () => {
    expect(table.parse.length).toBeGreaterThan(60);
    expect(table.format.length).toBeGreaterThan(10);
  });

  it.each(table.parse)('parse: $note — "$input"', ({ input, address, error }) => {
    const result = parseAddress(input);
    if (address !== undefined) {
      expect(result).toEqual({ ok: true, address });
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(error);
      }
    }
  });

  it.each(table.format)('format: $note → $text', ({ address, reader, text }) => {
    expect(formatAddress(address, reader)).toBe(text);
    const parsed = parseAddress(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(completeAddress(parsed.address, reader)).toEqual(address);
    }
  });
});
