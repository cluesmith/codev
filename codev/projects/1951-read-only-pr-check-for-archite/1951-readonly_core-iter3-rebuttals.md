# Phase 2 (readonly_core): iteration 3 response

Claude approved. Codex asked for one change, which is accepted. The architect approved the fix before it was made, and asked for an audit of every similar form in the stub. Everything here is in the test helpers, except a one-line guard in `git-facts.ts`.

## Codex

**The stub `git` checks `ls-remote`'s flags but not its remote or ref arguments.**
Accepted. The stub's `ls-remote` now requires `origin` as its first argument. Every argument after it must be `HEAD` or a `refs/…` name containing neither `::` nor `..`. Four shared cases were added to `OFF_GRAMMAR_FORMS`:
- another remote;
- an `ext::sh -c …` transport;
- a path to another repository;
- `origin` with an `ext::` ref.

Both layers refuse all four: `allow-list.test.ts` includes the list, and so does `stub-bin.test.ts`. The `ext::` case uses `sh -c true`, because the repository's `/tmp` residue check (`scripts/tmp-residue-check.mjs`) refuses a literal `/tmp` path in a test file.

## Audit requested by the architect: other forms with checked flags but unchecked arguments

Every subcommand the stub accepts was read for arguments that name a repository, a URL or a file system path:

| Form | Before | Now |
|---|---|---|
| `ls-remote` | remote and refs unchecked | `origin` only, then `HEAD` or `refs/…` names (above) |
| `fetch` | already checked: remote must be `origin`, every other argument a full 40-hex SHA | unchanged |
| global `-C <dir>` | already checked: absolute path, in both layers. It selects a local checkout that `codev check` itself named, such as a builder worktree; it is not a remote. | unchanged |
| `diff`, `log`, `show`, `diff-tree`, `merge-tree`, `merge-base`, `rev-list`, `rev-parse`, `cat-file` | **same gap: revision arguments were unchecked.** `git diff --no-ext-diff --no-textconv /etc/hosts /etc/passwd`, or `../a ../b`, runs as an implicit `--no-index` diff of files outside the repository. That is a read, but of arbitrary paths, and the runner already refuses it. | Each argument before `--` must look like a revision. Absolute paths, `../` paths, `:` (and so `::`) and backslashes are refused. Both cases were added to the shared refusals. |
| `ls-files`, `status` | positional pathspecs before `--` were unchecked (they are confined to the repository) | no arguments before `--`, as in the runner; shared refusal cases added |
| `for-each-ref` | patterns unchecked | `refs/…` patterns only, as in the runner; shared refusal case added |
| `config` | already exactly `--get <key>`, with no file option | unchanged |
| `worktree`, `symbolic-ref`, `version` | already exact forms | unchanged |

Pathspecs after `--` stay unchecked by design. git confines them to the repository, and `:(top,glob)` magic is how the commands use them.

## Claude (APPROVE, non-blocking notes)

- **`liveTip`'s branch argument is not pre-validated.** Taken, as the architect asked: one line. An invalid name now returns `{ ok: false, reason: 'invalid branch name "…"' }` without running git. A test uses a spawn spy.
- **Empty versus invalid forge output.** Left for Phase 6, as the note says.
- **Strictness about unknown `check.*` keys, the set-size test in the fetch globals rule, and optional askpass hardening.** Left as they are. None names a defect in this phase.
  - Refusing unknown keys is deliberate: a typo such as `wacth` exits 2 rather than silently doing nothing.
  - The fetch rule compares set sizes, but the set can only ever contain the two permitted overrides, so equal size means both are present.
  - `GIT_TERMINAL_PROMPT=0` already keeps a prompt from waiting for input.
