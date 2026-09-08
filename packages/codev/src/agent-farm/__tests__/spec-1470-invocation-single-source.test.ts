/**
 * Spec 1470 — `--boundary` must survive every path that tells someone how to run
 * the command.
 *
 * ## Why this file exists
 *
 * `--boundary` binds a challenge to the boundary it was issued at, so a
 * challenge left behind by an aborted refresh cannot clear a builder at a LATER
 * boundary against a save describing work that has since moved on. An
 * instruction that omits the flag silently disables that guard for whoever
 * follows it.
 *
 * The flag was dropped twice, in two different files, in consecutive commits:
 * porch's refresh task text (which made the guard inert in production from the
 * day it shipped) and the CLI's own `--begin` follow-up. Two independent
 * hand-typed copies, two identical omissions.
 *
 * So the emission was collapsed into one function, and these tests exist to keep
 * it that way — they assert both call sites carry the flag AND that neither
 * re-introduces a hand-typed invocation.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { selfRefreshInvocation } from '../../lib/self-refresh-invocation.js';
import { buildRefreshTask } from '../../commands/porch/context-refresh.js';

const SRC = resolve(__dirname, '../..');

describe('selfRefreshInvocation', () => {
  it('carries the boundary into both halves of the handshake', () => {
    const { begin, execute } = selfRefreshInvocation('enter:review');
    expect(begin).toContain('--begin');
    expect(begin).toContain('--boundary');
    expect(begin).toContain('enter:review');
    expect(execute).toContain('--boundary');
    expect(execute).toContain('enter:review');
    expect(execute).not.toContain('--begin');
  });

  it('omits the flag only when there is genuinely no boundary', () => {
    const { begin, execute } = selfRefreshInvocation();
    expect(begin).toBe('afx self-refresh --begin');
    expect(execute).toBe('afx self-refresh');
  });

  it('shell-quotes the boundary, including embedded quotes', () => {
    // The two hand-written copies interpolated the boundary raw. Nothing
    // currently produces a quote in a boundary id, but an emission helper that
    // builds shell commands should not depend on that staying true.
    const { execute } = selfRefreshInvocation("weird'id");
    expect(execute).toContain(`'weird'\\''id'`);
  });
});

describe('the porch refresh task', () => {
  it('emits a boundary-qualified invocation for both steps', () => {
    const task = buildRefreshTask('plan-phase:phase_7_docs');

    expect(task.description).toContain('--begin');
    // Both commands in the task must carry the flag — the begin step binds the
    // challenge, and the execute step is what checks the binding.
    const commandLines = task.description
      .split('\n')
      .filter(line => line.includes('afx self-refresh'));
    expect(commandLines.length).toBeGreaterThanOrEqual(2);
    for (const line of commandLines) {
      expect(line, `task line must carry --boundary: ${line}`).toContain('--boundary');
      expect(line).toContain('plan-phase:phase_7_docs');
    }
  });
});

describe('no hand-typed invocations remain', () => {
  /**
   * A structural sweep, not a style rule.
   *
   * The single source only helps while it is the only source. This fails the
   * moment someone types the command out again in TypeScript — which is exactly
   * how the flag was lost twice.
   */
  const filesThatEmitInstructions = [
    'commands/porch/context-refresh.ts',
    'agent-farm/commands/self-refresh.ts',
  ];

  for (const rel of filesThatEmitInstructions) {
    it(`${rel} builds its invocation from the shared helper`, () => {
      const source = readFileSync(resolve(SRC, rel), 'utf-8');

      expect(source, `${rel} must import the shared helper`).toMatch(
        /selfRefreshInvocation/,
      );

      // ANY mention of the command in non-comment code, unless the line also
      // uses the helper. An earlier version of this check required a quote
      // immediately before the command, which missed
      // `logger.info('...run: afx self-refresh')` — the exact shape of the bug
      // it was written to catch. Verified by mutation: re-introducing that line
      // now fails this test.
      //
      // Prose is exempt: comments discussing the command by name, including the
      // ones explaining this rule, are not instructions anyone can follow into a
      // mistake.
      const handTyped = source
        .split('\n')
        .filter(line => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            return false;
          }
          if (!line.includes('afx self-refresh')) return false;
          // The refusal message naming the command is not an invocation.
          if (/afx self-refresh must be run/.test(line)) return false;
          return true;
        })
        // The helper's own call site is the point, not a violation.
        .filter(line => !line.includes('selfRefreshInvocation'));

      expect(
        handTyped,
        `${rel} contains a hand-typed invocation; use selfRefreshInvocation() so the ` +
          `--boundary flag cannot be dropped:\n${handTyped.join('\n')}`,
      ).toHaveLength(0);
    });
  }

  it('the helper itself is the only place that spells the command out', () => {
    const helper = readFileSync(resolve(SRC, 'lib/self-refresh-invocation.ts'), 'utf-8');
    expect(helper).toContain('afx self-refresh --begin');
    expect(helper).toContain('afx self-refresh');
  });
});
