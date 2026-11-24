# Increment-1 rendered verification

Results (`verify-*.json`) and screenshots (`shots/`) from the isolated harness
(`apps/vscode/scripts/cockpit-harness/`), VS Code 1.147.0 serve-web. They come from two runs.

| Files | Run |
|---|---|
| `render`, `reveal`, `windows`, `requests` (results, `requests-table.json`, shots) | Increment 1, Phase 5 (`cockpit_actions`), 2026-11-24 10:34–10:42Z, committed in `7096e73a8` |
| `actions`, `reconnect` (results, shots) | The review phase, 2026-11-24 16:25Z, on the PR's final code |

The `actions` and `reconnect` files were replaced because the originals showed the machine's shell
prompt (`host:dir user$`) in a terminal panel VS Code opened by itself. The harness now gives its
shells a bare prompt, and every `verify` run fails on a screenshot that shows one. The re-run used
the same sequence on one `start`, with `render`, `reveal`, `windows` and `requests` first. Each
script gained one check, the prompt check: `actions` 28/28, `reconnect` 4/4.

The originals remain in the branch history.
