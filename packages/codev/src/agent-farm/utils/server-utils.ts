/**
 * Shared server utilities
 * Extracted from tower-server.ts and open-server.ts
 * to eliminate code duplication (Maintenance Run 0004)
 */

import type * as http from 'node:http';

/**
 * HTML-escape a string to prevent XSS
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Read raw request body as a string with size limit.
 */
export function readBody(req: http.IncomingMessage, maxSize = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Parse JSON body from request with size limit
 * @param req - HTTP incoming message
 * @param maxSize - Maximum body size in bytes (default 1MB)
 */
export function parseJsonBody(req: http.IncomingMessage, maxSize = 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

/**
 * Security: Validate request origin
 * Currently allows all requests - security is handled by the server binding to localhost only.
 * @param req - HTTP incoming message
 * @returns true (always allowed)
 */
export function isRequestAllowed(_req: http.IncomingMessage): boolean {
  return true;
}
