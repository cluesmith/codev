/**
 * Spec 1789 phase 1: the embedded sidebar vsix ships with a manifest naming
 * its id, version and engine range, derived from apps/vscode/package.json.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  IDE_EXTENSION_DIR,
  buildIdeExtensionManifest,
} from '../../scripts/ide-extension-manifest.mjs';

const codevPkgRoot = resolve(import.meta.dirname, '..', '..');

const extensionPackageJson = {
  name: 'codev-vscode',
  publisher: 'cluesmith',
  version: '3.3.4',
  engines: { vscode: '^1.105.0' },
};

describe('buildIdeExtensionManifest', () => {
  it('copies id, version and engine range from the extension package.json', () => {
    expect(buildIdeExtensionManifest(extensionPackageJson)).toEqual({
      id: 'cluesmith.codev-vscode',
      version: '3.3.4',
      engines: { vscode: '^1.105.0' },
    });
  });

  it.each(['publisher', 'name', 'version'])('throws when "%s" is missing', (field) => {
    const pkg: Record<string, unknown> = { ...extensionPackageJson };
    delete pkg[field];
    expect(() => buildIdeExtensionManifest(pkg)).toThrow(`missing "${field}"`);
  });

  it('throws when engines.vscode is missing', () => {
    expect(() => buildIdeExtensionManifest({ ...extensionPackageJson, engines: {} })).toThrow(
      'missing "engines.vscode"',
    );
    const { engines: _engines, ...withoutEngines } = extensionPackageJson;
    expect(() => buildIdeExtensionManifest(withoutEngines)).toThrow('missing "engines.vscode"');
  });

  it('derives a manifest from the real extension package.json', () => {
    const realExtension = JSON.parse(
      readFileSync(join(codevPkgRoot, '..', '..', 'apps', 'vscode', 'package.json'), 'utf8'),
    );
    const manifest = buildIdeExtensionManifest(realExtension);
    expect(manifest.id).toBe('cluesmith.codev-vscode');
    expect(manifest.version).toBe(realExtension.version);
  });
});

describe('codev package wiring', () => {
  it('builds and ships the ide-extension directory', () => {
    const codevPkg = JSON.parse(readFileSync(join(codevPkgRoot, 'package.json'), 'utf8'));
    expect(codevPkg.files).toContain(IDE_EXTENSION_DIR);
    expect(codevPkg.scripts['bundle-assets']).toContain('scripts/build-ide-extension.mjs');
  });
});
