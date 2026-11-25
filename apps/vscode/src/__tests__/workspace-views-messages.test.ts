/**
 * Spec 1963 scenario 6: the Work and Decisions panels' host ↔ webview contract. Webview → host messages are
 * untrusted, so every guard must reject anything malformed before the host acts on it.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_WEBVIEW_STRING,
  isDecisionsImageMessage,
  isDecisionsReadMessage,
  isDecisionsRuleMessage,
  isOpenExternalMessage,
  isReadyMessage,
  isWorkNewShellMessage,
  isWorkOpenArtifactMessage,
  isWorkOpenBuilderMessage,
  isWorkRefreshMessage,
  ruleRequestOf,
} from '../workspace-views/messages.js';

const NOT_OBJECTS = [undefined, null, 0, 'ready', true, [], [{ type: 'ready' }]];

describe('isReadyMessage', () => {
  it('accepts { type: ready } only', () => {
    expect(isReadyMessage({ type: 'ready' })).toBe(true);
    for (const bad of [...NOT_OBJECTS, {}, { type: 'Ready' }, { type: 'decisions/read', requestId: 0 }]) {
      expect(isReadyMessage(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('isDecisionsReadMessage', () => {
  it('accepts a read with a non-negative integer request id', () => {
    expect(isDecisionsReadMessage({ type: 'decisions/read', requestId: 0 })).toBe(true);
    expect(isDecisionsReadMessage({ type: 'decisions/read', requestId: 41 })).toBe(true);
  });

  it.each<[string, unknown]>([
    ...NOT_OBJECTS.map((v): [string, unknown] => [JSON.stringify(v) ?? 'undefined', v]),
    ['no request id', { type: 'decisions/read' }],
    ['a string id', { type: 'decisions/read', requestId: '1' }],
    ['a negative id', { type: 'decisions/read', requestId: -1 }],
    ['a fractional id', { type: 'decisions/read', requestId: 1.5 }],
    ['an unsafe id', { type: 'decisions/read', requestId: 2 ** 60 }],
    ['NaN', { type: 'decisions/read', requestId: Number.NaN }],
    ['another type', { type: 'decisions/rule', requestId: 1 }],
  ])('rejects %s', (_name, message) => {
    expect(isDecisionsReadMessage(message)).toBe(false);
  });
});

describe('isDecisionsRuleMessage', () => {
  const request = { id: 'D-1', fingerprint: 'f', word: 'ship', comment: 'ok' };

  it('accepts a ruling with an id and fingerprint, and word / comment when present', () => {
    expect(isDecisionsRuleMessage({ type: 'decisions/rule', requestId: 1, request })).toBe(true);
    expect(isDecisionsRuleMessage({ type: 'decisions/rule', requestId: 1, request: { id: 'D-1', fingerprint: 'f' } })).toBe(true);
  });

  it.each([
    ['no request', { type: 'decisions/rule', requestId: 1 }],
    ['an array request', { type: 'decisions/rule', requestId: 1, request: [] }],
    ['an empty id', { type: 'decisions/rule', requestId: 1, request: { ...request, id: '' } }],
    ['a numeric id', { type: 'decisions/rule', requestId: 1, request: { ...request, id: 7 } }],
    ['no fingerprint', { type: 'decisions/rule', requestId: 1, request: { id: 'D-1' } }],
    ['an empty fingerprint', { type: 'decisions/rule', requestId: 1, request: { ...request, fingerprint: '' } }],
    ['a non-string word', { type: 'decisions/rule', requestId: 1, request: { ...request, word: 1 } }],
    ['a non-string comment', { type: 'decisions/rule', requestId: 1, request: { ...request, comment: null } }],
    ['no request id', { type: 'decisions/rule', request }],
  ])('rejects %s', (_name, message) => {
    expect(isDecisionsRuleMessage(message)).toBe(false);
  });

  it('forwards only the fields Tower reads', () => {
    const message = { type: 'decisions/rule' as const, requestId: 1, request: { ...request, extra: 'x', path: '/etc/passwd' } };
    expect(isDecisionsRuleMessage(message)).toBe(true);
    expect(ruleRequestOf(message)).toEqual(request);
    expect(ruleRequestOf({ type: 'decisions/rule', requestId: 2, request: { id: 'D-2', fingerprint: 'g' } })).toEqual({ id: 'D-2', fingerprint: 'g' });
  });
});

describe('isDecisionsImageMessage', () => {
  it('accepts a path as written in the item', () => {
    expect(isDecisionsImageMessage({ type: 'decisions/image', requestId: 3, path: '../shots/a.png' })).toBe(true);
  });

  it.each([
    ['no path', { type: 'decisions/image', requestId: 3 }],
    ['an empty path', { type: 'decisions/image', requestId: 3, path: '' }],
    ['a NUL byte', { type: 'decisions/image', requestId: 3, path: 'a.png\0.txt' }],
    ['an over-long path', { type: 'decisions/image', requestId: 3, path: 'a'.repeat(MAX_WEBVIEW_STRING + 1) }],
    ['a non-string path', { type: 'decisions/image', requestId: 3, path: ['a.png'] }],
    ['no request id', { type: 'decisions/image', path: 'a.png' }],
  ])('rejects %s', (_name, message) => {
    expect(isDecisionsImageMessage(message)).toBe(false);
  });
});

describe('isOpenExternalMessage', () => {
  it('accepts a URL string (the scheme is security.ts’s decision)', () => {
    expect(isOpenExternalMessage({ type: 'open-external', url: 'https://github.com/cluesmith/codev' })).toBe(true);
  });

  it.each([
    ['no url', { type: 'open-external' }],
    ['an empty url', { type: 'open-external', url: '' }],
    ['a non-string url', { type: 'open-external', url: { href: 'https://x' } }],
    ['an over-long url', { type: 'open-external', url: `https://x/${'a'.repeat(MAX_WEBVIEW_STRING)}` }],
  ])('rejects %s', (_name, message) => {
    expect(isOpenExternalMessage(message)).toBe(false);
  });
});

describe('isWorkOpenBuilderMessage', () => {
  it('accepts a builder id', () => {
    expect(isWorkOpenBuilderMessage({ type: 'work/open-builder', builderId: 'spir-1963' })).toBe(true);
  });

  it.each<[string, unknown]>([
    ...NOT_OBJECTS.map((v): [string, unknown] => [JSON.stringify(v) ?? 'undefined', v]),
    ['no id', { type: 'work/open-builder' }],
    ['an empty id', { type: 'work/open-builder', builderId: '' }],
    ['a numeric id', { type: 'work/open-builder', builderId: 1963 }],
    ['an over-long id', { type: 'work/open-builder', builderId: 'a'.repeat(MAX_WEBVIEW_STRING + 1) }],
    ['another type', { type: 'open-builder', builderId: 'spir-1963' }],
  ])('rejects %s', (_name, message) => {
    expect(isWorkOpenBuilderMessage(message)).toBe(false);
  });
});

describe('isWorkNewShellMessage and isWorkRefreshMessage', () => {
  it('accept their type only', () => {
    expect(isWorkNewShellMessage({ type: 'work/new-shell' })).toBe(true);
    expect(isWorkRefreshMessage({ type: 'work/refresh' })).toBe(true);
    for (const bad of [...NOT_OBJECTS, {}, { type: 'work/refresh' }, { type: 'new-shell' }]) {
      expect(isWorkNewShellMessage(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const bad of [...NOT_OBJECTS, {}, { type: 'work/new-shell' }, { type: 'refresh' }]) {
      expect(isWorkRefreshMessage(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('isWorkOpenArtifactMessage', () => {
  it('accepts a path as the overview names it (whether it may be opened is security.ts’s decision)', () => {
    expect(isWorkOpenArtifactMessage({ type: 'work/open-artifact', path: 'codev/specs/1963-cockpit.md' })).toBe(true);
    expect(isWorkOpenArtifactMessage({ type: 'work/open-artifact', path: '../outside.md' })).toBe(true);
  });

  it.each<[string, unknown]>([
    ...NOT_OBJECTS.map((v): [string, unknown] => [JSON.stringify(v) ?? 'undefined', v]),
    ['no path', { type: 'work/open-artifact' }],
    ['an empty path', { type: 'work/open-artifact', path: '' }],
    ['a NUL byte', { type: 'work/open-artifact', path: 'codev/specs/a\0.md' }],
    ['an over-long path', { type: 'work/open-artifact', path: 'a'.repeat(MAX_WEBVIEW_STRING + 1) }],
    ['a non-string path', { type: 'work/open-artifact', path: ['codev'] }],
  ])('rejects %s', (_name, message) => {
    expect(isWorkOpenArtifactMessage(message)).toBe(false);
  });
});
