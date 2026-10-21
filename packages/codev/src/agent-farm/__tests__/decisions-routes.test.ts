/**
 * Spec 1819 — the decisions routes against real temporary workspaces: reading, the
 * configured path and its containment, serialized atomic writes, and the state flag.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type http from 'node:http';
import type { DecisionsDocument } from '@cluesmith/codev-types';
import { handleDecisionsGet, handleDecisionsRule, MAX_RULE_BODY_BYTES } from '../servers/decisions/routes.js';
import { CONFIGURED_PATH_MEMO_MS, decisionsFilePresent, DEFAULT_DECISIONS_FILE } from '../servers/decisions/file.js';
import { parseDecisions } from '../servers/decisions/parse.js';

const FIXTURE = fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures/decisions/issue-format.md'), 'utf8');
const ACCEPT_LINE = '**Your word:** `accept` = merge as is / `rework` = send back / `hold`';
const COMMENT = "accept but don't add the limit on additional tests. That could easily backfire.";

let tmpDir: string;
let origHome: string | undefined;
let workspace: string;
let decisionsFile: string;
let log: ReturnType<typeof vi.fn>;
let notify: ReturnType<typeof vi.fn>;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-routes-')));
  origHome = process.env.HOME;
  process.env.HOME = path.join(tmpDir, 'home');
  workspace = path.join(tmpDir, 'workspace');
  decisionsFile = path.join(workspace, DEFAULT_DECISIONS_FILE);
  fs.mkdirSync(path.dirname(decisionsFile), { recursive: true });
  log = vi.fn();
  notify = vi.fn(async () => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env.HOME = origHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(config: unknown, file = 'config.json'): void {
  fs.mkdirSync(path.join(workspace, '.codev'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.codev', file), typeof config === 'string' ? config : JSON.stringify(config));
}

function makeRes() {
  let status = 0;
  let body = '';
  const res = {
    writeHead: (code: number) => { status = code; },
    end: (data?: string) => { body += data ?? ''; },
  } as unknown as http.ServerResponse;
  return { res, status: () => status, json: () => JSON.parse(body) };
}

function makeReq(body: unknown): http.IncomingMessage {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return Object.assign(Readable.from([Buffer.from(raw)]), { method: 'POST', headers: {} }) as unknown as http.IncomingMessage;
}

async function get(ws = workspace) {
  const r = makeRes();
  await handleDecisionsGet(r.res, ws);
  return { status: r.status(), body: r.json() };
}

async function rule(body: unknown, ws = workspace) {
  const r = makeRes();
  await handleDecisionsRule(makeReq(body), r.res, ws, log, notify);
  return { status: r.status(), body: r.json() };
}

function fingerprintOf(text: string, id: string): string {
  const item = parseDecisions(text).items.find(i => i.id === id);
  if (!item) throw new Error(`no item ${id}`);
  return item.fingerprint;
}

/** The fixture with `ruling` inserted after main-11's Your-word line. */
function fixtureRuledWith(ruling: string): string {
  expect(FIXTURE.split(`${ACCEPT_LINE}\n`)).toHaveLength(2);
  return FIXTURE.replace(`${ACCEPT_LINE}\n`, `${ACCEPT_LINE}\n${ruling}`);
}

