/**
 * Regression test for bugfix #568: pr_exists check must use --state all
 *
 * Without --state all, gh pr list defaults to --state open, which causes
 * the pr_exists check to fail when a PR has already been merged before
 * the porch gate is approved.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../../../..');

describe('bugfix #568: pr_exists check uses --state all', () => {
  const protocolDirs = ['codev-skeleton/protocols', 'codev/protocols'];

  for (const protocolDir of protocolDirs) {
    const fullDir = path.join(ROOT, protocolDir);
    if (!fs.existsSync(fullDir)) continue;

    const protocols = fs.readdirSync(fullDir).filter((name) => {
      const jsonPath = path.join(fullDir, name, 'protocol.json');
      return fs.existsSync(jsonPath);
    });

    for (const proto of protocols) {
      const jsonPath = path.join(fullDir, proto, 'protocol.json');
      const raw = fs.readFileSync(jsonPath, 'utf-8');
      const parsed = JSON.parse(raw);

      // Find all pr_exists checks across phases
      const phases: Array<{ id: string; checks?: Record<string, unknown> }> =
        parsed.phases ?? [];

      for (const phase of phases) {
        if (!phase.checks) continue;
        const prCheck = phase.checks['pr_exists'] as
          | { command?: string }
          | undefined;
        if (!prCheck?.command) continue;

        it(`${protocolDir}/${proto} phase "${phase.id}" pr_exists includes --state all`, () => {
          expect(prCheck.command).toContain('--state all');
        });
      }
    }
  }
});
