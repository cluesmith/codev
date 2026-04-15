/**
 * Encode a workspace path for use in Tower API URLs.
 */
export function encodeWorkspacePath(workspacePath: string): string {
  return Buffer.from(workspacePath).toString('base64url');
}

/**
 * Decode a workspace path from a Tower API URL.
 */
export function decodeWorkspacePath(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf-8');
}
