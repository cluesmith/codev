/**
 * Spec 1963: the Decisions view with its real polling hook against a fake host. The host's members
 * are called through the host (a class instance keeps `this`), re-rendering does not re-read, and a
 * link the host opens stops at the view, so a webview's own link handling cannot open it again.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import type { DecisionsDocument, DecisionsRuleRequest } from '@cluesmith/codev-types';
import { DecisionsView } from '../components/DecisionsView.js';
import type { DecisionImageResult, DecisionRulingResult, DecisionsFetchResult, DecisionsViewHost } from '../host.js';

const DOC: DecisionsDocument = {
  path: 'codev/state/pending-decisions.md',
  version: 'v1',
  items: [{
    id: 'main-12',
    stamp: null,
    question: 'Merge the scan fix?',
    bodyMarkdown: '- **Links:** https://example.com/pr/42',
    options: [{ word: 'accept', description: 'merge as is', recommended: true }],
    currentRuling: '',
    qa: [],
    fingerprint: 'fp-main-12',
    problems: [],
    writable: true,
  }],
  ruledMarkdown: '',
  problems: [],
};

/** A host written as a class: every member reaches its state through `this`. */
class BridgeHost implements DecisionsViewHost {
  reads = 0;
  opened: string[] = [];
  private readonly document = DOC;

  async read(): Promise<DecisionsFetchResult> {
    this.reads++;
    return { kind: 'document', document: this.document };
  }

  async rule(_request: DecisionsRuleRequest): Promise<DecisionRulingResult> {
    return { kind: 'document', document: this.document };
  }

  async image(): Promise<DecisionImageResult> {
    return { kind: 'not-loaded', message: 'no images here' };
  }

  openExternal(url: string) {
    this.opened.push(url);
  }
}

afterEach(() => {
  cleanup();
});

async function show(host: DecisionsViewHost) {
  render(<DecisionsView host={host} isActive />);
  return screen.findByRole('heading', { name: 'Merge the scan fix?' });
}

describe('DecisionsView with its polling hook and a class-based host', () => {
  it('reads through the host, keeping its `this`', async () => {
    const host = new BridgeHost();
    await show(host);
    expect(host.reads).toBe(1);
  });

  it('does not read again as the owner types a comment', async () => {
    const host = new BridgeHost();
    await show(host);
    const box = screen.getByRole('textbox', { name: 'Comment or question' });
    for (const text of ['M', 'Me', 'Mer', 'Merg', 'Merge']) fireEvent.change(box, { target: { value: text } });
    await act(async () => { await Promise.resolve(); });
    expect(host.reads).toBe(1);
  });

  it('opens a link through the host, and the click goes no further than the view', async () => {
    const host = new BridgeHost();
    await show(host);
    const outside = vi.fn();
    window.addEventListener('click', outside);
    try {
      const notPrevented = fireEvent.click(screen.getByRole('link', { name: 'https://example.com/pr/42' }));
      expect(notPrevented).toBe(false);
      expect(host.opened).toEqual(['https://example.com/pr/42']);
      expect(outside).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('click', outside);
    }
  });
});
