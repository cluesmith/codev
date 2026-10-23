# Phase 11, iteration 2: responses

## Codex (REQUEST_CHANGES)

1. **The install verification ran npm's install scripts under Git Bash.** Correct: the workflow
   sets `npm_config_script_shell` to Git Bash for building the repo, and the verification step
   inherited it. Fixed: the step runs under `env -u npm_config_script_shell`, so the install uses
   npm's default `cmd.exe`, as a user's does and as `windows-probe.mjs` already did. Re-dispatched.

## Claude (APPROVE), notes

- Windows `unit` omits apps/* and artifact-canvas: stated as a limitation in the review's new
  Phase 11 section (no platform branches there; they run on POSIX).
- Review had no Phase 11 section: added.
- The plan's "`version` alone runs only post-release-e2e" wording: the workflow comment is the
  accurate one (probes always run); the plan's deviation note already describes the job gating.
- The skill-hash generator run produced no change: confirmed, `git status` clean for it.

## Gemini

Skipped (agy).