describe('GET decisions', () => {
  it('returns the parsed document for the default path', async () => {
    fs.writeFileSync(decisionsFile, FIXTURE);
    const { status, body } = await get();
    expect(status).toBe(200);
    const document = body.document as DecisionsDocument;
    expect(body.ok).toBe(true);
    expect(document.path).toBe('codev/state/pending-decisions.md');
    expect(document.items.map(i => i.id)).toEqual(['onboarding-3', 'main-11']);
    expect(document.version).toBe(parseDecisions(FIXTURE).version);
  });

  it('is not-found when the file is absent', async () => {
    const { status, body } = await get();
    expect(status).toBe(404);
    expect(body).toEqual({ ok: false, code: 'not-found', message: expect.stringContaining(DEFAULT_DECISIONS_FILE) });
  });

  it('refuses a configured path outside the workspace', async () => {
    fs.writeFileSync(path.join(tmpDir, 'outside.md'), FIXTURE);
    writeConfig({ dashboard: { decisionsFile: '../outside.md' } });
    const { status, body } = await get();
    expect(status).toBe(400);
    expect(body.code).toBe('outside-workspace');
  });

  it('refuses a symlinked file whose target is outside the workspace', async () => {
    fs.writeFileSync(path.join(tmpDir, 'outside.md'), FIXTURE);
    fs.symlinkSync(path.join(tmpDir, 'outside.md'), decisionsFile);
    const { status, body } = await get();
    expect(status).toBe(400);
    expect(body.code).toBe('outside-workspace');
  });

  it('refuses a path that passes through a symlinked directory outside the workspace', async () => {
    fs.mkdirSync(path.join(tmpDir, 'elsewhere'));
    fs.writeFileSync(path.join(tmpDir, 'elsewhere', 'pending-decisions.md'), FIXTURE);
    fs.rmSync(path.dirname(decisionsFile), { recursive: true });
    fs.symlinkSync(path.join(tmpDir, 'elsewhere'), path.dirname(decisionsFile));
    const { status, body } = await get();
    expect(status).toBe(400);
    expect(body.code).toBe('outside-workspace');
  });

  it('refuses an outside path even when nothing exists there', async () => {
    writeConfig({ dashboard: { decisionsFile: '../missing/dir/decisions.md' } });
    const { status, body } = await get();
    expect(status).toBe(400);
    expect(body.code).toBe('outside-workspace');
  });

  it('reports a config that does not load as config-error', async () => {
    fs.writeFileSync(decisionsFile, FIXTURE);
    writeConfig('{ not json');
    const { status, body } = await get();
    expect(status).toBe(500);
    expect(body.code).toBe('config-error');
  });

  it('reports an absolute dashboard.decisionsFile as config-error, even inside the workspace', async () => {
    fs.writeFileSync(decisionsFile, FIXTURE);
    writeConfig({ dashboard: { decisionsFile: decisionsFile } });
    const { status, body } = await get();
    expect(status).toBe(500);
    expect(body).toEqual({ ok: false, code: 'config-error', message: expect.stringContaining('relative to the workspace root') });
  });

  it('reports a non-string dashboard.decisionsFile as config-error', async () => {
    fs.writeFileSync(decisionsFile, FIXTURE);
    writeConfig({ dashboard: { decisionsFile: 42 } });
    const { status, body } = await get();
    expect(status).toBe(500);
    expect(body).toEqual({ ok: false, code: 'config-error', message: expect.stringContaining('dashboard.decisionsFile') });
  });
});

