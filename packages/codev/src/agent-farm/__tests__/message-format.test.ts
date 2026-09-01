/**
 * #1494: messages the VS Code extension relays on a human's behalf get a distinct
 * `[USER via VS Code]` header, so the architect can tell a button relay apart from
 * a peer-architect instruction or the user typing in the pane.
 */

import { describe, it, expect } from 'vitest';
import {
  formatUserViaVsCodeMessage,
  formatArchitectMessage,
  formatArchitectToBuilderMessage,
  formatBuilderMessage,
  REPLY_HINT,
} from '../utils/message-format.js';

describe('formatUserViaVsCodeMessage', () => {
  it('wraps the body in a [USER via VS Code] header/footer', () => {
    const out = formatUserViaVsCodeMessage('main', 'Approve the plan review gate for 158, please pass it to the builder.');
    expect(out).toMatch(/^### \[USER via VS Code → main \| .+\] ###\n/);
    expect(out).toContain('Approve the plan review gate for 158, please pass it to the builder.');
    expect(out.trimEnd().endsWith('###############################')).toBe(true);
  });

  it('is distinct from the architect-instruction and builder-message headers', () => {
    const body = 'hello';
    const user = formatUserViaVsCodeMessage('main', body);
    expect(user).not.toContain('ARCHITECT INSTRUCTION');
    expect(user).not.toContain('BUILDER');
    // The other formatters keep their own headers.
    expect(formatArchitectMessage('bugfix-1574', body)).toContain('ARCHITECT INSTRUCTION');
    expect(formatBuilderMessage('0158', 'main', body)).toContain('BUILDER 0158 MESSAGE');
  });

  it('raw mode returns the body unwrapped', () => {
    expect(formatUserViaVsCodeMessage('main', 'body', undefined, true)).toBe('body');
  });

  it('appends attached file content when provided', () => {
    const out = formatUserViaVsCodeMessage('main', 'msg', 'file contents');
    expect(out).toContain('Attached content:');
    expect(out).toContain('file contents');
  });
});

/**
 * #1574: every delivered wrapper is self-attesting — it names the RECIPIENT, not
 * just the sender. Without this, no pane-reader can verify a frame on its screen
 * was addressed to it, so a genuine misdelivery is invisible to its victim and a
 * false claim of one cannot be refuted from the screen (the #1543 incident).
 */
describe('recipient in every delivered wrapper (#1574)', () => {
  const body = 'hello';

  it('architect → builder names the recipient', () => {
    expect(formatArchitectToBuilderMessage('bugfix-1574', body))
      .toMatch(/^### \[ARCHITECT INSTRUCTION → bugfix-1574 \| .+\] ###\n/);
  });

  it('builder → architect names the recipient alongside the sender', () => {
    expect(formatBuilderMessage('bugfix-1574', 'main', body))
      .toMatch(/^### \[BUILDER bugfix-1574 MESSAGE → main \| .+\] ###\n/);
  });

  it('user via VS Code → architect names the recipient', () => {
    expect(formatUserViaVsCodeMessage('vscode', body))
      .toMatch(/^### \[USER via VS Code → vscode \| .+\] ###\n/);
  });

  it('renders the recipient the caller passed, not a placeholder', () => {
    // A frame that always said the same thing would attest to nothing.
    expect(formatBuilderMessage('af-cron', 'spir-42', body)).toContain('→ spir-42');
    expect(formatBuilderMessage('af-cron', 'main', body)).toContain('→ main');
  });

  it('leaves --raw sends unwrapped, so they gain no header', () => {
    expect(formatArchitectToBuilderMessage('bugfix-1574', body, undefined, true)).toBe(body);
    expect(formatBuilderMessage('bugfix-1574', 'main', body, undefined, true)).toBe(body);
  });
});

/**
 * #1574 (the real #1530 defect): a builder told to "reply" with no reply affordance
 * types assistant text into its own terminal, which reaches nobody and reports
 * nothing. The frame states the channel at the point of need.
 */
describe('reply hint on architect → builder frames (#1574)', () => {
  it('carries the reply hint on the closing delimiter line', () => {
    const out = formatArchitectToBuilderMessage('bugfix-1574', 'do the thing');
    expect(out.endsWith(REPLY_HINT)).toBe(true);
    expect(REPLY_HINT).toContain('afx send architect');
  });

  /**
   * Load-bearing, not incidental: `message-write.ts` paces any message of
   * PACED_WRITE_LINE_THRESHOLD (4) lines or more line-by-line. A hint on its own
   * trailing line would push every short architect→builder message off the
   * single-write path onto the paced one, widening the delivery-write exposure
   * window (#1521/#1573) as a side effect of a formatter change.
   */
  it('does not grow the frame beyond 3 lines, so the write path is unchanged', () => {
    expect(formatArchitectToBuilderMessage('bugfix-1574', 'do the thing').split('\n')).toHaveLength(3);
    expect(formatArchitectMessage('bugfix-1574', 'do the thing').split('\n')).toHaveLength(3);
  });

  it('is absent from architect-bound frames, which must not be told to reply to themselves', () => {
    expect(formatArchitectMessage('main', 'body')).not.toContain('afx send architect');
    expect(formatBuilderMessage('bugfix-1574', 'main', 'body')).not.toContain('afx send architect');
    expect(formatUserViaVsCodeMessage('main', 'body')).not.toContain('afx send architect');
  });

  it('is absent from --raw sends', () => {
    expect(formatArchitectToBuilderMessage('bugfix-1574', 'body', undefined, true)).toBe('body');
  });
});
