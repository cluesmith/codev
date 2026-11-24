/**
 * Regression test for GitHub Issue #335 (updated by #1902)
 *
 * Bugfix builders were notifying the architect before CMAP review results
 * came back. This test verifies the PR prompt contains explicit blocking
 * instructions that prevent notification before every consultation has
 * returned results.
 *
 * #1902 made the reviewer set configurable (three by default, narrowed by
 * `.codev/config.json` `porch.consultation`): porch renders the commands into
 * `{{consult_commands}}` and the per-model verdict list into `{{consult_verdicts}}`,
 * so the prompt no longer hardcodes "three" or the model names.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('bugfix PR prompt (#335)', () => {
  const promptPath = path.resolve(
    import.meta.dirname,
    '../../../../codev-skeleton/protocols/bugfix/prompts/pr.md'
  );

  it('should contain explicit wait instruction before notify step', () => {
    const content = fs.readFileSync(promptPath, 'utf-8');

    // Must tell builders to wait for EVERY configured result
    expect(content).toMatch(/ALL consultations listed above have returned results/i);
  });

  it('should require CMAP verdicts before notification', () => {
    const content = fs.readFileSync(promptPath, 'utf-8');

    // The notify step must explicitly prohibit sending the notification before verdicts are in
    expect(content).toMatch(/DO NOT send this notification until you have every CMAP verdict/i);
  });

  it('should take the reviewer commands from porch, not a hardcoded list', () => {
    const content = fs.readFileSync(promptPath, 'utf-8');

    expect(content).toContain('{{consult_commands}}');
    expect(content).not.toMatch(/^consult -m (gemini|codex|claude)\b/m);
  });

  it('should require per-model verdicts in the notification message', () => {
    const content = fs.readFileSync(promptPath, 'utf-8');

    // The notification template must carry the per-model verdict list porch renders
    // (`gemini=<APPROVE|REQUEST_CHANGES>, ...`), so the builder can't send a generic
    // "CMAP in progress" message.
    expect(content).toMatch(/afx send architect "PR #<number> ready for review[^"]*CMAP: \{\{consult_verdicts\}\}"/);
  });
});
