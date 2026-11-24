/**
 * Regression guard for cluesmith/codev#1910: shipped text named framework files by an on-disk
 * path that adopter workspaces do not have (the files live only in the installed package), and
 * agents searched the disk for them with `find /`.
 *
 * Pins the sites the issue found, in both trees, and the owner's rule that agents never search
 * from the filesystem root.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
const TREES = ['codev-skeleton', 'codev'];

/** An on-disk framework path that is not a `{{> … }}` resolver include. */
const linesNamingPath = (body: string, re: RegExp) =>
  body.split('\n').filter((l) => re.test(l) && !/\{\{>/.test(l)).map((l) => l.trim());

describe.each(TREES)('#1910 (%s)', (tree) => {
  it.each(['spir', 'aspir'])('%s spec-review.md and protocol.json do not name the spec template path', (p) => {
    for (const f of [`protocols/${p}/consult-types/spec-review.md`, `protocols/${p}/protocol.json`]) {
      expect(linesNamingPath(read(`${tree}/${f}`), /protocols\/spir\/templates\/spec\.md/), f).toEqual([]);
    }
  });

  it.each(['CLAUDE.md', 'AGENTS.md'])('templates/%s does not point at codev/protocols/ for protocol text', (t) => {
    const body = read(`${tree}/templates/${t}`);
    expect(linesNamingPath(body, /codev\/protocols\/[a-z]+\/protocol\.md/)).toEqual([]);
    expect(body).not.toContain('Read the full protocol documentation in `codev/protocols/`');
  });

  it.each(['roles/builder.md', 'roles/architect.md', 'templates/CLAUDE.md', 'templates/AGENTS.md'])(
    '%s says never to search from the filesystem root (owner ruling)',
    (f) => {
      const body = read(`${tree}/${f}`);
      expect(body).toContain('Never search from the filesystem root');
      expect(body).toContain('is delivered to you another way, so do not go looking for it');
    },
  );
});
