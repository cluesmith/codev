/**
 * Regression guards for cluesmith/codev#1902 — the prompt sweep outside `protocols/pir/`.
 *
 * Agents execute what these files say. Each block asserts that a command which failed as
 * written, or a contradiction the issue named, is gone from every agent-facing surface and
 * stays gone: both framework trees, the four skill trees, the root CLAUDE.md/AGENTS.md, and
 * the command reference docs. `protocols/pir/` is out of scope for #1902 and excluded.
 *
 * Historical artifacts (specs, plans, reviews, projects, audits) are not scanned — they record
 * what was true when written.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const THREE = ['gemini', 'codex', 'claude'];

/** Agent-facing roots, relative to the repo root. */
const ROOTS = [
  'codev-skeleton',
  'codev/protocols',
  'codev/roles',
  'codev/templates',
  'codev/resources/commands',
  'codev/resources/cheatsheet.md',
  'codev/resources/workflow-reference.md',
  'codev/resources/risk-triage.md',
  'codev/resources/protocol-format.md',
  '.claude/skills',
  '.codex/skills',
  'CLAUDE.md',
  'AGENTS.md',
  'docs', // live user-facing pages (faq, tips, ...); release notes are history, excluded below
];

const EXCLUDED = [
  /(^|\/)protocols\/pir\//, // out of scope for #1902
  /(^|\/)protocols\/release\//, // RELEASE problems are flagged to the architect, not rewritten
  /\/evals\//,
  /^docs\/releases\//, // historical release notes describe what shipped then
];

function walk(rel: string): string[] {
  const full = path.join(repoRoot, rel);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [rel];
  const out: string[] = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const child = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...walk(child));
    else if (/\.(md|json)$/.test(entry.name)) out.push(child);
  }
  return out;
}

const FILES = [...new Set(ROOTS.flatMap(walk))].filter((f) => !EXCLUDED.some((re) => re.test(f)));

interface Hit { file: string; line: number; text: string }

function scan(pattern: RegExp, allow: (line: string) => boolean = () => false): Hit[] {
  const hits: Hit[] = [];
  for (const file of FILES) {
    fs.readFileSync(path.join(repoRoot, file), 'utf-8').split('\n').forEach((text, i) => {
      if (pattern.test(text) && !allow(text)) hits.push({ file, line: i + 1, text: text.trim() });
    });
  }
  return hits;
}

const fmt = (hits: Hit[]) => hits.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join('\n');

function expectNone(pattern: RegExp, why: string, allow?: (line: string) => boolean): void {
  const hits = scan(pattern, allow);
  expect(hits, `${why}\n${fmt(hits)}`).toEqual([]);
}

const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
const protocolJson = (tree: string, name: string) => JSON.parse(read(`${tree}/protocols/${name}/protocol.json`));

describe('#1902 — the sweep covers real files', () => {
  it('scans a meaningful set of agent-facing files', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES).toContain('codev-skeleton/protocols/bugfix/prompts/pr.md');
    expect(FILES).toContain('.claude/skills/porch/SKILL.md');
    expect(FILES.some((f) => f.includes('protocols/pir/'))).toBe(false);
  });
});

