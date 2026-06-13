/**
 * Startup CLI preflight (#791) — vscode glue around the pure logic in
 * `preflight-core.ts`.
 *
 * On activation the extension fires `runPreflight` (fire-and-forget) to verify
 * the `codev` CLI is installed and at least as new as the extension itself
 * (the extension's own `package.json` `version` is the source of truth). The
 * result is cached for the session; the command guard in `extension.ts` reads
 * it via `isCliReady`. Depending on the outcome we either open the
 * `Get started with Codev` walkthrough (missing CLI), show an upgrade
 * notification (outdated CLI), or do nothing (ok).
 *
 * A single `codev.recheckCli` command re-runs the whole flow; it is surfaced
 * from the Status-view row, the post-install follow-up toast, and the
 * walkthrough's Verify step.
 */

import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import type { TowerClient } from '@cluesmith/codev-core/tower-client';
import {
  decidePreflight,
  decideTowerStatus,
  DEFAULT_VERSION_TIMEOUT_MS,
  parseCliVersion,
  preflightFeedbackMessage,
  resolveCodevPath,
  runCodevVersion,
  towerDivergenceMessage,
  type PreflightStatus,
  type TowerStatus,
} from './preflight-core.js';
import { getTowerAddress } from '../workspace-detector.js';
import { restartTower } from '../tower-starter.js';

/** Fully-qualified walkthrough id: `<publisher>.<name>#<walkthroughId>`. */
const WALKTHROUGH_ID = 'cluesmith.codev-vscode#codevGettingStarted';
/** workspaceState key gating the once-per-workspace auto-open of the walkthrough. */
const WALKTHROUGH_SHOWN_KEY = 'codev.preflight.walkthroughShown';
/** Install docs surfaced from the outdated-CLI notification and walkthrough. */
export const INSTALL_DOCS_URL = 'https://github.com/cluesmith/codev#quick-start';
/** The setting that overrides the `codev --version` probe timeout (#1024). */
const VERSION_TIMEOUT_SETTING = 'cliVersionTimeoutMs';
/** The command users / UI invoke to re-verify after fixing the CLI. */
export const RECHECK_COMMAND = 'codev.recheckCli';

/** What the Status-view row renders. */
export interface PreflightState {
  status: PreflightStatus | 'pending';
  cliVersion: string | null;
  /** #983 Tower-version dimension (additive — existing consumers ignore these). */
  towerStatus: TowerStatus;
  /** Version reported by the *running* Tower process, or null if not probed. */
  runningVersion: string | null;
  /** Whether the configured Tower host is local (gates the `Restart Tower` action). */
  hostIsLocal: boolean;
}

let cachedStatus: PreflightStatus | 'pending' = 'pending';
let cachedVersion: string | null = null;
let modalShownThisSession = false;

// #983 Tower-version dimension. Cached alongside the CLI dimension and surfaced
// via getPreflightState() / onPreflightChange.
let cachedTowerStatus: TowerStatus = 'pending';
let cachedRunningVersion: string | null = null;
let cachedHostIsLocal = true;
/** Mirrors `modalShownThisSession` for the Tower toast (modal-first, then ephemeral). */
let towerDivergenceShownThisSession = false;
/** Last Tower client passed to the probe — reused to re-probe after a restart. */
let lastTowerClient: TowerClient | null = null;

/** Dependencies captured on the first `runPreflight`, reused by recheck / button handlers. */
let deps: {
  context: vscode.ExtensionContext;
  workspacePath: string | null;
  outputChannel: vscode.OutputChannel;
} | null = null;

const changeEmitter = new vscode.EventEmitter<void>();
/** Fires whenever the cached preflight state changes (drives the Status-view row). */
export const onPreflightChange = changeEmitter.event;

/** Current cached preflight state, for the Status-view row. */
export function getPreflightState(): PreflightState {
  return {
    status: cachedStatus,
    cliVersion: cachedVersion,
    towerStatus: cachedTowerStatus,
    runningVersion: cachedRunningVersion,
    hostIsLocal: cachedHostIsLocal,
  };
}

