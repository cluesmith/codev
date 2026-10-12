/**
 * Invariants for `contributes.configurationDefaults` (#1773):
 * - `comments.openView` defaults to `"never"`, so adding a builder-review comment (#1562) does not
 *   auto-open the bottom Comments panel. The value is the enum string, not a boolean, and an
 *   explicit user setting still wins (configurationDefaults only changes the default).
 * - no other core setting is overridden.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const PKG = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

const defaults = PKG.contributes.configurationDefaults as Record<string, unknown> | undefined;

describe('contributes.configurationDefaults (#1773)', () => {
  it('defaults comments.openView to the "never" enum value', () => {
    expect(defaults).toBeDefined();
    expect(defaults!['comments.openView']).toBe('never');
  });

  it('overrides only comments.openView', () => {
    expect(Object.keys(defaults ?? {})).toEqual(['comments.openView']);
  });
});
