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
# Stub git (Spec 1951 tests): record, check the read-only list, exec the real git.
printf '%s\\n' "$*" >> "$STUB_DIR/git-calls"
violation() { printf 'git %s :: %s\\n' "$*" "$REASON" >> "$STUB_DIR/violations"; echo "stub git refused: $REASON" >&2; exit 99; }
sub=""; skip=0; for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    -C|-c) skip=1 ;;
    --no-optional-locks) ;;
    -*) REASON="global option $a"; violation "$@" ;;
    *) sub="$a"; break ;;
  esac
done
case "$sub" in
  version|rev-parse|rev-list|merge-base|log|show|diff|diff-tree|cat-file|for-each-ref|ls-files|ls-remote|merge-tree) ;;
  worktree) case "$*" in *"worktree list --porcelain"*) ;; *) REASON="worktree other than list"; violation "$@" ;; esac ;;
  config) case "$*" in *"config --get"*) ;; *) REASON="config without --get"; violation "$@" ;; esac ;;
  status) case "$*" in *--no-optional-locks*) ;; *) REASON="status without --no-optional-locks"; violation "$@" ;; esac ;;
  symbolic-ref) [ "$#" -le 6 ] || { REASON="symbolic-ref write form"; violation "$@"; } ;;
  fetch) case "$*" in *--no-write-fetch-head*--refmap=*) ;; *) REASON="fetch that may move a ref"; violation "$@" ;; esac ;;
  *) REASON="subcommand $sub"; violation "$@" ;;
esac
for a in "$@"; do
  case "$a" in
    --output*|--ext-diff|--textconv|--filters|--upload-pack*|--exec*) REASON="flag $a"; violation "$@" ;;
  esac
done
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
