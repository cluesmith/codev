/**
 * Invariant: the contextual panel introduces NO persistence surface. It is purely contextual with
 * only in-memory contextual state, so no source under `contextual-panel/` may touch
 * `workspaceState` / `globalState` / `getConfiguration`, and the manifest must contribute no
 * `codev.contextualPanel.*` configuration key.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const CONTEXTUAL_DIR = fileURLToPath(new URL('../contextual-panel', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('contextual panel introduces no persistence surface', () => {
  const files = sourceFiles(CONTEXTUAL_DIR);

  it('has source files to scan (guards against an empty glob)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('touches no workspaceState / globalState / configuration', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (/workspaceState|globalState|getConfiguration/.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('contributes no codev.contextualPanel.* configuration key in the manifest', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(fileURLToPath(new URL('../..', import.meta.url)), 'package.json'), 'utf8'),
    ) as { contributes?: { configuration?: { properties?: Record<string, unknown> } | Array<{ properties?: Record<string, unknown> }> } };
    const configuration = pkg.contributes?.configuration;
    const propertyBags: Array<Record<string, unknown>> = [];
    if (Array.isArray(configuration)) {
      for (const block of configuration) {
        if (block.properties !== undefined) {
          propertyBags.push(block.properties);
        }
      }
    } else if (configuration?.properties !== undefined) {
      propertyBags.push(configuration.properties);
    }
    const keys = propertyBags.flatMap((bag) => Object.keys(bag));
    expect(keys.filter((key) => key.startsWith('codev.contextualPanel'))).toEqual([]);
  });
});
