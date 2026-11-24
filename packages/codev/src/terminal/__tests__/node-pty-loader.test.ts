/**
 * #1944: node-pty is loaded with `require` through one loader. A dynamic `import('node-pty')`
 * inside Tower on Node 22.17+ (pnpm workspace) could return a second, empty copy of the module
 * whose `spawn` was undefined.
 */

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { loadNodePty } from '../node-pty-loader.js';

describe('loadNodePty', () => {
  it('returns the loaded node-pty module with a callable spawn', () => {
    expect(typeof loadNodePty().spawn).toBe('function');
  });

  it('returns the same module instance require holds, not a second copy', () => {
    const require = createRequire(import.meta.url);
    expect(loadNodePty()).toBe(require('node-pty'));
  });
});
