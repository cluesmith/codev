/**
 * Spec 1647 — a fake `gh` for the overview-bundle tests.
 *
 * The fake logs every argv (NUL-separated, so multi-line query texts survive) and answers
 * each call from a route keyed by:
 *   - `pr-list`, `issue-list`, `recently-closed`, `recently-merged` for the `gh` calls the
 *     four sibling scripts make, and `user-identity` for `gh api user`;
 *   - for `gh api graphql`: the operation name, then `.closed`/`.merged` for a search page
 *     (from its search string), then `@<cursor>` when a cursor is passed.
 * An unrouted call is recorded as a violation and exits 98, so a request a test did not
 * expect fails loudly.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

function hasJq(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v jq'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The github scripts are POSIX sh plus jq; their fake-gh tests run wherever jq is on PATH,
 * native Windows included, where the forge layer runs them under Git Bash. The few tests
 * that need POSIX signals, pids or file names skip on win32 by name.
 */
export const withJq = hasJq();

/** Git Bash emulates fork, so each process costs several times what it does on POSIX (#1137). */
export const scriptTestTimeoutMs = process.platform === 'win32' ? 120_000 : 30_000;

const FAKE_GH = `#!/bin/sh
dir="$(dirname "$0")"
# The overview cache runs several gh processes at once. Each call claims the lowest free
# number by creating the empty file call.$n under noclobber, which the shell opens with
# O_EXCL: no two calls share a number, and the numbers have no gaps. Not mkdir: Ubuntu
# 26.04's uutils mkdir (rust-coreutils before 0.11) reports success when it loses a race
# to create the same directory, so two concurrent calls both "claimed" one number on CI.
n=1
until (set -C; : > "$dir/call.$n") 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 1000 ]; then
    printf '%s\\n' "no call number could be claimed" >> "$dir/violations"
    exit 97
  fi
done
printf '%s\\000' "$@" > "$dir/call.$n.argv"
echo "$$" > "$dir/call.$n.pid"
key=
case "$1 $2" in
  'pr list') key=pr-list; for a in "$@"; do [ "$a" = merged ] && key=recently-merged; done ;;
  'issue list') key=issue-list; for a in "$@"; do [ "$a" = closed ] && key=recently-closed; done ;;
  'api user') key=user-identity ;;
  'api graphql')
    prev=; op=; cursor=; section=
    for a in "$@"; do
      if [ "$prev" = -f ] || [ "$prev" = -F ]; then
        case "$a" in
          query=*) op=$(printf '%s\\n' "\${a#query=}" | sed -n '1s/^query \\([A-Za-z]*\\).*/\\1/p') ;;
          cursor=*) cursor=\${a#cursor=} ;;
          search=*type:issue*) section=.closed ;;
          search=*type:pr*) section=.merged ;;
        esac
      fi
      prev=$a
    done
    key="$op$section"
    if [ -n "$cursor" ]; then key="$key@$(printf '%s' "$cursor" | tr '/+=' '_,%')"; fi
    ;;
esac
r="$dir/routes/$key"
if [ -z "$key" ] || [ ! -f "$r.json" ]; then
  printf '%s\\n' "unrouted: $key" >> "$dir/violations"
  exit 98
fi
if [ -f "$r.sleep" ]; then exec sleep "$(cat "$r.sleep")"; fi
cat "$r.json"
if [ -f "$r.err" ]; then cat "$r.err" >&2; fi
exit "$(cat "$r.code" 2>/dev/null || echo 0)"
`;

/**
 * Next on PATH after the fake. A shell that cannot execute the fake for any reason but "not
 * found" goes on searching PATH (dash and bash both do), and without this the next `gh` would
 * be a real one, against a real account. Reaching it is a violation, with the reason the fake
 * was skipped left to the shell's own error.
 */
const GUARD_GH = `#!/bin/sh
printf '%s\\n' "fell through to the next gh on PATH: $*" >> "$(dirname "$0")/../violations"
exit 96
`;

export interface Route {
  /** stdout: an object is written as JSON, a string verbatim. */
  body?: unknown;
  stderr?: string;
  code?: number;
  /** Hang for this many seconds instead of answering. */
  sleep?: number;
}

/** The route key the fake computes for a graphql call. */
export function graphqlKey(op: string, opts: { section?: 'closed' | 'merged'; cursor?: string } = {}): string {
  let key = op + (opts.section ? `.${opts.section}` : '');
  if (opts.cursor !== undefined) {
    key += `@${opts.cursor.replace(/\//g, '_').replace(/\+/g, ',').replace(/=/g, '%')}`;
  }
  return key;
}

export class FakeGh {
  constructor(readonly dir: string) {
    fs.mkdirSync(path.join(dir, 'routes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'gh'), FAKE_GH);
    fs.chmodSync(path.join(dir, 'gh'), 0o755);
    fs.mkdirSync(path.join(dir, 'guard'));
    fs.writeFileSync(path.join(dir, 'guard', 'gh'), GUARD_GH);
    fs.chmodSync(path.join(dir, 'guard', 'gh'), 0o755);
  }

  /** The PATH entries to put first: the fake, then the guard that keeps a real gh from running. */
  get pathEntries(): string {
    return `${this.dir}${path.delimiter}${path.join(this.dir, 'guard')}`;
  }

  /** What a failed call-count assertion needs: violations and the calls recorded so far. */
  diagnosis(extra: Record<string, unknown> = {}): string {
    const calls = fs.readdirSync(this.dir).filter(name => /^call\.\d+$/.test(name)).sort();
    return JSON.stringify({ ...extra, violations: this.violations(), calls });
  }

  route(key: string, r: Route): void {
    const base = path.join(this.dir, 'routes', key);
    const body = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    fs.writeFileSync(`${base}.json`, body);
    if (r.stderr !== undefined) fs.writeFileSync(`${base}.err`, r.stderr);
    if (r.code !== undefined) fs.writeFileSync(`${base}.code`, String(r.code));
    if (r.sleep !== undefined) fs.writeFileSync(`${base}.sleep`, String(r.sleep));
  }

  /** argv of every call, in order. */
  calls(): string[][] {
    const out: string[][] = [];
    for (let n = 1; fs.existsSync(path.join(this.dir, `call.${n}`)); n++) {
      out.push(fs.readFileSync(path.join(this.dir, `call.${n}.argv`), 'utf-8').split('\0').slice(0, -1));
    }
    return out;
  }

  pid(call: number): number {
    return Number(fs.readFileSync(path.join(this.dir, `call.${call}.pid`), 'utf-8').trim());
  }

  violations(): string[] {
    const file = path.join(this.dir, 'violations');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trim().split('\n') : [];
  }
}

/** The `-f`/`-F` fields of one gh argv, as [flag, name, value]. */
export function fields(argv: string[]): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-f' || argv[i] === '-F') {
      const pair = argv[i + 1];
      const eq = pair.indexOf('=');
      out.push([argv[i], pair.slice(0, eq), pair.slice(eq + 1)]);
      i++;
    }
  }
  return out;
}

/** The GraphQL operation a call sent, or the gh subcommand for a non-graphql call. */
export function operation(argv: string[]): string {
  const query = fields(argv).find(([, name]) => name === 'query');
  if (!query) return argv.slice(0, 2).join(' ');
  const search = fields(argv).find(([, name]) => name === 'search');
  const section = search ? (search[2].includes('type:issue') ? '.closed' : '.merged') : '';
  return (query[2].match(/^query (\w+)/)?.[1] ?? '?') + section;
}
