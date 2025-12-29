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
  isRequestAllowed,
} from '../utils/server-utils.js';

describe('Server Utilities', () => {
  describe('escapeHtml', () => {
    it('should escape ampersands', () => {
      expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
    });

    it('should escape less than', () => {
      expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    });

    it('should escape greater than', () => {
      expect(escapeHtml('a > b')).toBe('a &gt; b');
    });

    it('should escape double quotes', () => {
      expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;');
    });

    it('should escape single quotes', () => {
      expect(escapeHtml("it's")).toBe('it&#39;s');
    });

    it('should escape all special characters in combination', () => {
      expect(escapeHtml('<a href="test.html?a=1&b=2">it\'s a link</a>')).toBe(
        '&lt;a href=&quot;test.html?a=1&amp;b=2&quot;&gt;it&#39;s a link&lt;/a&gt;'
      );
    });

    it('should handle empty string', () => {
      expect(escapeHtml('')).toBe('');
    });

    it('should handle string with no special characters', () => {
      expect(escapeHtml('hello world')).toBe('hello world');
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

  describe('isRequestAllowed', () => {
    function createMockRequest(headers: Record<string, string>): http.IncomingMessage {
      return { headers } as http.IncomingMessage;
    }

    it('should allow requests from localhost host', () => {
      const req = createMockRequest({ host: 'localhost:4200' });
      expect(isRequestAllowed(req)).toBe(true);
    });

    it('should allow requests from 127.0.0.1 host', () => {
      const req = createMockRequest({ host: '127.0.0.1:4200' });
      expect(isRequestAllowed(req)).toBe(true);
    });

    it('should deny requests from external host', () => {
      const req = createMockRequest({ host: 'evil.com' });
      expect(isRequestAllowed(req)).toBe(false);
    });

    it('should allow requests with localhost origin', () => {
      const req = createMockRequest({
        host: 'localhost:4200',
        origin: 'http://localhost:4200',
      });
      expect(isRequestAllowed(req)).toBe(true);
    });

    it('should allow requests with 127.0.0.1 origin', () => {
      const req = createMockRequest({
        host: 'localhost:4200',
        origin: 'http://127.0.0.1:4200',
      });
      expect(isRequestAllowed(req)).toBe(true);
    });

    it('should deny requests with external origin', () => {
      const req = createMockRequest({
        host: 'localhost:4200',
        origin: 'http://evil.com',
      });
      expect(isRequestAllowed(req)).toBe(false);
    });

    it('should allow requests without origin header (CLI/curl)', () => {
      const req = createMockRequest({ host: 'localhost:4200' });
      expect(isRequestAllowed(req)).toBe(true);
    });

    it('should allow requests without any headers', () => {
      const req = createMockRequest({});
      expect(isRequestAllowed(req)).toBe(true);
    });
  });
});
