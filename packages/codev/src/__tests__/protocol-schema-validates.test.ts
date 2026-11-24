/**
 * #1902 — `protocol-schema.json` must describe the protocol.json files that ship.
 *
 * The schema had drifted: no `build_verify` phase type, `gate` typed as an object only, no
 * `verify`/`build`/`next`, keys the files use missing entirely. It is what editors validate
 * against, so a schema that rejects valid files teaches authors the wrong shape.
 *
 * Every protocol.json in both trees (PIR included — read-only here) is validated against the
 * schema. The three schema copies must be identical.
 *
 * No JSON-schema library is a dependency, so this carries a small validator for the draft-07
 * keywords the schema uses. An unsupported keyword throws, so the validator cannot silently
 * skip a rule the schema relies on.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

const SCHEMA_COPIES = [
  'codev-skeleton/protocols/protocol-schema.json',
  'codev-skeleton/protocol-schema.json',
  'codev/protocols/protocol-schema.json',
];

type Schema = Record<string, unknown>;

const SUPPORTED = new Set([
  '$schema', '$id', 'title', 'description', 'type', 'enum', 'required', 'properties',
  'additionalProperties', 'items', 'minItems', 'uniqueItems', 'pattern', 'oneOf', '$ref', 'minimum',
  'maximum', 'definitions',
]);

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function validate(value: unknown, schema: Schema, root: Schema, at: string): string[] {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) throw new Error(`validator does not support "${key}" (at ${at})`);
  }
  if (schema.$ref) {
    const ref = schema.$ref as string;
    const m = ref.match(/^#\/definitions\/(.+)$/);
    if (!m) throw new Error(`unsupported $ref ${ref}`);
    return validate(value, (root.definitions as Record<string, Schema>)[m[1]], root, at);
  }
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const allowed = ([] as string[]).concat(schema.type as string | string[]);
    const actual = typeOf(value);
    const ok = allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'));
    if (!ok) return [`${at}: expected ${allowed.join('|')}, got ${actual}`];
  }
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  }
  if (schema.oneOf) {
    const passing = (schema.oneOf as Schema[]).filter((s) => validate(value, s, root, at).length === 0);
    if (passing.length !== 1) errors.push(`${at}: matched ${passing.length} of oneOf (expected exactly 1)`);
  }
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern as string).test(value)) {
    errors.push(`${at}: "${value}" does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < (schema.minimum as number)) errors.push(`${at}: below minimum`);
    if (schema.maximum !== undefined && value > (schema.maximum as number)) errors.push(`${at}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < (schema.minItems as number)) errors.push(`${at}: too few items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      errors.push(`${at}: duplicate items`);
    }
    if (schema.items) value.forEach((v, i) => errors.push(...validate(v, schema.items as Schema, root, `${at}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in obj)) errors.push(`${at}: missing required "${req}"`);
    }
    const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) errors.push(...validate(v, props[k], root, `${at}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected key "${k}"`);
      else if (typeof schema.additionalProperties === 'object') {
        errors.push(...validate(v, schema.additionalProperties as Schema, root, `${at}.${k}`));
      }
    }
  }
  return errors;
}

const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, SCHEMA_COPIES[0]), 'utf-8')) as Schema;

const protocolFiles = ['codev-skeleton', 'codev'].flatMap((tree) =>
  fs
    .readdirSync(path.join(repoRoot, tree, 'protocols'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(repoRoot, tree, 'protocols', e.name, 'protocol.json')))
    .map((e) => `${tree}/protocols/${e.name}/protocol.json`),
);

describe('#1902 — protocol-schema.json describes the shipped protocols', () => {
  it('the three schema copies are identical', () => {
    const canonical = fs.readFileSync(path.join(repoRoot, SCHEMA_COPIES[0]), 'utf-8');
    for (const copy of SCHEMA_COPIES.slice(1)) {
      expect(fs.readFileSync(path.join(repoRoot, copy), 'utf-8'), copy).toBe(canonical);
    }
  });

  it('finds the protocols in both trees', () => {
    expect(protocolFiles.length).toBeGreaterThanOrEqual(16);
    expect(protocolFiles).toContain('codev-skeleton/protocols/bugfix/protocol.json');
    expect(protocolFiles).toContain('codev/protocols/spir/protocol.json');
  });

  it.each(protocolFiles)('%s validates', (file) => {
    const json = JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf-8'));
    expect(validate(json, schema, schema, '$')).toEqual([]);
  });

  it('the validator rejects what the schema forbids (it is not vacuous)', () => {
    const bad = {
      name: 'x',
      version: '1.0.0',
      description: 'd',
      phases: [{ id: 'p', type: 'sometimes', gate: 7, consultation: { models: ['claude'] } }],
      unknown_top_level: true,
    };
    const errors = validate(bad, schema, schema, '$');
    expect(errors.some((e) => e.includes('unexpected key "unknown_top_level"'))).toBe(true);
    expect(errors.some((e) => e.includes('"sometimes" not in'))).toBe(true);
    expect(errors.some((e) => e.includes('$.phases[0].gate'))).toBe(true);
    expect(errors.some((e) => e.includes('missing required "type"'))).toBe(true);
  });
});
