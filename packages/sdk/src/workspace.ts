/**
 * Workspace-path <-> URL-segment codec (base64url).
 *
 * Implemented over TextEncoder/TextDecoder with a local alphabet rather than
 * Node's `Buffer` (issue #1189): `Buffer` is a Node global that Metro and
 * browsers cannot resolve, and this module is part of the sdk's
 * environment-agnostic graph. The wire format is unchanged: RFC 4648
 * base64url, no padding, identical to `Buffer.toString('base64url')`.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const CHAR_TO_SEXTET = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i++) {
  CHAR_TO_SEXTET.set(ALPHABET[i], i);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    if (b1 === undefined) {
      out += ALPHABET[(b0 & 0x03) << 4];
    } else {
      out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
      if (b2 === undefined) {
        out += ALPHABET[(b1 & 0x0f) << 2];
      } else {
        out += ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
        out += ALPHABET[b2 & 0x3f];
      }
    }
  }
  return out;
}

function base64UrlToBytes(encoded: string): Uint8Array {
  const sextets: number[] = [];
  for (const ch of encoded) {
    if (ch === '=') continue; // tolerate padded input
    const v = CHAR_TO_SEXTET.get(ch);
    if (v === undefined) {
      throw new Error(`Invalid base64url character: ${JSON.stringify(ch)}`);
    }
    sextets.push(v);
  }
  const out = new Uint8Array(Math.floor((sextets.length * 6) / 8));
  let outIndex = 0;
  for (let i = 0; i + 1 < sextets.length; i += 4) {
    const s0 = sextets[i];
    const s1 = sextets[i + 1];
    out[outIndex++] = (s0 << 2) | (s1 >> 4);
    if (i + 2 < sextets.length) {
      out[outIndex++] = ((s1 & 0x0f) << 4) | (sextets[i + 2] >> 2);
    }
    if (i + 3 < sextets.length) {
      out[outIndex++] = ((sextets[i + 2] & 0x03) << 6) | sextets[i + 3];
    }
  }
  return out;
}

/**
 * Encode a workspace path for use in Tower API URLs.
 */
export function encodeWorkspacePath(workspacePath: string): string {
  return bytesToBase64Url(new TextEncoder().encode(workspacePath));
}

/**
 * Decode a workspace path from a Tower API URL.
 */
export function decodeWorkspacePath(encoded: string): string {
  return new TextDecoder().decode(base64UrlToBytes(encoded));
}
