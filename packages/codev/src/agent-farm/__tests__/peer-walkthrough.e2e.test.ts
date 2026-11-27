/**
 * The approved spec's stage 2 walkthrough, end to end (Spec 1967, plan phase 13, layer B):
 * "Walkthrough: two of my own Towers, from nothing to a reply" in the spec for issue #1940.
 *
 * Two built Towers on the stand-in relay over loopback, on one account: `mbp` (Tower a) and
 * `devvm` (Tower b). Both are registered and their tunnels are up; neither has sent a
 * cross-Tower message, and both start with remote messaging off, as a fresh install does.
 * Each has a workspace `codev`; its architect `main` runs on mbp and `local` on devvm. (A
 * workspace's first architect is always `main`, so devvm's `codev` has a `main` too; nothing
 * here sends to it.)
 *
 * Every step is the walkthrough's own command line, run through the CLI's own parser
 * (`runAgentFarm`) in this process as the agent the walkthrough names, against that Tower.
 * Each printed line is asserted as the walkthrough gives it. Delivery goes through the real
 * render gate: each architect runs an echo program named `claude` (`stty raw -echo; exec
 * cat`), and a clean claude composer is drawn on the recipient before each delivery, as
 * `peer-send.e2e.test.ts` does. What the recipient's terminal echoed is read back, so step 8
 * is the frame as it arrived, not only the frame as stored.
 *
 * Then each row of the walkthrough's skipped-step table, at step 7: the step is taken back
 * with the CLI (`afx peer off`, `afx peer revoke`, both agent-allowed), step 7 is run, and
 * the step is done again with the walkthrough's own command. The last row, "devvm is
 * switched off or asleep", is the stand-in reporting devvm offline (`setOffline`), which is
 * what the sending Tower's answer depends on; a restart of either Tower is phase 9's.
 *
 * Last, secrets and bodies: neither Tower's database, log, `cloud-config.json` nor any other
 * file it wrote contains a session secret, a statement or a MAC. None of them contains a body
 * either, but for two kinds of file that hold one by design: the database (its mailbox and
 * outbox), and the PTY session log (#1238, `<agent-farm>/logs/<terminal id>.log`) of the one
 * terminal a message was delivered to, which records what that terminal showed, as it does
 * for a local message. The record of attempts holds no body.
 *
 * The stand-in's message limits are raised, so the number of messages sent in a minute never
 * decides an answer; each Tower keeps its own default limits.
 *
 * On demand, after `npm run build`, never in porch's tests check:
 *
 *   pnpm exec vitest run --config vitest.e2e.config.ts \
 *     src/agent-farm/__tests__/peer-walkthrough.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { makeWorkspace, runCli, startTwoTowers, type CliAgent, type CliRun, type HarnessTower, type TwoTowers } from './helpers/two-towers.js';
import { encodeWorkspacePath, waitFor } from './helpers/tower-test-utils.js';

vi.mock('../lib/tower-client.js', async (importOriginal) =>
  (await import('./helpers/two-towers.js')).towerClientModuleFor(await importOriginal()),
);
vi.mock('../db/index.js', async (importOriginal) =>
  (await import('./helpers/two-towers.js')).dbModuleFor(await importOriginal()),
);

const { runAgentFarm } = await import('../cli.js');

const ESC = '\x1b';
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
/** A clean claude composer: the marker and a dim placeholder only (send-integration.e2e). */
const CLAUDE_CLEAN = `${CLEAR_SCREEN}❯ ${ESC}[2mTry "fix the flaky test"${ESC}[0m\r\n${'─'.repeat(22)}\r\n`;

