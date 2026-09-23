/**
 * Workspace Trust manifest declaration (#1727).
 *
 * Without a `capabilities.untrustedWorkspaces` declaration VS Code treats the
 * extension as unsupported in Restricted Mode and does NOT activate it until
 * the folder is trusted — so on first open of any untrusted repo the Codev
 * sidebar is dead and the Trust dialog counts Codev among the disabled
 * extensions. Declaring `"limited"` support flips that: the extension
 * activates immediately and VS Code withholds only the workspace-scoped
 * values of the `restrictedConfigurations` keys.
 *
 * The restricted set is exactly the four settings a hostile cloned repo could
 * weaponize via `.vscode/settings.json`: the two that redirect the Tower
 * endpoint (`towerHost`/`towerPort`), the one that re-roots the workspace and
 * is the cwd for afx child processes (`workspacePath`), and the one that
 * launches a process on activation (`autoStartTower`). The other 18 `codev.*`
 * keys are UI toggles, intervals, thresholds and font sizes — none resolves
 * to a command, path or endpoint — so they stay unrestricted and keep working
 * from workspace scope even while untrusted.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const PKG = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

const RESTRICTED = [
  'codev.towerHost',
  'codev.towerPort',
  'codev.workspacePath',
  'codev.autoStartTower',
];

const properties: Record<string, { restricted?: boolean }> =
  PKG.contributes.configuration.properties;

describe('capabilities.untrustedWorkspaces', () => {
  const caps = PKG.capabilities;

  it('declares limited support so the extension activates in Restricted Mode', () => {
    expect(caps).toBeDefined();
    expect(caps.untrustedWorkspaces?.supported).toBe('limited');
  });

  it('carries a description explaining what is withheld until trust', () => {
    const desc = caps.untrustedWorkspaces?.description;
    expect(typeof desc).toBe('string');
    expect(desc.length).toBeGreaterThan(0);
    expect(desc).toMatch(/Restricted Mode/);
  });

  it('restricts exactly the four Tower-endpoint / path / process settings', () => {
    expect(caps.untrustedWorkspaces?.restrictedConfigurations).toEqual(RESTRICTED);
  });

  it('declares virtualWorkspaces false — the extension shells out to afx/git and reads the local filesystem', () => {
    // A virtual workspace has no local FS: no `codev` CLI, no Tower, no PTYs.
    // false is the honest value; declaring true would promise a sidebar that
    // cannot function.
    expect(caps.virtualWorkspaces).toBe(false);
  });
});

describe('restricted configuration property flags', () => {
  it('sets "restricted": true on each of the four property definitions', () => {
    for (const key of RESTRICTED) {
      expect(properties[key], `${key} should be a declared setting`).toBeDefined();
      expect(properties[key].restricted, `${key} should be restricted`).toBe(true);
    }
  });

  it('restricts NO other codev.* setting (the audit: exactly these four)', () => {
    const flagged = Object.entries(properties)
      .filter(([, def]) => def.restricted === true)
      .map(([key]) => key)
      .sort();
    expect(flagged).toEqual([...RESTRICTED].sort());
  });

  it('keeps the restrictedConfigurations list and the property flags in sync', () => {
    // The manifest declares the restriction in two places (VS Code reads
    // both); they must not drift apart.
    const flagged = Object.entries(properties)
      .filter(([, def]) => def.restricted === true)
      .map(([key]) => key)
      .sort();
    const listed = [...(PKG.capabilities.untrustedWorkspaces.restrictedConfigurations as string[])].sort();
    expect(flagged).toEqual(listed);
  });
});
