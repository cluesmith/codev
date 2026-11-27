/**
 * The address parser and formatter (Spec 1940, phase 1), against the shared table in
 * `packages/types/fixtures/address-cases.json`. The same table is run by packages/codev
 * and apps/vscode through their own imports (`address-conformance.test.ts` in each), so
 * the three consumers cannot disagree about what an address means.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentAddress, AddressReader, AddressParseErrorCode } from '@cluesmith/codev-types';
import {
  ADDRESS_SCHEME,
  MAX_ADDRESS_LENGTH,
  RESERVED_WORKSPACE_NAMES,
  completeAddress,
  formatAddress,
  isAddressComponent,
  isRemoteAddress,
  isReservedWorkspaceName,
  parseAddress,
  parseTowerRef,
  sameAddress,
  tryFormatAddress,
} from '../address.js';

interface ParseCase { note: string; input: string; address?: AgentAddress; error?: AddressParseErrorCode }
interface FormatCase { note: string; address: AgentAddress; reader: AddressReader; text: string }

const table = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../types/fixtures/address-cases.json', import.meta.url)), 'utf8'),
) as { parse: ParseCase[]; format: FormatCase[] };

const valid = table.parse.filter((c) => c.address !== undefined);
const malformed = table.parse.filter((c) => c.error !== undefined);

describe('the shared address table', () => {
  it('is not empty, and every parse row is either an address or an error', () => {
    expect(valid.length).toBeGreaterThan(30);
    expect(malformed.length).toBeGreaterThan(30);
    expect(table.format.length).toBeGreaterThan(10);
    expect(valid.length + malformed.length).toBe(table.parse.length);
  });

  it('has no two rows for one input', () => {
    const inputs = table.parse.map((c) => c.input);
    expect(new Set(inputs).size).toBe(inputs.length);
  });
});

describe('parseAddress: valid addresses', () => {
  it.each(valid)('$note — $input', ({ input, address }) => {
    expect(parseAddress(input)).toEqual({ ok: true, address });
  });
});

describe('parseAddress: malformed addresses', () => {
  it.each(malformed)('$note — "$input" → $error', ({ input, error }) => {
    const result = parseAddress(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(error);
    // Every refusal says what is wrong and names the shape that was expected: the afx://
    // shape when the text was (or was meant to be) a remote address, the local one otherwise.
    expect(result.error.message.length).toBeGreaterThan(10);
    const meantRemote = /^afx(:\/|\/\/)/.test(input.trim().toLowerCase());
    expect(result.error.expected.startsWith(ADDRESS_SCHEME)).toBe(meantRemote);
    expect(result.error.expected).toContain('architect');
  });

  it('names the local shape for a local address and the afx:// shape for a remote one', () => {
    const local = parseAddress('a:b:c');
    const remote = parseAddress('afx://devvm');
    expect(local.ok).toBe(false);
    expect(remote.ok).toBe(false);
    if (local.ok || remote.ok) return;
    expect(local.error.expected.startsWith('[<workspace>:]')).toBe(true);
    expect(remote.error.expected.startsWith(ADDRESS_SCHEME)).toBe(true);
  });

  it('tells a mistyped scheme what was meant', () => {
    const result = parseAddress('afx:/devvm/codev:architect');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('`afx://`');
  });

  it('words the Tower-written-as-a-workspace error the way the spec does', () => {
    const result = parseAddress('devvm:codev:architect');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe('a local address has at most a workspace before `architect`');
  });
});

describe('parseAddress: what a refusal quotes back', () => {
  // The message goes into an HTTP body and onto a terminal; the value is what was typed.
  const hostile: Array<[string, string]> = [
    ['an owner', 'afx://s\u001b[31mam@mbp/codev:architect'],
    ['a Tower name', 'afx://dev\u001b]0;x\u0007vm/codev:architect'],
    ['a workspace', 'afx://devvm/co\u001b[2Jdev:architect'],
    ['an architect name', 'afx://devvm/codev:architect:re\u0007view'],
    ['an id', 'afx://devvm/codev:builder\u009b-spir'],
    ['a name outside ASCII', 'afx://devvm/codev:architect:caf\u00e9'],
  ];
  it.each(hostile)('%s with a character no terminal should be handed is quoted as `?`', (_note, input) => {
    const result = parseAddress(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_COMPONENT');
    expect(result.error.message).toMatch(/^[\x20-\x7e]+$/);
    expect(result.error.message).toContain('?');
  });

  it('cuts a long value short', () => {
    const result = parseAddress(`afx://devvm/codev:architect:${'x'.repeat(200)}!`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_COMPONENT');
    expect(result.error.message).toContain(`\`${'x'.repeat(64)}...\``);
    expect(result.error.message).not.toContain('x'.repeat(65));
  });
});

describe('parseAddress: the length bound', () => {
  const longest = `codev:architect:${'a'.repeat(MAX_ADDRESS_LENGTH - 'codev:architect:'.length)}`;

  it('reads an address of exactly the bound', () => {
    expect(longest.length).toBe(MAX_ADDRESS_LENGTH);
    expect(parseAddress(longest).ok).toBe(true);
  });

  it('refuses one character more, saying both lengths and quoting none of it', () => {
    const result = parseAddress(`${longest}a`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ADDRESS_TOO_LONG');
    expect(result.error.message).toBe('an address is at most 512 characters, and this one has 513');
  });

  it('measures the text after trimming, as it reads it', () => {
    expect(parseAddress(`   ${longest}   `).ok).toBe(true);
  });
});

describe('formatAddress: the shortest form correct for the reader', () => {
  it.each(table.format)('$note → $text', ({ address, reader, text }) => {
    expect(formatAddress(address, reader)).toBe(text);
  });

  it('lower-cases what it prints', () => {
    expect(formatAddress({ workspace: 'Codev-Cloud', kind: 'architect', name: 'Tunnel' }, { workspace: 'codev' }))
      .toBe('codev-cloud:architect:tunnel');
  });

  it('defaults to a reader that knows nothing, so the workspace is always printed', () => {
    expect(formatAddress({ workspace: 'codev', kind: 'id', name: 'builder-spir-1940' })).toBe('codev:builder-spir-1940');
  });
});

describe('round trip: parse the text, fill what it leaves out from the reader, get the address back', () => {
  it.each(table.format)('$note', ({ address, reader, text }) => {
    const parsed = parseAddress(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(completeAddress(parsed.address, reader)).toEqual(completeAddress(address, reader));
    // The address in the table is already complete for its reader.
    expect(completeAddress(address, reader)).toEqual(address);
  });

  it('every valid parse row formats back to text that parses to the same address', () => {
    for (const { address } of valid) {
      const text = formatAddress(address!, {});
      expect(parseAddress(text)).toEqual({ ok: true, address });
    }
  });
});

describe('formatAddress refuses an address that has no text form', () => {
  const reader: AddressReader = { workspace: 'codev' };
  const unprintable: Array<[string, AgentAddress]> = [
    ['a local workspace called architect (architect:<x> means a named architect)', { workspace: 'architect', kind: 'id', name: 'builder-spir-1' }],
    ['a local workspace containing a colon', { workspace: 'a:b', kind: 'architect' }],
    ['an empty local workspace', { workspace: '', kind: 'architect' }],
    ['an id that reads as the architect alias', { kind: 'id', name: 'arch' }],
    ['an id that reads as the kind word', { workspace: 'codev-cloud', kind: 'id', name: 'architect' }],
    ['an architect name containing a colon', { kind: 'architect', name: 'a:b' }],
    ['a remote workspace with a space', { tower: 'devvm', workspace: 'co dev', kind: 'architect' }],
    ['a remote workspace that is a reserved word', { tower: 'devvm', workspace: 'builder', kind: 'architect' }],
    ['a Tower name with a dot', { tower: 'dev.vm', workspace: 'codev', kind: 'architect' }],
  ];
  it.each(unprintable)('%s', (_note, address) => {
    expect(() => formatAddress(address, reader)).toThrow(/no text form/);
  });

  it('refuses structurally incomplete addresses', () => {
    // The type forbids an id with no name; an object read off the wire can still be one.
    expect(() => formatAddress({ kind: 'id' } as unknown as AgentAddress, reader)).toThrow(/no id/);
    expect(() => formatAddress({ owner: 'sam', workspace: 'codev', kind: 'architect' }, reader)).toThrow(/no Tower/);
    expect(() => formatAddress({ tower: 'devvm', kind: 'architect' }, reader)).toThrow(/no workspace/);
  });
});

describe('tryFormatAddress: the same answer as formatAddress, as a value', () => {
  const reader: AddressReader = { workspace: 'codev' };
  const frontDoorSuffix = ':architect';

  it('gives the text formatAddress gives', () => {
    const address: AgentAddress = { workspace: 'codev-cloud', kind: 'architect', name: 'tunnel' };
    expect(tryFormatAddress(address, reader)).toEqual({ ok: true, text: formatAddress(address, reader) });
  });

  it('a front door exactly as long as an address may be is written; one character more is refused by the parser', () => {
    const fits = 'w'.repeat(MAX_ADDRESS_LENGTH - frontDoorSuffix.length);
    expect(tryFormatAddress({ workspace: fits, kind: 'architect' })).toEqual({ ok: true, text: `${fits}${frontDoorSuffix}` });

    const tooLong = tryFormatAddress({ workspace: `${fits}w`, kind: 'architect' });
    expect(tooLong).toMatchObject({ ok: false, error: { code: 'ADDRESS_TOO_LONG' } });
    expect(() => formatAddress({ workspace: `${fits}w`, kind: 'architect' })).toThrow(/no text form/);
  });

  it('an address whose text reads as a different address has no parser error to report', () => {
    expect(tryFormatAddress({ workspace: 'architect', kind: 'id', name: 'builder-spir-1' }, reader)).toEqual({
      ok: false,
      text: 'architect:builder-spir-1',
      error: null,
    });
  });

  it('still throws for an address that cannot be laid out at all', () => {
    expect(() => tryFormatAddress({ tower: 'devvm', kind: 'architect' }, reader)).toThrow(/no workspace/);
  });
});

describe('completeAddress', () => {
  it('fills only what is absent', () => {
    const reader: AddressReader = { owner: 'ana', tower: 'mbp', workspace: 'codev' };
    expect(completeAddress({ kind: 'architect' }, reader))
      .toEqual({ owner: 'ana', tower: 'mbp', workspace: 'codev', kind: 'architect' });
    expect(completeAddress({ tower: 'devvm', workspace: 'x', kind: 'architect' }, reader))
      .toEqual({ owner: 'ana', tower: 'devvm', workspace: 'x', kind: 'architect' });
    expect(completeAddress({ owner: 'sam', tower: 'mbp', workspace: 'x', kind: 'architect' }, reader))
      .toEqual({ owner: 'sam', tower: 'mbp', workspace: 'x', kind: 'architect' });
  });

  it('leaves a part absent when the reader does not have it either (a Tower never connected)', () => {
    expect(completeAddress({ kind: 'id', name: '1940' }, { workspace: 'codev' }))
      .toEqual({ workspace: 'codev', kind: 'id', name: '1940' });
    expect(completeAddress({ kind: 'id', name: '1940' }, {})).toEqual({ kind: 'id', name: '1940' });
  });

  it('leaves an owner with no Tower as it found it, for the formatter to refuse', () => {
    const odd: AgentAddress = { owner: 'sam', workspace: 'codev', kind: 'architect' };
    expect(completeAddress(odd, { workspace: 'codev' })).toEqual(odd);
    expect(() => formatAddress(odd, { workspace: 'codev' })).toThrow(/no Tower/);
  });

  it('does not change its argument', () => {
    const address: AgentAddress = { kind: 'architect' };
    completeAddress(address, { workspace: 'codev' });
    expect(address).toEqual({ kind: 'architect' });
  });
});

describe('helpers', () => {
  it('isAddressComponent applies the component rule', () => {
    for (const ok of ['codev', 'codevos.ai', 'my_repo.v2-x', '1940', 'a']) expect(isAddressComponent(ok)).toBe(true);
    for (const bad of ['', 'Codev', 'co dev', '.codev', '-codev', '_x', 'a:b', 'a/b', 'a@b', 'café']) {
      expect(isAddressComponent(bad)).toBe(false);
    }
  });

  it('isReservedWorkspaceName covers the three words, in any case', () => {
    expect(RESERVED_WORKSPACE_NAMES).toEqual(['architect', 'arch', 'builder']);
    for (const word of ['architect', 'arch', 'builder', 'Architect', 'BUILDER']) expect(isReservedWorkspaceName(word)).toBe(true);
    for (const word of ['architects', 'builder-spir-1', 'codev']) expect(isReservedWorkspaceName(word)).toBe(false);
  });

  it('isRemoteAddress is true exactly when a Tower is named', () => {
    expect(isRemoteAddress({ kind: 'architect' })).toBe(false);
    expect(isRemoteAddress({ workspace: 'codev', kind: 'architect' })).toBe(false);
    expect(isRemoteAddress({ tower: 'devvm', workspace: 'codev', kind: 'architect' })).toBe(true);
  });

  it('sameAddress compares part for part', () => {
    expect(sameAddress({ kind: 'architect' }, { kind: 'architect' })).toBe(true);
    expect(sameAddress({ kind: 'architect' }, { kind: 'architect', name: 'main' })).toBe(false);
    expect(sameAddress({ workspace: 'a', kind: 'id', name: 'x' }, { workspace: 'b', kind: 'id', name: 'x' })).toBe(false);
  });
});

describe('parseTowerRef (Spec 1967): how commands and grants name a Tower', () => {
  it('reads a Tower alone, and an owner and a Tower, trimmed and lower-cased', () => {
    expect(parseTowerRef('devvm')).toEqual({ ok: true, ref: { tower: 'devvm' } });
    expect(parseTowerRef('  DevVM ')).toEqual({ ok: true, ref: { tower: 'devvm' } });
    expect(parseTowerRef('sam@studio')).toEqual({ ok: true, ref: { owner: 'sam', tower: 'studio' } });
    expect(parseTowerRef('ana-s-mbp')).toEqual({ ok: true, ref: { tower: 'ana-s-mbp' } });
  });

  it('holds a Tower and an owner to the same rules as the authority of an afx:// address', () => {
    for (const ref of ['devvm', 'sam@studio', 'a1@b-2', '9box']) {
      const viaAddress = parseAddress(`afx://${ref}/codev:architect`);
      const direct = parseTowerRef(ref);
      expect(direct.ok).toBe(true);
      expect(viaAddress.ok).toBe(true);
      if (direct.ok && viaAddress.ok) {
        expect(direct.ref.tower).toBe(viaAddress.address.tower);
        expect(direct.ref.owner).toBe(viaAddress.address.owner);
      }
    }
    for (const ref of ['dev_vm', 'dev.vm', '-x', '1sam@studio', 'sam@st_udio']) {
      expect(parseTowerRef(ref).ok).toBe(false);
      expect(parseAddress(`afx://${ref}/codev:architect`).ok).toBe(false);
    }
  });

  it('refuses an address, a URL, a port, an empty part and a second owner, with the shape it expected', () => {
    const cases: Array<[string, AddressParseErrorCode]> = [
      ['', 'EMPTY_COMPONENT'],
      ['   ', 'EMPTY_COMPONENT'],
      ['@studio', 'EMPTY_COMPONENT'],
      ['sam@', 'EMPTY_COMPONENT'],
      ['a@b@c', 'REMOTE_BAD_AUTHORITY'],
      ['afx://devvm', 'INVALID_COMPONENT'],
      ['devvm/codev:architect', 'INVALID_COMPONENT'],
      ['devvm:4100', 'INVALID_COMPONENT'],
      ['x'.repeat(MAX_ADDRESS_LENGTH + 1), 'ADDRESS_TOO_LONG'],
    ];
    for (const [text, code] of cases) {
      const parsed = parseTowerRef(text);
      expect(parsed.ok, text).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code, text).toBe(code);
        expect(parsed.error.expected).toBe('[<owner>@]<tower>');
      }
    }
  });

  it('quotes back only printable ASCII, cut short', () => {
    const parsed = parseTowerRef(`dev\u0007/${'y'.repeat(100)}`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).not.toContain('\u0007');
      expect(parsed.error.message).toContain('...');
    }
  });
});
