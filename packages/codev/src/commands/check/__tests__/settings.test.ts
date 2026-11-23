/**
 * Spec 1951 — `check.*` configuration: defaults, validation, and the file named on error.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckCommandError } from '../report.js';
import { DEFAULT_NOT_FOR_READING, DEFAULT_WATCH, loadCheckSettings, parseCheckSettings } from '../settings.js';
import { useFakeHome } from './helpers/fake-home.js';

let root: string;
let projectFile: string;
let localFile: string;

function writeProject(check: unknown): void {
  fs.writeFileSync(projectFile, JSON.stringify({ check }));
}

/** Never read the developer's own ~/.codev/config.json. */
const home = useFakeHome();

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codev-check-settings-')));
  fs.mkdirSync(path.join(root, '.codev'));
  projectFile = path.join(root, '.codev', 'config.json');
  localFile = path.join(root, '.codev', 'config.local.json');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function loadError(): CheckCommandError {
  try {
    loadCheckSettings(root);
  } catch (err) {
    expect(err).toBeInstanceOf(CheckCommandError);
    return err as CheckCommandError;
  }
  throw new Error('expected loadCheckSettings to fail');
}

describe('Spec 1951 — check settings', () => {
  it('applies the defaults when nothing is configured', () => {
    fs.writeFileSync(projectFile, '{}');
    const settings = loadCheckSettings(root);
    expect(settings.attribution).toEqual([]);
    expect(settings.watch).toEqual(DEFAULT_WATCH);
    expect(settings.flag).toEqual([]);
    expect(settings.notForReading).toEqual(DEFAULT_NOT_FOR_READING);
    expect(settings.deploy).toEqual({ branch: null, workflow: null });
    expect([...settings.skip]).toEqual([]);
  });

  it('reads every key', () => {
    writeProject({
      attribution: ['co-authored-by: claude'],
      watch: ['CLAUDE.md'],
      flag: ['CLAUDE.md'],
      notForReading: ['docs/**'],
      deploy: { branch: 'production', workflow: 'deploy.yml' },
      skip: ['size', 'overlap'],
    });
    const settings = loadCheckSettings(root);
    expect(settings.attribution.map((p) => p.source)).toEqual(['co-authored-by: claude']);
    expect(settings.attribution[0].regex.test('Co-Authored-By: Claude Opus')).toBe(true);
    expect(settings.watch).toEqual(['CLAUDE.md']);
    expect(settings.flag).toEqual(['CLAUDE.md']);
    expect(settings.deploy).toEqual({ branch: 'production', workflow: 'deploy.yml' });
    expect([...settings.skip]).toEqual(['size', 'overlap']);
  });

  it('reads ~/.codev/config.json as a layer, and names it on error', () => {
    const homeFile = path.join(home.dir(), '.codev', 'config.json');
    fs.mkdirSync(path.dirname(homeFile), { recursive: true });
    fs.writeFileSync(homeFile, JSON.stringify({ check: { attribution: ['co-authored-by'] } }));
    fs.writeFileSync(projectFile, '{}');
    expect(loadCheckSettings(root).attribution.map((p) => p.source)).toEqual(['co-authored-by']);
    fs.writeFileSync(homeFile, JSON.stringify({ check: { skip: ['colour'] } }));
    expect(loadError().message).toBe(`check.skip names an unknown check id "colour" (in ${homeFile})`);
  });

  it('replaces the notForReading default rather than adding to it', () => {
    writeProject({ notForReading: ['docs/**'] });
    expect(loadCheckSettings(root).notForReading).toEqual(['docs/**']);
  });

  it('lets config.local.json replace an array set by config.json', () => {
    writeProject({ watch: ['a/**', 'b/**'] });
    fs.writeFileSync(localFile, JSON.stringify({ check: { watch: ['c/**'] } }));
    expect(loadCheckSettings(root).watch).toEqual(['c/**']);
  });

  it('refuses a non-array check.watch, naming the key and the file', () => {
    writeProject({ watch: 'CLAUDE.md' });
    expect(loadError().message).toBe(`check.watch must be an array of glob strings (in ${projectFile})`);
  });

  it('names config.local.json when that is the file that set the bad value', () => {
    writeProject({ watch: ['ok/**'] });
    fs.writeFileSync(localFile, JSON.stringify({ check: { watch: [''] } }));
    expect(loadError().message).toContain(`(in ${localFile})`);
  });

  it('refuses an unparseable attribution regex, naming the key and the file', () => {
    writeProject({ attribution: ['co-authored-by: (claude'] });
    const message = loadError().message;
    expect(message).toContain('check.attribution pattern "co-authored-by: (claude" is not a valid regex');
    expect(message).toContain(`(in ${projectFile})`);
  });

  it('names what each array must hold', () => {
    writeProject({ attribution: 'claude' });
    expect(loadError().message).toBe(`check.attribution must be an array of regex strings (in ${projectFile})`);
    writeProject({ skip: [3] });
    expect(loadError().message).toBe(`check.skip must contain only non-empty check ids (got 3) (in ${projectFile})`);
  });

  it('refuses a deploy branch with a component ending in .lock', () => {
    writeProject({ deploy: { branch: 'release.lock/x' } });
    expect(loadError().message).toContain('check.deploy.branch "release.lock/x" is not a valid branch name');
  });

  it('refuses an unknown check.skip id', () => {
    writeProject({ skip: ['size', 'colour'] });
    expect(loadError().message).toBe(`check.skip names an unknown check id "colour" (in ${projectFile})`);
  });

  it('refuses a deploy workflow that reads as an option, naming the value', () => {
    writeProject({ deploy: { workflow: '--repo=x' } });
    expect(loadError().message).toBe(`check.deploy.workflow "--repo=x" may not begin with '-' (in ${projectFile})`);
  });

  it('refuses a deploy branch that is not a valid branch name', () => {
    writeProject({ deploy: { branch: 'a..b' } });
    expect(loadError().message).toContain('check.deploy.branch "a..b" is not a valid branch name');
  });

  it('refuses an unknown key, so a typo is not silently ignored', () => {
    writeProject({ wacth: ['x'] });
    expect(loadError().message).toContain('check.wacth is not a known key');
    writeProject({ deploy: { workflows: 'x' } });
    expect(loadError().message).toContain('check.deploy.workflows is not a known key');
  });

  it('refuses a check section that is not an object', () => {
    expect(() => parseCheckSettings(['x'], () => null)).toThrow('check must be an object');
  });

  it('refuses a glob with a control character', () => {
    expect(() => parseCheckSettings({ flag: ['a\nb'] }, () => null)).toThrow(/check\.flag must contain only non-empty glob strings/);
  });
});
