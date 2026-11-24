# Plan 1912 — iteration 1 responses

Both reviewers returned COMMENT. Every point was accepted and folded into the plan, except `--permission-prompts none`, which was considered and declined for the reason given below.

## codex

1. **Kill and await the child on malformed stream JSON.** *Accepted, and generalised.* Any failure detected mid-stream (malformed JSON, the new init guard, a stdout write error) terminates the child with SIGTERM and awaits its exit before the lane rejects. A test uses a stub that emits a malformed line and then sleeps, and asserts the stub is dead when the promise settles.
2. **Doctor's `.env` handling: say how it is shared.** *Accepted.* Phase 1 extracts a pure `readDotenvFile(root)` into `lib/dotenv.ts`, and consult's `loadDotenv` is re-expressed on top of it with identical behaviour. Doctor resolves the root with its existing `findWorkspaceRoot()`, merges the parsed `.env` *under* `process.env` into a local object without mutating `process.env`, and feeds that to the same env builder the lane uses. There is a new acceptance line for a withheld key from `.env` with `process.env` unchanged.
3. **`validateCodexPath` lives in `lib/consult-lanes.ts`.** *Accepted.* `validateClaudeAuth` goes there; `config.ts` gets the type and the call.
4. **Release notes / CHANGELOG.** *Accepted, by stating the route.* `CHANGELOG.md` is not maintained per PR here (last edited for Spec 786, May 2026); release notes come from the RELEASE protocol in `docs/releases/`. The PR body carries a ready-to-paste Release note paragraph covering the key-only breaking change and the one-line opt-in.

## claude

1. **`SDK_MODELS` is the validation list.** *Accepted. This was a real trap.* It is renamed to `RUNNER_LANES` and keeps both `claude` and `codex`. The `/Unknown model/` and default-model tests are named as checks.
2. **The Phase 2 grep scope.** *Accepted.* It is now scoped to `commands/consult`, since `doctor.ts` keeps its import until Phase 3.
3. **Validator location.** *Accepted.* Same fix as codex 3.
4. **Stream for the binary and auth lines.** *Accepted.* Both go out through `console.error`, and stdout carries only the review text.
5. **`--permission-prompts none`.** *Considered, not adopted.* It is absent from CLI 2.1.105 (checked in the SDK's bundled `cli.js`) and unverified at the 2.1.141 floor, so using it would silently invalidate the floor constant. `dontAsk` is present at 2.1.105 and documented to deny rather than prompt, and stdin is closed after the prompt. The live check confirms nothing blocks. The `--restricted` + `bypassPermissions` incompatibility is now noted against the fallback.
6. **Floor discipline for any added flag.** *Accepted.* Every Phase 2 flag is verified present at 2.1.105. The plan states that nothing else is added, and that any later flag must be verified at the floor or the floor must be raised in the same commit.
7. **Assert the init event's tool list, and use the comma form.** *Accepted, made a runtime guard.* The lane requires the init event and fails, killing the child, if its tools are not a subset of Read/Glob/Grep. The check runs in the fixture capture, the lane tests and the live check. All variadic flags (`--tools`, `--allowedTools`, `--add-dir`) use one comma-joined value.
8. **Stale comments in `consultant-role.test.ts` and `cli.ts`.** *Accepted.* The first is updated in Phase 2, the second in Phase 3.
9. **A codex-only machine must still pass doctor.** *Accepted.* Added as a Phase 3 acceptance line.
