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
  ) as { Version: string };

  it('manifest Version is package.json version plus a build segment', () => {
    expect(manifest.Version).toMatch(
      new RegExp(`^${pkg.version.replace(/\./g, '\\.')}\\.\\d+$`),
    );
  });
});