/**
 * Whether CLI-dependent commands may run. Optimistic: `pending` (preflight
 * hasn't finished its background `codev --version` probe yet) counts as ready
 * so a command fired during the startup window isn't falsely blocked.
 */
export function isCliReady(): boolean {
  return cachedStatus === 'ok' || cachedStatus === 'pending';
}

/**
 * Resolve → probe → decide → cache → dispatch UX. Shared by activation
 * (`runPreflight`) and the recheck command (`recheckCli`).
 */
async function performPreflight(): Promise<PreflightStatus> {
  if (!deps) {
    return 'missing';
  }
  const { context, workspacePath, outputChannel } = deps;
  const extVersion = context.extension.packageJSON.version as string;

  const codevPath = resolveCodevPath(workspacePath, existsSync);
  // VSCode resolves an unset setting to the package.json-declared default, and
  // enforces the contributed `minimum`/`maximum` in its settings UI; the inline
  // default here is the belt-and-suspenders fallback for that read.
  const timeoutMs = vscode.workspace
    .getConfiguration('codev')
    .get<number>(VERSION_TIMEOUT_SETTING, DEFAULT_VERSION_TIMEOUT_MS);
  const { ok, stdout, timedOut } = await runCodevVersion(codevPath, workspacePath, timeoutMs);
  const cliVersion = parseCliVersion(stdout);
  const status = decidePreflight({ cliFound: ok, cliVersion, extVersion });

  cachedStatus = status;
  cachedVersion = cliVersion;
  changeEmitter.fire();

  // Drives the `Get started with Codev` walkthrough's Verify step completion
  // (`onContext:codev.cliReady`) — so the step ticks only when the CLI is
  // genuinely OK, not merely when a recheck was attempted.
  vscode.commands.executeCommand('setContext', 'codev.cliReady', status === 'ok');

  outputChannel.appendLine(
    `[${new Date().toISOString()}] [Preflight] status=${status} `
    + `cli=${cliVersion ?? 'none'} ext=${extVersion}`,
  );

  // #1024: a timeout (not a genuinely absent binary) is the false-`missing`
  // case. Surface it so the next person who hits a slow-env false-negative can
  // diagnose it instead of being silently told their CLI is missing.
  if (timedOut) {
    outputChannel.appendLine(
      `[${new Date().toISOString()}] [Preflight] codev --version timed out after `
      + `${timeoutMs}ms, falling back to 'missing'. Run \`codev --version\` manually; `
      + `if it succeeds slowly, raise the 'codev.cliVersionTimeoutMs' setting.`,
    );
  }

  if (status === 'missing') {
    maybeOpenWalkthrough(context);
  } else if (status === 'outdated') {
    showOutdatedNotification(cliVersion, extVersion);
  }

  // #983: the Tower-divergence comparison needs the installed-CLI version this
  // check just resolved. If a Tower probe already ran (Tower connected before
  // this CLI check finished), it saw `installedCli = null` and reported
  // `ok`; re-run it now with the resolved version so the divergence isn't lost
  // to that startup race. No-op until the first probe sets `lastTowerClient`.
  if (lastTowerClient) {
    await probeTowerVersion(lastTowerClient);
  }

  return status;
}

/**
 * Activation entry point. Fire-and-forget — never awaited in `activate` — so
 * activation isn't blocked. Captures deps for later recheck / button handlers.
 */
export async function runPreflight(
  context: vscode.ExtensionContext,
  workspacePath: string | null,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  deps = { context, workspacePath, outputChannel };
  await performPreflight();
}

/**
 * Re-verify after the user (claims to have) fixed the CLI. Clears the cache,
 * re-runs the flow, and confirms success with a toast. The single re-verify
 * path that every recheck affordance funnels through.
 */
export async function recheckCli(): Promise<void> {
  if (!deps) {
    return;
  }
  cachedStatus = 'pending';
  changeEmitter.fire();
  const status = await performPreflight();
  if (status === 'ok') {
    modalShownThisSession = false; // a fresh problem later restarts the modal-first pattern
    vscode.window.showInformationMessage(
      `Codev: CLI ready — codev ${cachedVersion ?? ''}`.trim(),
    );
  }
}

