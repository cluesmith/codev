/**
 * Spec 1963 scenario 8: the host's decisions bridge. Every Tower outcome becomes what the shared
 * Decisions view shows, the dashboard's way: a document; a refusal with its code and message; the
 * empty state for a missing file; an error saying Tower was not reached or answered oddly; image
 * bytes, or why the image was not loaded. Never thrown; nothing requested while not connected.
 */

import { describe, it, expect, vi } from 'vitest';
import type { DecisionsDocument } from '@cluesmith/codev-types';
import { DecisionsBridge, DECISIONS_INIT_HINT, NOT_CONNECTED_MESSAGE, type DecisionsConnection } from '../workspace-views/decisions-bridge.js';

const WS = '/work/codev';
const DOC: DecisionsDocument = { path: 'codev/decisions.md', version: 'v1', items: [], ruledMarkdown: '', problems: [] };

function bridgeWith(client: Partial<NonNullable<ReturnType<DecisionsConnection['getClient']>>>, state: DecisionsConnection['getState'] = () => 'connected') {
  const full = {
    getDecisions: vi.fn(async () => { throw new Error('unexpected getDecisions'); }),
    ruleDecision: vi.fn(async () => { throw new Error('unexpected ruleDecision'); }),
    getDecisionImage: vi.fn(async () => { throw new Error('unexpected getDecisionImage'); }),
    ...client,
  };
  const bridge = new DecisionsBridge({ getState: state, getClient: () => full as never, getWorkspacePath: () => WS });
  return { bridge, client: full };
}

describe('read', () => {
  it("reads this window's workspace and returns the document", async () => {
    const getDecisions = vi.fn(async () => ({ kind: 'verdict' as const, status: 200, verdict: { ok: true as const, document: DOC } }));
    const { bridge } = bridgeWith({ getDecisions });
    expect(await bridge.read()).toEqual({ kind: 'document', document: DOC });
    expect(getDecisions).toHaveBeenCalledWith(WS);
  });

  it("maps no decisions file to the empty state, with Tower's message and the hint to create one", async () => {
    const message = 'There is no decisions file at codev/decisions.md.';
    const { bridge } = bridgeWith({
      getDecisions: async () => ({ kind: 'verdict', status: 404, verdict: { ok: false, code: 'not-found', message } }),
    });
    expect(await bridge.read()).toEqual({ kind: 'not-found', message: `${message} ${DECISIONS_INIT_HINT}` });
    expect(DECISIONS_INIT_HINT).toContain('afx decisions init');
  });

  it("shows any other refusal's message as an error", async () => {
    const message = 'The decisions file codev/../x.md resolves outside the workspace; nothing was read or written.';
    const { bridge } = bridgeWith({
      getDecisions: async () => ({ kind: 'verdict', status: 400, verdict: { ok: false, code: 'outside-workspace', message } }),
    });
    expect(await bridge.read()).toEqual({ kind: 'error', message });
  });

  it('says Tower was not reached, or answered with something else', async () => {
    expect(await bridgeWith({ getDecisions: async () => ({ kind: 'unreachable', error: 'Tower not running' }) }).bridge.read())
      .toEqual({ kind: 'error', message: 'Could not reach Tower: Tower not running' });
    expect(await bridgeWith({ getDecisions: async () => ({ kind: 'unreadable', status: 401 }) }).bridge.read())
      .toEqual({ kind: 'error', message: 'Unexpected response from Tower (HTTP 401)' });
  });

  it.each(['disconnected', 'connecting', 'reconnecting'] as const)('requests nothing while %s, and says it is not connected', async (state) => {
    const { bridge, client } = bridgeWith({}, () => state);
    expect(await bridge.read()).toEqual({ kind: 'error', message: NOT_CONNECTED_MESSAGE });
    expect(client.getDecisions).not.toHaveBeenCalled();
  });

  it('requests nothing in a window with no workspace or no client', async () => {
    const noWorkspace = new DecisionsBridge({ getState: () => 'connected', getClient: () => ({}) as never, getWorkspacePath: () => null });
    const noClient = new DecisionsBridge({ getState: () => 'connected', getClient: () => null, getWorkspacePath: () => WS });
    expect(await noWorkspace.read()).toEqual({ kind: 'error', message: NOT_CONNECTED_MESSAGE });
    expect(await noClient.read()).toEqual({ kind: 'error', message: NOT_CONNECTED_MESSAGE });
  });
});

