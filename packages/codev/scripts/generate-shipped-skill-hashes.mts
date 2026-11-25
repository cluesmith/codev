/**
 * Regenerate src/lib/shipped-skill-hashes.ts: the content hash of every version of every
 * shipped skill, read from git history plus the working tree (issue #1811); and
 * src/lib/shipped-root-doc-hashes.ts: the same for the CLAUDE.md / AGENTS.md templates,
 * each version hashed in the form `codev update` hashes a project's doc in (issue #1985).
 *
 * Run from anywhere in the repository after changing a shipped skill or root-doc template:
 *   pnpm --filter @cluesmith/codev generate-skill-hashes
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hashSkillFiles, readSkillFiles, type SkillFile } from '../src/lib/skill-refresh.js';
import { HOT_BLOCK_BEGIN, HOT_BLOCK_END, ROOT_DOCS, upsertHotContextBlock } from '../src/lib/managed-block.js';
import { hashRootDocForm, PROJECT_NAME_PLACEHOLDER, rootDocHashForm, SKILL_PROVIDERS } from '../src/lib/scaffold.js';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
const outFile = path.join(repoRoot, 'packages/codev/src/lib/shipped-skill-hashes.ts');
const rootDocOutFile = path.join(repoRoot, 'packages/codev/src/lib/shipped-root-doc-hashes.ts');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
}

function record(into: Map<string, Set<string>>, key: string, hash: string): void {
  if (!into.has(key)) into.set(key, new Set());
  into.get(key)!.add(hash);
}

/** Write a generated module exporting `name`: a sorted map of key to sorted hashes. */
function writeHashes(file: string, header: string[], name: string, from: Map<string, Set<string>>): void {
  const out = ['/**', ...header.map((line) => ` * ${line}`.trimEnd()), ' */', `export const ${name}: Record<string, readonly string[]> = {`];
  for (const key of [...from.keys()].sort()) {
    out.push(`  '${key}': [`);
    for (const hash of [...from.get(key)!].sort()) out.push(`    '${hash}',`);
    out.push('  ],');
  }
  out.push('};', '');
  fs.writeFileSync(file, out.join('\n'));
  const versions = [...from.values()].reduce((n, set) => n + set.size, 0);
  console.log(`Wrote ${path.relative(repoRoot, file)}: ${from.size} keys, ${versions} versions.`);
}

const hashes = new Map<string, Set<string>>();
for (const provider of SKILL_PROVIDERS) {
  const root = `codev-skeleton/.${provider}/skills`;

  // Every commit that changed this provider's skills, and the skills as they stood after it.
  const commits = git(['log', '--format=%H', '--', root]).split('\n').filter(Boolean);
  for (const commit of commits) {
    const bySkill = new Map<string, SkillFile[]>();
    const entries = git(['ls-tree', '-r', commit, '--', `${root}/`]).split('\n').filter(Boolean);
    for (const entry of entries) {
      const [meta, filePath] = entry.split('\t');
      const [mode, , blob] = meta.split(' ');
      const rel = filePath.slice(root.length + 1);
      const slash = rel.indexOf('/');
      if (slash < 0) continue;
      const skill = rel.slice(0, slash);
      const name = path.posix.basename(rel);
      if (name === '.DS_Store' || name.endsWith('.codev-new')) continue;
      let content = git(['cat-file', '-p', blob]);
      if (mode === '120000') content = `<link:${content}>`;
      if (!bySkill.has(skill)) bySkill.set(skill, []);
      bySkill.get(skill)!.push({ path: rel.slice(slash + 1), content });
    }
    for (const [skill, files] of bySkill) record(hashes, `.${provider}/skills/${skill}`, hashSkillFiles(files));
  }

  // The working tree, so a skill edited in this change is already in the history.
  const workDir = path.join(repoRoot, root);
  for (const entry of fs.readdirSync(workDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = readSkillFiles(path.join(workDir, entry.name));
    if (files) record(hashes, `.${provider}/skills/${entry.name}`, hashSkillFiles(files));
  }
}

// Root docs (#1985). The template has lived at three paths; every version at any of them,
// plus the working tree, is hashed in the form update hashes a doc in. A version is listed
// only if it carries the project name once, in the current template's heading (the only
// place update reads a doc's name from), and if it hashes the same as shipped and with a
// live managed block put in, as a later update put one into a doc from before the block
// existed. Any other version stays the adopter's to merge.
const LIVE_BLOCK = `${HOT_BLOCK_BEGIN}\nlive block content\n${HOT_BLOCK_END}`;
const rootDocHashes = new Map<string, Set<string>>();
for (const doc of ROOT_DOCS) {
  const current = fs.readFileSync(path.join(repoRoot, 'codev-skeleton/templates', doc), 'utf-8');
  // Keyed by blob, each with where it was first seen.
  const versions = new Map<string, { label: string; template: string }>([['working tree', { label: 'working tree', template: current }]]);
  for (const rel of [`packages/codev/templates/${doc}`, `codev-skeleton/${doc}.template`, `codev-skeleton/templates/${doc}`]) {
    for (const commit of git(['log', '--format=%H', '--', rel]).split('\n').filter(Boolean)) {
      const entry = git(['ls-tree', commit, '--', rel]).trim();
      if (entry === '') continue; // the commit that moved or removed it
      const blob = entry.split('\t')[0].split(' ')[2];
      if (!versions.has(blob)) versions.set(blob, { label: `${commit.slice(0, 9)}:${rel}`, template: git(['cat-file', '-p', blob]) });
    }
  }
  for (const { label, template } of versions.values()) {
    const parsed = rootDocHashForm(template, current);
    if (template.split(PROJECT_NAME_PLACEHOLDER).length !== 2 || parsed?.projectName !== PROJECT_NAME_PLACEHOLDER) {
      console.warn(`Not listed: ${doc} ${label}: the project name is not once, in the current heading.`);
      continue;
    }
    if (rootDocHashForm(upsertHotContextBlock(template, LIVE_BLOCK), current)?.form !== parsed.form) {
      console.warn(`Not listed: ${doc} ${label}: it does not normalise the same with a managed block put in.`);
      continue;
    }
    record(rootDocHashes, doc, hashRootDocForm(parsed.form));
  }
}

writeHashes(outFile, [
  'Content hashes of every shipped version of every Codev skill, keyed by its',
  'project-relative directory (issue #1811). `codev update` replaces a skill whose',
  'hash is listed here: the user never edited it.',
  '',
  'GENERATED: do not edit by hand. After changing a shipped skill, regenerate with',
  '  pnpm --filter @cluesmith/codev generate-skill-hashes',
], 'SHIPPED_SKILL_HASHES', hashes);

writeHashes(rootDocOutFile, [
  'Hashes of every shipped version of the CLAUDE.md / AGENTS.md templates, keyed by doc',
  '(issue #1985), each in the form `rootDocHashForm` gives: LF line endings, the managed',
  'block emptied, the project name on the heading put back to the placeholder.',
  '`codev update` replaces a doc whose hash is listed here: the user never edited it.',
  '',
  'GENERATED: do not edit by hand. After changing a root-doc template, regenerate with',
  '  pnpm --filter @cluesmith/codev generate-skill-hashes',
], 'SHIPPED_ROOT_DOC_HASHES', rootDocHashes);