/** Open the walkthrough automatically, but only once per workspace. */
function maybeOpenWalkthrough(context: vscode.ExtensionContext): void {
  if (context.workspaceState.get<boolean>(WALKTHROUGH_SHOWN_KEY, false)) {
    return;
  }
  context.workspaceState.update(WALKTHROUGH_SHOWN_KEY, true);
  openWalkthrough();
}

function openWalkthrough(): void {
  vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false);
}

/**
 * Rich notification for an outdated CLI: one-click upgrade, docs, or dismiss.
 */
function showOutdatedNotification(cliVersion: string | null, extVersion: string): void {
  const message = `Codev CLI ${cliVersion ?? '(unknown)'} is older than the extension `
    + `(${extVersion}). Update to avoid compatibility issues.`;
  vscode.window
    .showWarningMessage(message, 'Update via npm', 'Open Install Docs', 'Dismiss')
    .then((choice) => {
      if (choice === 'Update via npm') {
        updateViaNpm();
      } else if (choice === 'Open Install Docs') {
        vscode.env.openExternal(vscode.Uri.parse(INSTALL_DOCS_URL));
      }
    });
}

/**
 * Run the global install in an integrated terminal, then re-verify once that
 * specific terminal closes with a success exit code. A failed / cancelled
 * install does not silently re-cache — it surfaces an explicit Recheck toast.
 */
function updateViaNpm(): void {
  const terminal = vscode.window.createTerminal({ name: 'Codev: Update CLI' });
  terminal.show();
  terminal.sendText('npm install -g @cluesmith/codev');

  const listener = vscode.window.onDidCloseTerminal((closed) => {
    if (closed !== terminal) {
      return; // instance-matched: ignore every other terminal
    }
    listener.dispose();
    if (closed.exitStatus?.code === 0) {
      recheckCli();
    } else {
      vscode.window
        .showWarningMessage('Codev: CLI update did not complete. Recheck once installed.', 'Recheck')
        .then((choice) => { if (choice === 'Recheck') { recheckCli(); } });
    }
  });
  deps?.context.subscriptions.push(listener);
}

/**
 * Point-of-action feedback when a guarded command is rejected because the CLI
 * is missing / outdated. Attenuated, never silent:
 *
 * - **First** bad-state click this session: a modal warning toast with a
 *   `Run Setup` action — the user is being told the state for the first time,
 *   so a modal interrupt is warranted.
 * - **Subsequent** clicks: an ephemeral status-bar message naming the same
 *   state and the recovery command, auto-dismissing after a few seconds. No
 *   modal, no action button — just enough to confirm the click registered and
 *   the same problem still applies.
 *
 * The session flag resets when `recheckCli` confirms `ok`, so a fresh breakage
 * later restarts the modal-first pattern. The Tower-version dimension (#983)
 * reuses this same modal-first/ephemeral-after shape in
 * `showTowerDivergenceFeedback` below, kept as a separate surface so this CLI
 * command-guard entry point stays no-arg and untouched.
 */
export function showPreflightFeedback(): void {
  if (!modalShownThisSession) {
    modalShownThisSession = true;
    vscode.window
      .showWarningMessage('Codev: CLI not installed / outdated — run setup', 'Run Setup')
      .then((choice) => {
        if (choice !== 'Run Setup') {
          return;
        }
        if (cachedStatus === 'outdated') {
          showOutdatedNotification(cachedVersion, deps?.context.extension.packageJSON.version ?? '');
        } else {
          openWalkthrough();
        }
      });
    return;
  }
  // The guard only calls this when `isCliReady()` is false, so `cachedStatus`
  // is `missing` or `outdated` here — never `ok` / `pending`.
  vscode.window.setStatusBarMessage(
    preflightFeedbackMessage(cachedStatus as PreflightStatus),
    4000,
  );
}

// ===========================================================================
// Tower-version dimension (#983)
// ===========================================================================

