/**
 * Regenerate src/lib/shipped-skill-hashes.ts: the content hash of every version of every
 * shipped skill, read from git history plus the working tree (issue #1811).
 *
 * Run from anywhere in the repository after changing a shipped skill:
 *   pnpm --filter @cluesmith/codev generate-skill-hashes
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hashSkillFiles, readSkillFiles, type SkillFile } from '../src/lib/skill-refresh.js';
import { SKILL_PROVIDERS } from '../src/lib/scaffold.js';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
const outFile = path.join(repoRoot, 'packages/codev/src/lib/shipped-skill-hashes.ts');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
}

const hashes = new Map<string, Set<string>>();
function record(key: string, hash: string): void {
  if (!hashes.has(key)) hashes.set(key, new Set());
  hashes.get(key)!.add(hash);
}

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
    for (const [skill, files] of bySkill) record(`.${provider}/skills/${skill}`, hashSkillFiles(files));
  }

  // The working tree, so a skill edited in this change is already in the history.
  const workDir = path.join(repoRoot, root);
  for (const entry of fs.readdirSync(workDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = readSkillFiles(path.join(workDir, entry.name));
    if (files) record(`.${provider}/skills/${entry.name}`, hashSkillFiles(files));
  }
}

const lines = [
  '/**',
  ' * Content hashes of every shipped version of every Codev skill, keyed by its',
  ' * project-relative directory (issue #1811). `codev update` replaces a skill whose',
  ' * hash is listed here: the user never edited it.',
  ' *',
  ' * GENERATED: do not edit by hand. After changing a shipped skill, regenerate with',
  ' *   pnpm --filter @cluesmith/codev generate-skill-hashes',
  ' */',
  'export const SHIPPED_SKILL_HASHES: Record<string, readonly string[]> = {',
];
for (const key of [...hashes.keys()].sort()) {
  lines.push(`  '${key}': [`);
  for (const hash of [...hashes.get(key)!].sort()) lines.push(`    '${hash}',`);
  lines.push('  ],');
}
lines.push('};', '');
fs.writeFileSync(outFile, lines.join('\n'));
console.log(`Wrote ${path.relative(repoRoot, outFile)}: ${hashes.size} skills, ${[...hashes.values()].reduce((n, s) => n + s.size, 0)} versions.`);
