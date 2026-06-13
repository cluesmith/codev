/**
 * vscode-free logic for the startup CLI preflight (#791).
 *
 * Kept free of any `vscode` import so it can be unit-tested under vitest
 * (`src/__tests__/preflight-core.test.ts`). This includes the `codev --version`
 * probe (`runCodevVersion`): it only needs `spawn` + a timer, no vscode, so it
 * lives here where it's directly testable. The genuinely vscode-dependent glue
 * — reading the timeout setting, toasts, walkthrough, the Status-view row —
 * lives in `preflight.ts` and is reviewed by running the worktree.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Default hard cap on the `codev --version` probe so a hung binary can't stall
 * startup. Bumped from 400ms to 5000ms (#1024): 400ms was too tight against the
 * legitimate latency sources on slow envs (remote SSH, WSL, nvm/fnm/volta shim
 * re-resolution, AV scanning, network filesystems), causing a false `missing`
 * → the `Get started with Codev` walkthrough opening despite a healthy install.
 * Overridable per-workspace via the `codev.cliVersionTimeoutMs` setting.
 */
export const DEFAULT_VERSION_TIMEOUT_MS = 5000;

/**
 * Spawn `codev --version` with a hard timeout. Resolves `{ ok, stdout, timedOut }`;
 * `ok` is false on spawn error (binary not on PATH), non-zero exit, or timeout
 * (the child is killed). `timedOut` distinguishes the timeout case so the glue
 * can log it — the false-`missing` symptom #1024 is about — distinctly from a
 * genuinely absent / broken binary.
 */
export function runCodevVersion(
  codevPath: string,
  cwd: string | null,
  timeoutMs: number = DEFAULT_VERSION_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string; timedOut: boolean }> {
  return new Promise((resolveResult) => {
    let stdout = '';
    let settled = false;
    const finish = (ok: boolean, timedOut: boolean) => {
      if (!settled) {
        settled = true;
        resolveResult({ ok, stdout, timedOut });
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(codevPath, ['--version'], { cwd: cwd ?? undefined });
    } catch {
      finish(false, false);
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(false, true);
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.on('error', () => { clearTimeout(timer); finish(false, false); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0, false); });
  });
}

/**
 * The outcome of a preflight check.
 *
 * - `ok`       — the codev CLI is installed and its version is >= the extension's.
 * - `missing`  — the CLI could not be resolved, or `--version` failed / was
 *                unparseable. Treated as first-run / setup-required.
 * - `outdated` — the CLI is installed but older than the extension.
 */
export type PreflightStatus = 'ok' | 'missing' | 'outdated';

/** Parsed semver triple; suffixes (`-rc.1`, `+build`) are dropped. */
type SemverTriple = [number, number, number];

/**
 * Extract the first `X.Y.Z` from a string, ignoring a leading `v` and any
 * `-prerelease` / `+build` suffix. Returns `null` when no triple is present.
 */
export function parseSemver(raw: string): SemverTriple | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Numeric major/minor/patch comparison. Pre-release / build suffixes are
 * ignored (stripped by `parseSemver`). Unparseable inputs sort *before*
 * parseable ones so a garbage CLI version compares as "less than" the
 * extension — i.e. conservatively triggers an upgrade prompt.
 *
 * Returns -1 if `a < b`, 1 if `a > b`, 0 if equal.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) { return 0; }
  if (!pa) { return -1; }
  if (!pb) { return 1; }
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) { return -1; }
    if (pa[i] > pb[i]) { return 1; }
  }
  return 0;
}

/**
 * Pull the version token out of `codev --version` stdout. Commander's
 * `program.version()` emits a bare `X.Y.Z\n`, but we trim and re-parse
 * defensively in case the output is wrapped or empty. Returns `null` when
 * no version can be found.
 */
export function parseCliVersion(stdout: string): string | null {
  const triple = parseSemver(stdout.trim());
  return triple ? triple.join('.') : null;
}

/**
 * Resolve the `codev` binary path, mirroring `resolveAfxPath` in
 * `tower-starter.ts`: prefer the workspace-local `node_modules/.bin/codev`,
 * else fall back to the bare name on `PATH`.
 *
 * `existsFn` is injected so this stays pure and unit-testable (the caller
 * passes `existsSync`).
 */
export function resolveCodevPath(
  workspacePath: string | null,
  existsFn: (p: string) => boolean,
): string {
  if (workspacePath) {
    const localPath = resolve(workspacePath, 'node_modules', '.bin', 'codev');
    if (existsFn(localPath)) {
      return localPath;
    }
  }
  return 'codev';
}

/**
 * Decide the preflight status from the resolved facts. The single source of
 * truth for the minimum version is the extension's own `package.json`
 * `version` (`extVersion`) — same-or-higher is the rule.
 */
export function decidePreflight(input: {
  cliFound: boolean;
  cliVersion: string | null;
  extVersion: string;
}): PreflightStatus {
  if (!input.cliFound || !input.cliVersion) {
    return 'missing';
  }
  return compareSemver(input.cliVersion, input.extVersion) < 0 ? 'outdated' : 'ok';
}

/**
 * Ephemeral status-bar text shown when a guarded command is rejected for a
 * non-ok preflight status, after the first-click modal has already fired this
 * session (see `showPreflightFeedback` in `preflight.ts`). Names the current
 * problem and the recovery command so the click reads as registered, not as a
 * silent no-op. Kept pure so the wording is unit-tested without a vscode mock.
 * The Tower-version dimension (#983) is a separate surface — see
 * `towerDivergenceMessage` below — rather than an overload of this CLI helper.
 */
