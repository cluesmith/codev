/**
 * Regression test for Bugfix #430: Tower Restart button kills all terminals
 *
 * The Restart button in tower.html must NOT call the stop API, which kills
 * all terminals (architect + builders + shells). It should only refresh the
 * dashboard UI state.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Bugfix #430: restartInstance must not call stop API', () => {
  const towerHtmlPath = path.resolve(
    import.meta.dirname,
    '../../../templates/tower.html'
  );

  it('tower.html exists', () => {
    expect(fs.existsSync(towerHtmlPath)).toBe(true);
  });

  it('restartInstance does not call api/stop', () => {
    const html = fs.readFileSync(towerHtmlPath, 'utf-8');

    // Extract the restartInstance function body
    const fnMatch = html.match(
      /async function restartInstance\([\s\S]*?\n    \}/
    );
    expect(fnMatch).not.toBeNull();

    const fnBody = fnMatch![0];

    // Must NOT contain api/stop — that kills all terminals
    expect(fnBody).not.toContain('api/stop');
    expect(fnBody).not.toContain('api/launch');
  });

  it('restartInstance calls refresh instead', () => {
    const html = fs.readFileSync(towerHtmlPath, 'utf-8');

    const fnMatch = html.match(
      /async function restartInstance\([\s\S]*?\n    \}/
    );
    expect(fnMatch).not.toBeNull();

    const fnBody = fnMatch![0];

    // Should call refresh() to reload UI state
    expect(fnBody).toContain('refresh()');
  });
});
