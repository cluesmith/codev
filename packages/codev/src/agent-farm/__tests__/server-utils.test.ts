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

});