describe('POST decisions/rule', () => {
  beforeEach(() => {
    fs.writeFileSync(decisionsFile, FIXTURE);
  });

  it('writes a valid ruling to disk and returns the re-parsed document', async () => {
    const { status, body } = await rule({ id: 'main-11', word: 'accept', comment: COMMENT, fingerprint: fingerprintOf(FIXTURE, 'main-11') });
    expect(status).toBe(200);
    const written = fs.readFileSync(decisionsFile, 'utf8');
    expect(written).toBe(fixtureRuledWith(`accept\n\n${COMMENT}\n`));
    expect(body).toEqual({ ok: true, document: expect.any(Object) });
    const item = (body.document as DecisionsDocument).items.find(i => i.id === 'main-11')!;
    expect(item.currentRuling).toBe(`accept\n\n${COMMENT}`);
    expect(item.fingerprint).toBe(fingerprintOf(written, 'main-11'));
    expect((body.document as DecisionsDocument).version).toBe(parseDecisions(written).version);
    expect(log).toHaveBeenCalledWith('INFO', expect.stringContaining('main-11'));
  });

  describe('telling the hub architect (#1828)', () => {
    it('sends one notice, after the ruling is on disk', async () => {
      let onDisk = '';
      notify.mockImplementation(async () => { onDisk = fs.readFileSync(decisionsFile, 'utf8'); });
      expect((await rule({ id: 'main-11', word: 'accept', comment: COMMENT, fingerprint: fingerprintOf(FIXTURE, 'main-11') })).status).toBe(200);
      expect(notify.mock.calls).toEqual([[`RULED main-11: accept\n${COMMENT}`]]);
      expect(onDisk).toBe(fixtureRuledWith(`accept\n\n${COMMENT}\n`));
    });

    it('sends a comment-only submit as a QUESTION', async () => {
      await rule({ id: 'main-11', comment: `  ${COMMENT}\n`, fingerprint: fingerprintOf(FIXTURE, 'main-11') });
      expect(notify.mock.calls).toEqual([[`QUESTION main-11:\n${COMMENT}`]]);
    });

    it('logs a failed notice and leaves the ruling response unchanged', async () => {
      const request = { id: 'main-11', word: 'accept', fingerprint: fingerprintOf(FIXTURE, 'main-11') };
      const told = await rule(request);
      fs.writeFileSync(decisionsFile, FIXTURE);
      notify.mockRejectedValueOnce(new Error('no architect registered'));
      const untold = await rule(request);
      expect(untold).toEqual(told);
      expect(untold.status).toBe(200);
      expect(fs.readFileSync(decisionsFile, 'utf8')).toBe(fixtureRuledWith('accept\n'));
      expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining('no architect registered'));
    });
  });

  it('never takes the file path from the request', async () => {
    const outside = path.join(tmpDir, 'outside.md');
    fs.writeFileSync(outside, FIXTURE);
    const { status } = await rule({ id: 'main-11', word: 'accept', fingerprint: fingerprintOf(FIXTURE, 'main-11'), path: outside, file: outside });
    expect(status).toBe(200);
    expect(fs.readFileSync(outside, 'utf8')).toBe(FIXTURE);
    expect(fs.readFileSync(decisionsFile, 'utf8')).toBe(fixtureRuledWith('accept\n'));
  });

  const refusals: Array<[string, () => unknown, number, string]> = [
    ['an unknown word', () => ({ id: 'main-11', word: 'merge', fingerprint: fingerprintOf(FIXTURE, 'main-11') }), 409, 'unknown-word'],
    ['a stale fingerprint', () => ({ id: 'main-11', word: 'accept', fingerprint: 'stale' }), 409, 'item-changed'],
    ['a missing item', () => ({ id: 'main-99', word: 'accept', fingerprint: 'x' }), 409, 'heading-missing'],
    ['no word and no comment', () => ({ id: 'main-11', comment: '  ', fingerprint: fingerprintOf(FIXTURE, 'main-11') }), 400, 'empty-ruling'],
    ['a comment with a heading', () => ({ id: 'main-11', comment: 'ok\n## Ruled', fingerprint: fingerprintOf(FIXTURE, 'main-11') }), 400, 'comment-heading'],
    ['malformed JSON', () => '{ "id": ', 400, 'invalid-request'],
    ['a JSON array', () => [], 400, 'invalid-request'],
    ['a missing id', () => ({ word: 'accept', fingerprint: 'x' }), 400, 'invalid-request'],
    ['a missing fingerprint', () => ({ id: 'main-11', word: 'accept' }), 400, 'invalid-request'],
    ['a non-string word', () => ({ id: 'main-11', word: 1, fingerprint: 'x' }), 400, 'invalid-request'],
    ['a non-string comment', () => ({ id: 'main-11', comment: ['x'], fingerprint: 'x' }), 400, 'invalid-request'],
    ['an oversized body', () => JSON.stringify({ id: 'main-11', comment: 'x'.repeat(MAX_RULE_BODY_BYTES), fingerprint: 'x' }), 400, 'invalid-request'],
  ];

  for (const [what, body, status, code] of refusals) {
    it(`refuses ${what} (${code}) and leaves the file byte-identical`, async () => {
      const result = await rule(body());
      expect(result.status).toBe(status);
      expect(result.body).toEqual({ ok: false, code, message: expect.any(String) });
      expect(fs.readFileSync(decisionsFile, 'utf8')).toBe(FIXTURE);
      expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining(code));
      expect(notify).not.toHaveBeenCalled();
    });
  }

  it('refuses a ruling that would change the structure (structure-changed, 422)', async () => {
    const text = FIXTURE.replace(ACCEPT_LINE, '**Your word:** `####` = a heading / `hold`');
    fs.writeFileSync(decisionsFile, text);
    const result = await rule({ id: 'main-11', word: '####', fingerprint: fingerprintOf(text, 'main-11') });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('structure-changed');
    expect(fs.readFileSync(decisionsFile, 'utf8')).toBe(text);
  });

  it('refuses a file that is not valid UTF-8 and leaves its bytes alone', async () => {
    const bytes = Buffer.concat([Buffer.from(FIXTURE), Buffer.from([0xff, 0xfe, 0x0a])]);
    fs.writeFileSync(decisionsFile, bytes);
    const result = await rule({ id: 'main-11', word: 'accept', fingerprint: fingerprintOf(bytes.toString('utf8'), 'main-11') });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('not-utf8');
    expect(fs.readFileSync(decisionsFile).equals(bytes)).toBe(true);
  });

  it('is not-found when the file is absent', async () => {
    fs.rmSync(decisionsFile);
    const result = await rule({ id: 'main-11', word: 'accept', fingerprint: fingerprintOf(FIXTURE, 'main-11') });
    expect(result.status).toBe(404);
    expect(result.body.code).toBe('not-found');
    expect(fs.existsSync(decisionsFile)).toBe(false);
  });

  it('refuses to write through a symlink that leaves the workspace', async () => {
    const outside = path.join(tmpDir, 'outside.md');
    fs.writeFileSync(outside, FIXTURE);
    fs.rmSync(decisionsFile);
    fs.symlinkSync(outside, decisionsFile);
    const result = await rule({ id: 'main-11', word: 'accept', fingerprint: fingerprintOf(FIXTURE, 'main-11') });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('outside-workspace');
    expect(fs.readFileSync(outside, 'utf8')).toBe(FIXTURE);
  });

  it('honours the configured path, including a config.local.json override', async () => {
    const projectPath = path.join(workspace, 'notes', 'project.md');
    const localPath = path.join(workspace, 'notes', 'local.md');
    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(projectPath, FIXTURE);
    fs.writeFileSync(localPath, FIXTURE);
    writeConfig({ dashboard: { decisionsFile: 'notes/project.md' } });
    writeConfig({ dashboard: { decisionsFile: 'notes/local.md' } }, 'config.local.json');

    expect((await get()).body.document.path).toBe('notes/local.md');
    const result = await rule({ id: 'main-11', word: 'accept', fingerprint: fingerprintOf(FIXTURE, 'main-11') });
    expect(result.status).toBe(200);
    expect(result.body.document.path).toBe('notes/local.md');
    expect(fs.readFileSync(localPath, 'utf8')).toBe(fixtureRuledWith('accept\n'));
    expect(fs.readFileSync(projectPath, 'utf8')).toBe(FIXTURE);
    expect(fs.readFileSync(decisionsFile, 'utf8')).toBe(FIXTURE);
  });

  it('reads the config on every request', async () => {
    const other = path.join(workspace, 'other.md');
    fs.writeFileSync(other, FIXTURE);
    expect((await get()).body.document.path).toBe(DEFAULT_DECISIONS_FILE);
    writeConfig({ dashboard: { decisionsFile: 'other.md' } });
    expect((await get()).body.document.path).toBe('other.md');
    expect((await rule({ id: 'main-11', word: 'accept', fingerprint: fingerprintOf(FIXTURE, 'main-11') })).body.document.path).toBe('other.md');
  });

  it('applies exactly one of two concurrent rulings for the same item', async () => {
    const fingerprint = fingerprintOf(FIXTURE, 'main-11');
    const [first, second] = await Promise.all([
      rule({ id: 'main-11', word: 'accept', fingerprint }),
      rule({ id: 'main-11', word: 'rework', fingerprint }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const refused = first.status === 409 ? first : second;
    expect(refused.body.code).toBe('already-ruled');
    const winner = first.status === 200 ? 'accept' : 'rework';
    expect(fs.readFileSync(decisionsFile, 'utf8')).toBe(fixtureRuledWith(`${winner}\n`));
    expect(notify.mock.calls).toEqual([[`RULED main-11: ${winner}`]]);
  });

  it('replaces the file by rename: a new inode, and nothing written in place', async () => {
    const before = fs.statSync(decisionsFile).ino;
    await rule({ id: 'main-11', word: 'accept', fingerprint: fingerprintOf(FIXTURE, 'main-11') });
    expect(fs.statSync(decisionsFile).ino).not.toBe(before);
    expect(fs.readdirSync(path.dirname(decisionsFile))).toEqual(['pending-decisions.md']);
  });

  it('refuses as write-failed, leaving the original intact and no temporary file, when the rename fails', async () => {
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('EIO: rename failed'), { code: 'EIO' }));
    const request = { id: 'main-11', word: 'accept', fingerprint: fingerprintOf(FIXTURE, 'main-11') };
    const failed = await rule(request);
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ ok: false, code: 'write-failed', message: expect.stringContaining('EIO: rename failed') });
    expect(rename).toHaveBeenCalledOnce();
    expect(fs.readFileSync(decisionsFile, 'utf8')).toBe(FIXTURE);
    expect(fs.readdirSync(path.dirname(decisionsFile))).toEqual(['pending-decisions.md']);
    expect(notify).not.toHaveBeenCalled();

    // The failure does not wedge the file's write queue.
    expect((await rule(request)).status).toBe(200);
    expect(fs.readFileSync(decisionsFile, 'utf8')).toBe(fixtureRuledWith('accept\n'));
  });

  it('keeps a symlinked decisions file a symlink and updates its in-workspace target', async () => {
    const target = path.join(workspace, 'docs', 'decisions.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, FIXTURE);
    fs.rmSync(decisionsFile);
    fs.symlinkSync('../../docs/decisions.md', decisionsFile);

    const result = await rule({ id: 'main-11', word: 'accept', fingerprint: fingerprintOf(FIXTURE, 'main-11') });
    expect(result.status).toBe(200);
    expect(result.body.document.path).toBe(DEFAULT_DECISIONS_FILE);
    expect(fs.lstatSync(decisionsFile).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(decisionsFile)).toBe('../../docs/decisions.md');
    expect(fs.readFileSync(target, 'utf8')).toBe(fixtureRuledWith('accept\n'));
    expect(fs.readdirSync(path.dirname(target))).toEqual(['decisions.md']);
  });

  it('keeps the file permissions', async () => {
    fs.chmodSync(decisionsFile, 0o640);
    await rule({ id: 'main-11', word: 'accept', fingerprint: fingerprintOf(FIXTURE, 'main-11') });
    expect(fs.statSync(decisionsFile).mode & 0o7777).toBe(0o640);
  });
});

