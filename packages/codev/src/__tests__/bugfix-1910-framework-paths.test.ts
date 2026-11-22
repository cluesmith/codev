/**
 * Regression guard for cluesmith/codev#1910 — shipped text named framework files by an on-disk
 * path that adopter workspaces do not have.
 *
 * Protocols, roles and templates resolve at runtime through the four-tier lookup; in an adopter
 * workspace the standard ones live only inside the installed package. A prompt or template that
 * says "the template is at `protocols/spir/templates/spec.md`" or lists a protocol as
 * "(`codev/protocols/experiment/protocol.md`)" reads as a location, and agents went looking for it
 * with `find /`. Content reaches agents through `{{> …}}` includes, the spawn prompt and porch.
 *
 * Allowed: resolver includes (`{{> protocols/…}}`), and lines that name a `codev/…` path as the
 * place a project's own customization goes (they say "customiz…", "local" or "override").
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

/** What ships to adopters (the skeleton) and our instance's copies of the same framework files. */
const ROOTS = [
  'codev-skeleton',
  'codev/protocols',
  'codev/roles',
  'codev/templates',
  'codev/resources/commands',
  'codev/resources/workflow-reference.md',
  'codev/resources/risk-triage.md',
];

/** RELEASE is this repository's own protocol; it never ships, and its files exist here. */
const EXCLUDED = [/^codev\/protocols\/release\//];

/** A framework file named by location: `codev/protocols/x/…`, `protocols/x/templates/…`, `../roles/x.md`. */
const FRAMEWORK_PATH =
  /(?:\bcodev\/|\.\.\/|`|\(|\s)(?:protocols\/[a-z-]+\/(?:protocol\.md|templates\/|prompts\/|consult-types\/)|roles\/[a-z-]+\.md)/;

const ALLOWED = (line: string) =>
  /\{\{>\s*protocols\//.test(line) || /customi[sz]|\blocal\b|override/i.test(line);

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

describe('#1910 — shipped text never names a framework file by an on-disk path', () => {
  it('scans the files that carried the bug', () => {
    for (const f of [
      'codev-skeleton/protocols/spir/consult-types/spec-review.md',
      'codev-skeleton/protocols/aspir/protocol.json',
      'codev-skeleton/templates/CLAUDE.md',
      'codev-skeleton/templates/AGENTS.md',
      'codev-skeleton/resources/workflow-reference.md',
      'codev/templates/CLAUDE.md',
    ]) {
      expect(FILES).toContain(f);
    }
  });

  it('every remaining framework path is a resolver include or a customization pointer', () => {
    const hits: string[] = [];
    for (const file of FILES) {
      fs.readFileSync(path.join(repoRoot, file), 'utf-8').split('\n').forEach((text, i) => {
        if (FRAMEWORK_PATH.test(text) && !ALLOWED(text)) hits.push(`  ${file}:${i + 1}  ${text.trim().slice(0, 160)}`);
      });
    }
    expect(
      hits,
      `These name a framework file by a path adopter workspaces do not have; agents search the disk for it. ` +
        `Deliver the content (include, spawn prompt, porch) or name the path only as where a customization goes.\n` +
        hits.join('\n'),
    ).toEqual([]);
  });

  it('the guard bites on the shapes #1910 found', () => {
    for (const line of [
      'the spec follows the delivered template (`protocols/spir/templates/spec.md`), which the specify prompt inlines.',
      '"description": "canonical template delivered by the specify prompt (protocols/spir/templates/spec.md)."',
      '- **EXPERIMENT**: Disciplined experimentation (`codev/protocols/experiment/protocol.md`)',
      '- [SPIR Protocol](../protocols/spir/protocol.md) - Multi-phase development workflow',
      '- Builder role: `codev/roles/builder.md`',
    ]) {
      expect(FRAMEWORK_PATH.test(line) && !ALLOWED(line), line).toBe(true);
    }
    expect(ALLOWED('{{> protocols/spir/templates/spec.md}}')).toBe(true);
  });

  it.each(['codev-skeleton', 'codev'])('%s CLAUDE.md/AGENTS.md templates say protocols are delivered, not opened', (tree) => {
    for (const t of ['CLAUDE.md', 'AGENTS.md']) {
      expect(fs.readFileSync(path.join(repoRoot, tree, 'templates', t), 'utf-8'), t).toContain('there is no protocol file to open');
    }
  });
});
