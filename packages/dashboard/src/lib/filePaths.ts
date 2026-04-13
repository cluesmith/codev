/**
 * File path detection utilities for terminal links (Spec 0092)
 */

/**
 * Regex for detecting file paths in terminal output.
 * Matches:
 * - src/file.ts
 * - ./src/file.ts
 * - ../src/file.ts
 * - /absolute/path/file.ts
 * - file.ts:42 (with line number)
 * - file.ts:42:15 (with line and column)
 * - src/file.ts(42,15) (Visual Studio style)
 *
 * Does NOT match:
 * - URLs (http://, https://)
 * - Plain words without extensions
 */
export const FILE_PATH_REGEX = /(?<![a-zA-Z]:\/\/)(?:^|[\s"'`(\[{])([./]?[\w./-]+\.[a-zA-Z]{1,10})(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))?/g;

export interface ParsedFilePath {
  path: string;
  line?: number;
  column?: number;
}

/**
 * Parse a matched file path string to extract path, line, and column.
 */
export function parseFilePath(match: string): ParsedFilePath {
  // Try colon format: file.ts:42:15
  const colonMatch = match.match(/^(.+?):(\d+)(?::(\d+))?$/);
  if (colonMatch) {
    return {
      path: colonMatch[1],
      line: parseInt(colonMatch[2], 10),
      column: colonMatch[3] ? parseInt(colonMatch[3], 10) : undefined,
    };
  }

  // Try parenthesis format: file.ts(42,15)
  const parenMatch = match.match(/^(.+?)\((\d+),(\d+)\)$/);
  if (parenMatch) {
    return {
      path: parenMatch[1],
      line: parseInt(parenMatch[2], 10),
      column: parseInt(parenMatch[3], 10),
    };
  }

  // No line/column info
  return { path: match };
}

/**
 * Check if a string looks like a valid file path (basic heuristic).
 * Used to filter out false positives.
 */
export function looksLikeFilePath(str: string): boolean {
  // Must have a file extension
  if (!/\.[a-zA-Z]{1,10}(?::\d+(?::\d+)?|\(\d+,\d+\))?$/.test(str)) {
    return false;
  }

  // Should not be a URL
  if (/^https?:\/\//i.test(str)) {
    return false;
  }

  // Should not be just a domain
  if (/^[a-z0-9-]+\.(com|org|net|io|dev|app|co)$/i.test(str)) {
    return false;
  }

  return true;
}
