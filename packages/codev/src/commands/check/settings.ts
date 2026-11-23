/**
 * `check.*` configuration (Spec 1951 § What is configurable).
 *
 * Read from the main workspace root through the usual five-layer loader (arrays replace,
 * never concatenate). Every value is validated; a bad one is exit 2 naming the key and the
 * file that set it.
 */

import { findConfigSource, loadConfig } from '../../lib/config.js';
import { ALL_CHECK_IDS, CheckCommandError } from './report.js';
import { hasControlChars, isRefName, validateConfigString, InputError } from './validate.js';

/** The agent-instruction surface: always worth knowing when it moves. */
export const DEFAULT_WATCH: readonly string[] = [
  'CLAUDE.md',
  'AGENTS.md',
  '.codev/**',
  '.claude/**',
  'codev/roles/**',
  'codev/protocols/**',
  'codev/templates/**',
  'codev/resources/arch-critical.md',
  'codev/resources/lessons-critical.md',
];

/** Porch state and review artifacts, thread logs and architect state, and lockfiles. */
export const DEFAULT_NOT_FOR_READING: readonly string[] = [
  'codev/projects/**',
  'codev/state/**',
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/uv.lock',
  '**/go.sum',
  '**/Gemfile.lock',
  '**/composer.lock',
];

export interface AttributionPattern {
  source: string;
  regex: RegExp;
}

export interface CheckSettings {
  attribution: AttributionPattern[];
  watch: readonly string[];
  /** Applies only to files `watch` matched: a flag glob outside the watch list has no effect. */
  flag: readonly string[];
  notForReading: readonly string[];
  deploy: { branch: string | null; workflow: string | null };
  skip: ReadonlySet<string>;
}

const KNOWN_KEYS = new Set(['attribution', 'watch', 'flag', 'notForReading', 'deploy', 'skip']);
const KNOWN_DEPLOY_KEYS = new Set(['branch', 'workflow']);

export function loadCheckSettings(mainRoot: string): CheckSettings {
  let raw: unknown;
  try {
    raw = loadConfig(mainRoot).check;
  } catch (err) {
    throw new CheckCommandError('could not load configuration', err instanceof Error ? err.message : String(err));
  }
  return parseCheckSettings(raw, (keyPath) => findConfigSource(mainRoot, keyPath));
}

/** Pure validation; `sourceOf` names the file that set a key (for error messages). */
export function parseCheckSettings(raw: unknown, sourceOf: (keyPath: string[]) => string | null): CheckSettings {
  const fail = (keyPath: string[], problem: string): never => {
    const source = sourceOf(keyPath);
    throw new CheckCommandError(`${keyPath.join('.')} ${problem}${source ? ` (in ${source})` : ''}`);
  };

  if (raw === undefined) raw = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(['check'], 'must be an object');
  const section = raw as Record<string, unknown>;
  for (const key of Object.keys(section)) {
    if (!KNOWN_KEYS.has(key)) fail(['check', key], `is not a known key (known: ${[...KNOWN_KEYS].join(', ')})`);
  }

  const strings = (key: string, kind: string, fallback: readonly string[]): readonly string[] => {
    const value = section[key];
    if (value === undefined) return fallback;
    if (!Array.isArray(value)) fail(['check', key], `must be an array of ${kind}`);
    for (const item of value as unknown[]) {
      if (typeof item !== 'string' || item.trim() === '' || hasControlChars(item)) {
        fail(['check', key], `must contain only non-empty ${kind} (got ${JSON.stringify(item)})`);
      }
    }
    return value as string[];
  };
  const globs = (key: string, fallback: readonly string[]) => strings(key, 'glob strings', fallback);

  const attributionSources = strings('attribution', 'regex strings', []);
  const attribution = attributionSources.map((source): AttributionPattern => {
    try {
      return { source, regex: new RegExp(source, 'i') };
    } catch (err) {
      return fail(['check', 'attribution'], `pattern ${JSON.stringify(source)} is not a valid regex: ${(err as Error).message}`);
    }
  });

  const deploy = { branch: null as string | null, workflow: null as string | null };
  const rawDeploy = section.deploy;
  if (rawDeploy !== undefined) {
    if (typeof rawDeploy !== 'object' || rawDeploy === null || Array.isArray(rawDeploy)) fail(['check', 'deploy'], 'must be an object');
    const d = rawDeploy as Record<string, unknown>;
    for (const key of Object.keys(d)) {
      if (!KNOWN_DEPLOY_KEYS.has(key)) fail(['check', 'deploy', key], 'is not a known key (known: branch, workflow)');
    }
    for (const key of ['branch', 'workflow'] as const) {
      if (d[key] === undefined) continue;
      const keyPath = ['check', 'deploy', key];
      try {
        deploy[key] = validateConfigString(d[key], keyPath.join('.'), sourceOf(keyPath));
      } catch (err) {
        if (err instanceof InputError) throw new CheckCommandError(err.message);
        throw err;
      }
    }
    if (deploy.branch !== null && !isRefName(deploy.branch)) {
      fail(['check', 'deploy', 'branch'], `${JSON.stringify(deploy.branch)} is not a valid branch name`);
    }
  }

  const skip = strings('skip', 'check ids', []);
  for (const id of skip) {
    if (!ALL_CHECK_IDS.has(id)) fail(['check', 'skip'], `names an unknown check id ${JSON.stringify(id)}`);
  }

  return {
    attribution,
    watch: globs('watch', DEFAULT_WATCH),
    flag: globs('flag', []),
    notForReading: globs('notForReading', DEFAULT_NOT_FOR_READING),
    deploy,
    skip: new Set(skip),
  };
}
