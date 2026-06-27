/**
 * Activity hooks: the extension publishes abstract events (`window-focus`,
 * `builder-active`) to URL templates configured in `.codev/config.json`, with no
 * knowledge of the destination. These cover the pure selection + interpolation core
 * (`resolveHookUrls`); the OS-handler delivery is a thin `execFile` wrapper.
 *
 * Mocks `vscode` per the established `__tests__` pattern (the module imports it for
 * the one-time failure warning).
 */
import { describe, it, expect, vi } from 'vitest';
import type { ActivityHook } from '@cluesmith/codev-types';

vi.mock('vscode', () => ({ window: { showWarningMessage: vi.fn() } }));

const { resolveHookUrls } = await import('../activity-hooks.js');

const values = { workspace: '/Users/me/repos/proj', builder: 'pir-1298-slug' };

describe('resolveHookUrls', () => {
  it('interpolates + URL-encodes placeholders', () => {
    const out = resolveHookUrls(
      [{ on: ['builder-active'], url: 'app://x/active?workspace={workspace}&builder={builder}' }],
      'builder-active',
      values,
    );
    expect(out).toEqual([{
      url: 'app://x/active?workspace=%2FUsers%2Fme%2Frepos%2Fproj&builder=pir-1298-slug',
      background: false,
    }]);
  });

  it('only returns hooks listening for the event', () => {
    const hooks = [
      { on: ['window-focus' as const], url: 'app://focus?w={workspace}' },
      { on: ['builder-active' as const], url: 'app://builder?b={builder}' },
    ];
    expect(resolveHookUrls(hooks, 'window-focus', values).map((h) => h.url)).toEqual(['app://focus?w=%2FUsers%2Fme%2Frepos%2Fproj']);
    expect(resolveHookUrls(hooks, 'builder-active', values).map((h) => h.url)).toEqual(['app://builder?b=pir-1298-slug']);
  });

  it('passes through the background flag and blanks unknown placeholders', () => {
    const out = resolveHookUrls(
      [{ on: ['window-focus'], url: 'app://x?b={builder}&z={unknown}', background: true }],
      'window-focus',
      { workspace: '/w' }, // no builder
    );
    expect(out).toEqual([{ url: 'app://x?b=&z=', background: true }]);
  });

  it('ignores malformed hooks (no url, or no on[])', () => {
    // Tower validates before serving, but resolveHookUrls is defensive; feed it junk.
    const hooks = [
      { on: ['window-focus'] },                    // no url
      { url: 'app://x' },                          // no on[]
      { on: ['window-focus'], url: 'app://ok' },
    ] as unknown as ActivityHook[];
    expect(resolveHookUrls(hooks, 'window-focus', values).map((h) => h.url)).toEqual(['app://ok']);
  });
});
