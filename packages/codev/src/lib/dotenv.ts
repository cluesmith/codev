/**
 * Pure parser for `<workspace>/.env` (#1912).
 *
 * Extracted from consult's `loadDotenv` so `codev doctor` can see what the claude lane would see
 * without populating its own `process.env`. consult's loader is built on this, so both read the
 * file by one set of rules:
 *
 * - blank lines and lines starting with `#` are skipped
 * - a line with no `=` is skipped
 * - the key is everything before the first `=`, trimmed; the value is everything after it, trimmed,
 *   so a value may itself contain `=`
 * - one pair of matching surrounding quotes (`"…"` or `'…'`) is stripped from the value
 * - when a key appears twice, the first occurrence wins
 *
 * Never mutates `process.env`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The key/value pairs in `<workspaceRoot>/.env`, or `{}` when there is no such file. */
export function readDotenvFile(workspaceRoot: string): Record<string, string> {
  const envFile = path.join(workspaceRoot, '.env');
  if (!fs.existsSync(envFile)) return {};

  // A Map, not an object literal: a key such as `__proto__` or `constructor` must be an ordinary
  // entry, not a prototype lookup.
  const pairs = new Map<string, string>();
  const content = fs.readFileSync(envFile, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!pairs.has(key)) pairs.set(key, value);
  }
  return Object.fromEntries(pairs);
}
