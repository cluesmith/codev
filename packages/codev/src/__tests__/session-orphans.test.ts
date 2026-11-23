/**
 * #1915: which processes in a session's job count as orphaned, and Tower's
 * listing and ending with the protected set. Pure logic and injected
 * dependencies; runs on every platform.
 */

import { describe, it, expect, vi } from 'vitest';
import type { JobMemberProcess, JobMembersOutcome } from '../lib/platform/windows/job-objects.js';
import { classifyOrphans, hasDeadParent, withLiveDescendants } from '../lib/platform/windows/session-orphans.js';
import { listOrphans, type OrphanDeps, type OrphanSessionRef } from '../agent-farm/servers/session-orphans.js';
import type { ProcessCensusEntry } from '../lib/platform/processes.js';

/** A live member; `parent` defaults to a live parent created before it. */
function m(pid: number, ppid: number, createdAt: number, parent: JobMemberProcess['parent'] = 'alive', parentCreatedAt?: number, name = `p${pid}.exe`): JobMemberProcess {
  const member: JobMemberProcess = { pid, ppid, state: 'alive', createdAt, cpuMs: pid, name, parent };
  if (parent === 'alive') member.parentCreatedAt = parentCreatedAt ?? createdAt - 1;
  return member;
}

// The session as measured on the owner's host: shellper → conhost, bash launch loop → bash → claude → tool bash.
const ROOT = 100;
const sessionTree = [
  m(100, 50, 1000, 'gone'), // the shellper; after a Tower restart its parent is dead
  m(101, 100, 1001, 'alive', 1000, 'conhost.exe'),
  m(102, 100, 1002, 'alive', 1000, 'bash.exe'),
  m(103, 102, 1003, 'alive', 1002, 'bash.exe'),
  m(104, 103, 1004, 'alive', 1003, 'claude.exe'),
  m(105, 104, 1005, 'alive', 1004, 'bash.exe'),
];

describe('classifyOrphans', () => {
  it('never lists the root, console host, launch loop, agent or its live tool calls', () => {
    expect(classifyOrphans(ROOT, sessionTree, new Set())).toEqual([]);
  });

  it('lists a process whose parent is gone, with its live descendants', () => {
    const members = [...sessionTree, m(110, 999, 2000, 'gone', undefined, 'find.exe'), m(111, 110, 2001, 'alive', 2000, 'grep.exe')];
    expect(classifyOrphans(ROOT, members, new Set())).toEqual([
      { pid: 110, name: 'find.exe', createdAt: 2000, cpuMs: 110, descendants: [{ pid: 111, name: 'grep.exe', createdAt: 2001, cpuMs: 111 }] },
    ]);
  });

  it('lists a process whose parent pid was reused by a later process', () => {
    const members = [...sessionTree, m(120, 104, 900, 'alive', 1004)];
    expect(classifyOrphans(ROOT, members, new Set()).map((o) => o.pid)).toEqual([120]);
  });

  it('never lists a process whose parent cannot be opened, or that is not alive', () => {
    const unknownParent = m(130, 7, 2000, 'unknown');
    const exited: JobMemberProcess = { pid: 131, ppid: 999, state: 'gone', parent: 'gone' };
    const noTime: JobMemberProcess = { pid: 132, ppid: 999, state: 'alive', parent: 'gone' };
    expect(classifyOrphans(ROOT, [...sessionTree, unknownParent, exited, noTime], new Set())).toEqual([]);
  });

  it('never lists a console host, as an orphan or a descendant', () => {
    const members = [
      ...sessionTree,
      m(150, 999, 2000, 'gone', undefined, 'conhost.exe'),
      m(151, 998, 2001, 'gone', undefined, 'cmd.exe'),
      m(152, 151, 2002, 'alive', 2001, 'OpenConsole.exe'),
    ];
    expect(classifyOrphans(ROOT, members, new Set())).toEqual([{ pid: 151, name: 'cmd.exe', createdAt: 2001, cpuMs: 151, descendants: [] }]);
  });

  it('never lists a protected process', () => {
    const members = [...sessionTree, m(140, 999, 2000, 'gone')];
    expect(classifyOrphans(ROOT, members, new Set([140]))).toEqual([]);
  });

  it('hasDeadParent needs a known later parent for reuse', () => {
    expect(hasDeadParent({ ...m(1, 2, 10, 'alive', 5), createdAt: 10 })).toBe(false);
    expect(hasDeadParent({ ...m(1, 2, 10, 'alive', 50), createdAt: 10 })).toBe(true);
    expect(hasDeadParent({ pid: 1, state: 'alive', createdAt: 10, parent: 'alive' })).toBe(false);
  });

  it('withLiveDescendants follows only live parent links', () => {
    const members = [m(1, 0, 10, 'gone'), m(2, 1, 11, 'alive', 10), m(3, 2, 12, 'alive', 11), m(4, 999, 13, 'gone')];
    expect([...withLiveDescendants(members, [1])].sort()).toEqual([1, 2, 3]);
  });
});

// ── Tower listing and ending ───────────────────────────────────────────────

const WS = 'C:\\repo';
const SHELLPER_CMD = 'C:\\node\\node.exe C:\\codev\\dist\\terminal\\shellper-main.js "{}"';
const TOWER_CMD = 'C:\\node\\node.exe C:\\codev\\dist\\agent-farm\\servers\\tower-server.js 4300';

function census(entries: Array<[number, number, string]>): ProcessCensusEntry[] {
  return entries.map(([pid, ppid, cmdline]) => ({ pid, ppid, cmdline, rssKb: 0, creationTime: pid }));
}

