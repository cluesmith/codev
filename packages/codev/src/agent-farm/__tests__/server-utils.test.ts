/**
 * Tests for server utility functions
 * These test the shared utilities before they're extracted from individual server files
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { Readable } from 'node:stream';

// Import from where we'll extract to (will create this file next)
import {
  escapeHtml,
  parseJsonBody,
  validateHost,
} from '../utils/server-utils.js';

describe('Server Utilities', () => {
  describe('escapeHtml', () => {
    it('should escape all special characters in combination', () => {
      expect(escapeHtml('<a href="test.html?a=1&b=2">it\'s a link</a>')).toBe(
        '&lt;a href=&quot;test.html?a=1&amp;b=2&quot;&gt;it&#39;s a link&lt;/a&gt;'
      );
    });
  });

  describe('parseJsonBody', () => {
    function createMockRequest(body: string, chunkSize = body.length): http.IncomingMessage {
      const readable = new Readable({
        read() {
          // Send in chunks if specified
          for (let i = 0; i < body.length; i += chunkSize) {
            this.push(Buffer.from(body.slice(i, i + chunkSize)));
          }
          this.push(null);
        },
      });
      return readable as unknown as http.IncomingMessage;
    }

    it('should parse valid JSON body', async () => {
      const req = createMockRequest('{"name":"test","value":42}');
      const result = await parseJsonBody(req);
      expect(result).toEqual({ name: 'test', value: 42 });
    });

    it('should return empty object for empty body', async () => {
      const req = createMockRequest('');
      const result = await parseJsonBody(req);
      expect(result).toEqual({});
    });

    it('should handle chunked data', async () => {
      const req = createMockRequest('{"chunked":"data"}', 5);
      const result = await parseJsonBody(req);
      expect(result).toEqual({ chunked: 'data' });
    });

    it('should reject invalid JSON', async () => {
      const req = createMockRequest('not valid json');
      await expect(parseJsonBody(req)).rejects.toThrow('Invalid JSON');
    });

    it('should reject body exceeding max size', async () => {
      const largeBody = 'x'.repeat(100);
      const req = createMockRequest(largeBody);
      await expect(parseJsonBody(req, 50)).rejects.toThrow('Request body too large');
    });

    it('should accept body within max size', async () => {
      const body = '{"ok":true}';
      const req = createMockRequest(body);
      const result = await parseJsonBody(req, 1000);
      expect(result).toEqual({ ok: true });
    });
  });

  describe('validateHost', () => {
    it('should accept 127.0.0.1', () => {
      expect(validateHost('127.0.0.1')).toBe('127.0.0.1');
    });

    it('should accept 0.0.0.0', () => {
      expect(validateHost('0.0.0.0')).toBe('0.0.0.0');
    });

    it('should accept localhost', () => {
      expect(validateHost('localhost')).toBe('localhost');
    });

    it('should accept valid IPv4 addresses', () => {
      expect(validateHost('192.168.1.1')).toBe('192.168.1.1');
      expect(validateHost('10.0.0.1')).toBe('10.0.0.1');
      expect(validateHost('255.255.255.255')).toBe('255.255.255.255');
      expect(validateHost('0.0.0.0')).toBe('0.0.0.0');
    });

    it('should accept whitespace and return trimmed value', () => {
      expect(validateHost('  127.0.0.1  ')).toBe('127.0.0.1');
    });

    it('should reject empty string', () => {
      expect(() => validateHost('')).toThrow('Invalid bind host ""');
    });

    it('should reject null/undefined via empty check', () => {
      expect(() => validateHost(null as unknown as string)).toThrow();
      expect(() => validateHost('')).toThrow();
    });

    it('should reject octets outside 0-255 range', () => {
      expect(() => validateHost('256.1.1.1')).toThrow();
      expect(() => validateHost('1.1.1.999')).toThrow();
      expect(() => validateHost('-1.1.1.1')).toThrow();
    });

    it('should reject non-localhost hostnames', () => {
      expect(() => validateHost('example.com')).toThrow();
      expect(() => validateHost('myhost.local')).toThrow();
    });

    it('should reject non-localhost with trailing/leading slash', () => {
      expect(() => validateHost('/127.0.0.1')).toThrow();
    });

    // Bracketed IPv6 validation - strict hex+colon only
    it('should accept valid bracketed IPv6 addresses', () => {
      expect(validateHost('[::1]')).toBe('[::1]');
      expect(validateHost('[::]')).toBe('[::]');
      expect(validateHost('[fe80::1]')).toBe('[fe80::1]');
      expect(validateHost('[2001:db8::1]')).toBe('[2001:db8::1]');
      expect(validateHost('[2001:0db8:0000:0000:0000:0000:0000:0001]')).toBe('[2001:0db8:0000:0000:0000:0000:0000:0001]');
    });

    it('should reject invalid bracketed IPv6 addresses', () => {
      expect(() => validateHost('[not-an-ip]')).toThrow();
      expect(() => validateHost('[anything]')).toThrow();
      expect(() => validateHost('[foo]')).toThrow();
      expect(() => validateHost('[::g]')).toThrow(); // 'g' is not valid hex
      expect(() => validateHost('[hello]')).toThrow();
    });

    it('should reject unbracketed IPv6', () => {
      expect(() => validateHost('::1')).toThrow();
      expect(() => validateHost('fe80::1')).toThrow();
    });

    it('should reject bracketed but missing IPv6', () => {
      expect(() => validateHost('[]')).toThrow();
    });
  });

});
