/**
 * Spec 1280 — Phase 0: the corrected measurement instrument.
 *
 * The Spec 1252 instrument was committed, deterministic, and wrong: it derived
 * its phase-task term from `codev-skeleton/porch/prompts/`, a dead tree with no
 * runtime consumer, while the live resolver loads `protocols/<p>/prompts/`. It
 * also omitted the spawn-inlined `roles/builder.md` and mis-stated how the hot
 * tier reaches CLAUDE.md.
 *
 * These tests exist because "deterministic and committed" is not "correct".
 * They assert the instrument against the REAL resolver and the REAL runtime
 * loader, so a future edit cannot quietly reintroduce any of the three defects.
 *
 * Covers T1, T1b, T2, T3, T11, T12, T15.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const script = path.join(repoRoot, 'scripts/measure-prompt-surface.sh');

function run(root: string = repoRoot, env: Record<string, string> = {}): string {
  return execFileSync('bash', [script, root], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    maxBuffer: 20 * 1024 * 1024,
  });
}

function num(output: string, key: string): number {
  const m = output.match(new RegExp(`^${key}=(\\d+)$`, 'm'));
  if (!m) throw new Error(`${key} not found in measurement output`);
  return Number(m[1]);
}

/** Minimal fixture repo: only what the script reads. */
function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec1280-'));
  const mk = (rel: string, body: string) => {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  mk('CLAUDE.md', 'alpha bravo charlie\n');
  mk('AGENTS.md', 'alpha bravo charlie\n');
  mk('codev/resources/arch-critical.md', 'one two\n');
  mk('codev/resources/lessons-critical.md', 'three four\n');
  mk('codev/roles/builder.md', 'role word here\n');
  mk('codev/roles/architect.md', 'architect role words\n');
  mk('codev/roles/consultant.md', 'consultant words\n');
  mk('codev-skeleton/protocols/spir/builder-prompt.md', 'wrapper words here\n');
  mk('codev-skeleton/protocols/spir/protocol.md', 'protocol words here now\n');
  mk('codev-skeleton/protocols/spir/prompts/specify.md', 'aa bb cc dd ee\n');
  mk('codev-skeleton/protocols/spir/consult-types/spec-review.md', 'rubric words\n');
  return dir;
}

