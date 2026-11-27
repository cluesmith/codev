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
# The overview cache runs several gh processes at once: number the calls under a lock.
# The trap releases the lock only while this process holds it, so a fake gh killed inside
# the window cannot leave the next one spinning, and one that exits later cannot remove a
# lock another process has since taken.
spins=0
until mkdir "$dir/lock" 2>/dev/null; do
  spins=$((spins + 1))
  if [ "$spins" -gt 2000 ]; then
    printf '%s\\n' "lock never acquired" >> "$dir/violations"
    exit 97
  fi
done
trap 'rmdir "$dir/lock" 2>/dev/null' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
n=$(( $(cat "$dir/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$dir/count"
rmdir "$dir/lock"
trap - EXIT TERM INT
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
    const countFile = path.join(this.dir, 'count');
    const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf-8').trim()) : 0;
    return Array.from({ length: n }, (_, i) =>
      fs.readFileSync(path.join(this.dir, `call.${i + 1}.argv`), 'utf-8').split('\0').slice(0, -1));
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
