#!/usr/bin/env node
// Fixture driver for the cockpit harness. harness.mjs runs it as a child process whose environment
// is the isolated one (CODEV_AGENT_FARM_DIR, scratch HOME, NODE_ENV/AF_TEST_DB pinned), because the
// branch's dist resolves its database from the environment at import time.
//
// It creates state only through:
//   - explicit-port HTTP calls to the isolated Tower (workspace activation, builder terminals);
//   - the product's own in-process writers from the branch's built dist (porch state, the
//     `builders` row through `upsertBuilder`, as `afx spawn` writes it);
//   - git, in fixture repos under the harness's fixtures dir.
// It runs no Tower-contacting `afx` / `porch` command: those default to :4100.
//
//   node fixtures.mjs probe                → JSON { agentFarmDir, globalDbPath } (writes nothing)
//   node fixtures.mjs seed <scenario>      → re-checks gate 3, then seeds the scenario
//
// SCENARIOS is also imported by harness.mjs (for the gate-6 expectations); the dist modules are
// imported lazily so that import loads nothing from the product.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REFUSAL_EXIT_CODE, Refusal, gateDbAgreement } from './preflight.mjs';
import { run } from './procs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../../../..');
export const CODEV_DIST = path.join(REPO, 'packages/codev/dist');

/** Every fixture session is a plain shell: never an agent. */
export const PLAIN_SHELL = ['/bin/bash', '--noprofile', '--norc'];
const PLAIN_HARNESS = 'cockpit-plain-shell';

/** Phase 5's dev config: a long-running no-op dev command and two dev URLs (never opened for real). */
const DEV_CONFIG = {
  devCommand: 'sleep 3600',
  devUrls: [{ label: 'App', url: 'http://127.0.0.1:18799/' }, { label: 'Admin', url: 'http://127.0.0.1:18799/admin' }],
};

/**
 * Scenarios. A workspace is a git repo under the fixtures dir; `activate` starts it in the isolated
 * Tower (which starts `main`). A builder gets a worktree, porch state, a live builder terminal and
 * a `builders` row carrying `architect` as spawned_by_architect.
 *
 * Optional workspace fields:
 * - `siblings`: architects added after activation through Tower's own add-architect route;
 * - `deactivate`: activate, then deactivate, so Tower lists it as dormant;
 * - `worktree`: merged into the fixture's `.codev/config.json` as its `worktree` block, committed
 *   before any builder branches;
 * - `decisions`: write the pending-decisions file (`DECISIONS_FILE`) and its image, so the
 *   Decisions surfaces have an open item to rule on. A workspace without it has no decisions file;
 * - `forge`: point the PR and issue concepts at fixed JSON (`forgeFixture`), committed with the
 *   spec, plan and review files those items name, so Work's Needs Attention, Backlog and Recently
 *   Closed have rows. A workspace without it has no forge (the `gh` concepts fail, as on a
 *   machine without `gh`).
 *
 * Optional builder fields:
 * - `gate`: a human gate porch has requested (`status: pending` + `requested_at`), so the builder
 *   is blocked on it;
 * - `spec`: commit a spec file, so *View Spec* has something to open;
 * - `changedFile`: commit a file on the builder branch, so the builder has a changed file.
 */
export const SCENARIOS = {
  empty: {
    workspaces: [{ name: 'alpha', activate: false, architects: [], builders: [] }],
  },
  'one-builder': {
    workspaces: [{
      name: 'alpha',
      activate: true,
      architects: ['main'],
      builders: [{ project: '101', slug: 'fixture-one', architect: 'main' }],
    }],
  },
  // Phase 5: this window's workspace (alpha) with N>1 builders across main and a sibling, one
  // gated; beta with N=1; gamma with N=0; delta dormant.
  fleet: {
    workspaces: [
      {
        name: 'alpha',
        activate: true,
        siblings: ['web'],
        architects: ['main', 'web'],
        worktree: DEV_CONFIG,
        decisions: true,
        forge: true,
        builders: [
          { project: '101', slug: 'gated-spec', architect: 'main', gate: 'spec-approval', spec: true, changedFile: 'src/feature/alpha.ts' },
          { project: '102', slug: 'second-main', architect: 'main' },
          { project: '103', slug: 'web-work', architect: 'web' },
        ],
      },
      { name: 'beta', activate: true, architects: ['main'], builders: [{ project: '201', slug: 'beta-one', architect: 'main' }] },
      { name: 'gamma', activate: true, architects: ['main'], builders: [] },
      { name: 'delta', activate: true, deactivate: true, architects: [], builders: [] },
    ],
  },
};

