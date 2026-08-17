// Issue #1478 — the architect's specific name must survive the trip from `afx send`
// to both attribution surfaces.
//
// Root cause: `commands/send.ts` collapsed every architect sender to the generic string
// `architect`, and `formatMessageForTarget`'s any → builder branch discarded `from`
// entirely — so even a corrected sender could not have surfaced in the composer header.
//
// This file covers the header label itself: every sender shape, including the ones that
// must stay unattributed. The rest of the chain is covered where its harness already
// lives — the persisted row's identity + framing in tower-routes.test.ts (`architect
// identity in the persisted row`), the send-side `from` value in send.test.ts, and the
// `afx inbox` rendering of that identity in inbox-cli.test.ts.

import { describe, it, expect } from 'vitest';
import {
  architectHeaderLabel,
  formatArchitectMessage,
  formatBuilderMessage,
} from '../utils/message-format.js';

describe('architectHeaderLabel (issue #1478)', () => {
  it('names the specific architect carried as `architect:<name>`', () => {
    expect(architectHeaderLabel('architect:main')).toBe('ARCHITECT:main');
    expect(architectHeaderLabel('architect:feedback')).toBe('ARCHITECT:feedback');
    expect(architectHeaderLabel('architect-3')).toBe('ARCHITECT');
  });

  it('falls back to the bare label for senders that are not an architect identity', () => {
    // An unattributed call (cron's architect-framed paths, older callers) and a
    // builder → builder send both keep the historical header — this change is about
    // naming the architect, not relabelling every sender.
    expect(architectHeaderLabel(undefined)).toBe('ARCHITECT');
    expect(architectHeaderLabel('builder-air-1478')).toBe('ARCHITECT');
    // A malformed identity with no name after the colon must not render `ARCHITECT:`.
    expect(architectHeaderLabel('architect:')).toBe('ARCHITECT');
    expect(architectHeaderLabel('architect:   ')).toBe('ARCHITECT');
  });
});

describe('formatArchitectMessage (issue #1478)', () => {
  it('puts the architect name in the composer header', () => {
    const out = formatArchitectMessage('ship it', undefined, false, 'architect:feedback');
    expect(out).toMatch(/^### \[ARCHITECT:feedback INSTRUCTION \| .+\] ###\n/);
    expect(out).toContain('ship it');
    expect(out.endsWith('###############################')).toBe(true);
  });

  it('is unchanged when no sender is supplied (back-compat)', () => {
    const out = formatArchitectMessage('ship it');
    expect(out).toMatch(/^### \[ARCHITECT INSTRUCTION \| .+\] ###\n/);
  });

  it('keeps raw mode unattributed — body only, no header (issue #1478 note)', () => {
    expect(formatArchitectMessage('ship it', undefined, true, 'architect:main')).toBe('ship it');
  });

  it('still appends attached file content under an attributed header', () => {
    const out = formatArchitectMessage('review this', 'FILE BODY', false, 'architect:main');
    expect(out).toContain('ARCHITECT:main INSTRUCTION');
    expect(out).toContain('Attached content:\n```\nFILE BODY\n```');
  });

  it('leaves the builder → architect direction untouched (it already carried its sender)', () => {
    expect(formatBuilderMessage('builder-air-1478', 'done')).toMatch(
      /^### \[BUILDER builder-air-1478 MESSAGE \| .+\] ###\n/,
    );
  });
});