const BODY = 'CI is green on the tunnel branch';
const REPLY = 'Thanks, taking over';
const TO_LOCAL = 'afx://devvm/codev:architect:local';
const TO_MAIN = 'afx://mbp/codev:architect:main';
const HUMAN = '--a-human-explicitly-approved-this';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const HEADER_TO_LOCAL = /^### \[REMOTE, your Tower · afx:\/\/mbp\/codev:architect:main → local \| \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\] ###$/;
const FOOTER_TO_LOCAL = '###############################  (reply: afx send afx://mbp/codev:architect:main "…")';
const HEADER_TO_MAIN = /^### \[REMOTE, your Tower · afx:\/\/devvm\/codev:architect:local → main \| \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\] ###$/;
const FOOTER_TO_MAIN = '###############################  (reply: afx send afx://devvm/codev:architect:local "…")';

interface MailRow {
  id: string;
  workspace_path: string;
  to_agent: string;
  status: string;
  formatted_message: string;
  remote_tower_id: string | null;
  remote_message_id: string | null;
}

interface OutboxRow {
  message_id: string;
  state: string;
  last_outcome: string | null;
  last_reason: string | null;
}

describe('Spec 1967 phase 13: the stage 2 walkthrough, from nothing to a reply', () => {
  let towers: TwoTowers;
  let a: HarnessTower;
  let b: HarnessTower;
  let wsA: string;
  let wsB: string;

  /** Each tunnel session's secret, by `<tower id>:<session seq>`, noted after every case. */
  const secrets = new Map<string, Buffer>();
  const noteSessions = () => {
    for (const tower of [a, b]) {
      const session = towers.relay.session(tower.towerId);
      if (session?.secret) secrets.set(`${tower.towerId}:${session.seq}`, session.secret);
    }
  };

  const mainOnMbp = (): CliAgent => ({ cwd: wsA, architect: 'main' });
  const localOnDevvm = (): CliAgent => ({ cwd: wsB, architect: 'local' });
  /**
   * One walkthrough command line, on `tower`, as `agent`, through the CLI's own parser. A
   * refused `afx send` exits from inside `send()`; in this process that exit is the runner's
   * thrown stand-in, which the command's own `catch` logs as `[error] exit 1` before exiting
   * again. A real process has ended at the first exit, so that one line is dropped.
   */
  const afx = async (tower: HarnessTower, agent: CliAgent, ...args: string[]): Promise<CliRun> => {
    const run = await runCli(tower, agent, () => runAgentFarm(args));
    if (run.exitCode !== null && run.stderr.at(-1) === `[error] exit ${run.exitCode}`) run.stderr.pop();
    return run;
  };

  const mailOn = (tower: HarnessTower): MailRow[] =>
    tower.readDb((db) => db.prepare('SELECT * FROM mailbox ORDER BY rowid').all() as MailRow[]);
  const remoteMail = (tower: HarnessTower, id: string) => mailOn(tower).filter((row) => row.remote_message_id === id);
  const outboxRow = (id: string): OutboxRow | undefined =>
    a.readDb((db) => db.prepare('SELECT * FROM peer_outbox WHERE message_id = ?').get(id) as OutboxRow | undefined);
  const outboxCount = () => a.readDb((db) => (db.prepare('SELECT COUNT(*) AS n FROM peer_outbox').get() as { n: number }).n);
  const relayCallCount = () => towers.relay.calls.filter((call) => call.route === 'relay').length;

  /** The terminal of a running workspace's architect, by name, from its dashboard state. */
  const architectTerminal = async (tower: HarnessTower, workspacePath: string, name: string): Promise<string> => {
    const state = await tower.json<{ architects: Array<{ name: string; terminalId?: string }> }>(
      'GET',
      `/workspace/${encodeWorkspacePath(workspacePath)}/api/state`,
    );
    const terminalId = state.body.architects.find((architect) => architect.name === name)?.terminalId;
    if (!terminalId) throw new Error(`no ${name} architect terminal in ${workspacePath}: ${JSON.stringify(state.body.architects)}`);
    return terminalId;
  };

  /** Draw a clean claude composer on an architect's terminal, past the input settle (#1473). */
  const cleanPrompt = async (tower: HarnessTower, workspacePath: string, name: string) => {
    const terminalId = await architectTerminal(tower, workspacePath, name);
    const res = await tower.fetch(`/api/terminals/${terminalId}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: CLAUDE_CLEAN }),
    });
    expect(res.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
  };

  /** What an architect's terminal has shown, as lines of text. */
  const screenOf = async (tower: HarnessTower, workspacePath: string, name: string): Promise<string[]> => {
    const terminalId = await architectTerminal(tower, workspacePath, name);
    const output = await tower.json<{ lines: string[] }>('GET', `/api/terminals/${terminalId}/output?lines=10000`);
    expect(output.status).toBe(200);
    return stripVTControlCharacters(output.body.lines.join('\n')).split(/\r\n|\r|\n/);
  };

  /** The one message delivered to `to` on `tower` with this id, and its frame's three lines. */
  const deliveredFrame = (tower: HarnessTower, id: string, workspacePath: string, to: string): string[] => {
    const rows = remoteMail(tower, id);
    expect(rows, JSON.stringify(rows)).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspace_path: workspacePath, to_agent: to, status: 'delivered' });
    return rows[0].formatted_message.split('\n');
  };

  const idOf = (run: CliRun): string => {
    const match = UUID.exec(run.stdout.at(-1) ?? '');
    if (!match) throw new Error(`no message id in ${JSON.stringify(run)}`);
    return match[0];
  };

  beforeAll(async () => {
    towers = await startTwoTowers({
      relay: {
        limits: {
          messagesPerTowerPerMinute: 10_000,
          messagesPerPairPerMinute: 10_000,
        },
      },
    });
    ({ a, b } = towers);
    expect([a.slug, b.slug]).toEqual(['mbp', 'devvm']);

    // An architect command is split on whitespace and given further arguments by Tower:
    // one executable named claude that ignores them.
    const echoDir = join(towers.root, 'claude-echo');
    mkdirSync(echoDir, { recursive: true });
    const claudeEcho = join(echoDir, 'claude');
    writeFileSync(claudeEcho, '#!/bin/sh\nstty raw -echo 2>/dev/null; exec cat\n', { mode: 0o755 });
    wsA = makeWorkspace(join(towers.root, 'a', 'codev'), claudeEcho);
    wsB = makeWorkspace(join(towers.root, 'b', 'codev'), claudeEcho);
    await a.activate(wsA);
    await b.activate(wsB);
    await b.addArchitect(wsB, 'local');
    noteSessions();
  }, 240_000);

  afterEach(() => noteSessions());

  afterAll(async () => {
    const report = await towers?.stop();
    if (report) expect(report).toEqual({ processes: [], shellpers: [], paths: [], relayListening: false });
  }, 120_000);

  // -------------------------------------------------------------------------
  // The walkthrough, step by step
  // -------------------------------------------------------------------------

  it('steps 1 to 9, as written: the same commands, in that order, with those results', async () => {
    // Step 1, mbp: the listing works while the switch is off.
    const step1 = await afx(a, mainOnMbp(), 'peer', 'list');
    expect(step1.exitCode, JSON.stringify(step1)).toBeNull();
    expect(step1.stdout).toEqual([
      'Remote messaging: off — a human turns it on with: afx peer on',
      'devvm  you  online  may message this Tower: nothing',
    ]);
    expect(step1.stderr).toEqual([]);

    // Step 2, mbp.
    const step2 = await afx(a, mainOnMbp(), 'peer', 'on', HUMAN);
    expect(step2.exitCode, JSON.stringify(step2)).toBeNull();
    expect(step2.stdout).toEqual(['[ok] Remote messaging is on for mbp. No Tower may message it yet. Allow one with: afx peer grant <tower> …']);

    // Step 3, devvm: the same, for devvm.
    const step3 = await afx(b, localOnDevvm(), 'peer', 'on', HUMAN);
    expect(step3.exitCode, JSON.stringify(step3)).toBeNull();
    expect(step3.stdout).toEqual(['[ok] Remote messaging is on for devvm. No Tower may message it yet. Allow one with: afx peer grant <tower> …']);

    // Step 4, devvm.
    const step4 = await afx(b, localOnDevvm(), 'peer', 'grant', 'mbp', 'codev:architect:local', HUMAN);
    expect(step4.exitCode, JSON.stringify(step4)).toBeNull();
    expect(step4.stdout).toEqual(['[ok] mbp (your Tower) may message codev:architect:local on this Tower. Mail is delivered directly.']);

    // Step 5, mbp: what lets the reply in step 9 arrive.
    const step5 = await afx(a, mainOnMbp(), 'peer', 'grant', 'devvm', 'codev:architect:main', HUMAN);
    expect(step5.exitCode, JSON.stringify(step5)).toBeNull();
    expect(step5.stdout).toEqual(['[ok] devvm (your Tower) may message codev:architect:main on this Tower. Mail is delivered directly.']);

    // Step 6, mbp: one address a line, ready to paste, and only what mbp has been granted.
    const step6 = await afx(a, mainOnMbp(), 'peer', 'show', 'devvm');
    expect(step6.exitCode, JSON.stringify(step6)).toBeNull();
    expect(step6.stdout).toEqual([`${TO_LOCAL}  live`]);

    // Step 7, mbp, architect main.
    await cleanPrompt(b, wsB, 'local');
    const step7 = await afx(a, mainOnMbp(), 'send', TO_LOCAL, BODY);
    expect(step7.exitCode, JSON.stringify(step7)).toBeNull();
    expect(step7.stdout.at(-1)).toBe(`[ok] Message delivered to ${TO_LOCAL} (32 bytes)`);
    expect(Buffer.byteLength(BODY)).toBe(32);

    // Step 8, devvm, architect local: nothing to do; the message arrives, as the frame.
    const [sent] = a.readDb((db) => db.prepare('SELECT message_id FROM peer_outbox ORDER BY seq').all() as Array<{ message_id: string }>);
    expect(outboxRow(sent.message_id)).toMatchObject({ state: 'accepted', last_outcome: 'delivered' });
    const frame = deliveredFrame(b, sent.message_id, wsB, 'local');
    expect(frame).toEqual([expect.stringMatching(HEADER_TO_LOCAL), BODY, FOOTER_TO_LOCAL]);
    const onLocal = await screenOf(b, wsB, 'local');
    expect(onLocal.some((line) => HEADER_TO_LOCAL.test(line.trim())), onLocal.join('\n')).toBe(true);
    expect(onLocal.map((line) => line.trim())).toContain(BODY);
    expect(onLocal.map((line) => line.trim())).toContain(FOOTER_TO_LOCAL);

    // Step 9, devvm, architect local: the command pasted from the frame's footer.
    const pasted = /\(reply: afx send (\S+) "…"\)$/.exec(frame[2])![1];
    expect(pasted).toBe(TO_MAIN);
    await cleanPrompt(a, wsA, 'main');
    const step9 = await afx(b, localOnDevvm(), 'send', pasted, REPLY);
    expect(step9.exitCode, JSON.stringify(step9)).toBeNull();
    expect(step9.stdout.at(-1)).toBe(`[ok] Message delivered to ${TO_MAIN} (19 bytes)`);
    expect(Buffer.byteLength(REPLY)).toBe(19);

    // ... and main on the laptop sees the matching frame.
    const [reply] = b.readDb((db) => db.prepare('SELECT message_id FROM peer_outbox ORDER BY seq').all() as Array<{ message_id: string }>);
    expect(deliveredFrame(a, reply.message_id, wsA, 'main')).toEqual([expect.stringMatching(HEADER_TO_MAIN), REPLY, FOOTER_TO_MAIN]);
    const onMain = await screenOf(a, wsA, 'main');
    expect(onMain.some((line) => HEADER_TO_MAIN.test(line.trim())), onMain.join('\n')).toBe(true);
    expect(onMain.map((line) => line.trim())).toContain(REPLY);
    expect(onMain.map((line) => line.trim())).toContain(FOOTER_TO_MAIN);
  }, 120_000);

  // -------------------------------------------------------------------------
  // What a skipped step looks like, at step 7
  // -------------------------------------------------------------------------

  it('skipped step 2 (the switch on mbp): refused on mbp, and nothing leaves the machine', async () => {
    const off = await afx(a, mainOnMbp(), 'peer', 'off');
    expect(off.stdout).toEqual(['[ok] Remote messaging is off for mbp. It sends nothing to other Towers and accepts nothing from them.']);

    const calls = relayCallCount();
    const stored = outboxCount();
    const step7 = await afx(a, mainOnMbp(), 'send', TO_LOCAL, BODY);
    expect(step7.exitCode).toBe(1);
    expect(step7.stderr).toEqual(['[error] Remote messaging is off on this Tower (mbp). A human turns it on with: afx peer on']);
    expect(relayCallCount()).toBe(calls);
    expect(outboxCount()).toBe(stored);

    const step2 = await afx(a, mainOnMbp(), 'peer', 'on', HUMAN);
    expect(step2.stdout).toEqual(['[ok] Remote messaging is on for mbp. One grant applies: afx peer grants']);
  }, 60_000);

  it('skipped step 3 (the switch on devvm): refused by devvm, exiting non-zero, and nothing left there', async () => {
    const off = await afx(b, localOnDevvm(), 'peer', 'off');
    expect(off.stdout).toEqual(['[ok] Remote messaging is off for devvm. It sends nothing to other Towers and accepts nothing from them.']);

    const mail = mailOn(b).length;
    const step7 = await afx(a, mainOnMbp(), 'send', TO_LOCAL, BODY);
    expect(step7.exitCode).toBe(1);
    expect(step7.stderr).toEqual(['[error] Refused by devvm: remote messaging is off there.']);
    expect(mailOn(b)).toHaveLength(mail);

    const step3 = await afx(b, localOnDevvm(), 'peer', 'on', HUMAN);
    expect(step3.stdout).toEqual(['[ok] Remote messaging is on for devvm. One grant applies: afx peer grants']);
  }, 60_000);

  it('skipped step 4 (the grant on devvm): refused by devvm, naming the command to run there', async () => {
    const revoke = await afx(b, localOnDevvm(), 'peer', 'revoke', 'mbp', 'codev:architect:local');
    expect(revoke.stdout).toEqual(['[ok] mbp may no longer message codev:architect:local on this Tower.']);

    const mail = mailOn(b).length;
    const step7 = await afx(a, mainOnMbp(), 'send', TO_LOCAL, BODY);
    expect(step7.exitCode).toBe(1);
    expect(step7.stderr).toEqual([
      '[error] Refused by devvm: mbp has no grant there for codev:architect:local. On devvm: afx peer grant mbp codev:architect:local',
    ]);
    expect(mailOn(b)).toHaveLength(mail);

    const step4 = await afx(b, localOnDevvm(), 'peer', 'grant', 'mbp', 'codev:architect:local', HUMAN);
    expect(step4.stdout).toEqual(['[ok] mbp (your Tower) may message codev:architect:local on this Tower. Mail is delivered directly.']);
  }, 60_000);

  it('skipped step 5 (the grant on mbp): step 7 succeeds, and the reply in step 9 is refused, naming the command to run on mbp', async () => {
    const revoke = await afx(a, mainOnMbp(), 'peer', 'revoke', 'devvm', 'codev:architect:main');
    expect(revoke.stdout).toEqual(['[ok] devvm may no longer message codev:architect:main on this Tower.']);

    await cleanPrompt(b, wsB, 'local');
    const step7 = await afx(a, mainOnMbp(), 'send', TO_LOCAL, BODY);
    expect(step7.exitCode, JSON.stringify(step7)).toBeNull();
    expect(step7.stdout.at(-1)).toBe(`[ok] Message delivered to ${TO_LOCAL} (32 bytes)`);

    const mail = mailOn(a).length;
    const step9 = await afx(b, localOnDevvm(), 'send', TO_MAIN, REPLY);
    expect(step9.exitCode).toBe(1);
    expect(step9.stderr).toEqual([
      '[error] Refused by mbp: devvm has no grant there for codev:architect:main. On mbp: afx peer grant devvm codev:architect:main',
    ]);
    expect(mailOn(a)).toHaveLength(mail);

    const step5 = await afx(a, mainOnMbp(), 'peer', 'grant', 'devvm', 'codev:architect:main', HUMAN);
    expect(step5.stdout).toEqual(['[ok] devvm (your Tower) may message codev:architect:main on this Tower. Mail is delivered directly.']);
  }, 60_000);

  it('devvm switched off or asleep: held on mbp with its mailbox id, and sent once when devvm returns', async () => {
    towers.relay.setOffline(b.towerId, true);
    const mailOnMbp = mailOn(a).length;
    const step7 = await afx(a, mainOnMbp(), 'send', TO_LOCAL, BODY);
    expect(step7.exitCode, JSON.stringify(step7)).toBeNull();
    expect(step7.stdout.at(-1)).toMatch(
      new RegExp(`^\\[info\\] Message held on this Tower \\(tower-offline\\) — mailbox id ${UUID.source}\\. It is sent when devvm returns\\.$`),
    );
    const id = idOf(step7);
    expect(outboxRow(id)).toMatchObject({ state: 'held', last_reason: 'tower-offline' });
    expect(mailOn(a)).toHaveLength(mailOnMbp);
    expect(remoteMail(b, id)).toEqual([]);

    await cleanPrompt(b, wsB, 'local');
    towers.relay.setOffline(b.towerId, false);
    const accepted = await waitFor(async () => outboxRow(id)?.state === 'accepted', 30_000, 100);
    expect(accepted, JSON.stringify(outboxRow(id))).toBe(true);
    expect(deliveredFrame(b, id, wsB, 'local')).toEqual([expect.stringMatching(HEADER_TO_LOCAL), BODY, FOOTER_TO_LOCAL]);
  }, 90_000);

  // -------------------------------------------------------------------------
  // Secrets and bodies, after the walkthrough
  // -------------------------------------------------------------------------

  it('no session secret, statement or MAC anywhere a Tower wrote, and no body outside the mailbox and outbox', async () => {
    noteSessions();
    const opened = towers.relay.sessionsOpened(a.towerId) + towers.relay.sessionsOpened(b.towerId);
    // Every session's secret was noted, so none is missing from the search below.
    expect(secrets.size, 'a tunnel session was opened and replaced between two notes').toBe(opened);
    expect(towers.relay.forwards.length).toBeGreaterThan(0);

    const secretNeedles: Array<[string, Buffer]> = [];
    for (const [session, secret] of secrets) {
      secretNeedles.push(
        [`secret ${session} (raw)`, secret],
        [`secret ${session} (base64url)`, Buffer.from(secret.toString('base64url'))],
        [`secret ${session} (base64)`, Buffer.from(secret.toString('base64'))],
        [`secret ${session} (hex)`, Buffer.from(secret.toString('hex'))],
      );
    }
    towers.relay.forwards.forEach((forward, i) => {
      const statementBytes = Buffer.from(forward.statementHeader, 'base64url');
      const macBytes = Buffer.from(forward.mac, 'base64url');
      secretNeedles.push(
        [`statement ${i} (header)`, Buffer.from(forward.statementHeader)],
        [`statement ${i} (JSON)`, statementBytes],
        [`MAC ${i} (header)`, Buffer.from(forward.mac)],
        [`MAC ${i} (raw)`, macBytes],
        [`MAC ${i} (hex)`, Buffer.from(macBytes.toString('hex'))],
      );
      const statementId = forward.statement?.statementId;
      if (typeof statementId === 'string') secretNeedles.push([`statement ${i} (statementId)`, Buffer.from(statementId)]);
    });
    const bodyNeedles: Array<[string, Buffer]> = [
      ['body (step 7)', Buffer.from(BODY)],
      ['body (step 9)', Buffer.from(REPLY)],
    ];
    const found = (haystack: Buffer, needles: Array<[string, Buffer]>) =>
      needles.filter(([, needle]) => haystack.includes(needle)).map(([what]) => what);

    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        const stat = statSync(path, { throwIfNoEntry: false });
        if (!stat) return [];
        return stat.isDirectory() ? files(path) : stat.isFile() ? [path] : [];
      });

    // Where each body was delivered: the one terminal whose transcript may show it.
    const deliveredTo = [
      { tower: b, terminalId: await architectTerminal(b, wsB, 'local'), body: 'body (step 7)' },
      { tower: a, terminalId: await architectTerminal(a, wsA, 'main'), body: 'body (step 9)' },
    ];
    const transcriptOf = (tower: HarnessTower, terminalId: string) => join(tower.agentFarmDir, 'logs', `${terminalId}.log`);

    for (const tower of [a, b]) {
      const label = `Tower ${tower.slug}`;
      const db = basename(tower.dbPath);
      const written = [tower.agentFarmDir, tower.home, tower.socketDir].flatMap(files);
      const names = written.map((path) => basename(path));
      expect(names, label).toContain(db);
      expect(names, label).toContain('cloud-config.json');
      const sessionLogs = new Set(written.filter((path) => dirname(path) === join(tower.agentFarmDir, 'logs') && path.endsWith('.log')));
      expect(sessionLogs.size, label).toBeGreaterThan(0);

      for (const path of written) {
        const bytes = readFileSync(path);
        if (basename(path).startsWith(db)) {
          // The database: the mailbox and outbox hold bodies by design; never a secret, statement or MAC.
          expect(found(bytes, secretNeedles), `${label}: ${path}`).toEqual([]);
        } else if (sessionLogs.has(path)) {
          // A terminal's transcript: a body only where it was delivered, never a secret, statement or MAC.
          const allowed = deliveredTo.filter((d) => transcriptOf(d.tower, d.terminalId) === path).map((d) => d.body);
          const bodies = found(bytes, bodyNeedles).filter((what) => !allowed.includes(what));
          expect({ secrets: found(bytes, secretNeedles), bodies }, `${label}: ${path}`).toEqual({ secrets: [], bodies: [] });
        } else {
          // Every other file it wrote, cloud-config.json among them: none of the four.
          expect(found(bytes, [...secretNeedles, ...bodyNeedles]), `${label}: ${path}`).toEqual([]);
        }
      }
      // Its log: what the process printed over the whole run.
      const log = Buffer.from(tower.output.join(''));
      expect(log.length, label).toBeGreaterThan(0);
      expect(found(log, [...secretNeedles, ...bodyNeedles]), `${label}: its log`).toEqual([]);
      // Its record of attempts: every attempt is there, with none of the four.
      const records = tower.readDb((database) => database.prepare('SELECT * FROM peer_records').all());
      expect(records.length, label).toBeGreaterThan(0);
      expect(found(Buffer.from(JSON.stringify(records)), [...secretNeedles, ...bodyNeedles]), `${label}: peer_records`).toEqual([]);
    }

    // The two delivered bodies are in their recipients' transcripts: the check above can see a body.
    for (const { tower, terminalId, body } of deliveredTo) {
      expect(found(readFileSync(transcriptOf(tower, terminalId)), bodyNeedles), `${tower.slug}: ${terminalId}.log`).toContain(body);
    }
  }, 60_000);
});
