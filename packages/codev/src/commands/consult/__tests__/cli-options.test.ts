/**
 * Every registered `consult` flag must be forwarded onto ConsultOptions (spec 1286).
 *
 * This targets one specific recurrence class rather than behavior in general: `--model-id` shipped
 * registered, parsed, present in `--help`, and covered by passing runner-level unit tests — while
 * doing nothing at all, because cli.ts's action copied options across field-by-field and omitted it.
 * A dropped field is silent by construction, so the guard has to be structural.
 *
 * The flag list is not duplicated here — it is read back out of commander via `attributeName()`, so
 * adding a flag automatically extends this test's coverage. That is the whole point: a hand-written
 * list would drift exactly the way the mapping did.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerConsultOptions, buildConsultOptions, STATS_ONLY_FLAGS } from '../cli-options.js';

/** Commander keys for every flag the consult command registers. */
function registeredFlagKeys(): string[] {
  const cmd = registerConsultOptions(new Command('consult'));
  return cmd.options.map((o) => o.attributeName());
}

describe('consult flag registration and ConsultOptions mapping agree', () => {
  it('registers the flags this spec added', () => {
    // Sanity-check the introspection itself: if attributeName() ever stopped yielding camelCase
    // keys, every assertion below would pass vacuously against an empty or mangled list.
    const keys = registeredFlagKeys();
    expect(keys).toContain('model');
    expect(keys).toContain('modelId');
    expect(keys).toContain('planPhase');
    expect(keys.length).toBeGreaterThan(10);
  });

  it('forwards every non-stats flag onto the options object', () => {
    const keys = registeredFlagKeys().filter(
      (k) => !(STATS_ONLY_FLAGS as readonly string[]).includes(k),
    );

    // A distinct sentinel per key, so a mapping that reads the wrong source key is caught too —
    // not just a missing one.
    const raw: Record<string, unknown> = {};
    for (const k of keys) raw[k] = `value-of-${k}`;

    const built = buildConsultOptions(raw) as unknown as Record<string, unknown>;

    const dropped = keys.filter((k) => built[k] !== `value-of-${k}`);
    expect(
      dropped,
      `these flags are registered but not forwarded by buildConsultOptions: ${dropped.join(', ')}`,
    ).toEqual([]);
  });

  it('forwards nothing the command does not register', () => {
    // The reverse direction: a key in the mapping that no flag supplies is dead weight, and usually
    // means a flag was renamed on one side only.
    const registered = new Set(registeredFlagKeys());
    const built = buildConsultOptions({}) as unknown as Record<string, unknown>;
    const unknown = Object.keys(built).filter((k) => !registered.has(k));
    expect(unknown, `mapped keys with no registered flag: ${unknown.join(', ')}`).toEqual([]);
  });

  it('leaves unset flags undefined rather than inventing values', () => {
    const built = buildConsultOptions({ model: 'codex' });
    expect(built.model).toBe('codex');
    expect(built.modelId).toBeUndefined();
    expect(built.output).toBeUndefined();
  });

  it('excludes stats-only flags from ConsultOptions', () => {
    const raw: Record<string, unknown> = {};
    for (const k of STATS_ONLY_FLAGS) raw[k] = 'set';
    const built = buildConsultOptions(raw) as unknown as Record<string, unknown>;
    for (const k of STATS_ONLY_FLAGS) expect(built[k]).toBeUndefined();
  });
});