describe('#1902 A — commands that failed as written', () => {
  it('no `consult --type integration pr <N>` (the PR number goes in --issue)', () => {
    expectNone(/--type integration pr\b/, 'Use `consult -m <m> --type integration --issue <N>`.');
  });

  it('no consult command combines --prompt with --prompt-file (they are mutually exclusive)', () => {
    expectNone(
      /consult\b.*--prompt\s+"[^"]*"\s+--prompt-file|consult\b.*--prompt-file\s+\S+\s+--prompt\s/,
      'consult rejects --prompt together with --prompt-file.',
    );
  });

  it('no `porch run` (removed; the loop is porch next / porch done)', () => {
    expectNone(/\bporch run\b/, '`porch run` no longer exists.', (l) => /`porch run` was removed/.test(l));
  });

  it('no bare protocol review type without --protocol on a consult command line', () => {
    // Only `integration` resolves without --protocol; spec/plan/impl/pr/phase prompts live
    // under protocols/<name>/consult-types/.
    expectNone(
      /^\s*(\$\s*)?consult\s+-m\s+\S+(?!.*--protocol).*--type\s+(spec|plan|impl|pr|phase)\b/,
      'Add `--protocol <name>`: bare spec/plan/impl/pr/phase types do not resolve.',
    );
  });

  it('no stdin --context and no filesystem-less consult mode', () => {
    expectNone(/--context\s+-(\s|$|`)/, '`consult --context` takes a file path; there is no stdin mode.');
    expectNone(/filesystem-less|without filesystem access/i, 'consult has no filesystem-less mode.');
  });

  it('`afx spawn --protocol <name> --help` is never offered as a check (it exits 0 for any name)', () => {
    expectNone(
      /afx spawn --protocol <name> --help/,
      '`--help` succeeds for any protocol name, so it verifies nothing.',
      (l) => /proves(\s+nothing)?\s*$|proves\s+nothing|is no check|succeeds for any name/.test(l),
    );
  });

  it('no trailing-`&` consult backgrounding (run each as a background task instead)', () => {
    // Agent-facing only: a human at a shell (docs/ pages) backgrounds with `&` + `wait`, correctly.
    const hits = scan(/^\s*consult\s.*\s&\s*$/).filter((h) => !h.file.startsWith('docs/'));
    expect(hits, `Use run_in_background tasks, not \`&\` + \`wait\`.\n${fmt(hits)}`).toEqual([]);
  });
});

