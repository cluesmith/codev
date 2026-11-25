/**
 * Whoami command — report this terminal's agent identity (Spec 1134).
 *
 * Answers "who am I, from Tower/global.db's perspective?" for any terminal:
 * builders resolve from their worktree cwd against global.db, architects from
 * the Tower-injected CODEV_ARCHITECT_NAME env var. Identity precedence is
 * fixed by the spec: builder-worktree cwd match → CODEV_ARCHITECT_NAME →
 * unknown (exit non-zero). There is deliberately NO implicit fallback to
 * 'main' — an unverified identity misroutes downstream consumers (issue
 * #1094), so unknown must fail loud.
 *
 * Read-only invariant: this command never opens global.db read-write. Builder
 * resolution reuses detectCurrentBuilderId() (its own read-only connection);
 * all whoami-specific queries share one read-only connection opened here.
 *
 * The identity helpers are imported from ./send.js rather than relocated:
 * they are already exported and tested there, and whoami is only their second
 * consumer (extraction deferred until a third appears).
 *
 * Spec 1940: it also prints the caller's own ADDRESS, in the form another workspace on
 * this Tower would type (`codev:architect:review`, `codev:builder-spir-7`). The
 * workspace's name comes from the same naming module Tower resolves addresses with
 * (`utils/workspace-address.ts`), fed from global.db on the read-only handle, so whoami
 * still does not need Tower. The address is informational, as `workspace` is: when it
 * cannot be given the line says why, and identity and exit code are unaffected.
 */

import { basename } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '../../lib/sqlite.js';
import { rethrowIfNativeLoadFailure } from '../../lib/native-deps.js';
import { detectCurrentBuilderId, detectWorkspaceRoot, BuilderIdResolutionError } from './send.js';
import { tryFormatAddress } from '@cluesmith/codev-sdk/address';
import type { AgentAddress } from '@cluesmith/codev-types';
import { getRegisteredWorkspaces, lookupBuilderSpawningArchitect } from '../state.js';
import { getGlobalDbPath } from '../db/index.js';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';
import { printableAddressName, runningWorkspaces } from '../utils/workspace-address.js';
import { TOWER_RESTART_COMMAND } from '../utils/older-tower.js';

export interface WhoamiOptions {
  json?: boolean;
}

/**
 * Resolved identity. `architect` (builder) is omitted when the row's
 * `spawned_by_architect` is NULL (legacy) or missing. `rowMissing`
 * (architect) marks a best-effort diagnostic: the env var named an architect
 * but no matching `architect` table row exists — surfaced as a stderr
 * warning, never a failure (rows are legitimately absent after crashes).
 */
export type WhoamiIdentity = (
  | { type: 'builder'; workspace: string; name: string; architect?: string }
  | { type: 'architect'; workspace: string; name: string; rowMissing?: boolean }
) &
  WhoamiAddress;

/**
 * The caller's own address as another workspace on this Tower types it (Spec 1940), or
 * why there is none to give: exactly one of the two is set.
 */
export type WhoamiAddress =
  | { address: string; addressUnavailable?: undefined }
  | { address?: undefined; addressUnavailable: string };

/** Thrown when no identity signal resolves. Message is the user-facing text. */
export class WhoamiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhoamiError';
  }
}

/**
 * Open global.db read-only, or return null when it is missing/unopenable.
 * Null degrades gracefully: the informational lookups (workspace display
 * name, spawning architect, architect-row cross-check) are skipped. Identity
 * itself never depends on this handle — the builder path already verified
 * against the db inside detectCurrentBuilderId(), and the architect path is
 * env-based.
 */
function openReadonlyGlobalDb(): Database.Database | null {
  try {
    return openDatabase(getGlobalDbPath(), { readonly: true });
  } catch (err) {
    rethrowIfNativeLoadFailure(err);
    return null;
  }
}

/**
 * Display name for the workspace: the `known_workspaces` registry entry when
 * present, else the directory basename. Informational context only — the
 * spec's fail-loud rule applies to type/name, not this field.
 */
