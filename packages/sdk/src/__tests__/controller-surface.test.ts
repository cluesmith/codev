import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as controller from '../controller.js';

/**
 * Controller-surface pin (issue #1411): `@cluesmith/codev-sdk/controller` is a
 * true capability surface, not a re-export of the full client. It exposes only
 * what a controller needs — read (overview, workspaces, SSE) and act
 * (`sendCommand`, `sendCanvasCommand`) — via `ControllerClient` and the
 * `createControllerClient` factory, plus the types/constants a controller
 * reads. Host/admin operations (`TowerClient`, the command-route constants, the
 * canvas view-registration trio, …) are reachable only from the full client at
 * `@cluesmith/codev-sdk/tower-client`.
 *
 * These assertions fail CI on any WIDENING of the surface (same spirit as the
 * #1189 import-boundary tests): the exact export list is pinned, so re-adding a
 * host method or the full client to this subpath is a deliberate, visible edit
 * to this list rather than a silent leak.
 */

const here = dirname(fileURLToPath(import.meta.url));
const controllerSrc = join(here, '..', 'controller.ts');

/**
 * The exact set of names the controller subpath exports — value AND type. Any
 * addition or removal must be a conscious edit here, which is the whole point.
 */
const PINNED_EXPORTS = [
  'CanvasCommand',
  'CanvasCommandClientErrorCode',
  'CanvasCommandClientResult',
  'CanvasCommandErrorCode',
  'CanvasCommandTarget',
  'ControllerClient',
  'DEFAULT_TOWER_PORT',
  'OverviewBacklogItem',
  'OverviewBuilder',
  'OverviewData',
  'OverviewPR',
  'SseEnvelope',
  'TowerClientOptions',
  'TowerWorkspace',
  'createControllerClient',
  'parseSseText',
].sort();

/** The value exports that survive type erasure and exist on the runtime namespace object. */
const PINNED_RUNTIME_EXPORTS = ['DEFAULT_TOWER_PORT', 'createControllerClient', 'parseSseText'].sort();

/** The exact method set the constructed controller client carries — read + act, nothing else. */
const CAPABILITY_METHODS = ['getOverview', 'listWorkspaces', 'subscribeEvents', 'sendCommand', 'sendCanvasCommand'].sort();

/** Host/admin surface that must NEVER be reachable from the controller subpath. */
const FORBIDDEN_EXPORTS = ['TowerClient', 'COMMAND_ROUTE', 'CANVAS_COMMAND_ROUTE'];

/** Host/admin methods that must NEVER be reachable on a constructed controller client. */
const FORBIDDEN_METHODS = ['killTerminal', 'addArchitect', 'sweepHusks', 'registerCanvasView', 'unregisterCanvasView', 'writeTerminal'];

/** Strip block and whole-line `//` comments so doc prose naming an export can't be miscounted. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Collect every exported identifier declared in a module's source — local
 * declarations (`export function/const/type/interface/...`) and re-export lists
 * (`export { ... }`, `export type { ... }`, with or without `from`). Per-item
 * `type` modifiers and `as` aliases are resolved to the exported name.
 */
function collectExportedNames(source: string): string[] {
  const names = new Set<string>();
  const code = stripComments(source);

  const blockRe = /export\s+(?:type\s+)?\{([^}]*)\}/g;
  for (let m = blockRe.exec(code); m; m = blockRe.exec(code)) {
    for (const raw of m[1].split(',')) {
      const spec = raw.trim().replace(/^type\s+/, '');
      if (!spec) continue;
      const asMatch = spec.match(/\bas\s+([A-Za-z_$][\w$]*)/);
      names.add(asMatch ? asMatch[1] : spec);
    }
  }

  const declRe = /export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (let m = declRe.exec(code); m; m = declRe.exec(code)) {
    names.add(m[1]);
  }

  return [...names].sort();
}

describe('controller surface', () => {
  it('declares exactly the pinned export list — nothing wider', () => {
    const declared = collectExportedNames(readFileSync(controllerSrc, 'utf8'));
    expect(declared).toEqual(PINNED_EXPORTS);
  });

  it('exposes only the capability-set value exports at runtime', () => {
    expect(Object.keys(controller).sort()).toEqual(PINNED_RUNTIME_EXPORTS);
  });

  it('does not re-export the full client or the command-route constants', () => {
    const declared = collectExportedNames(readFileSync(controllerSrc, 'utf8'));
    for (const name of FORBIDDEN_EXPORTS) {
      expect(declared).not.toContain(name);
      expect(controller).not.toHaveProperty(name);
    }
  });

  /**
   * A `export * from` / `export type * from` star re-export would widen the
   * surface without naming anything, so `collectExportedNames` (which pins
   * named exports) can't see it. The runtime `Object.keys` check above catches a
   * value-carrying star, but a type-only star would slip through — so forbid the
   * form outright.
   */
  it('uses no star re-exports (which would widen the surface unnamed)', () => {
    const src = stripComments(readFileSync(controllerSrc, 'utf8'));
    expect(src).not.toMatch(/export\s+(?:type\s+)?\*/);
  });

  it('constructs a controller client that carries EXACTLY the capability methods', () => {
    const client = controller.createControllerClient({ port: 4100 });
    // The facade must expose the five capability methods and nothing more — the
    // restriction is real at runtime, not just a narrowed TypeScript type.
    expect(Object.keys(client).sort()).toEqual(CAPABILITY_METHODS);
    for (const method of CAPABILITY_METHODS) {
      expect(typeof (client as Record<string, unknown>)[method]).toBe('function');
    }
  });

  it('constructs a controller client with NO host/admin methods reachable', () => {
    const client = controller.createControllerClient({ port: 4100 }) as Record<string, unknown>;
    for (const method of FORBIDDEN_METHODS) {
      expect(client[method]).toBeUndefined();
    }
  });
});
