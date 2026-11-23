/**
 * The read-only allow-list for `codev check` (Spec 1951 § Read-only enforcement).
 *
 * A CLOSED grammar: every token of a git argv must be explicitly permitted, so an unknown
 * flag is refused rather than passed through. It covers the git subcommands the commands
 * run, and only the flags they use. Diff-family commands must carry
 * `--no-ext-diff --no-textconv`, so no repository-configured diff program runs; flags that
 * write files (`--output`) or run programs (`--upload-pack`, `--exec`, `--textconv`,
 * `--filters`) are never permitted. `fetch` is allowed only in its ref-neutral form, which
 * adds objects and moves no ref and writes no FETCH_HEAD.
 *
 * Forge concepts are allowed by name: only the four read concepts.
 */

import { hasControlChars, isFullSha, isRefName, isSha } from './validate.js';
import { isAbsolute } from 'node:path';

export class RunnerRefusal extends Error {
  constructor(public readonly argv: readonly string[], reason: string) {
    super(`refused to run ${argv.join(' ')}: ${reason}`);
    this.name = 'RunnerRefusal';
  }
}

export const ALLOWED_CONCEPTS: readonly string[] = ['pr-view', 'pr-search', 'commit-checks', 'workflow-runs'];

export function assertConceptAllowed(concept: string): void {
  if (!ALLOWED_CONCEPTS.includes(concept)) {
    throw new RunnerRefusal([concept], `forge concept '${concept}' is not on the read-only list (${ALLOWED_CONCEPTS.join(', ')})`);
  }
}

/** `-c` settings the ref-neutral fetch needs; no other `-c` is accepted. */
const ALLOWED_CONFIG_OVERRIDES = new Set(['gc.auto=0', 'maintenance.auto=false']);

interface Globals {
  noOptionalLocks: boolean;
  configOverrides: Set<string>;
}

type PositionalCheck = (positionals: string[]) => string | null;

interface SubcommandRule {
  /** Exact flags permitted. */
  flags?: readonly string[];
  /** `--name=` prefixes permitted; the value may be anything without control characters. */
  valueFlags?: readonly string[];
  /** Flags that must be present. */
  required?: readonly string[];
  /** Exactly one of these flags must be present. */
  oneOf?: readonly string[];
  /** Whether `--` followed by pathspecs is permitted. */
  pathspecs?: boolean;
  /** Validates the positional arguments; returns a reason to refuse, or null. */
  positionals: PositionalCheck;
  /** Extra checks on the global options. */
  globals?: (globals: Globals) => string | null;
}

/** A revision `codev check` may name: a SHA, a ref name, or either peeled with `^{commit}`. */
export function isRevision(value: string): boolean {
  const base = value.endsWith('^{commit}') ? value.slice(0, -'^{commit}'.length) : value;
  return isSha(base) || isRefName(base);
}

/** A revision, or `<rev>..<rev>`. */
function isRevisionOrRange(value: string): boolean {
  const parts = value.split('..');
  if (parts.length === 1) return isRevision(value);
  return parts.length === 2 && parts.every(isRevision);
}

const none: PositionalCheck = (p) => (p.length === 0 ? null : `unexpected argument ${p[0]}`);

function exactly(n: number, check: (value: string) => boolean, what: string): PositionalCheck {
  return (p) => {
    if (p.length !== n) return `expected ${n} ${what}, got ${p.length}`;
    const bad = p.find((value) => !check(value));
    return bad === undefined ? null : `${JSON.stringify(bad)} is not a valid ${what}`;
  };
}

function between(min: number, max: number, check: (value: string) => boolean, what: string): PositionalCheck {
  return (p) => {
    if (p.length < min || p.length > max) return `expected ${min}–${max} ${what}, got ${p.length}`;
    const bad = p.find((value) => !check(value));
    return bad === undefined ? null : `${JSON.stringify(bad)} is not a valid ${what}`;
  };
}

