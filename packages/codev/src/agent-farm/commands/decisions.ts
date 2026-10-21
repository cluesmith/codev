/**
 * `afx decisions init` (Issue #1840) — the one command that turns on the dashboard's
 * Decisions tab: it creates the decisions file from its template.
 *
 * The target is `--path`, else `dashboard.decisionsFile`, else the default, relative to
 * the workspace root and held to the tab's own rule: it must resolve, symlinks followed,
 * inside the workspace. An existing file is never replaced — it holds the owner's rulings.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { configuredDecisionsPath, resolveDecisionsPath } from '../servers/decisions/file.js';
import { DECISIONS_FILE_TEMPLATE } from '../servers/decisions/template.js';
import { getConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export const ARCHITECT_INSTRUCTION = 'Route every ask for my word through the decisions file.';

export interface DecisionsInitOptions {
  /** The file to create, relative to the workspace root. */
  path?: string;
  /** Defaults to the workspace this CLI runs in. */
  workspaceRoot?: string;
}

export interface DecisionsInitResult {
  /** The created file, relative to the workspace root. */
  displayPath: string;
  /** The file the tab reads, relative to the workspace root. */
  configuredPath: string;
}

/** Create the decisions file and return where it went. Throws, writing nothing, on any refusal. */
export async function createDecisionsFile(options: DecisionsInitOptions = {}): Promise<DecisionsInitResult> {
  if (options.path !== undefined && (options.path.trim() === '' || path.isAbsolute(options.path))) {
    throw new Error(`--path must be relative to the workspace root, got ${JSON.stringify(options.path)}`);
  }
  const workspaceRoot = options.workspaceRoot ?? getConfig().workspaceRoot;
  const configured = await resolveDecisionsPath(workspaceRoot, configuredDecisionsPath(workspaceRoot, { fresh: true }));
  const target = options.path === undefined ? configured : await resolveDecisionsPath(workspaceRoot, options.path);
  if (!target.inside) {
    throw new Error(`${target.displayPath} resolves outside the workspace (${target.canonicalPath}); the Decisions tab refuses it`);
  }
  if (!configured.inside) {
    throw new Error(`dashboard.decisionsFile (${configured.displayPath}) resolves outside the workspace; the Decisions tab refuses it`);
  }

  await fsp.mkdir(path.dirname(target.canonicalPath), { recursive: true });
  try {
    await fsp.writeFile(target.canonicalPath, DECISIONS_FILE_TEMPLATE, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    throw new Error(`${target.displayPath} already exists; init never replaces it, because a decisions file holds the owner's rulings`);
  }
  return { displayPath: target.displayPath, configuredPath: configured.displayPath };
}

export async function decisionsInit(options: DecisionsInitOptions = {}): Promise<void> {
  const { displayPath, configuredPath } = await createDecisionsFile(options);
  logger.success(`Created ${displayPath}`);
  if (displayPath === configuredPath) {
    logger.info('The Decisions tab appears in the dashboard within a few seconds.');
  } else {
    const setting = JSON.stringify({ dashboard: { decisionsFile: displayPath } });
    logger.info(
      `The Decisions tab reads ${configuredPath}. Set ${setting} in .codev/config.json, ` +
        'and the tab appears within a few seconds.',
    );
  }
  logger.info(`Tell your main architect: "${ARCHITECT_INSTRUCTION}"`);
}
