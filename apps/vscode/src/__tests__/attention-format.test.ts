/**
 * Spec 1595: the wait vocabulary shared by the Tower view and the contextual panel. Pure and
 * vscode-free, so it runs under the vitest `__tests__/` harness.
 */

import { describe, it, expect } from 'vitest';
import { describeWait, waitWord } from '../views/attention-format.js';

describe('waitWord', () => {
  it('names each served wait', () => {
    expect(waitWord('needs-input')).toBe('needs input');
    expect(waitWord('dead')).toBe('agent exited');
    expect(waitWord('idle')).toBe('idle');
  });

  it('keeps the PTY-silence fallback (no served state) a generic wait, not a served idle', () => {
    expect(waitWord(undefined)).toBe('waiting');
  });
});

describe('describeWait', () => {
  it('tints needs-input as a warning and dead as an error, each with its own icon', () => {
    expect(describeWait('needs-input', null)).toEqual({ icon: 'question', color: 'list.warningForeground', text: 'needs input' });
    expect(describeWait('dead', null)).toEqual({ icon: 'debug-disconnect', color: 'list.errorForeground', text: 'agent exited' });
    expect(describeWait(undefined, null)).toEqual({ icon: 'clock', text: 'waiting' });
  });
});