const NO_EXT_DIFF = ['--no-ext-diff', '--no-textconv'] as const;

const RULES: Record<string, SubcommandRule> = {
  version: { positionals: none },
  'rev-parse': {
    flags: ['--show-toplevel', '--verify', '--quiet', '-q', '--abbrev-ref'],
    positionals: between(0, 1, isRevision, 'revision'),
  },
  'rev-list': {
    flags: ['--first-parent', '--parents', '--count', '--not', '--reverse'],
    valueFlags: ['--max-count='],
    positionals: between(1, 8, isRevisionOrRange, 'revision'),
  },
  'merge-base': {
    flags: ['--is-ancestor'],
    positionals: exactly(2, isRevision, 'revision'),
  },
  log: {
    flags: [...NO_EXT_DIFF, '--first-parent', '--no-merges', '-z'],
    valueFlags: ['--format=', '--max-count='],
    required: NO_EXT_DIFF,
    positionals: between(1, 4, isRevisionOrRange, 'revision'),
  },
  show: {
    flags: [...NO_EXT_DIFF, '-s', '--no-patch'],
    valueFlags: ['--format='],
    required: NO_EXT_DIFF,
    positionals: exactly(1, isRevision, 'revision'),
  },
  diff: {
    flags: [...NO_EXT_DIFF, '--name-only', '--numstat', '-z', '--no-renames'],
    required: NO_EXT_DIFF,
    pathspecs: true,
    positionals: exactly(2, isRevision, 'revision'),
  },
  'diff-tree': {
    flags: ['--no-commit-id', '--name-only', '-r', '-z', '--no-renames'],
    positionals: between(1, 2, isRevision, 'revision'),
  },
  'cat-file': {
    flags: ['-e', '-t', '-p'],
    positionals: exactly(1, isRevision, 'revision'),
  },
  'for-each-ref': {
    valueFlags: ['--format='],
    positionals: between(0, 4, (v) => v.startsWith('refs/') && isRefName(v), 'ref pattern'),
  },
  'ls-files': {
    flags: ['--others', '--ignored', '--exclude-standard', '--directory', '-z'],
    pathspecs: true,
    positionals: none,
  },
  'ls-remote': {
    flags: ['--symref'],
    positionals: (p) => {
      if (p[0] !== 'origin') return 'ls-remote may only query origin';
      const bad = p.slice(1).find((ref) => !(ref === 'HEAD' || (ref.startsWith('refs/') && isRefName(ref))));
      return bad === undefined ? null : `${JSON.stringify(bad)} is not a valid ref`;
    },
  },
  worktree: {
    flags: ['--porcelain', '-z'],
    required: ['--porcelain'],
    positionals: exactly(1, (v) => v === 'list', 'worktree subcommand (only "list")'),
  },
  config: {
    flags: ['--get', '--get-regexp'],
    oneOf: ['--get', '--get-regexp'],
    positionals: exactly(1, (v) => /^[A-Za-z0-9._-]+$/.test(v), 'config key'),
  },
  'symbolic-ref': {
    flags: ['--short', '-q', '--quiet'],
    positionals: exactly(1, isRefName, 'ref name'),
  },
  status: {
    flags: ['--porcelain=v1', '-z', '--untracked-files=all'],
    positionals: none,
    globals: (g) => (g.noOptionalLocks ? null : 'status needs the global --no-optional-locks (a plain status may rewrite the index)'),
  },
  'merge-tree': {
    flags: ['--write-tree', '--name-only', '--no-messages', '-z'],
    required: ['--write-tree'],
    positionals: exactly(2, isRevision, 'revision'),
  },
  fetch: {
    flags: ['--no-write-fetch-head', '--refmap=', '--no-tags', '--no-recurse-submodules', '--quiet'],
    required: ['--no-write-fetch-head', '--refmap='],
    positionals: (p) => {
      if (p[0] !== 'origin') return 'fetch may only fetch from origin';
      if (p.length < 2) return 'fetch needs at least one commit SHA';
      const bad = p.slice(1).find((sha) => !isFullSha(sha));
      return bad === undefined ? null : `fetch accepts only full commit SHAs, not ${JSON.stringify(bad)}`;
    },
    globals: (g) =>
      ALLOWED_CONFIG_OVERRIDES.size === g.configOverrides.size
        ? null
        : 'fetch needs -c gc.auto=0 -c maintenance.auto=false (no housekeeping)',
  },
};

