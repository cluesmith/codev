import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The plugin ships to the Elgato Marketplace versioned by the manifest's
 * four-part `Version` ({major}.{minor}.{patch}.{build}), while the workspace
 * versions the package via package.json in lockstep with the other shipped
 * surfaces (apps/vscode pattern). Release tooling bumps package.json but has
 * no knowledge of the manifest — this pin makes that drift loud: after a
 * release bump, the manifest must be updated to `<version>.<build>`.
 */
describe('manifest / package version lockstep', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version: string };
  const manifest = JSON.parse(
    readFileSync(join(root, 'com.cluesmith.codev.sdPlugin', 'manifest.json'), 'utf-8'),
  ) as { Version: string; SDKVersion: number; Software: { MinimumVersion: string } };

  it('manifest Version is package.json version plus a build segment', () => {
    expect(manifest.Version).toMatch(
      new RegExp(`^${pkg.version.replace(/\./g, '\\.')}\\.\\d+$`),
    );
  });
});

/**
 * The Elgato Marketplace rejects submissions below SDKVersion 3 / Stream
 * Deck 6.9 (issue #1394). Local `streamdeck validate` can lag behind the
 * marketplace's requirements, so pin them here to fail loudly if the
 * manifest is ever regenerated or downgraded.
 */
describe('marketplace submission requirements', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const manifest = JSON.parse(
    readFileSync(join(root, 'com.cluesmith.codev.sdPlugin', 'manifest.json'), 'utf-8'),
  ) as { SDKVersion: number; Software: { MinimumVersion: string } };

  it('declares SDKVersion 3 or later', () => {
    expect(manifest.SDKVersion).toBeGreaterThanOrEqual(3);
  });

  it('requires Stream Deck 6.9 or later', () => {
    const [major, minor] = manifest.Software.MinimumVersion.split('.').map(Number);
    expect(major * 100 + minor).toBeGreaterThanOrEqual(6 * 100 + 9);
  });
});
