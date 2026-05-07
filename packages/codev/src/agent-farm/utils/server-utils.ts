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
/**
 * Validate a bind host value for server.listen().
 *
 * Accepts 127.0.0.1, 0.0.0.0, localhost, valid IPv4, and bracketed IPv6.
 * Returns the validated host string, or throws on invalid input.
 *
 * Used by tower-server.ts to resolve BRIDGE_TOWER_HOST when BRIDGE_MODE=1.
 *
 * @param host - The bind host string (e.g., from BRIDGE_TOWER_HOST env var)
 * @returns The validated/trimmed host string
 * @throws Error with a clear message if the host is invalid
 */
export function validateHost(host: string): string {
  if (!host || host.trim().length === 0) {
    throw new Error(
      'Invalid bind host "". ' +
        'Accepted values: 127.0.0.1 (default), 0.0.0.0, localhost, ' +
        'or a valid IPv4/IPv6 literal.',
    );
  }
  const h = host.trim();

  // Allow common literals
  if (h === '127.0.0.1' || h === '0.0.0.0' || h === 'localhost') {
    return h;
  }

  // IPv4: four octets 0-255
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) {
    const parts = h.split('.').map(Number);
    if (parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
      return h;
    }
  }

  // Bracketed IPv6 (e.g., [::1], [::])
  if (/^\[[0-9a-fA-F:]+\]$/.test(h)) {
    return h;
  }

  throw new Error(
    `Invalid bind host "${h}". ` +
      'Accepted values: 127.0.0.1 (default), 0.0.0.0, localhost, ' +
      'or a valid IPv4/IPv6 literal.',
  );
}
