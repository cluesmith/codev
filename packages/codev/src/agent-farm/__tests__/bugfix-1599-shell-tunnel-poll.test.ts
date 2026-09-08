/**
 * Regression test for Bugfix #1599: the Tower shell must not poll
 * /api/tunnel/status when it is being viewed through Codev Cloud.
 *
 * Over the tunnel, every /api/tunnel/* endpoint is local-only by design
 * (blocked at the tunnel edge and again by Tower, #1370), so a cloud-served
 * shell polling tunnel status can only ever collect 403s — for a widget
 * renderCloudStatus() suppresses in that case anyway. The fix gates the
 * fetch and the render on one shared isCloudServed() predicate.
 *
 * Source-text assertions on the template, following the
 * bugfix-430-tower-restart.test.ts pattern.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const towerHtmlPath = path.resolve(import.meta.dirname, '../../../templates/tower.html');

function read(): string {
  return fs.readFileSync(towerHtmlPath, 'utf-8');
}

describe('Bugfix #1599: cloud-served shell skips the tunnel-status poll', () => {
  it('fetchCloudStatus is gated on isCloudServed() before the request', () => {
    const html = read();
    const fnMatch = html.match(/async function fetchCloudStatus\(\)[\s\S]*?\n    \}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];

    const guardIdx = fnBody.indexOf('isCloudServed()');
    const fetchIdx = fnBody.indexOf('api/tunnel/status');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
  });

  it('renderCloudStatus uses the same shared predicate (no drift)', () => {
    const html = read();
    const fnMatch = html.match(/function renderCloudStatus\(status\)[\s\S]*?\n    \}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).toContain('isCloudServed()');
    // The old inline hostname check must not survive anywhere outside the
    // single predicate definition — that is the drift this test pins.
    const inlineChecks = html.match(/hostname\.endsWith\(['"]/g) ?? [];
    expect(inlineChecks.length).toBeLessThanOrEqual(1);
  });

  it('the predicate matches codevos.ai exactly or as a subdomain, not as a bare suffix', () => {
    const html = read();
    const fnMatch = html.match(/function isCloudServed\(\)[\s\S]*?\n    \}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];
    expect(fnBody).toContain("=== 'codevos.ai'");
    expect(fnBody).toContain(".endsWith('.codevos.ai')");
  });
});