describe('#1902 B — the builder runs porch approve, with the human-approval flag', () => {
  it('every concrete `porch approve <id> <gate>` carries --a-human-explicitly-approved-this', () => {
    expectNone(
      /porch approve\s+[^\s`]+\s+[^\s`-][^\s`]*/,
      'porch approve requires --a-human-explicitly-approved-this.',
      (l) => l.includes('--a-human-explicitly-approved-this'),
    );
  });

  it('every approve hint porch itself prints carries the flag', () => {
    // An agent copies what porch prints; a hint without the flag gets a refusal instead.
    const dir = 'packages/codev/src/commands/porch';
    const hits: string[] = [];
    for (const f of fs.readdirSync(path.join(repoRoot, dir)).filter((n) => n.endsWith('.ts'))) {
      read(`${dir}/${f}`).split('\n').forEach((line, i) => {
        if (/porch approve \$\{[^}]+\} \$\{[^}]+\}/.test(line) && !line.includes('--a-human-explicitly-approved-this')) {
          hits.push(`${dir}/${f}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('no text tells a builder to skip a flaky test (owner ruling: report it, leave it running)', () => {
    // PIR included: the ruling covers every protocol, unlike the rest of this sweep.
    const pir = ['codev-skeleton', 'codev'].flatMap((t) => walk(`${t}/protocols/pir`));
    const pattern = /skip it with (an )?annotation|skipped as flaky|tests you skipped due to|skipped\/flaky/i;
    const hits: Hit[] = [];
    for (const file of [...new Set([...FILES, ...pir])]) {
      read(file).split('\n').forEach((text, i) => {
        if (pattern.test(text)) hits.push({ file, line: i + 1, text: text.trim() });
      });
    }
    expect(hits, `A flaky pre-existing test is reported and left running, not skipped.\n${fmt(hits)}`).toEqual([]);
    for (const tree of ['codev-skeleton', 'codev']) {
      expect(read(`${tree}/roles/builder.md`)).toMatch(/do not skip it\. Leave it\s+running/);
    }
  });

  it('no text tells builders never to run porch approve', () => {
    expectNone(/Builders? (must )?NEVER (call|run) `?porch approve/i, 'The builder runs porch approve (#1902 B).');
  });

  it.each(['codev-skeleton', 'codev'])('%s roles/builder.md: the builder runs the approval itself', (tree) => {
    const builder = read(`${tree}/roles/builder.md`);
    expect(builder).toContain('`porch approve <id> <gate> --a-human-explicitly-approved-this`');
    expect(builder).not.toMatch(/Defer to your protocol's phase\s+prompts on who types/);
  });

  it('the porch skill says the builder runs it', () => {
    const skill = read('.claude/skills/porch/SKILL.md');
    expect(skill).toMatch(/\*\*Who runs `porch approve`:\*\* the builder, after the architect relays the human's decision/);
  });
});

describe('#1902 C — owner rulings', () => {
  it('C1: builders write specs and plans; architects review them', () => {
    expectNone(/Architects? (create|creates|write|writes) specs/i, 'Builders write specs and plans (#1902 C1).');
    expect(read('CLAUDE.md')).toContain('Builders write specs and plans');
  });

  it.each(['codev-skeleton', 'codev'])('C2: %s BUGFIX and AIR PR phases default to three pr reviewers', (tree) => {
    for (const name of ['bugfix', 'air']) {
      const json = protocolJson(tree, name);
      const pr = json.phases.find((p: { id: string }) => p.id === 'pr');
      expect(pr.consultation, `${tree}/${name}`).toEqual({ models: THREE, type: 'pr' });
      expect(json.defaults?.consultation, `${tree}/${name}: a second, unread lane list`).toBeUndefined();
    }
  });

  it('C2: the BUGFIX/AIR PR prompts take their consult lines from porch', () => {
    for (const name of ['bugfix', 'air']) {
      const prompt = read(`codev-skeleton/protocols/${name}/prompts/pr.md`);
      expect(prompt, name).toContain('{{consult_commands}}');
      expect(prompt, name).toContain('{{consult_verdicts}}');
      expect(prompt, name).not.toMatch(/^consult -m /m);
    }
  });

  it.each(['codev-skeleton', 'codev'])('C2: %s — a prompt using {{consult_*}} belongs to a phase declaring consultation', (tree) => {
    // The converse of the check above: porch renders {{consult_commands}} / {{consult_verdicts}}
    // only for a phase with a `consultation` block, so a prompt elsewhere would reach the builder
    // as a literal, unrendered token.
    const offenders: string[] = [];
    const visited: string[] = [];
    for (const name of fs.readdirSync(path.join(repoRoot, tree, 'protocols'))) {
      const file = `${tree}/protocols/${name}/protocol.json`;
      if (!fs.existsSync(path.join(repoRoot, file))) continue;
      for (const phase of JSON.parse(read(file)).phases as Array<{ id: string; build?: { prompt?: string }; consultation?: unknown }>) {
        // Porch's own lookup: build.prompt, else `<phase id>.md` (prompts.ts).
        const prompt = `${tree}/protocols/${name}/prompts/${phase.build?.prompt ?? `${phase.id}.md`}`;
        if (!fs.existsSync(path.join(repoRoot, prompt))) continue;
        visited.push(prompt);
        if (/\{\{consult_(commands|verdicts)\}\}/.test(read(prompt)) && !phase.consultation) {
          offenders.push(`${prompt} (phase ${phase.id} has no consultation block)`);
        }
      }
    }
    expect(visited, 'the guard must actually see the BUGFIX/AIR PR prompts').toEqual(
      expect.arrayContaining([`${tree}/protocols/bugfix/prompts/pr.md`, `${tree}/protocols/air/prompts/pr.md`]),
    );
    expect(offenders).toEqual([]);
  });

  it.each(['codev-skeleton', 'codev'])('C3: %s roles carry the fix-in-place rule', (tree) => {
    for (const role of ['builder', 'architect']) {
      expect(read(`${tree}/roles/${role}.md`), role).toMatch(/\*\*Fix in place\.\*\*/);
    }
  });

  it('C3: 300 lines is a guideline, never a hard limit', () => {
    expectNone(/300[- ]?(LOC|lines?)[^.]*\b(hard limit|maximum|must not exceed|cap)\b/i, '300 lines is a guideline.', (l) =>
      /not a hard limit|guideline/i.test(l),
    );
    expectNone(/TOO_COMPLEX/, 'BUGFIX/AIR escalate with afx send architect; TOO_COMPLEX was never read.');
  });
});

describe('#1902 D — dead machinery and stale text', () => {
  it('no non-PIR protocol.json declares signals or on_too_complex (porch reads neither)', () => {
    for (const tree of ['codev-skeleton', 'codev']) {
      for (const name of fs.readdirSync(path.join(repoRoot, tree, 'protocols'))) {
        const file = `${tree}/protocols/${name}/protocol.json`;
        if (name === 'pir' || !fs.existsSync(path.join(repoRoot, file))) continue;
        const json = JSON.parse(read(file));
        expect(json.signals, `${file} still declares signals`).toBeUndefined();
        expect(JSON.stringify(json), file).not.toContain('on_too_complex');
      }
    }
  });

  it('no prompt tells an agent to emit a <signal>', () => {
    expectNone(/<signal\b|\bPHASE_COMPLETE\b|\bBLOCKED:\s*</, 'Finish with porch done; report blockers with afx send architect.');
  });

  it('no TICK (retired protocol) and no --amends', () => {
    expectNone(/\bTICK\b|--amends\b|--protocol tick\b/, 'TICK is retired.');
  });

  it('no zero-padded project-id placeholders (ids are never zero-padded)', () => {
    expectNone(/XXXX|#NNN\b|afx send 0\d{3}\b/, 'Use <id> / <N>; project and issue ids carry no leading zeros.');
  });

  it('no per-project port blocks (one Tower on 4100)', () => {
    expectNone(/port 4200, 4300|afx ports list|afx workspace start -p\b/, 'All workspaces share one Tower on port 4100.');
  });

  it('RESEARCH JSON and prose agree on three models', () => {
    for (const tree of ['codev-skeleton', 'codev']) {
      const json = protocolJson(tree, 'research');
      for (const id of ['investigate', 'critique']) {
        expect(json.phases.find((p: { id: string }) => p.id === id).consultation.models, `${tree} ${id}`).toEqual(THREE);
      }
      expect(read(`${tree}/protocols/research/protocol.md`)).not.toContain('`["codex"]`');
    }
  });

  it('the shipped CLAUDE.md/AGENTS.md templates list porch and no `afx start`', () => {
    for (const t of ['CLAUDE.md', 'AGENTS.md']) {
      const body = read(`codev-skeleton/templates/${t}`);
      expect(body, t).toMatch(/\*\*porch\*\*: Protocol orchestration/);
      expect(body, t).not.toMatch(/\bthree CLI tools\b/);
      expect(body, t).not.toMatch(/orchestration \(start,/);
    }
  });

  it('MAINTAIN has no orphan local templates and names its gate', () => {
    for (const orphan of ['audit-report.md', 'lessons-learned.md']) {
      expect(fs.existsSync(path.join(repoRoot, 'codev/protocols/maintain/templates', orphan)), orphan).toBe(false);
    }
    expect(read('codev-skeleton/protocols/maintain/protocol.md')).toContain('maintain-complete');
    expectNone(/cd packages\/codev/, 'MAINTAIN must not hardcode this repo\'s package path.');
  });

  const GATE_PROTOCOLS = ['spir', 'aspir', 'air', 'bugfix', 'pir', 'maintain', 'research', 'experiment'];
  const gatesOf = (name: string): string[] =>
    protocolJson('codev-skeleton', name)
      .phases.map((p: { gate?: string | { name: string } }) => (typeof p.gate === 'string' ? p.gate : p.gate?.name))
      .filter(Boolean) as string[];

  it('the porch skill\'s gate table matches protocol.json row by row', () => {
    const skill = read('.claude/skills/porch/SKILL.md');
    for (const name of GATE_PROTOCOLS) {
      const row = skill.split('\n').find((l) => l.startsWith('|') && l.split('|')[1].toLowerCase().split(',').map((x) => x.trim()).includes(name));
      expect(row, `porch skill has no gate row for ${name}`).toBeTruthy();
      for (const gate of gatesOf(name)) expect(row, `${name}: ${gate}`).toContain(`\`${gate}\``);
    }
  });

  it.each([
    'codev-skeleton/roles/builder.md',
    'codev/roles/builder.md',
    'codev-skeleton/templates/lifecycle.md',
    'codev/templates/lifecycle.md',
    'CLAUDE.md',
  ])('%s names every gate of every protocol', (doc) => {
    // Each of these enumerates the gates per protocol; an omitted protocol is the drift #1902 fixed.
    const body = read(doc);
    for (const name of GATE_PROTOCOLS) {
      for (const gate of gatesOf(name)) expect(body, `${doc} omits ${name}'s ${gate}`).toContain(`\`${gate}\``);
    }
  });

  it.each(['codev-skeleton', 'codev'])('%s builder.md: "ready for cleanup" never precedes SPIR/ASPIR verification', (tree) => {
    const lines = read(`${tree}/roles/builder.md`).split('\n').filter((l) => /Ready for cleanup/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line, line).toMatch(/no `verify` phase|Verified/);
    expect(read(`${tree}/roles/builder.md`)).toMatch(/PR merged — SPIR, ASPIR \| `afx send architect "Project <id>: PR merged\. Entering verify\."`/);
  });
});
