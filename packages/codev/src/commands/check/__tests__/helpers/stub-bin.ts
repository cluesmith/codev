/**
 * Stub `git` and `gh` for `codev check` tests (Spec 1951). POSIX only: the stubs are `sh`
 * scripts found on PATH.
 *
 * Both record every invocation and check it against a read-only list THEY keep, separate
 * from the runner's allow-list, so a runner bug cannot hide behind a matching stub. A call
 * off the list is written to `violations` and fails with exit 99; `assertNoViolations()`
 * turns it into a test failure.
 *
 *   - `git` then execs the real git, whose absolute path was resolved before PATH changed.
 *   - `gh` answers from fixtures: `answer(args, stdout, { exit, sleepSeconds })` matches the
 *     exact argument list. An unanswered call exits 98.
 *
 * `install()` puts the stub directory first on the TEST PROCESS's PATH, so a subprocess
 * started by any module — not only the runner — is recorded.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { REAL_GIT } from './git-fixture.js';

const GIT_STUB = `#!/bin/sh
# Stub git (Spec 1951 tests): record, check a read-only grammar of its own, exec the real git.
printf '%s\\n' "$*" >> "$STUB_DIR/git-calls"
ALL="$*"
violation() { printf 'git %s :: %s\\n' "$ALL" "$1" >> "$STUB_DIR/violations"; echo "stub git refused: $1" >&2; exit 99; }
has() { want="$1"; shift; for a in "$@"; do [ "$a" = "$want" ] && return 0; done; return 1; }
is_sha40() { case "$1" in ''|*[!0-9a-f]*) return 1 ;; esac; [ "\${#1}" -eq 40 ]; }
check() {
  gcauto=0; maint=0; locks=0
  while [ $# -gt 0 ]; do
    case "$1" in
      -C) case "$2" in /*) ;; *) violation "-C needs an absolute path" ;; esac; shift 2 ;;
      -c) case "$2" in gc.auto=0) gcauto=1 ;; maintenance.auto=false) maint=1 ;; *) violation "-c $2" ;; esac; shift 2 ;;
      --no-optional-locks) locks=1; shift ;;
      -*) violation "global option $1" ;;
      *) break ;;
    esac
  done
  sub="$1"; [ $# -gt 0 ] && shift
  for a in "$@"; do
    case "$a" in
      --) break ;;
      --output*|--ext-diff|--textconv|--filters|--upload-pack*|--exec*) violation "flag $a" ;;
    esac
  done
  if [ "$sub" != fetch ] && [ $((gcauto + maint)) -gt 0 ]; then violation "-c outside fetch"; fi
  case "$sub" in
    version|rev-parse|rev-list|merge-base|log|show|diff|diff-tree|cat-file|for-each-ref|ls-files|ls-remote) ;;
    merge-tree) has --write-tree "$@" || violation "merge-tree without --write-tree" ;;
    status) [ "$locks" = 1 ] || violation "status without --no-optional-locks" ;;
    worktree) [ "$*" = "list --porcelain" ] || [ "$*" = "list --porcelain -z" ] || violation "worktree $*" ;;
    config) { [ $# -eq 2 ] && [ "$1" = --get ]; } || violation "config other than --get <key>" ;;
    symbolic-ref)
      refs=0
      for a in "$@"; do
        case "$a" in --short|-q|--quiet) ;; -*) violation "symbolic-ref $a" ;; *) refs=$((refs + 1)) ;; esac
      done
      [ "$refs" -eq 1 ] || violation "symbolic-ref write form" ;;
    fetch)
      [ "$gcauto" = 1 ] && [ "$maint" = 1 ] || violation "fetch without the housekeeping overrides"
      for flag in --no-write-fetch-head --refmap= --no-tags --no-recurse-submodules; do
        has "$flag" "$@" || violation "fetch without $flag"
      done
      remote=""; shas=0
      for a in "$@"; do
        case "$a" in
          --no-write-fetch-head|--refmap=|--no-tags|--no-recurse-submodules|--quiet) ;;
          -*) violation "fetch $a" ;;
          *) if [ -z "$remote" ]; then remote="$a"; elif is_sha40 "$a"; then shas=$((shas + 1)); else violation "fetch of $a, not a full SHA"; fi ;;
        esac
      done
      [ "$remote" = origin ] || violation "fetch from $remote, not origin"
      [ "$shas" -gt 0 ] || violation "fetch with no SHA" ;;
    *) violation "subcommand $sub" ;;
  esac
}
check "$@"
exec "$REAL_GIT" "$@"
`;

const GH_STUB = `#!/bin/sh
# Stub gh (Spec 1951 tests): record, check the read-only list, answer from fixtures.
printf '%s\\n' "$*" >> "$STUB_DIR/gh-calls"
violation() { printf 'gh %s :: %s\\n' "$*" "$REASON" >> "$STUB_DIR/violations"; echo "stub gh refused: $REASON" >&2; exit 99; }
case "$1 $2" in
  "pr view"|"pr list"|"run list"|"run view") ;;
  api\\ *) for a in "$@"; do case "$a" in
      -X|--method|-f|-F|--field|--raw-field|--input) REASON="api write flag $a"; violation "$@" ;;
    esac; done ;;
  *) REASON="$1 $2"; violation "$@" ;;
esac
for f in "$STUB_DIR"/answers/*.args; do
  [ -e "$f" ] || break
  if [ "$(cat "$f")" = "$*" ]; then
    base="\${f%.args}"
    [ -e "$base.sleep" ] && sleep "$(cat "$base.sleep")"
    cat "$base.out"
    exit "$(cat "$base.exit")"
  fi
done
echo "stub gh: no answer for: $*" >&2
exit 98
`;

export interface StubBin {
  dir: string;
  /** PATH with the stub directory first. */
  pathValue: string;
  /** Environment for a runner: the stub PATH and the variables the stubs read. */
  env: Record<string, string>;
  answer(args: readonly string[], stdout: string, options?: { exit?: number; sleepSeconds?: number }): void;
  gitCalls(): string[];
  ghCalls(): string[];
  violations(): string[];
  /** Put the stubs first on the test process's own PATH; returns the undo. */
  install(): () => void;
}

export function createStubBin(dir: string): StubBin {
  fs.mkdirSync(path.join(dir, 'answers'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'git'), GIT_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'gh'), GH_STUB, { mode: 0o755 });
  const pathValue = `${dir}${path.delimiter}${process.env.PATH ?? ''}`;
  const env = { PATH: pathValue, STUB_DIR: dir, REAL_GIT };
  let answers = 0;
  const lines = (file: string): string[] => {
    const full = path.join(dir, file);
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf-8').split('\n').filter(Boolean) : [];
  };
  return {
    dir,
    pathValue,
    env,
    answer(args, stdout, options = {}) {
      const base = path.join(dir, 'answers', String(answers++));
      fs.writeFileSync(`${base}.args`, args.join(' '));
      fs.writeFileSync(`${base}.out`, stdout);
      fs.writeFileSync(`${base}.exit`, String(options.exit ?? 0));
      if (options.sleepSeconds !== undefined) fs.writeFileSync(`${base}.sleep`, String(options.sleepSeconds));
    },
    gitCalls: () => lines('git-calls'),
    ghCalls: () => lines('gh-calls'),
    violations: () => lines('violations'),
    install() {
      const saved = { PATH: process.env.PATH, STUB_DIR: process.env.STUB_DIR, REAL_GIT: process.env.REAL_GIT };
      Object.assign(process.env, env);
      return () => {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      };
    },
  };
}
