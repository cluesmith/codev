/**
 * Shared server utilities
 * Extracted from dashboard-server.ts, tower-server.ts, open-server.ts
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
 * Security: Validate request origin to prevent CSRF and DNS rebinding attacks
 * Allows only localhost and 127.0.0.1 by default.
 * Set CODEV_WEB_INSECURE=1 to allow any host (for tunnel access).
 * @param req - HTTP incoming message
 * @returns true if request should be allowed
 */
export function isRequestAllowed(req: http.IncomingMessage): boolean {
  // INSECURE MODE: Skip all checks (for tunnel access)
  if (process.env.CODEV_WEB_INSECURE === '1') {
    return true;
  }

  const host = req.headers.host;
  const origin = req.headers.origin;

  // Host check (prevent DNS rebinding attacks)
  if (host && !host.startsWith('localhost') && !host.startsWith('127.0.0.1')) {
    return false;
  }

  // Origin check (prevent CSRF from external sites)
  // Note: CLI tools/curl might not send Origin, so we only block if Origin is present and invalid
  if (origin && !origin.startsWith('http://localhost') && !origin.startsWith('http://127.0.0.1')) {
    return false;
  }

  return true;
}