function workspaceDisplayName(workspaceRoot: string | null, db: Database.Database | null): string {
  const root = workspaceRoot ?? process.cwd();
  if (db) {
    try {
      const row = db
        .prepare('SELECT name FROM known_workspaces WHERE workspace_path = ?')
        .get(normalizeWorkspacePath(root)) as { name: string } | undefined;
      if (row?.name) return row.name;
    } catch {
      // Table missing or query failure — informational field, fall through.
    }
  }
  return basename(root);
}

/**
 * The running workspaces, by the one definition Tower uses ({@link runningWorkspaces}), fed
 * from global.db because whoami does not need Tower: Tower writes a `terminal_sessions` row
 * when it starts a terminal and deletes it when the terminal ends or its workspace stops.
 * Whether the caller's own workspace is running does not change its own name, so it is not
 * added.
 */
function runningWorkspacesInDb(db: Database.Database): string[] {
  const rows = db.prepare('SELECT workspace_path FROM terminal_sessions').all() as Array<{ workspace_path: string }>;
  return runningWorkspaces(rows.map((row) => row.workspace_path));
}

/**
 * Whether this global.db holds workspace address names: the `address_name` column that
 * migration v20 adds. Only Tower migrates the database, so one that lacks it has not been
 * opened by a Tower of this version, whether or not an older Tower is running on it now.
 */
function holdsWorkspaceNames(db: Database.Database): boolean {
  const columns = db.prepare('PRAGMA table_info(known_workspaces)').all() as Array<{ name: string }>;
  return columns.some((column) => column.name === 'address_name');
}

/**
 * The address of `agent` in the workspace at `workspaceRoot`, or why it has none. The
 * workspace's name is the one a frame or `afx workspace list` would print for it
 * ({@link printableAddressName}); a workspace with no usable name has no address, and the
 * reason carries the remedy.
 */
function ownAddress(agent: AgentAddress, workspaceRoot: string | null, db: Database.Database | null): WhoamiAddress {
  if (workspaceRoot === null) {
    return { addressUnavailable: 'the current directory is not inside a workspace' };
  }
  if (db === null) {
    return { addressUnavailable: 'global.db could not be read, so the name of this workspace is not known' };
  }
  // The spelling the registry stores, as the lookups above use it.
  const root = normalizeWorkspacePath(workspaceRoot);
  let named: ReturnType<typeof printableAddressName>;
  try {
    if (!holdsWorkspaceNames(db)) {
      return {
        addressUnavailable:
          'global.db has not been migrated by a Tower of this version, so it holds no workspace names; ' +
          `restarting Tower migrates it: ${TOWER_RESTART_COMMAND}`,
      };
    }
    named = printableAddressName(root, getRegisteredWorkspaces(db), runningWorkspacesInDb(db));
  } catch (err) {
    // Any other failure is reported as itself: advice for a cause it is not would mislead.
    const cause = err instanceof Error ? err.message : String(err);
    return { addressUnavailable: `the name of this workspace could not be read from global.db: ${cause}` };
  }
  if (named.name === null) return { addressUnavailable: `this workspace has no address name: ${named.reason}` };
  const formatted = tryFormatAddress({ ...agent, workspace: named.name });
  if (!formatted.ok) {
    return { addressUnavailable: `'${formatted.text}' does not read back as this agent's address` };
  }
  return { address: formatted.text };
}

/**
 * Resolve the current terminal's identity per the spec precedence.
 *
 * Throws `BuilderIdResolutionError` when cwd IS a builder worktree whose
 * identity cannot be verified (no fallthrough to the env check — #1094), and
 * `WhoamiError` when no identity signal resolves at all.
 */
