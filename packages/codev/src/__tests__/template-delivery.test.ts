/**
 * Issue #1279 — every protocol template must have an owning consumer.
 *
 * Spec 1011 introduced `{{> <codev-path>}}` includes (`resolveCodevIncludes`) as
 * the resolver-aware way to *deliver* a framework file to a builder. It was wired
 * for three of the nine shipped templates and never generalized, so six templates
 * rotted unreferenced: builders never saw them, reviewers never checked against
 * them, and two hand-rolled inline copies had already drifted from the templates
 * they duplicated.
 *
 * The invariant this file enforces: a file under `protocols/<p>/templates/` is
 * dead code unless some prompt or `protocol.md` delivers it via a `{{> }}`
 * include. Both directions are checked — no orphaned template, and no dangling
 * include — across BOTH trees (`codev-skeleton/` ships to adopters, `codev/` is
 * this repo's own instance; the mirror convention requires parity).
 *
 * The last describe block is a mutation check: it seeds an unreachable template
 * into a copy of the real tree and proves the detector FAILS on it. An
 * enforcement test that cannot fail is decoration.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative, sep } from 'node:path';
import {
  cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveCodevIncludes } from '../lib/skeleton.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/__tests__ → repo root is four levels up.
const REPO_ROOT = resolve(__dirname, '../../../..');

/** Trees that carry a `protocols/` directory. Both must satisfy the invariant. */
const TREES = ['codev-skeleton', 'codev'] as const;

const INCLUDE_RE = /\{\{>\s*([^}\s]+)\s*\}\}/g;

/** Every `.md` under the tree, as tree-relative POSIX paths (e.g. `protocols/spir/prompts/plan.md`). */
function listMarkdown(treeRoot: string, subdir: string): string[] {
  const start = join(treeRoot, subdir);
  if (!existsSync(start)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) out.push(relative(treeRoot, full).split(sep).join('/'));
    }
  };
  walk(start);
  return out.sort();
}

/** Include targets (`{{> path}}`) appearing anywhere in the tree's protocol docs. */
function collectIncludeTargets(treeRoot: string): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  for (const rel of listMarkdown(treeRoot, 'protocols')) {
    const content = readFileSync(join(treeRoot, rel), 'utf-8');
    for (const m of content.matchAll(INCLUDE_RE)) {
      const target = m[1];
      const sources = targets.get(target) ?? [];
      sources.push(rel);
      targets.set(target, sources);
    }
  }
  return targets;
}

