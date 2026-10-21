/**
 * Issue #1840 — `afx decisions init` creates the decisions file from its template, at
 * the path the tab reads, and refuses anything that would overwrite rulings or leave
 * the workspace.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDecisionsFile, decisionsInit, ARCHITECT_INSTRUCTION } from '../commands/decisions.js';
import { DEFAULT_DECISIONS_FILE, decisionsFilePresent } from '../servers/decisions/file.js';
import { DECISIONS_FILE_TEMPLATE } from '../servers/decisions/template.js';
import { parseDecisions } from '../servers/decisions/parse.js';

let tmpDir: string;
let origHome: string | undefined;
let workspace: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-init-')));
  origHome = process.env.HOME;
  process.env.HOME = path.join(tmpDir, 'home');
  workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(workspace, 'codev'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = origHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(config: unknown): void {
  fs.mkdirSync(path.join(workspace, '.codev'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.codev', 'config.json'), JSON.stringify(config));
}

const read = (rel: string) => fs.readFileSync(path.join(workspace, rel), 'utf8');

describe('afx decisions init', () => {
  it('creates codev/state/ and the default file from the template, and the tab then shows', async () => {
    expect(fs.existsSync(path.join(workspace, 'codev', 'state'))).toBe(false);
    const result = await createDecisionsFile({ workspaceRoot: workspace });
    expect(result).toEqual({ displayPath: DEFAULT_DECISIONS_FILE, configuredPath: DEFAULT_DECISIONS_FILE });
    expect(read(DEFAULT_DECISIONS_FILE)).toBe(DECISIONS_FILE_TEMPLATE);
    expect(parseDecisions(DECISIONS_FILE_TEMPLATE).problems).toEqual([]);
    expect(await decisionsFilePresent(workspace, vi.fn())).toBe(true);
  });

  it('refuses an existing file and leaves its rulings as they are', async () => {
    const file = path.join(workspace, DEFAULT_DECISIONS_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'the owner rulings\n');
    await expect(createDecisionsFile({ workspaceRoot: workspace })).rejects.toThrow(
      `${DEFAULT_DECISIONS_FILE} already exists; init never replaces it`,
    );
    expect(read(DEFAULT_DECISIONS_FILE)).toBe('the owner rulings\n');
  });

  it('writes where dashboard.decisionsFile points', async () => {
    writeConfig({ dashboard: { decisionsFile: 'docs/decisions.md' } });
    const result = await createDecisionsFile({ workspaceRoot: workspace });
    expect(result).toEqual({ displayPath: 'docs/decisions.md', configuredPath: 'docs/decisions.md' });
    expect(read('docs/decisions.md')).toBe(DECISIONS_FILE_TEMPLATE);
  });

  it('--path wins over dashboard.decisionsFile, resolved against the workspace root', async () => {
    writeConfig({ dashboard: { decisionsFile: 'docs/decisions.md' } });
    const result = await createDecisionsFile({ workspaceRoot: workspace, path: './notes/../owner.md' });
    expect(result).toEqual({ displayPath: 'owner.md', configuredPath: 'docs/decisions.md' });
    expect(read('owner.md')).toBe(DECISIONS_FILE_TEMPLATE);
    expect(fs.existsSync(path.join(workspace, 'docs'))).toBe(false);
  });

  it('refuses a path outside the workspace, through .. or through a symlink, and writes nothing', async () => {
    await expect(createDecisionsFile({ workspaceRoot: workspace, path: '../outside.md' })).rejects.toThrow(
      '../outside.md resolves outside the workspace',
    );
    fs.mkdirSync(path.join(tmpDir, 'elsewhere'));
    fs.symlinkSync(path.join(tmpDir, 'elsewhere'), path.join(workspace, 'codev', 'state'));
    await expect(createDecisionsFile({ workspaceRoot: workspace })).rejects.toThrow('resolves outside the workspace');
    writeConfig({ dashboard: { decisionsFile: '../configured.md' } });
    await expect(createDecisionsFile({ workspaceRoot: workspace })).rejects.toThrow('resolves outside the workspace');
    // The config the tab refuses is refused here even when --path names a good file.
    await expect(createDecisionsFile({ workspaceRoot: workspace, path: 'owner.md' })).rejects.toThrow(
      'dashboard.decisionsFile (../configured.md) resolves outside the workspace',
    );
    expect(fs.existsSync(path.join(workspace, 'owner.md'))).toBe(false);
    expect(fs.readdirSync(tmpDir).sort()).toEqual(['elsewhere', 'workspace']);
    expect(fs.readdirSync(path.join(tmpDir, 'elsewhere'))).toEqual([]);
  });

  it('refuses an absolute or empty --path, and a broken dashboard.decisionsFile', async () => {
    const absolute = path.join(workspace, 'owner.md');
    await expect(createDecisionsFile({ workspaceRoot: workspace, path: absolute })).rejects.toThrow(
      '--path must be relative to the workspace root',
    );
    await expect(createDecisionsFile({ workspaceRoot: workspace, path: ' ' })).rejects.toThrow('--path must be relative');
    writeConfig({ dashboard: { decisionsFile: absolute } });
    await expect(createDecisionsFile({ workspaceRoot: workspace })).rejects.toThrow(
      'dashboard.decisionsFile must be relative to the workspace root',
    );
    expect(fs.existsSync(absolute)).toBe(false);
  });

  it('prints the path, that the tab appears, and the sentence for the architect', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await decisionsInit({ workspaceRoot: workspace });
    const printed = log.mock.calls.map(call => call.join(' ')).join('\n');
    expect(printed).toContain(`Created ${DEFAULT_DECISIONS_FILE}`);
    expect(printed).toContain('The Decisions tab appears in the dashboard within a few seconds.');
    expect(printed).toContain(`Tell your main architect: "${ARCHITECT_INSTRUCTION}"`);
    expect(ARCHITECT_INSTRUCTION).toBe('Route every ask for my word through the decisions file.');
  });

  it('a --path the tab does not read says which setting shows it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await decisionsInit({ workspaceRoot: workspace, path: 'owner.md' });
    const printed = log.mock.calls.map(call => call.join(' ')).join('\n');
    expect(printed).toContain('Created owner.md');
    expect(printed).toContain(
      `The Decisions tab reads ${DEFAULT_DECISIONS_FILE}. Set {"dashboard":{"decisionsFile":"owner.md"}} in .codev/config.json`,
    );
    expect(printed).not.toContain('appears in the dashboard within a few seconds');
  });
});