export function resolveIdentity(env: NodeJS.ProcessEnv = process.env): WhoamiIdentity {
  // 1. Builder-worktree cwd match. A BuilderIdResolutionError propagates
  //    verbatim: inside a confirmed worktree, an unverifiable identity is an
  //    error, never a reason to consult the env var.
  const builderId = detectCurrentBuilderId();
  const workspaceRoot = detectWorkspaceRoot();
  const db = openReadonlyGlobalDb();
  try {
    if (builderId) {
      const identity: WhoamiIdentity = {
        type: 'builder',
        workspace: workspaceDisplayName(workspaceRoot, db),
        name: builderId,
        ...ownAddress({ kind: 'id', name: builderId }, workspaceRoot, db),
      };
      if (db) {
        try {
          const spawnedBy = lookupBuilderSpawningArchitect(builderId, workspaceRoot ?? undefined, db);
          if (spawnedBy) identity.architect = spawnedBy;
        } catch {
          // Enrichment only — the identity is already verified; a lookup
          // failure means "not recorded", not "unknown identity".
        }
      }
      return identity;
    }

    // 2. Tower-injected architect env var. Read directly, NOT via
    //    currentArchitectName() — its default of 'main' is exactly the
    //    implicit fallback whoami must not have.
    const architectName = env.CODEV_ARCHITECT_NAME?.trim();
    if (architectName) {
      const identity: WhoamiIdentity = {
        type: 'architect',
        workspace: workspaceDisplayName(workspaceRoot, db),
        name: architectName,
        ...ownAddress({ kind: 'architect', name: architectName }, workspaceRoot, db),
      };
      // Best-effort cross-check against the architect table (diagnostics
      // only): a missing row is a warning, never a failure — rows are
      // legitimately absent in the crash-recovery scenarios whoami serves.
      if (db && workspaceRoot) {
        try {
          const row = db
            .prepare('SELECT 1 AS present FROM architect WHERE workspace_path = ? AND id = ?')
            .get(normalizeWorkspacePath(workspaceRoot), architectName);
          if (!row) identity.rowMissing = true;
        } catch {
          // Swallowed by design — this check never affects output or exit code.
        }
      }
      return identity;
    }
  } finally {
    db?.close();
  }

  // 3. Fail loud. No implicit 'main'.
  throw new WhoamiError(
    'Cannot determine agent identity: the current directory is not inside a ' +
      '.builders/<id>/ worktree and CODEV_ARCHITECT_NAME is not set. ' +
      'Likely causes: a plain shell, a terminal not started by Tower, or a ' +
      'pre-#786 architect terminal. Refusing to guess (issue #1094) — ' +
      'identity must come from a verified signal, never a default.',
  );
}

/** Format an identity as the human-readable `key: value` lines. */
export function formatIdentity(identity: WhoamiIdentity): string {
  const lines = [`workspace: ${identity.workspace}`, `type: ${identity.type}`, `name: ${identity.name}`];
  if (identity.type === 'builder' && identity.architect) {
    lines.push(`architect: ${identity.architect}`);
  }
  // Added after the lines that were there before (Spec 1940): those keep their order.
  lines.push(
    identity.address !== undefined ? `address: ${identity.address}` : `address: none (${identity.addressUnavailable})`,
  );
  return lines.join('\n');
}

/**
 * Format an identity as the JSON payload (`architect` omitted when unknown). `address` is
 * the caller's own address; when there is none it is absent and `addressUnavailable` says
 * why.
 */
export function identityToJson(identity: WhoamiIdentity): Record<string, string> {
  const payload: Record<string, string> = {
    workspace: identity.workspace,
    type: identity.type,
    name: identity.name,
  };
  if (identity.type === 'builder' && identity.architect) {
    payload.architect = identity.architect;
  }
  if (identity.address !== undefined) payload.address = identity.address;
  else payload.addressUnavailable = identity.addressUnavailable;
  return payload;
}

/**
 * `afx whoami` — print this terminal's identity.
 *
 * Success: identity to stdout (text or --json), exit 0.
 * Unknown identity: explanation to stderr (always), `{ "error": ... }` to
 * stdout under --json, exit 1 via process.exitCode (streams flush).
 */
export async function whoami(options: WhoamiOptions = {}): Promise<void> {
  let identity: WhoamiIdentity;
  try {
    identity = resolveIdentity();
  } catch (err) {
    if (!(err instanceof WhoamiError) && !(err instanceof BuilderIdResolutionError)) throw err;
    process.stderr.write(`${err.message}\n`);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ error: err.message })}\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (identity.type === 'architect' && identity.rowMissing) {
    process.stderr.write(
      `warning: CODEV_ARCHITECT_NAME='${identity.name}' but no matching architect row ` +
        `in global.db for this workspace (Tower may not have registered this terminal, ` +
        `or it predates a crash). Identity is reported from the env signal.\n`,
    );
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(identityToJson(identity))}\n`);
  } else {
    process.stdout.write(`${formatIdentity(identity)}\n`);
  }
}