/** Template files (`protocols/<p>/templates/*.md`) present in the tree. */
function listTemplates(treeRoot: string): string[] {
  return listMarkdown(treeRoot, 'protocols').filter(p => /^protocols\/[^/]+\/templates\//.test(p));
}

/**
 * The invariant, as a pure predicate so the mutation check can run it against a
 * seeded fixture. Returns templates that no `{{> }}` include delivers.
 */
export function findOrphanedTemplates(treeRoot: string, exempt: readonly string[] = []): string[] {
  const delivered = new Set(collectIncludeTargets(treeRoot).keys());
  return listTemplates(treeRoot).filter(t => !delivered.has(t) && !exempt.includes(t));
}

/**
 * Two local-only maintain templates in `codev/` have no skeleton counterpart and
 * no consumer. They are exempt here rather than deleted: the Spec 1252
 * shadow-tree audit records an explicit architect ruling (T8) preserving them,
 * and reversing that ruling is not this fix's call. Flagged as follow-up.
 */
const CODEV_LOCAL_ONLY_EXEMPT = [
  'protocols/maintain/templates/audit-report.md',
  'protocols/maintain/templates/lessons-learned.md',
] as const;

function exemptFor(tree: string): readonly string[] {
  return tree === 'codev' ? CODEV_LOCAL_ONLY_EXEMPT : [];
}

describe('#1279 — every protocol template has an owning consumer', () => {
  it.each(TREES)('%s: no template is orphaned', (tree) => {
    const orphans = findOrphanedTemplates(join(REPO_ROOT, tree), exemptFor(tree));
    expect(
      orphans,
      `Orphaned template(s) in ${tree}/ — no prompt or protocol.md delivers them via a `
      + `{{> path}} include, so builders never see them. Either wire them up or delete them:\n`
      + orphans.map(o => `  - ${o}`).join('\n'),
    ).toEqual([]);
  });

  it.each(TREES)('%s: no include points at a template that does not exist', (tree) => {
    const treeRoot = join(REPO_ROOT, tree);
    const dangling: string[] = [];
    for (const [target, sources] of collectIncludeTargets(treeRoot)) {
      // Includes resolve through the four-tier chain, so a target that is absent
      // from THIS tree may still resolve from the skeleton. Only a target missing
      // from both trees is genuinely dangling.
      const found = TREES.some(t => existsSync(join(REPO_ROOT, t, target)));
      if (!found) dangling.push(`${target} (included by ${sources.join(', ')})`);
    }
    expect(dangling, `Dangling include target(s) in ${tree}/ — these collapse to '' at delivery`).toEqual([]);
  });

  it('the two trees ship the same set of templates (mirror parity, minus known local-only files)', () => {
    const skeleton = listTemplates(join(REPO_ROOT, 'codev-skeleton'));
    const local = listTemplates(join(REPO_ROOT, 'codev'))
      .filter(t => !CODEV_LOCAL_ONLY_EXEMPT.includes(t as typeof CODEV_LOCAL_ONLY_EXEMPT[number]));
    expect(local).toEqual(skeleton);
  });
});

describe('#1279 — the specific wirings this fix added', () => {
  // Named explicitly so a future edit that drops one fails loudly here, with the
  // reason, rather than only tripping the generic orphan check.
  const WIRINGS: Array<[string, string]> = [
    ['protocols/spir/prompts/specify.md', 'protocols/spir/templates/spec.md'],
    ['protocols/aspir/prompts/specify.md', 'protocols/spir/templates/spec.md'],
    ['protocols/spir/prompts/review.md', 'protocols/spir/templates/review.md'],
    ['protocols/aspir/prompts/review.md', 'protocols/spir/templates/review.md'],
    ['protocols/maintain/protocol.md', 'protocols/maintain/templates/maintenance-run.md'],
    // Pre-existing (Spec 1011) — guarded here too so the set stays complete.
    ['protocols/spir/prompts/plan.md', 'protocols/spir/templates/plan.md'],
    ['protocols/aspir/prompts/plan.md', 'protocols/spir/templates/plan.md'],
    ['protocols/experiment/protocol.md', 'protocols/experiment/templates/notes.md'],
    ['protocols/spike/protocol.md', 'protocols/spike/templates/findings.md'],
  ];

  it.each(TREES)('%s: each consumer delivers its template via an include', (tree) => {
    for (const [consumer, template] of WIRINGS) {
      const content = readFileSync(join(REPO_ROOT, tree, consumer), 'utf-8');
      expect(content, `${tree}/${consumer} must deliver ${template}`).toContain(`{{> ${template}}}`);
    }
  });

  it('ASPIR ships no templates/ directory — it includes SPIR\'s, so there is one copy to drift', () => {
    for (const tree of TREES) {
      expect(existsSync(join(REPO_ROOT, tree, 'protocols/aspir/templates'))).toBe(false);
    }
  });

  it('the specify prompt, once its includes resolve, actually carries the spec template', () => {
    // Mirrors porch's loadPromptFile delivery path. Without this the builder sees
    // prose only and pattern-matches whatever spec happens to be in codev/specs/.
    for (const proto of ['spir', 'aspir']) {
      const prompt = readFileSync(
        join(REPO_ROOT, 'codev-skeleton', `protocols/${proto}/prompts/specify.md`), 'utf-8');
      const resolved = resolveCodevIncludes(prompt, REPO_ROOT);
      expect(resolved).not.toContain('{{>');            // include expanded
      expect(resolved).toContain('## Problem Statement'); // template content arrived
      expect(resolved).toContain('## Solution Approaches');
      expect(resolved).toContain('SPEC vs PLAN BOUNDARY');
    }
  });

  it('the review prompt, once its includes resolve, carries the porch-checked headings', () => {
    for (const proto of ['spir', 'aspir']) {
      const prompt = readFileSync(
        join(REPO_ROOT, 'codev-skeleton', `protocols/${proto}/prompts/review.md`), 'utf-8');
      const resolved = resolveCodevIncludes(prompt, REPO_ROOT);
      expect(resolved).not.toContain('{{>');
      // porch's review_has_arch_updates / review_has_lessons_updates grep for these.
      expect(resolved).toContain('## Architecture Updates');
      expect(resolved).toContain('## Lessons Learned Updates');
      // Content that lived only in the old inline copy must survive the swap.
      expect(resolved).toContain('## Flaky Tests');
      expect(resolved).toContain('### Methodology Improvements');
    }
  });

  it('the maintain protocol, once its includes resolve, carries the run-file structure', () => {
    const md = readFileSync(join(REPO_ROOT, 'codev-skeleton', 'protocols/maintain/protocol.md'), 'utf-8');
    const resolved = resolveCodevIncludes(md, REPO_ROOT);
    expect(resolved).not.toContain('{{>');
    expect(resolved).toContain('# Maintenance Run NNNN');
    // Content that lived only in the old inline copy must survive the swap.
    expect(resolved).toContain('## Audit Findings');
    // Content that lived only in the template must now reach the builder.
    expect(resolved).toContain('### Dependencies Cleaned');
  });
});

/**
 * Mutation check (architect requirement, learned from Spec 1252 T12).
 *
 * The orphan detector above passes on the real tree. That is only meaningful if
 * it would FAIL on a tree that violates the invariant — so seed a violation into
 * a copy of the real tree and assert it is caught.
 */
describe('#1279 — the orphan detector actually fails on a violation', () => {
  const withTreeCopy = (fn: (treeRoot: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'template-delivery-mutation-'));
    try {
      cpSync(join(REPO_ROOT, 'codev-skeleton', 'protocols'), join(dir, 'protocols'), { recursive: true });
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('control: the unmutated copy is clean', () => {
    withTreeCopy(treeRoot => {
      expect(findOrphanedTemplates(treeRoot)).toEqual([]);
    });
  });

  it('MUTATION: an unreferenced template is reported as orphaned', () => {
    withTreeCopy(treeRoot => {
      writeFileSync(join(treeRoot, 'protocols/spir/templates/orphan.md'), '# Nobody includes me\n');
      expect(findOrphanedTemplates(treeRoot)).toEqual(['protocols/spir/templates/orphan.md']);
    });
  });

  it('MUTATION: re-creating the deleted aspir template duplicates is reported as orphaned', () => {
    // The exact regression this issue fixed — a per-protocol copy with no consumer.
    withTreeCopy(treeRoot => {
      mkdirSync(join(treeRoot, 'protocols/aspir/templates'), { recursive: true });
      for (const t of ['spec', 'plan', 'review']) {
        cpSync(join(treeRoot, `protocols/spir/templates/${t}.md`),
               join(treeRoot, `protocols/aspir/templates/${t}.md`));
      }
      expect(findOrphanedTemplates(treeRoot)).toEqual([
        'protocols/aspir/templates/plan.md',
        'protocols/aspir/templates/review.md',
        'protocols/aspir/templates/spec.md',
      ]);
    });
  });

  it('MUTATION: unwiring the spec template (the reported bug) is reported as orphaned', () => {
    withTreeCopy(treeRoot => {
      const p = join(treeRoot, 'protocols/spir/prompts/specify.md');
      const stripped = readFileSync(p, 'utf-8')
        .replace('{{> protocols/spir/templates/spec.md}}', '');
      writeFileSync(p, stripped);
      // aspir/prompts/specify.md still includes it, so unwire that one too —
      // this reproduces the pre-fix state exactly.
      const a = join(treeRoot, 'protocols/aspir/prompts/specify.md');
      writeFileSync(a, readFileSync(a, 'utf-8').replace('{{> protocols/spir/templates/spec.md}}', ''));
      expect(findOrphanedTemplates(treeRoot)).toEqual(['protocols/spir/templates/spec.md']);
    });
  });
});
