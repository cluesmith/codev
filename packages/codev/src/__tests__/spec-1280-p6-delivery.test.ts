/**
 * Spec 1280 — T18: P6 delivery of the structured source, in BOTH consumption modes.
 *
 * Principle P6 ("simple specs → rich references") lets `protocol.md` stop narrating the state
 * machine and reference `protocol.json` instead. That is only safe if the reference actually
 * ARRIVES. A prose instruction to "read protocol.json" would be the fetch-by-path CLAUDE.md
 * forbids: in a fresh adopter project `codev/protocols/<p>/protocol.json` does not exist on
 * disk at all — it resolves from the installed package skeleton — so the builder would be told
 * to open a file that is not there.
 *
 * The mechanism is therefore a `{{> ... }}` include, expanded by the same resolver the runtime
 * uses. These tests assert the delivery, not the intention.
 *
 * The two modes are NOT symmetric, which is why both are tested:
 *   STRICT — porch drives; the builder also receives gates and checks as task JSON, so the
 *            include is corroborating.
 *   SOFT   — no porch. The spawn-inlined `protocol.md` is the ONLY place the builder learns
 *            the phase order, gates and checks. Here the include is load-bearing, and a
 *            silent expansion failure would leave a soft-mode builder with a protocol document
 *            that describes nothing.
 *
 * Budgets are explicit from the outset rather than inherited: these shell out and read the
 * whole protocol tree.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveCodevIncludes } from '../lib/skeleton.js';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

/** Protocols that ship a protocol.json — the ones P6 applies to. */
function protocolsWithJson(): string[] {
  const seen = new Map<string, boolean>();
  for (const tree of ['codev/protocols', 'codev-skeleton/protocols']) {
    const dir = path.join(repoRoot, tree);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const hasJson = fs.existsSync(path.join(dir, e.name, 'protocol.json'));
      seen.set(e.name, (seen.get(e.name) ?? false) || hasJson);
    }
  }
  return [...seen].filter(([, hasJson]) => hasJson).map(([n]) => n).sort();
}

function resolveFile(rel: string): string | null {
  for (const base of ['.codev', 'codev', 'codev-skeleton']) {
    const p = path.join(repoRoot, base, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** The served text of a protocol.md, expanded exactly as the runtime expands it. */
function servedProtocolDoc(protocol: string): string {
  const p = resolveFile(`protocols/${protocol}/protocol.md`);
  if (!p) throw new Error(`no protocol.md for ${protocol}`);
  return resolveCodevIncludes(fs.readFileSync(p, 'utf-8'), repoRoot);
}

function gatesAndChecks(protocol: string): { gates: string[]; checks: string[]; phases: string[] } {
  const p = resolveFile(`protocols/${protocol}/protocol.json`)!;
  const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const gates: string[] = [];
  const checks: string[] = [];
  const phases: string[] = [];
  for (const ph of d.phases ?? []) {
    phases.push(ph.id);
    const g = typeof ph.gate === 'string' ? ph.gate : ph.gate?.name;
    if (g) gates.push(g);
    checks.push(...Object.keys(ph.checks ?? {}));
  }
  return { gates, checks, phases };
}

describe('T18 — P6 delivers the structured source, not a path to fetch', () => {
  const targets = protocolsWithJson().filter((p) => resolveFile(`protocols/${p}/protocol.md`));

  it('there is something to test', () => {
    expect(targets.length).toBeGreaterThan(0);
  });

  for (const protocol of targets) {
    describe(protocol, () => {
      it('never instructs the agent to go READ protocol.json by path', () => {
        const raw = fs.readFileSync(resolveFile(`protocols/${protocol}/protocol.md`)!, 'utf-8');
        // An include directive is delivery. An imperative to open the path is a fetch, and
        // fetch-by-path of a framework file fails in a fresh install.
        const fetchy = /\b(read|open|see|consult|cat)\b[^.\n]{0,40}protocol\.json/i;
        expect(raw, `${protocol}/protocol.md instructs a fetch instead of delivering`).not.toMatch(
          fetchy,
        );
      });

      it('SOFT mode: the served doc alone carries every phase, gate and check', () => {
        // No porch. The spawn-inlined protocol.md is the only source.
        const served = servedProtocolDoc(protocol);
        const { gates, checks, phases } = gatesAndChecks(protocol);
        for (const id of phases) {
          expect(served, `${protocol}: phase "${id}" absent from served doc`).toContain(id);
        }
        for (const g of gates) {
          expect(served, `${protocol}: gate "${g}" absent from served doc`).toContain(g);
        }
        for (const c of checks) {
          expect(served, `${protocol}: check "${c}" absent from served doc`).toContain(c);
        }
      }, 60_000);

      it('the include measurably expands — a silent no-op would look like success', () => {
        const raw = fs.readFileSync(resolveFile(`protocols/${protocol}/protocol.md`)!, 'utf-8');
        if (!raw.includes('{{>')) return; // protocol not yet migrated to P6; nothing to assert
        const served = servedProtocolDoc(protocol);
        expect(served.length).toBeGreaterThan(raw.length);
        expect(served).not.toContain('{{>'); // every directive consumed
      }, 60_000);
    });
  }

  it('STRICT mode parity: the same resolver backs the spawn path', () => {
    // spawn-roles.ts resolveProtocolReference() reads protocol.md and passes it through
    // resolveCodevIncludes before inlining it as {{protocol_reference}}. If that ever stops,
    // strict-mode builders lose the structured source too.
    const spawn = fs.readFileSync(
      path.join(repoRoot, 'packages/codev/src/agent-farm/commands/spawn-roles.ts'),
      'utf-8',
    );
    expect(spawn).toMatch(/resolveCodevIncludes\(\s*readFileSync\(protocolDocPath/);
  });

  it('fresh-install shape: with no .codev/ and no codev/ tier, the include still resolves', () => {
    // CORRECTION to an earlier version of this test, worth stating because it changed my model
    // of the resolver: tier 4 is `getSkeletonDir()` — the INSTALLED NPM PACKAGE — not
    // `<root>/codev-skeleton/`. The repo-local `codev-skeleton/` directory is a build SOURCE
    // (copy-skeleton copies it into packages/codev/skeleton); the resolver never reads it.
    // So a fresh install cannot be simulated by planting files under a temp root — it is
    // simulated by giving the resolver a root with NO local tiers and letting it fall through.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec1280-p6-fresh-'));
    const proto = targets[0];
    const out = resolveCodevIncludes(
      `\`\`\`json\n{{> protocols/${proto}/protocol.json}}\n\`\`\``,
      dir,
    );
    expect(out, 'include collapsed to empty — an adopter would get a doc describing nothing')
      .not.toMatch(/^```json\s*```$/);
    expect(out).not.toContain('{{>');
    expect(out).toContain('"phases"');
  }, 60_000);

  it('the shipped package actually contains the JSON the include depends on', () => {
    // The adopter guarantee behind P6: tier 4 can only deliver what npm publishes.
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'packages/codev/package.json'), 'utf-8'),
    );
    expect(pkg.files, 'skeleton must be in the npm files allowlist').toContain('skeleton');
    for (const protocol of targets) {
      const shipped = path.join(repoRoot, 'packages/codev/skeleton/protocols', protocol, 'protocol.json');
      expect(
        fs.existsSync(shipped),
        `${protocol}/protocol.json is not in the built skeleton — P6 would deliver nothing to adopters`,
      ).toBe(true);
    }
  });
});