/** Subcommands that reach the network, and so are bounded by the runner's time limit. */
export const NETWORK_SUBCOMMANDS: ReadonlySet<string> = new Set(['ls-remote', 'fetch']);

/**
 * Throws `RunnerRefusal` unless `argv` (the arguments after `git`) is on the read-only
 * list. Returns the subcommand.
 */
export function assertGitArgvAllowed(argv: readonly string[]): string {
  function refuse(reason: string): never {
    throw new RunnerRefusal(['git', ...argv], reason);
  }
  const bad = argv.find((token) => hasControlChars(token));
  if (bad !== undefined) refuse('an argument contains a control character');

  const globals: Globals = { noOptionalLocks: false, configOverrides: new Set() };
  let i = 0;
  for (; i < argv.length && argv[i].startsWith('-'); i++) {
    const token = argv[i];
    if (token === '--no-optional-locks') {
      globals.noOptionalLocks = true;
    } else if (token === '-C') {
      const dir = argv[++i];
      if (dir === undefined || !isAbsolute(dir)) refuse('-C needs an absolute directory');
    } else if (token === '-c') {
      const setting = argv[++i];
      if (setting === undefined || !ALLOWED_CONFIG_OVERRIDES.has(setting)) refuse(`-c ${setting ?? ''} is not permitted`);
      globals.configOverrides.add(setting);
    } else {
      refuse(`global option ${token} is not permitted`);
    }
  }

  const subcommand = argv[i];
  if (subcommand === undefined) refuse('no git subcommand');
  if (!Object.hasOwn(RULES, subcommand)) refuse(`git ${subcommand} is not on the read-only list`);
  const rule = RULES[subcommand];
  if (globals.configOverrides.size > 0 && subcommand !== 'fetch') refuse(`-c is permitted only for fetch`);

  const flags = new Set(rule.flags ?? []);
  const seen = new Set<string>();
  const positionals: string[] = [];
  const rest = argv.slice(i + 1);
  for (let j = 0; j < rest.length; j++) {
    const token = rest[j];
    if (token === '--') {
      if (!rule.pathspecs) refuse(`git ${subcommand} takes no pathspecs`);
      const specs = rest.slice(j + 1);
      if (specs.some((spec) => spec === '')) refuse('empty pathspec');
      break;
    }
    if (token.startsWith('-')) {
      if (flags.has(token)) {
        seen.add(token);
        continue;
      }
      const valueFlag = (rule.valueFlags ?? []).find((prefix) => token.startsWith(prefix) && token.length > prefix.length);
      if (valueFlag) {
        seen.add(valueFlag);
        continue;
      }
      refuse(`git ${subcommand} ${token} is not permitted`);
    }
    positionals.push(token);
  }

  for (const required of rule.required ?? []) {
    if (!seen.has(required)) refuse(`git ${subcommand} must carry ${required}`);
  }
  if (rule.oneOf && rule.oneOf.filter((flag) => seen.has(flag)).length !== 1) {
    refuse(`git ${subcommand} must carry exactly one of ${rule.oneOf.join(', ')}`);
  }
  const positionalProblem = rule.positionals(positionals);
  if (positionalProblem) refuse(positionalProblem);
  const globalProblem = rule.globals?.(globals);
  if (globalProblem) refuse(globalProblem);
  return subcommand;
}
