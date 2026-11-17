/**
 * Regression test for GitHub Issue #1902 (C2) — BUGFIX/AIR PR-phase consultation.
 *
 * The BUGFIX and AIR PR prompts used to hardcode `consult -m gemini|codex|claude` lines while
 * protocol.json declared a different set, and `.codev/config.json` `porch.consultation` was
 * never consulted for them: a project narrowed to codex+claude still got a gemini line.
 *
 * Now the PR phase carries `consultation: {type, models}`; porch resolves the lanes through
 * the same resolver as a build_verify verify step and renders them into
 * `{{consult_commands}}` / `{{consult_verdicts}}`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPhasePrompt, renderConsultation } from '../prompts.js';
import { loadProtocol } from '../protocol.js';
import type { ProjectState } from '../types.js';

// No real `gh issue view` round-trip from getProjectSummary.
vi.mock('../../../lib/github.js', () => ({
  fetchIssue: vi.fn().mockResolvedValue(null),
}));

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const THREE = ['gemini', 'codex', 'claude'];

function stateFor(protocol: string, id: string): ProjectState {
  return {
    id,
    title: 'pr-consultation',
    protocol,
    phase: 'pr',
    plan_phases: [],
    current_plan_phase: null,
    gates: {},
    iteration: 1,
    build_complete: false,
    history: [],
    started_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  } as unknown as ProjectState;
}

describe('#1902 — PR-phase consultation honours porch.consultation', () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-consultation-1902-'));
    origHome = process.env.HOME;
    process.env.HOME = path.join(tmp, 'fake-home'); // no user-global config leaks in
    // The shipped protocols, as a project that customised nothing sees them.
    for (const proto of ['bugfix', 'air']) {
      fs.cpSync(
        path.join(repoRoot, 'codev-skeleton', 'protocols', proto),
        path.join(tmp, 'codev', 'protocols', proto),
        { recursive: true },
      );
    }
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeConsultation(consultation: Record<string, unknown>): void {
    fs.mkdirSync(path.join(tmp, '.codev'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.codev', 'config.json'), JSON.stringify({ porch: { consultation } }));
  }

  describe('protocol.json', () => {
    it.each(['bugfix', 'air'])('%s PR phase declares three pr-type reviewers', (proto) => {
      const protocol = loadProtocol(tmp, proto);
      const pr = protocol.phases.find((p) => p.id === 'pr');
      expect(pr?.consultation).toEqual({ type: 'pr', models: THREE });
    });
  });

  describe('renderConsultation', () => {
    const consultation = { type: 'pr', models: THREE };

    it('defaults to all three reviewers', () => {
      const { commands, verdicts } = renderConsultation(tmp, 'bugfix', consultation);
      expect(commands.split('\n')).toEqual([
        'consult -m gemini --protocol bugfix --type pr',
        'consult -m codex --protocol bugfix --type pr',
        'consult -m claude --protocol bugfix --type pr',
      ]);
      expect(verdicts).toBe(
        'gemini=<APPROVE|REQUEST_CHANGES>, codex=<APPROVE|REQUEST_CHANGES>, claude=<APPROVE|REQUEST_CHANGES>',
      );
    });

    it('a project narrowed to codex+claude gets exactly those lanes', () => {
      writeConsultation({ models: ['codex', 'claude'] });
      const { commands, verdicts } = renderConsultation(tmp, 'bugfix', consultation);
      expect(commands.split('\n')).toEqual([
        'consult -m codex --protocol bugfix --type pr',
        'consult -m claude --protocol bugfix --type pr',
      ]);
      expect(commands).not.toContain('gemini');
      expect(verdicts).toBe('codex=<APPROVE|REQUEST_CHANGES>, claude=<APPROVE|REQUEST_CHANGES>');
    });

    it('a per-protocol override applies to that protocol only', () => {
      writeConsultation({ byProtocol: { air: { models: ['claude'] } } });
      expect(renderConsultation(tmp, 'air', consultation).commands).toBe('consult -m claude --protocol air --type pr');
      expect(renderConsultation(tmp, 'bugfix', consultation).commands.split('\n')).toHaveLength(3);
    });

    it('"none" renders no consult command', () => {
      writeConsultation({ models: 'none' });
      const { commands, verdicts } = renderConsultation(tmp, 'bugfix', consultation);
      expect(commands).not.toMatch(/^consult /m);
      expect(commands).toContain('"none"');
      expect(verdicts).toContain('none');
    });

    it('"parent" renders no consult command and names the architect', () => {
      writeConsultation({ models: 'parent' });
      const { commands, verdicts } = renderConsultation(tmp, 'bugfix', consultation);
      expect(commands).not.toMatch(/^consult /m);
      expect(verdicts).toContain('architect');
    });
  });

  describe('the rendered PR prompt', () => {
    it.each(['bugfix', 'air'])('%s: carries the configured lanes and no unrendered token', async (proto) => {
      writeConsultation({ models: ['codex', 'claude'] });
      const protocol = loadProtocol(tmp, proto);
      const prompt = await buildPhasePrompt(tmp, stateFor(proto, `${proto}-1902`), protocol);

      expect(prompt).toContain(`consult -m codex --protocol ${proto} --type pr`);
      expect(prompt).toContain(`consult -m claude --protocol ${proto} --type pr`);
      expect(prompt).not.toMatch(/consult -m gemini/);
      expect(prompt).not.toContain('{{consult_commands}}');
      expect(prompt).not.toContain('{{consult_verdicts}}');
    });

    it('bugfix: the builder runs porch approve with the human-approval flag', async () => {
      const protocol = loadProtocol(tmp, 'bugfix');
      const prompt = await buildPhasePrompt(tmp, stateFor('bugfix', 'bugfix-1902'), protocol);
      expect(prompt).toContain('porch approve bugfix-1902 pr --a-human-explicitly-approved-this');
      expect(prompt).toContain('CMAP: gemini=<APPROVE|REQUEST_CHANGES>, codex=<APPROVE|REQUEST_CHANGES>, claude=<APPROVE|REQUEST_CHANGES>');
    });
  });

  it('a prompt using a consult token in a phase with no consultation block fails fast', async () => {
    // A local protocol.json older than its prompt: the token would otherwise reach the builder raw.
    const file = path.join(tmp, 'codev', 'protocols', 'bugfix', 'protocol.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
    delete json.phases.find((p: { id: string }) => p.id === 'pr').consultation;
    fs.writeFileSync(file, JSON.stringify(json));
    const protocol = loadProtocol(tmp, 'bugfix');
    await expect(buildPhasePrompt(tmp, stateFor('bugfix', 'bugfix-1902'), protocol)).rejects.toThrow(
      /phase "pr": the prompt uses \{\{consult_commands\}\} but the phase declares no "consultation" block/,
    );
  });

  it.each(['enabled', 'parallel'])('consultation "%s": false is an error, not silently ignored', (key) => {
    const file = path.join(tmp, 'codev', 'protocols', 'bugfix', 'protocol.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
    json.phases.find((p: { id: string }) => p.id === 'pr').consultation = { type: 'pr', models: THREE, [key]: false };
    fs.writeFileSync(file, JSON.stringify(json));
    expect(() => loadProtocol(tmp, 'bugfix')).toThrow(new RegExp(`consultation "${key}": false is not supported`));
  });

  it('a legacy enabled/parallel: true is a tolerated no-op', () => {
    const file = path.join(tmp, 'codev', 'protocols', 'bugfix', 'protocol.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
    json.phases.find((p: { id: string }) => p.id === 'pr').consultation = { type: 'pr', models: THREE, enabled: true, parallel: true };
    fs.writeFileSync(file, JSON.stringify(json));
    const phase = loadProtocol(tmp, 'bugfix').phases.find((p) => p.id === 'pr');
    expect(phase?.consultation).toEqual({ type: 'pr', models: THREE });
  });

  it('a malformed consultation block is an error, not a silent skip', () => {
    const file = path.join(tmp, 'codev', 'protocols', 'bugfix', 'protocol.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
    json.phases.find((p: { id: string }) => p.id === 'pr').consultation = { models: THREE };
    fs.writeFileSync(file, JSON.stringify(json));
    expect(() => loadProtocol(tmp, 'bugfix')).toThrow(/consultation needs a string "type"/);
  });
});
