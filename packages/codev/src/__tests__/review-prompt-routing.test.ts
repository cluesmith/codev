/**
 * Spec 987 — Phase 5: review-phase producer routing.
 *
 * Guards the dual-tree sweep: every live review prompt/template that drives the
 * "Update Architecture and Lessons Learned Documentation" step must use the hot/cold
 * ROUTING model (point at arch-critical.md / lessons-critical.md), keep the section
 * headers the porch review check greps for, and no longer instruct appending to the
 * cold archive — in BOTH the codev/ instance tree and the codev-skeleton/ tree.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

const ROUTING_FILES = [
  'protocols/spir/prompts/review.md',
  'protocols/aspir/prompts/review.md',
  'protocols/pir/prompts/review.md',
  'protocols/spir/templates/review.md',
  'protocols/aspir/templates/review.md',
];

const files: string[] = [];
for (const tree of ['codev', 'codev-skeleton']) {
  for (const f of ROUTING_FILES) files.push(`${tree}/${f}`);
}
files.push('codev-skeleton/porch/prompts/review.md'); // generic porch review prompt (skeleton-only)

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
}

describe('Spec 987 — review prompts/templates route hot vs cold (both trees)', () => {
  it.each(files)('%s routes to the hot files and keeps the porch-check section headers', (rel) => {
    const c = read(rel);
    expect(c, `${rel} should route to arch-critical.md`).toMatch(/arch-critical\.md/);
    expect(c, `${rel} should route to lessons-critical.md`).toMatch(/lessons-critical\.md/);
    // The porch review check greps the produced review file for these headers — keep referencing them.
    expect(c).toContain('## Architecture Updates');
    expect(c).toContain('## Lessons Learned Updates');
  });

  it.each(files)('%s no longer instructs appending to the cold archive', (rel) => {
    expect(read(rel)).not.toContain('add entries to lessons-learned.md');
  });
});
