/**
 * Regression test for issue #840.
 *
 * The `codev.telemetry` configuration entry was removed because it had zero
 * code consumers — it surfaced in VS Code's Settings UI as a toggle that did
 * nothing. This test asserts the entry stays out of `package.json` so it
 * doesn't get re-added by accident.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
);

describe('issue #840 — codev.telemetry setting removed', () => {
  it('does not declare codev.telemetry in contributes.configuration.properties', () => {
    const props = PKG.contributes?.configuration?.properties ?? {};
    expect(props).not.toHaveProperty('codev.telemetry');
  });
});
