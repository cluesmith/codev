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
 */

import { basename } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '../../lib/sqlite.js';
import { rethrowIfNativeLoadFailure } from '../../lib/native-deps.js';
import { detectCurrentBuilderId, detectWorkspaceRoot, BuilderIdResolutionError } from './send.js';
import { lookupBuilderSpawningArchitect } from '../state.js';
import { getGlobalDbPath } from '../db/index.js';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';

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
export type WhoamiIdentity =
  | { type: 'builder'; workspace: string; name: string; architect?: string }
  | { type: 'architect'; workspace: string; name: string; rowMissing?: boolean };

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
  return lines.join('\n');
}

/** Format an identity as the JSON payload (`architect` omitted when unknown). */
export function identityToJson(identity: WhoamiIdentity): Record<string, string> {
  const payload: Record<string, string> = {
    workspace: identity.workspace,
    type: identity.type,
    name: identity.name,
  };
  if (identity.type === 'builder' && identity.architect) {
    payload.architect = identity.architect;
  }
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