describe('decisionsFilePresent (the state flag)', () => {
  it('is true when the file exists and false when it does not', async () => {
    expect(await decisionsFilePresent(workspace, log)).toBe(false);
    fs.writeFileSync(decisionsFile, FIXTURE);
    expect(await decisionsFilePresent(workspace, log)).toBe(true);
    fs.rmSync(decisionsFile);
    expect(await decisionsFilePresent(workspace, log)).toBe(false);
  });

  it('is false for a file outside the workspace', async () => {
    fs.writeFileSync(path.join(tmpDir, 'outside.md'), FIXTURE);
    fs.symlinkSync(path.join(tmpDir, 'outside.md'), decisionsFile);
    expect(await decisionsFilePresent(workspace, log)).toBe(false);
  });

  it('is false on a config error, logged once rather than on every poll', async () => {
    fs.writeFileSync(decisionsFile, FIXTURE);
    writeConfig('{ not json');
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(await decisionsFilePresent(workspace, log)).toBe(false);
    vi.setSystemTime(Date.now() + CONFIGURED_PATH_MEMO_MS);
    expect(await decisionsFilePresent(workspace, log)).toBe(false);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining(workspace));
  });

  it('sees a config change after the memo window', async () => {
    fs.writeFileSync(decisionsFile, FIXTURE);
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(await decisionsFilePresent(workspace, log)).toBe(true);
    writeConfig({ dashboard: { decisionsFile: 'absent.md' } });
    vi.setSystemTime(Date.now() + CONFIGURED_PATH_MEMO_MS - 1);
    expect(await decisionsFilePresent(workspace, log)).toBe(true);
    vi.setSystemTime(Date.now() + 1);
    expect(await decisionsFilePresent(workspace, log)).toBe(false);
  });

  it('memoizes only the configured path, never the file: presence follows the disk at once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(await decisionsFilePresent(workspace, log)).toBe(false);
    fs.writeFileSync(decisionsFile, FIXTURE);
    expect(await decisionsFilePresent(workspace, log)).toBe(true);
  });
});
