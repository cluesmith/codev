/**
 * #1494: messages the VS Code extension relays on a human's behalf get a distinct
 * `[USER via VS Code]` header, so the architect can tell a button relay apart from
 * a peer-architect instruction or the user typing in the pane.
 */

import { describe, it, expect } from 'vitest';
import {
  formatUserViaVsCodeMessage,
  formatArchitectMessage,
  formatBuilderMessage,
} from '../utils/message-format.js';

describe('formatUserViaVsCodeMessage', () => {
  it('wraps the body in a [USER via VS Code] header/footer', () => {
    const out = formatUserViaVsCodeMessage('Approve the plan review gate for 158, please pass it to the builder.');
    expect(out).toMatch(/^### \[USER via VS Code \| .+\] ###\n/);
    expect(out).toContain('Approve the plan review gate for 158, please pass it to the builder.');
    expect(out.trimEnd().endsWith('###############################')).toBe(true);
  });

  it('is distinct from the architect-instruction and builder-message headers', () => {
    const body = 'hello';
    const user = formatUserViaVsCodeMessage(body);
    expect(user).not.toContain('ARCHITECT INSTRUCTION');
    expect(user).not.toContain('BUILDER');
    // The other formatters keep their own headers.
    expect(formatArchitectMessage(body)).toContain('ARCHITECT INSTRUCTION');
    expect(formatBuilderMessage('0158', body)).toContain('BUILDER 0158 MESSAGE');
  });

  it('raw mode returns the body unwrapped', () => {
    expect(formatUserViaVsCodeMessage('body', undefined, true)).toBe('body');
  });

  it('appends attached file content when provided', () => {
    const out = formatUserViaVsCodeMessage('msg', 'file contents');
    expect(out).toContain('Attached content:');
    expect(out).toContain('file contents');
  });
});
