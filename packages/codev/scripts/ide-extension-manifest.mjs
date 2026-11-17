/**
 * Manifest for the sidebar vsix embedded in @cluesmith/codev (Spec 1789).
 *
 * The package build writes `ide-extension/manifest.json` next to
 * `ide-extension/codev-vscode.vsix` so Tower can learn the embedded
 * extension's id, version and engine range without unzipping the vsix.
 *
 * Pure and import-safe: no side effects, shared by the build script and its
 * unit test.
 */

export const IDE_EXTENSION_DIR = 'ide-extension';
export const IDE_EXTENSION_VSIX = 'codev-vscode.vsix';
export const IDE_EXTENSION_MANIFEST = 'manifest.json';

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`ide-extension manifest: extension package.json is missing "${field}"`);
  }
  return value;
}

/**
 * Derive the embedded-extension manifest from the extension's package.json.
 *
 * @param {Record<string, unknown>} extensionPackageJson parsed apps/vscode/package.json
 * @returns {{ id: string, version: string, engines: { vscode: string } }}
 */
export function buildIdeExtensionManifest(extensionPackageJson) {
  const publisher = requireString(extensionPackageJson.publisher, 'publisher');
  const name = requireString(extensionPackageJson.name, 'name');
  const version = requireString(extensionPackageJson.version, 'version');
  const engines = extensionPackageJson.engines ?? {};
  const vscodeRange = requireString(engines.vscode, 'engines.vscode');
  return {
    id: `${publisher}.${name}`,
    version,
    engines: { vscode: vscodeRange },
  };
}