/** Where Tower reads a workspace's decisions file when its config names none. */
export const DECISIONS_FILE = 'codev/state/pending-decisions.md';

/**
 * Phase 6's decisions file: `main-1` is open and writable, with an image (a workspace path the
 * Decisions view loads through Tower) and an http(s) link; `web-1` already has a ruling written
 * under it; `## Ruled` holds one line.
 */
export const DECISIONS_DOC = `# Pending owner decisions — all architects (hub: main)

Rule inline: one word on the line under an item's **Your word:** line, or in the Decisions tab.
Newest first. Only main edits this file; architects send items with \`afx send architect:main 'DECISION …'\`.

_Status: 2 open — main-1, web-1._
_Zone: UTC_

## Open

### main-1 · 2026-11-20 09:30 UTC · Should the fixture board show builders compact or stacked?

- **Context:** a fixture decision for the cockpit harness.
- **Options:** (a) \`compact\` = one row per builder (b) \`stacked\` = a card per builder
- **Links:** https://example.com/fixture/main-1

![Compact board](decision-assets/main-1-compact.svg)

**Your word:** \`compact\` / \`stacked\` / \`hold\`

### web-1 · 2026-11-20 08:00 UTC · Ship the web fixture now?

- **Context:** an item that already has a ruling written under it.

**Your word:** \`ship\` / \`hold\`
hold

## Ruled

- **main-0** · ruled \`keep\` — the first fixture decision.
`;

const DECISIONS_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">
<rect width="240" height="120" fill="#2b6cb0"/><rect x="16" y="20" width="208" height="16" fill="#bee3f8"/>
<rect x="16" y="52" width="208" height="16" fill="#bee3f8"/><rect x="16" y="84" width="208" height="16" fill="#bee3f8"/>
</svg>
`;

function writeDecisions(dir) {
  const file = path.join(dir, DECISIONS_FILE);
  fs.mkdirSync(path.join(path.dirname(file), 'decision-assets'), { recursive: true });
  fs.writeFileSync(file, DECISIONS_DOC);
  fs.writeFileSync(path.join(path.dirname(file), 'decision-assets', 'main-1-compact.svg'), DECISIONS_IMAGE);
}

/**
 * Phase 6's forge data, as the PR and issue concept commands print it. Times are relative to the
 * seed, because the overview keeps only issues closed in the last 24 hours.
 * - PR #301 is human-authored and awaits review: a Needs Attention row with a link.
 * - Issues #401 (spec and plan written) and #402 (a bug) are the backlog. The builders' issues
 *   (#101–#103) are open too, and the overview leaves them out of the backlog.
 * - Issue #399 closed an hour ago, with a review written and merged PR #398 naming it.
 */
export function forgeFixture(now = Date.now()) {
  const iso = (hoursAgo) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const url = (kind, n) => `https://example.com/fixture/${kind}/${n}`;
  const issue = (n, title, labels, hoursAgo) => ({ number: n, title, url: url('issues', n), labels: labels.map((name) => ({ name })), createdAt: iso(hoursAgo), author: { login: 'fixture-owner' }, assignees: [] });
  return {
    concepts: {
      'pr-list': [{ number: 301, title: 'Fixture: a human-authored change', url: url('pull', 301), reviewDecision: 'REVIEW_REQUIRED', body: '', createdAt: iso(5), author: { login: 'fixture-human' }, reviewRequests: [], isDraft: false }],
      'issue-list': [
        issue(401, 'Fixture backlog feature', ['type:project', 'priority:high'], 72),
        issue(402, 'Fixture backlog bug', ['type:bug'], 30),
        issue(101, 'gated-spec', [], 96), issue(102, 'second-main', [], 96), issue(103, 'web-work', [], 96),
      ],
      'recently-closed': [{ ...issue(399, 'Fixture closed feature', ['type:project'], 120), closedAt: iso(1) }],
      'recently-merged': [{ number: 398, title: 'Fixture: close the feature', url: url('pull', 398), reviewDecision: 'APPROVED', body: 'Fixes #399', createdAt: iso(3), mergedAt: iso(1), author: { login: 'fixture-human' }, reviewRequests: [], isDraft: false }],
    },
    files: {
      'codev/specs/401-fixture-backlog.md': '# Spec 401: fixture backlog feature\n\nCockpit-harness fixture spec.\n',
      'codev/plans/401-fixture-backlog.md': '# Plan 401: fixture backlog feature\n\nCockpit-harness fixture plan.\n',
      'codev/reviews/399-fixture-closed.md': '# Review 399: fixture closed feature\n\nCockpit-harness fixture review.\n',
    },
  };
}