describe('rule', () => {
  const REQUEST = { id: 'D-1', fingerprint: 'abc', word: 'ship' };

  it('writes the ruling and returns the re-parsed document', async () => {
    const ruleDecision = vi.fn(async () => ({ kind: 'verdict' as const, status: 200, verdict: { ok: true as const, document: DOC } }));
    const { bridge } = bridgeWith({ ruleDecision });
    expect(await bridge.rule(REQUEST)).toEqual({ kind: 'document', document: DOC });
    expect(ruleDecision).toHaveBeenCalledWith(WS, REQUEST);
  });

  it('keeps a refusal structured: its code and its message, for the card', async () => {
    const message = 'D-1 has changed since you read it, so nothing was written. Review it and rule again.';
    const { bridge } = bridgeWith({
      ruleDecision: async () => ({ kind: 'verdict', status: 409, verdict: { ok: false, code: 'item-changed', message } }),
    });
    expect(await bridge.rule(REQUEST)).toEqual({ kind: 'refused', code: 'item-changed', message });
  });

  it('a transport failure is an error on the card, and while not connected nothing is sent', async () => {
    expect(await bridgeWith({ ruleDecision: async () => ({ kind: 'unreachable', error: 'Request timeout' }) }).bridge.rule(REQUEST))
      .toEqual({ kind: 'error', message: 'Could not reach Tower: Request timeout' });
    const { bridge, client } = bridgeWith({}, () => 'reconnecting');
    expect(await bridge.rule(REQUEST)).toEqual({ kind: 'error', message: `${NOT_CONNECTED_MESSAGE} The ruling was not sent.` });
    expect(client.ruleDecision).not.toHaveBeenCalled();
  });
});

describe('image', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  it('delivers the bytes and type for the webview to show as an object URL', async () => {
    const getDecisionImage = vi.fn(async () => ({ kind: 'image' as const, bytes: PNG, contentType: 'image/png' }));
    const { bridge } = bridgeWith({ getDecisionImage });
    expect(await bridge.image('../shots/a.png')).toEqual({ kind: 'image', bytes: PNG, contentType: 'image/png' });
    expect(getDecisionImage).toHaveBeenCalledWith(WS, '../shots/a.png');
  });

  it("is not loaded, with Tower's message, when Tower refuses it", async () => {
    const message = 'The image ../../etc/x.png is outside the workspace, so it was not read.';
    const { bridge } = bridgeWith({
      getDecisionImage: async () => ({ kind: 'verdict', status: 400, verdict: { ok: false, code: 'outside-workspace', message } }),
    });
    expect(await bridge.image('../../etc/x.png')).toEqual({ kind: 'not-loaded', message });
  });

  it('is not loaded when Tower is not reached, answers oddly, or the window is not connected', async () => {
    expect(await bridgeWith({ getDecisionImage: async () => ({ kind: 'unreachable', error: 'Tower not running' }) }).bridge.image('a.png'))
      .toEqual({ kind: 'not-loaded', message: 'Could not reach Tower: Tower not running' });
    expect(await bridgeWith({ getDecisionImage: async () => ({ kind: 'unreadable', status: 200 }) }).bridge.image('a.png'))
      .toEqual({ kind: 'not-loaded', message: 'Unexpected response from Tower (HTTP 200)' });
    const { bridge, client } = bridgeWith({}, () => 'disconnected');
    expect(await bridge.image('a.png')).toEqual({ kind: 'not-loaded', message: NOT_CONNECTED_MESSAGE });
    expect(client.getDecisionImage).not.toHaveBeenCalled();
  });
});