export function preflightFeedbackMessage(status: PreflightStatus): string {
  const label = status === 'outdated' ? 'outdated' : 'not installed';
  return `Codev: CLI ${label}. Run "Codev: Recheck CLI" when ready.`;
}

// ---------------------------------------------------------------------------
// Tower-version dimension (#983)
//
// The CLI preflight above inspects the on-disk binary. This second dimension
// inspects the *running* Tower process via `GET /api/version`. After an
// `npm install -g` upgrade without a Tower restart the two diverge: the disk
// binary is current but Tower still serves the old in-memory code. These pure
// helpers decide the divergence state and word the toast; the vscode glue in
// `preflight.ts` owns the probe, caching, and the `Restart Tower` action.
// ---------------------------------------------------------------------------

/**
 * The Tower-version dimension of the preflight.
 *
 * - `ok`          — running Tower is at least as new as both the installed CLI
 *                   and the extension's expected version. No signal.
 * - `stale`       — running Tower is older than the installed CLI and/or the
 *                   extension. The user upgraded (or this build needs newer)
 *                   but Tower is still on old in-memory code. Prompt a restart.
 * - `too-old`     — the probe returned 404: this Tower predates the
 *                   `/api/version` endpoint entirely. Prompt a restart, with
 *                   stronger wording.
 * - `unreachable` — the probe could not reach Tower. Defer to the existing
 *                   "not connected to Tower" path; no new signal.
 * - `pending`     — the probe has not completed yet.
 */
export type TowerStatus = 'ok' | 'stale' | 'too-old' | 'unreachable' | 'pending';

/**
 * Decide the Tower-version dimension from the probe outcome and the *installed
 * CLI* version. The divergence rule is `running < installedCli` — i.e. the
 * user upgraded the on-disk binary but Tower is still serving the old
 * in-memory code. That is the only case a Tower **restart** actually fixes
 * (it reloads the installed binary).
 *
 * Deliberately **not** compared against the extension's own version: a Tower
 * older than the extension but equal to the installed CLI cannot be fixed by a
 * restart (there's no newer code on disk to load) — that's the installed CLI
 * being behind the extension, which the #791 CLI preflight already surfaces as
 * an "update the CLI" toast. Folding it in here produced a futile "Restart
 * Tower" prompt with a version that isn't actually installed.
 *
 * A running Tower *newer* than the installed CLI (local-dev / global-install
 * lag) is likewise not flagged, so the healthy path stays silent. When the
 * installed CLI version is unknown there's no basis for a restart, so the
 * caller suppresses the toast.
 *
 * `probeStatus` is the raw HTTP status from `TowerClient.getVersion()`
 * (`0` = unreachable, `404` = endpoint absent, `200` = reported).
 */
export function decideTowerStatus(input: {
  probeStatus: number;
  runningVersion: string | null;
  installedCli: string | null;
  cliStatus: PreflightStatus | 'pending';
}): TowerStatus {
  if (input.probeStatus === 404) {
    // Tower predates the /api/version endpoint. A restart only helps if the
    // installed CLI is current enough to include the endpoint — otherwise it
    // reloads the same endpoint-less code and the 404 (and prompt) recur. A
    // stale/missing installed CLI is the #791 CLI preflight's concern (its
    // "update the CLI" toast is the real remedy), so suppress the Tower prompt
    // here rather than recommend a futile restart. (`cliStatus === 'ok'` means
    // the installed CLI is >= this extension, which expects the endpoint.)
    return input.cliStatus === 'ok' ? 'too-old' : 'ok';
  }
  if (input.probeStatus !== 200 || !input.runningVersion) {
    return 'unreachable';
  }
  // `stale` is not gated on cliStatus: running < installedCli means a restart
  // loads a genuinely newer (endpoint-having, since the 200 proves the older
  // running Tower already has it) version, which is actionable even when the
  // installed CLI is itself behind the extension.
  if (input.installedCli && compareSemver(input.runningVersion, input.installedCli) < 0) {
    return 'stale';
  }
  return 'ok';
}

/**
 * Toast wording for a divergent Tower (`stale` / `too-old`). The action button
 * itself is attached by the vscode glue; this is just the message body, kept
 * pure so the wording is unit-tested without a vscode mock. `installedVersion`
 * is the on-disk CLI version a restart would load — so "X is installed" is
 * literally true. When the Tower is non-local (tunnelled / remote `towerHost`)
 * the local `Restart Tower` action would target the wrong machine, so the
 * wording names the host instead.
 */
export function towerDivergenceMessage(input: {
  status: 'stale' | 'too-old';
  runningVersion: string | null;
  installedVersion: string;
  hostIsLocal: boolean;
  host: string;
}): string {
  const runningClause = input.status === 'too-old'
    ? 'Codev Tower is running code too old to report its version'
    : `Codev Tower is running ${input.runningVersion ?? '(unknown)'}`;
  const restartClause = input.hostIsLocal
    ? 'Restart Tower to load it.'
    : `Restart the Tower on ${input.host} to load it.`;
  return `${runningClause}, but ${input.installedVersion} is installed. ${restartClause}`;
}