/** Write the forge fixture's JSON and artifact files, and point the concepts at the JSON. */
function writeForge(dir) {
  const { concepts, files } = forgeFixture();
  const forgeDir = path.join(dir, '.codev', 'forge');
  fs.mkdirSync(forgeDir, { recursive: true });
  const forge = {};
  for (const [concept, data] of Object.entries(concepts)) {
    const file = path.join(forgeDir, `${concept}.json`);
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    forge[concept] = `cat '${file}'`;
  }
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const configFile = path.join(dir, '.codev', 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  config.forge = forge;
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  git(dir, ['add', '.codev/config.json', '.codev/forge', ...Object.keys(files)]);
  git(dir, ['commit', '-q', '-m', 'fixture: forge data']);
}

export const roleIdFor = (builder) => `builder-spir-${builder.project}`;

/** The gate-6 expectation for a scenario workspace. */
export function expectedOverview(ws) {
  return {
    architects: ws.architects,
    builders: ws.builders.map((b) => ({ roleId: roleIdFor(b), spawnedByArchitect: b.architect })),
  };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (fixtures.mjs runs only under harness.mjs)`);
  return value;
}

async function loadDist(rel) {
  return import(pathToFileURL(path.join(CODEV_DIST, rel)).href);
}

/** What the branch's dist resolves in this process's environment. Writes nothing. */
async function probe() {
  const { AGENT_FARM_DIR } = await loadDist('agent-farm/lib/tower-client.js');
  const { getGlobalDbPath } = await loadDist('agent-farm/db/index.js');
  return { agentFarmDir: AGENT_FARM_DIR, globalDbPath: getGlobalDbPath() };
}

function git(cwd, args) {
  const r = run('git', ['-c', 'user.name=cockpit-harness', '-c', 'user.email=cockpit-harness@localhost', ...args], { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr}`);
  return r.stdout;
}