function harness(opts: {
  sessions: OrphanSessionRef[];
  jobs: Record<string, JobMemberProcess[]>;
  census?: ProcessCensusEntry[] | Error;
  infrastructurePids?: number[];
  shellperJobs?: Record<number, string>;
}) {
  const jobMembers = vi.fn(async (name: string, rootPid: number): Promise<JobMembersOutcome> => {
    const members = opts.jobs[name];
    if (!members) return { ok: true, found: false, member: false, processes: [] };
    if (!members.some((p) => p.pid === rootPid)) return { ok: true, found: true, member: false, processes: [] };
    return { ok: true, found: true, member: true, processes: members };
  });
  const censusFn = vi.fn(async () => {
    if (opts.census instanceof Error) throw opts.census;
    return opts.census ?? [];
  });
  const deps: OrphanDeps = {
    helper: () => ({ jobMembers }),
    sessions: () => opts.sessions,
    infrastructurePids: () => opts.infrastructurePids ?? [],
    census: censusFn,
    shellperJobName: (cmdline) => {
      for (const [pid, name] of Object.entries(opts.shellperJobs ?? {})) if (cmdline.includes(`#${pid}`)) return name;
      return null;
    },
  };
  return { deps, jobMembers, census: censusFn };
}

const builder: OrphanSessionRef = { workspacePath: WS, terminalId: 't-b', agent: 'pir-1', kind: 'builder', rootPid: 100, jobName: 'J-b' };
const architect: OrphanSessionRef = { workspacePath: WS, terminalId: 't-a', agent: 'main', kind: 'architect', rootPid: 200, jobName: 'J-a' };

describe('listOrphans (Tower)', () => {
  it('lists a session\'s orphan, reading the census only when there is a candidate', async () => {
    const h = harness({
      sessions: [builder, architect],
      jobs: { 'J-b': [...sessionTree, m(110, 999, 2000, 'gone', undefined, 'find.exe')], 'J-a': [m(200, 1, 500, 'alive', 1)] },
      census: census([[100, 1, SHELLPER_CMD], [110, 999, 'find.exe / -name x']]),
    });
    const listing = await listOrphans(h.deps);
    expect(listing.supported).toBe(true);
    expect(listing.sessions.map((s) => [s.agent, s.job, s.orphans.map((o) => o.pid)])).toEqual([['pir-1', true, [110]], ['main', true, []]]);
    expect(h.census).toHaveBeenCalledTimes(1);
  });

  it('never lists Tower, its helper or IDE server, nor their descendants', async () => {
    // A Tower (300) started from inside the builder's session, its helper (301) and IDE server (302, child of 303 which is gone).
    const h = harness({
      sessions: [builder],
      jobs: { 'J-b': [...sessionTree, m(300, 999, 2000, 'gone'), m(301, 300, 2001, 'alive', 2000), m(302, 998, 2002, 'gone'), m(304, 302, 2003, 'alive', 2002)] },
      infrastructurePids: [300, 301, 302],
      census: census([[300, 999, TOWER_CMD]]),
    });
    expect((await listOrphans(h.deps)).sessions[0].orphans).toEqual([]);
  });

  it('never lists a nested session\'s shellper, agent or that session\'s own orphans', async () => {
    // Session 400 (known to Tower) was created by a Tower inside the builder's job; its job members are subtracted.
    const nested: OrphanSessionRef = { workspacePath: 'C:\\other', terminalId: 't-n', agent: 'other', kind: 'builder', rootPid: 400, jobName: 'J-n' };
    const nestedMembers = [m(400, 999, 3000, 'gone'), m(401, 400, 3001, 'alive', 3000), m(402, 997, 3002, 'gone')];
    const h = harness({
      sessions: [builder, nested],
      jobs: { 'J-b': [...sessionTree, ...nestedMembers], 'J-n': nestedMembers },
      census: census([]),
    });
    const listing = await listOrphans(h.deps, (ws) => ws === WS);
    expect(listing.sessions.map((s) => s.agent)).toEqual(['pir-1']);
    expect(listing.sessions[0].orphans).toEqual([]);
  });

  it('never lists a Tower or a shellper Tower does not know (a husk), found by command line, with its job and descendants', async () => {
    const h = harness({
      sessions: [builder],
      jobs: {
        'J-b': [...sessionTree, m(500, 999, 2000, 'gone'), m(501, 500, 2001, 'alive', 2000), m(502, 996, 2002, 'gone'), m(600, 995, 2003, 'gone')],
        'J-husk': [m(500, 999, 2000, 'gone'), m(502, 996, 2002, 'gone')],
      },
      census: census([[500, 999, `${SHELLPER_CMD} #500`], [600, 995, TOWER_CMD]]),
      shellperJobs: { 500: 'J-husk' },
    });
    expect((await listOrphans(h.deps)).sessions[0].orphans).toEqual([]);
  });

  it('lists nothing when the census fails, and says why', async () => {
    const h = harness({ sessions: [builder], jobs: { 'J-b': [...sessionTree, m(110, 999, 2000, 'gone')] }, census: new Error('cim down') });
    const row = (await listOrphans(h.deps)).sessions[0];
    expect(row.orphans).toEqual([]);
    expect(row.error).toMatch(/nothing is listed: cim down/);
  });

  it('reports a session without a job, and a missing helper', async () => {
    const h = harness({ sessions: [builder], jobs: {} });
    expect((await listOrphans(h.deps)).sessions[0]).toMatchObject({ job: false, orphans: [] });
    const noHelper = { ...h.deps, helper: () => null };
    expect((await listOrphans(noHelper)).sessions[0]).toMatchObject({ job: false, error: 'no job helper is running' });
  });
});
