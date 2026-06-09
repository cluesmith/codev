/**
 * Tests for issue #1011 — framework-file delivery via resolver-aware channels.
 *
 * Two concerns:
 *  1. The `auditFrameworkRefs` lib (Layer 3 regression guard) flags shell-fetch
 *     violations and ignores legitimate references.
 *  2. The skeleton sweep + template embeds (Layers 1/2 / Patch 2) actually
 *     landed: builder-prompts no longer point at protocol.md, the cat example
 *     and workflow-reference pointer are gone, the redundant plan-template
 *     pointers are dropped, and the embedded templates byte-match canonical.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { auditFrameworkRefs } from '../lib/framework-ref-audit.js';
import { resolveCodevIncludes } from '../lib/skeleton.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/__tests__ → repo root is four levels up.
const REPO_ROOT = resolve(__dirname, '../../../..');
const SKELETON = join(REPO_ROOT, 'codev-skeleton');

describe('auditFrameworkRefs (issue #1011 Layer 3)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fw-ref-audit-'));
    mkdirSync(join(dir, 'protocols', 'demo'), { recursive: true });
    mkdirSync(join(dir, 'roles'), { recursive: true });
    mkdirSync(join(dir, 'resources'), { recursive: true });
  });

  it('flags a shell cat of a framework file by literal path', () => {
    writeFileSync(join(dir, 'protocols', 'demo', 'protocol.md'),
      '# Demo\n\ncat codev/protocols/demo/protocol.md\n');
    const findings = auditFrameworkRefs(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toContain('protocol.md');
    expect(findings[0].line).toBe(3);
  });

  it('flags a shell cp of a framework template by literal path', () => {
    writeFileSync(join(dir, 'protocols', 'demo', 'protocol.md'),
      'cp codev/protocols/demo/templates/notes.md notes.md\n');
    expect(auditFrameworkRefs(dir)).toHaveLength(1);
  });

  it('does NOT flag documentation references or user-file paths', () => {
    writeFileSync(join(dir, 'protocols', 'demo', 'protocol.md'),
      [
        'See `codev/protocols/demo/protocol.md` for details.',          // backtick doc ref
        'Update `codev/resources/arch.md` after the change.',           // user file
        'git add codev/resources/lessons-learned.md',                   // user file write
        'Follow the DEMO protocol.',                                    // swept form
      ].join('\n') + '\n');
    expect(auditFrameworkRefs(dir)).toHaveLength(0);
  });

  it('does NOT scan codev/resources (mixed framework + user files)', () => {
    writeFileSync(join(dir, 'resources', 'guide.md'),
      'cat codev/resources/workflow-reference.md\n');
    expect(auditFrameworkRefs(dir)).toHaveLength(0);
  });

  it('the real swept skeleton is clean (no shell-fetch violations) — CI/source guard', () => {
    if (!existsSync(SKELETON)) return; // resilient if layout shifts
    expect(auditFrameworkRefs(SKELETON)).toEqual([]);
  });

  it('is a no-op for a codev root with no protocol/role overrides (the doctor case)', () => {
    // A typical end-user project resolves framework files from the package and
    // has no local codev/protocols or codev/roles; doctor scans that root and
    // should find nothing rather than error.
    const bare = mkdtempSync(join(tmpdir(), 'fw-ref-bare-'));
    mkdirSync(join(bare, 'specs'), { recursive: true }); // user dirs, no protocols/roles
    expect(auditFrameworkRefs(bare)).toEqual([]);
  });
});

describe('shipped protocol completeness (issue #1011)', () => {
  // The builder-prompts inline `{{protocol_reference}}` UNCONDITIONALLY (no {{#if}}
  // guard) — that is safe only because every shipped protocol ships a protocol.md
  // for it to resolve. This test enforces that invariant: a contributor adding a
  // protocol.json-only protocol (the shape bugfix had pre-#1013) fails CI here,
  // rather than shipping a builder prompt with an empty `## Protocol Reference`.
  it('every shipped skeleton protocol with a protocol.json also ships a protocol.md', () => {
    const protocolsDir = join(SKELETON, 'protocols');
    if (!existsSync(protocolsDir)) return; // resilient if layout shifts
    const missing = readdirSync(protocolsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => existsSync(join(protocolsDir, name, 'protocol.json')))
      .filter((name) => !existsSync(join(protocolsDir, name, 'protocol.md')));
    expect(missing).toEqual([]);
  });
});

describe('skeleton sweep + embeds (issue #1011 Layers 1/2, Patch 2)', () => {
  const protocols = ['air', 'aspir', 'bugfix', 'experiment', 'maintain', 'pir', 'research', 'spike', 'spir'];

  it('no builder-prompt.md references protocol.md by path', () => {
    for (const p of protocols) {
      const f = join(SKELETON, 'protocols', p, 'builder-prompt.md');
      if (!existsSync(f)) continue;
      expect(readFileSync(f, 'utf-8')).not.toMatch(/protocol\.md/);
    }
  });

  it('roles/builder.md no longer cats the protocol by path', () => {
    const f = join(SKELETON, 'roles', 'builder.md');
    expect(readFileSync(f, 'utf-8')).not.toMatch(/cat codev\/protocols\//);
  });

  it('spir/protocol.md no longer points at workflow-reference.md (A.3)', () => {
    const f = join(SKELETON, 'protocols', 'spir', 'protocol.md');
    expect(readFileSync(f, 'utf-8')).not.toMatch(/workflow-reference\.md/);
  });

  it('spir/aspir plan prompts deliver the canonical plan template via include (not a divergent inline copy)', () => {
    for (const p of ['spir', 'aspir']) {
      const md = readFileSync(join(SKELETON, 'protocols', p, 'prompts', 'plan.md'), 'utf-8');
      // Uses the fresh-at-delivery include of the real template (which carries the
      // machine-readable phases JSON porch requires), not a hand-rolled inline copy.
      expect(md).toContain('{{> protocols/spir/templates/plan.md}}');
      expect(md).not.toContain('### Plan Structure'); // the divergent JSON-less inline block is gone
      // No literal-path / shell-fetch reference to the template (the include is resolver-mediated).
      expect(md).not.toMatch(/codev\/protocols\/spir\/templates\/plan\.md/);
    }
  });

  it('the plan template (delivered via the include) carries the porch-required phases JSON', () => {
    const tmpl = readFileSync(join(SKELETON, 'protocols', 'spir', 'templates', 'plan.md'), 'utf-8');
    expect(tmpl).toMatch(/"phases"\s*:/);            // has_phases_json
    expect((tmpl.match(/"id"\s*:/g) || []).length).toBeGreaterThanOrEqual(2); // min_two_phases
  });

  it('the plan phase prompt, once its includes resolve (porch delivery), carries the phases JSON', () => {
    // Mirrors what porch's loadPromptFile now does: read the phase prompt and
    // resolve {{> ...}} includes. The resolved plan prompt must contain the JSON
    // the plan gate requires — otherwise the builder writes a plan that fails it.
    const planPrompt = readFileSync(join(SKELETON, 'protocols', 'spir', 'prompts', 'plan.md'), 'utf-8');
    const resolved = resolveCodevIncludes(planPrompt, REPO_ROOT);
    expect(resolved).not.toContain('{{> protocols/spir/templates/plan.md}}'); // include expanded
    expect(resolved).toMatch(/"phases"\s*:/);                                  // JSON now present
  });

  it('experiment/spike reference templates via fresh-at-delivery include, not a static embed', () => {
    const cases = [
      { protocol: 'experiment', tmpl: 'notes.md' },
      { protocol: 'spike', tmpl: 'findings.md' },
    ];
    for (const { protocol, tmpl } of cases) {
      const md = readFileSync(join(SKELETON, 'protocols', protocol, 'protocol.md'), 'utf-8');
      // Uses the include placeholder, so the canonical template stays single-source
      // and is read fresh at spawn — it cannot drift.
      expect(md).toContain(`{{> protocols/${protocol}/templates/${tmpl}}}`);
      // The static embed (BEGIN/END markers) is gone — that was the drift risk.
      expect(md).not.toContain('EMBEDDED TEMPLATE');
      // The canonical template still exists for the include to resolve against.
      expect(existsSync(join(SKELETON, 'protocols', protocol, 'templates', tmpl))).toBe(true);
    }
  });
});