function ensureWorkspaceRepo(dir) {
  if (fs.existsSync(path.join(dir, '.git'))) return;
  fs.mkdirSync(path.join(dir, 'codev', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.codev'), { recursive: true });
  const shell = PLAIN_SHELL.join(' ');
  const config = {
    shell: {
      architect: shell,
      builder: shell,
      shell,
      architectHarness: PLAIN_HARNESS,
      builderHarness: PLAIN_HARNESS,
    },
    harness: { [PLAIN_HARNESS]: { roleArgs: [], roleScriptFragment: '' } },
  };
  fs.writeFileSync(path.join(dir, '.codev', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'codev', 'README.md'), `# ${path.basename(dir)}\n\nCockpit-harness fixture workspace.\n`);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.builders/\n.architect-role.md\n');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '.gitignore', '.codev/config.json', 'codev/README.md']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
}

function tower() {
  const port = Number(requireEnv('COCKPIT_TOWER_PORT'));
  const key = requireEnv('COCKPIT_TOWER_KEY');
  return async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'codev-tower-key': key, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${route} answered ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  };
}

/** Merge `worktree` into the fixture's committed `.codev/config.json`. */
function writeWorktreeConfig(dir, worktree) {
  const file = path.join(dir, '.codev', 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf-8'));
  config.worktree = { ...(config.worktree ?? {}), ...worktree };
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  git(dir, ['add', '.codev/config.json']);
  git(dir, ['commit', '-q', '-m', 'fixture: worktree config']);
}

async function addSibling(call, dir, name) {
  const enc = Buffer.from(dir).toString('base64url');
  const result = await call('POST', `/api/workspaces/${enc}/architects`, { name });
  if (!result.success) throw new Error(`adding architect '${name}' to ${dir} failed: ${JSON.stringify(result)}`);
}

async function deactivate(call, dir) {
  const enc = Buffer.from(dir).toString('base64url');
  await call('POST', `/api/workspaces/${enc}/deactivate`, {});
}

async function activate(call, dir) {
  const enc = Buffer.from(dir).toString('base64url');
  const result = await call('POST', `/api/workspaces/${enc}/activate`, {});
  if (!result.success) throw new Error(`activating ${dir} failed: ${JSON.stringify(result)}`);
  if (result.adopted) throw new Error(`activating ${dir} ran codev adopt; the fixture should already be a codev workspace`);
}

async function seedBuilder(call, wsDir, builder) {
  const name = `spir-${builder.project}`;
  const worktree = path.join(wsDir, '.builders', name);
  const branch = `builder/${name}`;
  if (fs.existsSync(worktree)) throw new Error(`${worktree} already exists; seed scenarios onto a fresh harness`);
  git(wsDir, ['worktree', 'add', '-q', '-b', branch, worktree]);
  const committed = [];
  if (builder.spec) {
    const spec = path.join('codev', 'specs', `${builder.project}-${builder.slug}.md`);
    fs.mkdirSync(path.join(worktree, path.dirname(spec)), { recursive: true });
    fs.writeFileSync(path.join(worktree, spec), `# Spec ${builder.project}: ${builder.slug}\n\nCockpit-harness fixture spec.\n`);
    committed.push(spec);
  }
  if (builder.changedFile) {
    fs.mkdirSync(path.join(worktree, path.dirname(builder.changedFile)), { recursive: true });
    fs.writeFileSync(path.join(worktree, builder.changedFile), `export const fixture = '${builder.slug}';\n`);
    committed.push(builder.changedFile);
  }
  if (committed.length) {
    git(worktree, ['add', ...committed]);
    git(worktree, ['commit', '-q', '-m', `fixture: ${builder.slug}`]);
  }

  const { loadProtocol } = await loadDist('commands/porch/protocol.js');
  const { createInitialState, getStatusPath, writeState } = await loadDist('commands/porch/state.js');
  const protocol = loadProtocol(worktree, 'spir');
  const state = createInitialState(protocol, builder.project, builder.slug, worktree);
  if (builder.gate) {
    if (!state.gates[builder.gate]) throw new Error(`protocol spir has no gate '${builder.gate}'`);
    state.gates[builder.gate] = { ...state.gates[builder.gate], status: 'pending', requested_at: new Date().toISOString() };
  }
  writeState(getStatusPath(worktree, builder.project, builder.slug), state);

  const roleId = roleIdFor(builder);
  const [command, ...args] = PLAIN_SHELL;
  const terminal = await call('POST', '/api/terminals', {
    command, args, cwd: worktree, type: 'builder', roleId, workspacePath: wsDir, persistent: true, label: `Builder ${name}`,
  });
  if (terminal.persistent !== true) throw new Error(`builder terminal for ${roleId} is not shellper-backed: ${JSON.stringify(terminal)}`);

  const { upsertBuilder } = await loadDist('agent-farm/state.js');
  upsertBuilder({
    id: roleId, name: builder.slug, status: 'implementing', phase: 'init',
    worktree, branch, type: 'spec', issueNumber: builder.project, terminalId: terminal.id,
    spawnedByArchitect: builder.architect,
  });
}

async function seed(scenarioName) {
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) throw new Error(`unknown scenario '${scenarioName}' (known: ${Object.keys(SCENARIOS).join(', ')})`);

  // Gate 3, re-checked in this process before it writes anything.
  const driver = await probe();
  gateDbAgreement({ driver, agentFarmDir: requireEnv('COCKPIT_EXPECT_AGENT_FARM_DIR'), towerPid: Number(requireEnv('COCKPIT_TOWER_PID')) });

  const fixturesDir = requireEnv('COCKPIT_FIXTURES_DIR');
  const call = tower();
  for (const ws of scenario.workspaces) {
    const dir = path.join(fixturesDir, ws.name);
    ensureWorkspaceRepo(dir);
    if (ws.worktree) writeWorktreeConfig(dir, ws.worktree);
    if (ws.forge) writeForge(dir);
    if (ws.decisions) writeDecisions(dir);
    if (ws.activate) await activate(call, dir);
    for (const name of ws.siblings ?? []) await addSibling(call, dir, name);
    for (const builder of ws.builders) await seedBuilder(call, dir, builder);
    if (ws.deactivate) await deactivate(call, dir);
  }
  const { closeAllDbs } = await loadDist('agent-farm/db/index.js');
  closeAllDbs();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, arg] = process.argv.slice(2);
  const main = async () => {
    if (cmd === 'probe') console.log(JSON.stringify(await probe()));
    else if (cmd === 'seed') await seed(arg);
    else throw new Error('usage: fixtures.mjs probe | seed <scenario>');
  };
  main().catch((err) => {
    console.error(err instanceof Refusal ? err.message : `fixtures error: ${err.stack ?? err}`);
    process.exit(err instanceof Refusal ? REFUSAL_EXIT_CODE : 1);
  });
}