/**
 * Probe the *running* Tower's version (`GET /api/version`) and compare it
 * against the installed CLI and this extension's expected version. On
 * divergence (`stale` / `too-old`) the user gets an actionable toast; the
 * healthy path is silent. Invoked on each `connected` transition (activation +
 * reconnect) — not per-tick, since the in-memory version only changes on a
 * Tower restart, which severs and re-establishes the connection anyway.
 *
 * `unreachable` is intentionally silent: the existing "Not connected to Tower"
 * path already covers that case.
 */
export async function probeTowerVersion(client: TowerClient): Promise<void> {
  if (!deps) {
    return;
  }
  lastTowerClient = client;
  const { outputChannel } = deps;
  const { host } = getTowerAddress();
  const hostIsLocal = host === 'localhost' || host === '127.0.0.1';
  cachedHostIsLocal = hostIsLocal;

  const result = await client.getVersion();
  const runningVersion = result.data?.version ?? null;
  const towerStatus = decideTowerStatus({
    probeStatus: result.status,
    runningVersion,
    installedCli: cachedVersion,
    cliStatus: cachedStatus,
  });

  cachedTowerStatus = towerStatus;
  cachedRunningVersion = runningVersion;
  changeEmitter.fire();

  outputChannel.appendLine(
    `[${new Date().toISOString()}] [Preflight] towerStatus=${towerStatus} `
    + `running=${runningVersion ?? 'none'} installed=${cachedVersion ?? 'none'}`,
  );

  if (towerStatus === 'ok') {
    // Healthy again — let a future divergence re-arm the modal-first pattern.
    towerDivergenceShownThisSession = false;
    return;
  }
  // `unreachable` is silent — the existing "not connected to Tower" path owns
  // it. For stale / too-old, a restart only helps if we know the installed CLI
  // version it would load; otherwise the prompt is unactionable (and the CLI
  // preflight already covers the "CLI missing" case). cachedVersion is the
  // installed CLI.
  if ((towerStatus === 'stale' || towerStatus === 'too-old') && cachedVersion) {
    showTowerDivergenceFeedback(towerStatus, runningVersion, cachedVersion, host, hostIsLocal);
  }
}

/**
 * Toast for a divergent running Tower. Mirrors `showPreflightFeedback`'s
 * modal-first / ephemeral-after shape. For a local Tower the toast carries a
 * `Restart Tower` action; for a remote/tunnelled Tower the local restart would
 * target the wrong machine, so the toast is informational and names the host.
 */
function showTowerDivergenceFeedback(
  status: 'stale' | 'too-old',
  runningVersion: string | null,
  installedVersion: string,
  host: string,
  hostIsLocal: boolean,
): void {
  const message = towerDivergenceMessage({ status, runningVersion, installedVersion, hostIsLocal, host });

  if (towerDivergenceShownThisSession) {
    vscode.window.setStatusBarMessage(message, 5000);
    return;
  }
  towerDivergenceShownThisSession = true;

  if (!hostIsLocal) {
    vscode.window.showWarningMessage(message);
    return;
  }
  vscode.window
    .showWarningMessage(message, 'Restart Tower')
    .then((choice) => {
      if (choice === 'Restart Tower') {
        restartTowerAndReprobe();
      }
    });
}

/**
 * Run `afx tower stop && afx tower start`, then re-probe to confirm the
 * divergence cleared. Safe to invoke from inside the extension only because
 * #991 scoped `afx tower stop` to the listening Tower process (it no longer
 * SIGTERMs the extension host's own client sockets).
 */
async function restartTowerAndReprobe(): Promise<void> {
  if (!deps) {
    return;
  }
  const ok = await restartTower(deps.workspacePath, deps.outputChannel);
  if (!ok) {
    vscode.window
      .showWarningMessage('Codev: Tower restart did not complete. Try `afx tower start`.', 'Retry')
      .then((choice) => { if (choice === 'Retry') { restartTowerAndReprobe(); } });
    return;
  }
  // A fresh divergence after this restart should re-arm the modal.
  towerDivergenceShownThisSession = false;
  if (lastTowerClient) {
    await probeTowerVersion(lastTowerClient);
  }
}
