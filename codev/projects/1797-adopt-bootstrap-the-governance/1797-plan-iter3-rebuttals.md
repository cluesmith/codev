# Plan iter3 rebuttals / dispositions

Gemini: APPROVE. Claude: APPROVE (with minor items). Codex: REQUEST_CHANGES.

## Codex
1. Gitignored paths not detected: PARTIALLY REBUTTED. The spec's detector snapshots "the four files and the git state". Gitignored paths are not git state and never reach a commit, and hashing them (node_modules, build output) makes runs slow and noisy. The plan keeps the narrower reading, states it in every summary, and flags it for the human at the plan gate.
2. `--grep` alternation without `-E`: ACCEPTED; uses `-i -E`.
3. Contradictions (exec summary "no index fingerprint"; risk table "informational"): ACCEPTED; both fixed.

## Claude (minor items, all ACCEPTED)
- cli.ts and the UpdateResult field are added to phase 6's file list.
- Codex headless detection matches a named subcommand list instead of the first non-flag token.
- The RetiredHarnessError is caught, so a retired harness resolves to "unsupported".
- The risk table now names the `diffTreeSnapshots` signature change.
- The non-git walk is bounded at 50k files.