describe('T1 — the instrument sources the directory the runtime actually loads', () => {
  it('reads protocols/<p>/prompts/, not the dead porch/prompts tree', () => {
    const src = fs.readFileSync(script, 'utf-8');
    // Assert on EXECUTABLE lines only. The header comment legitimately names the
    // dead tree while explaining the defect, and a blanket string ban would
    // forbid documenting the very bug this test guards.
    const code = src
      .split('\n')
      .filter((l) => !/^\s*#/.test(l) && l.trim() !== '')
      .join('\n');
    expect(code).toMatch(/protocols\/\$p\/prompts\//);
    expect(code).not.toMatch(/PORCH_DIR=/);
    // porch/prompts may appear only as the DEAD bucket (its measurement and its
    // report label) — never as an input to the phase-task term. The tree still
    // exists and the report must expose it; what must never return is it FEEDING
    // the phase mean, which was defect 1.
    const porchRefs = code.split('\n').filter((l) => l.includes('porch/prompts'));
    expect(porchRefs.length).toBeGreaterThan(0);
    for (const line of porchRefs) {
      expect(line, `unexpected porch/prompts use: ${line}`).toMatch(/DEAD_[WF]=|\| DEAD /);
    }
    const phaseMeanFn = code.slice(code.indexOf('phase_mean()'), code.indexOf('consult_mean()'));
    expect(phaseMeanFn).not.toMatch(/porch/);
  });

  it('agrees with loadPromptFile, which resolves protocols/<protocol>/prompts/<file>', () => {
    // Ground the assertion in the real loader rather than a hardcoded string:
    // if porch's resolution path ever moves, this fails loudly.
    const loader = fs.readFileSync(
      path.join(repoRoot, 'packages/codev/src/commands/porch/prompts.ts'),
      'utf-8',
    );
    expect(loader).toMatch(/protocols\/\$\{protocolName\}\/prompts\/\$\{promptFile\}/);
  });

  it('counts the spawn-inlined role file (defect 2)', () => {
    const spawn = fs.readFileSync(
      path.join(repoRoot, 'packages/codev/src/agent-farm/commands/spawn-worktree.ts'),
      'utf-8',
    );
    expect(spawn).toContain('.builder-role.md'); // it really is injected at spawn
    expect(fs.readFileSync(script, 'utf-8')).toMatch(/BUILDER_ROLE=.*roles\/builder\.md/);
  });

  it('adds the hot tier to CLAUDE.md rather than assuming it is inlined (defect 3)', () => {
    const managed = fs.readFileSync(
      path.join(repoRoot, 'packages/codev/src/lib/managed-block.ts'),
      'utf-8',
    );
    expect(managed).toContain('@codev/resources/arch-critical.md'); // @import, not inlined
    const src = fs.readFileSync(script, 'utf-8');
    expect(src).toMatch(/SHARED=\$\(\(\s*CLAUDE_MD \+ HOT\s*\)\)/);
    // The stale claim must not survive as an ASSERTION about current behaviour.
    // It may appear in the header, where it is quoted as a defect being corrected.
    const header = src.slice(0, src.indexOf('set -euo pipefail'));
    const body = src.slice(src.indexOf('set -euo pipefail'));
    expect(body).not.toMatch(/already inlines/);
    expect(header).toMatch(/TRANSCLUDES|@import/); // documents the real mechanism
  });
});

describe('T1b — per-file four-tier resolution, not directory-level selection', () => {
  it('resolves each file at its own winning tier', () => {
    const dir = makeFixture();
    // Override ONE prompt in .codev/ while its siblings stay in the skeleton.
    fs.mkdirSync(path.join(dir, '.codev/protocols/spir/prompts'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.codev/protocols/spir/prompts/specify.md'),
      'aa bb cc dd ee ff gg hh\n', // 8 words vs 5
    );
    const out = run(dir);
    // Directory-level selection would have missed the override entirely.
    expect(out).toMatch(/\| spir \| \d+ \| 8 \| \d+ \|/);
  }, 60_000);

  it('prefers .codev/ over codev/ over codev-skeleton/', () => {
    const src = fs.readFileSync(script, 'utf-8');
    const order = src.slice(src.indexOf('resolve() {'), src.indexOf('# SERVED words'));
    expect(order.indexOf('.codev/')).toBeLessThan(order.indexOf('"codev/$1"'));
    expect(order.indexOf('"codev/$1"')).toBeLessThan(order.indexOf('codev-skeleton/'));
  });
});

describe('T2 — phantom-savings proof: includes are expanded', () => {
  it('moving text from a prompt into an included template changes nothing', () => {
    const dir = makeFixture();
    const before = num(run(dir), 'ALWAYS_ON_WORDS');

    // Same served content, different authored ownership.
    fs.writeFileSync(
      path.join(dir, 'codev-skeleton/protocols/spir/prompts/specify.md'),
      'aa bb {{> protocols/spir/templates/frag.md}}\n',
    );
    fs.mkdirSync(path.join(dir, 'codev-skeleton/protocols/spir/templates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'codev-skeleton/protocols/spir/templates/frag.md'), 'cc dd ee\n');

    expect(num(run(dir), 'ALWAYS_ON_WORDS')).toBe(before);
  }, 60_000);

  it('expands non-markdown includes too — protocol.json delivery depends on it (P6)', () => {
    const dir = makeFixture();
    const before = num(run(dir), 'ALWAYS_ON_WORDS');
    fs.writeFileSync(
      path.join(dir, 'codev-skeleton/protocols/spir/protocol.md'),
      'protocol words here now\n```json\n{{> protocols/spir/protocol.json}}\n```\n',
    );
    fs.writeFileSync(
      path.join(dir, 'codev-skeleton/protocols/spir/protocol.json'),
      '{ "a": 1, "b": 2 }\n',
    );
    // The JSON's words must appear in the served count, not vanish.
    expect(num(run(dir), 'ALWAYS_ON_WORDS')).toBeGreaterThan(before);
  }, 60_000);
});

describe('T3 — per-surface reporting completeness (not a ceiling)', () => {
  it('reports every protocol found on disk, in either tree', () => {
    const out = run();
    const onDisk = new Set<string>();
    for (const tree of ['codev/protocols', 'codev-skeleton/protocols']) {
      const p = path.join(repoRoot, tree);
      if (!fs.existsSync(p)) continue;
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (e.isDirectory()) onDisk.add(e.name);
      }
    }
    expect(onDisk.size).toBeGreaterThan(0);
    for (const name of onDisk) {
      expect(out, `protocol "${name}" missing from the report`).toMatch(
        new RegExp(`^\\| ${name} \\|`, 'm'),
      );
    }
  }, 60_000);

  it('includes codev-only protocols with no skeleton twin (release)', () => {
    expect(run()).toMatch(/^\| release \|/m);
  }, 60_000);
});

describe('T11 — buckets vs audience loads are reported on different bases', () => {
  it('states the formulas and warns the audience loads overlap', () => {
    const out = run();
    expect(out).toContain('ALWAYS_ON(builder,p,I)   = SHARED + BUILDER_SPAWN[p]');
    expect(out).toMatch(/OVERLAP by design/);
    expect(out).toMatch(/these SUM/);
  }, 60_000);

  it('one bucket growing while another shrinks shows BOTH movements, not a netted zero', () => {
    const dir = makeFixture();
    const before = run(dir);
    const sharedBefore = Number(before.match(/\| SHARED [^|]*\| (\d+) \|/)![1]);
    const archBefore = Number(before.match(/\| ARCHITECT [^|]*\| (\d+) \|/)![1]);

    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'alpha\n');                       // shrink
    fs.writeFileSync(path.join(dir, 'codev/roles/architect.md'), 'a b c d e f g\n'); // grow

    const after = run(dir);
    const sharedAfter = Number(after.match(/\| SHARED [^|]*\| (\d+) \|/)![1]);
    const archAfter = Number(after.match(/\| ARCHITECT [^|]*\| (\d+) \|/)![1]);

    expect(sharedAfter).toBeLessThan(sharedBefore);
    expect(archAfter).toBeGreaterThan(archBefore);
  }, 60_000);
});

describe('T15 — relocation is visible, never reported as deletion (M0c)', () => {
  it('moving a block into a skill drops always-on but holds total-authored steady', () => {
    const dir = makeFixture();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'alpha bravo charlie delta echo foxtrot\n');
    const before = run(dir);

    // Relocate three words out of CLAUDE.md into a skill — the P3/P4 move.
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'alpha bravo charlie\n');
    fs.mkdirSync(path.join(dir, '.claude/skills/afx'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude/skills/afx/SKILL.md'), 'delta echo foxtrot\n');

    const after = run(dir);
    expect(num(after, 'ALWAYS_ON_WORDS')).toBeLessThan(num(before, 'ALWAYS_ON_WORDS'));
    expect(num(after, 'TOTAL_AUTHORED_WORDS')).toBe(num(before, 'TOTAL_AUTHORED_WORDS'));
  }, 60_000);

  it('counts all four skill trees — one-tree counting would report relocation as deletion', () => {
    const src = fs.readFileSync(script, 'utf-8');
    for (const tree of [
      '.claude/skills',
      '.codex/skills',
      'codev-skeleton/.claude/skills',
      'codev-skeleton/.codex/skills',
    ]) {
      expect(src, `total-authored basis must include ${tree}`).toContain(tree);
    }
  });
});

describe('portability — the count must not depend on the host', () => {
  it('does not delegate word counting to `wc -w`', () => {
    // BSD wc (macOS, UTF-8 locale) counts `⚠️` (U+26A0 U+FE0F) as two words; GNU wc
    // and Python's str.split() count one. Four such banners in spir/protocol.md
    // made the same commit measure 34,235 locally and 34,231 in CI. An instrument
    // whose before/after must be comparable across machines cannot delegate its
    // core definition to a platform-variant tool.
    const code = fs
      .readFileSync(script, 'utf-8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toMatch(/wc -w/);
    expect(code).toMatch(/_count\(\)/);
  });

  it('reports the same total under a C locale as under UTF-8', () => {
    const utf8 = num(run(repoRoot, { LC_ALL: 'en_US.UTF-8' }), 'ALWAYS_ON_WORDS');
    const c = num(run(repoRoot, { LC_ALL: 'C' }), 'ALWAYS_ON_WORDS');
    expect(c).toBe(utf8);
  }, 60_000);
});

describe('T12 — determinism', () => {
  it('emits byte-identical output twice at the same commit', () => {
    expect(run()).toBe(run());
  }, 60_000);
});

describe('instrument correctness — asserted without pinning the live surface', () => {
  // WHY THERE ARE NO LIVE ABSOLUTE NUMBERS IN THIS FILE
  //
  // The original form asserted `ALWAYS_ON_WORDS === 34231` against the REAL repo. That fires
  // on every always-on edit by every project — Spec 1307 hit it on day one, correctly checked
  // causality and bumped it. But the incentive it creates for the NEXT project is
  // bump-without-checking, which is exactly the regression this test exists to catch: the
  // number moves for two different reasons (the instrument broke / the surface changed) and
  // the test cannot tell them apart, so it delegates that judgement to whoever is least able
  // to spend time on it.
  //
  // Three layers replace it, none of which a legitimate surface edit can disturb:
  //   1. INVARIANTS on the live repo — the composition arithmetic, true at any surface size.
  //   2. ABSOLUTE values on a synthetic FIXTURE — pins the instrument's correctness without
  //      pinning the repo's content. This is what invariants alone cannot do: a component
  //      that is silently wrong (say SHARED omitting the hot tier) still satisfies every
  //      internal identity, because the wrong value propagates consistently.
  //   3. BYTE-assertions on the frozen baseline artifacts — historical record, and editing
  //      one should be a deliberate act.
  //
  // Live absolute numbers belong in the phase manifests and generated artifacts, where a
  // human reads them as findings rather than maintaining them as expectations.

  let out: string;
  beforeAll(() => { out = run(); }, 60_000);

  describe('layer 1 — invariants over the live repo (hold at any surface size)', () => {
    it('ALWAYS_ON = SHARED + BUILDER_SPAWN[spir] + I x (HOT + PHASE mean[spir])', () => {
      const shared = Number(out.match(/\| SHARED [^|]*\| (\d+) \|/)![1]);
      const spir = out.match(/^\| spir \| (\d+) \| (\d+) \| \d+ \|$/m)!;
      const hot = Number(out.match(/lessons-critical\(\d+\) = (\d+)/)![1]);
      expect(num(out, 'ALWAYS_ON_WORDS')).toBe(
        shared + Number(spir[1]) + 10 * (hot + Number(spir[2])),
      );
    });

    it('architect load = SHARED + ARCHITECT', () => {
      const shared = Number(out.match(/\| SHARED [^|]*\| (\d+) \|/)![1]);
      const architect = Number(out.match(/\| ARCHITECT [^|]*\| (\d+) \|/)![1]);
      expect(Number(out.match(/\| Architect \(per session\) \| (\d+) \|/)![1])).toBe(
        shared + architect,
      );
    });

    it('PHASE_ITERS is a linear comparison constant', () => {
      const one = num(run(repoRoot, { PHASE_ITERS: '1' }), 'ALWAYS_ON_WORDS');
      const two = num(run(repoRoot, { PHASE_ITERS: '2' }), 'ALWAYS_ON_WORDS');
      const spir = out.match(/^\| spir \| \d+ \| (\d+) \| \d+ \|$/m)!;
      const hot = Number(out.match(/lessons-critical\(\d+\) = (\d+)/)![1]);
      expect(two - one).toBe(hot + Number(spir[1]));
    }, 60_000);
  });

  describe('layer 2 — absolute values on a fixture whose arithmetic a human can check', () => {
    // Fixture contents (see makeFixture): CLAUDE.md 3 words, hot tier 2+2, builder role 3,
    // spir wrapper 3, spir protocol.md 4, one spir prompt 5, consultant role 2, one
    // consult-type 2, architect role 3.
    //   SHARED  = 3 + 4                     =   7
    //   SPAWN   = 3 + 3 + 4                 =  10
    //   ALWAYS_ON = 7 + 10 + 10 x (4 + 5)   = 107
    it('reports the hand-computed total for a known surface', () => {
      const out2 = run(makeFixture());
      expect(num(out2, 'ALWAYS_ON_WORDS')).toBe(107);
    }, 60_000);

    it('reports the hand-computed architect and consultant loads', () => {
      const out2 = run(makeFixture());
      expect(out2).toMatch(/\| Architect \(per session\) \| 10 \|/);
      expect(out2).toMatch(/\| Consultant \(per review, spir\) \| 4 \|/);
    }, 60_000);

    it('a component silently omitted would fail here even though invariants still hold', () => {
      // The blind spot invariants cannot see: drop the hot tier from SHARED and every
      // internal identity still balances, because the wrong value propagates consistently.
      // Only an externally-known expected value catches it.
      const out2 = run(makeFixture());
      expect(Number(out2.match(/\| SHARED [^|]*\| (\d+) \|/)![1])).toBe(7);
    }, 60_000);
  });

  describe('layer 3 — the frozen baseline artifacts are historical records', () => {
    it('the pre-rewrite baseline still records 34,231', () => {
      const baseline = fs.readFileSync(
        path.join(repoRoot, 'codev/resources/1280-word-baseline.md'),
        'utf-8',
      );
      expect(baseline).toMatch(/^ALWAYS_ON_WORDS=34231$/m);
    });
  });
});
