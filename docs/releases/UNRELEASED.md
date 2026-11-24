# Unreleased

<!--
  TEMPLATE — copy to docs/releases/UNRELEASED.md at the start of each release cycle:

      cp docs/releases/UNRELEASED.template.md docs/releases/UNRELEASED.md

  Edit UNRELEASED.md across the cycle (the working copy). NEVER edit this
  template directly — it's the cold-start structure, untouched between cycles.

  Per-PR architect workflow (on the docs/vscode-changelog branch):
    1. cd worktrees/changelog                       # no fetch / no rebase — branches diverge by design
    2. Add the CHANGELOG entry to apps/vscode/CHANGELOG.md under [Unreleased]
       (add the [Unreleased] heading if it's missing — post-release state removes it)
    3. Add the matching release-notes entry to UNRELEASED.md under the right section:
         substantive change → its own ## section
         small vscode item  → Polish
         non-vscode change  → Other fixes
    4. Commit both files together; plain `git push` (fast-forward, no force)

  Why no rebase, ever: main moves with code merges, docs/vscode-changelog moves
  with changelog/release-notes entries — neither branch touches the other's
  files, so they diverge by design and reconcile at release time via merge.
  Rebasing rewrites commit hashes and forces force-pushes for zero real benefit.

  At release time:
    1. Rename the title to `# vX.Y.Z <Codename>` and add `Released: YYYY-MM-DD`
    2. Replace this entire comment block with the release Summary paragraph
       (one paragraph framing what shipped — lead with the biggest story)
    3. Fill in the Contributors section at the bottom
    4. git mv docs/releases/UNRELEASED.md docs/releases/vX.Y.Z-<codename>.md
    5. Commit, plain push, merge to main alongside the version bump
    6. Re-cp the template back to UNRELEASED.md to start the next cycle
-->

## Summary

Codev now runs natively on Windows 11 without WSL, and the work since the first Windows build closes the gaps that kept it a preview: Windows never runs a program from the current folder, and everything a session starts ends with that session. Node.js 22 is now the minimum on every platform. The claude review lane runs on your installed Claude Code and your subscription login. The dashboard's Open IDE link works over Codev Cloud, the Decisions tab shows workspace images, and `afx status` shows what each builder is doing. `porch skip-phase` drops an unbuilt plan phase, and `afx send`, `afx cleanup`, `afx spawn` and `porch` gain small options. A set of terminal, Tower, consult and prompt fixes rounds it out.

## Node.js 22 is the minimum

Codev now requires Node.js 22 or newer; Node.js 20, which reached end of life in April 2026, is no longer supported (#1944, PR #1962). The package declares `node >=22.0.0`, `codev doctor` fails on anything older, and every CI job on every platform runs on Node 22, the one tested version. On macOS and Linux an install on an older Node prints npm's engine warning and proceeds; on native Windows the installer refuses a Node version that has no prebuilt native binaries, as before. Newer Node versions with prebuilt binaries still install but are not tested. The install docs, the Ubuntu and Debian quick-install steps and `codev doctor`'s Linux hint now install Node 22 from NodeSource, because the distribution packages are older.

## Native Windows

Codev now runs natively on Windows 11, no WSL required (#1658, PR #1859). Install needs Node.js 22, Git for Windows and `jq`, with no admin rights or Developer Mode. Builders, Tower, the dashboard, `consult`, `codev doctor` and the Codev IDE server all work from a native checkout; the Windows Terminal is PowerShell while Codev's own plumbing runs in Git Bash. Platform-specific behaviour now lives behind a small set of capabilities with POSIX and Windows implementations, so macOS and Linux behaviour is unchanged. The preview label is gone now that Windows never runs a program from the current folder (#1911, below). WSL 2 remains a supported path.

Follow-ups since native support landed:

- **Windows never runs a program from the current folder** (#1911, PR #1948). Windows looks up a program started by bare name in the current folder before `PATH`, so a `git.exe` committed to a repository ran in place of Git whenever Codev ran `git` there. Every Codev command, Tower and every terminal Tower opens now turn that lookup off, and the VS Code extension refuses a `codev`, `afx` or `porch` that is not on `PATH`. In a `cmd.exe` session inside a Codev terminal, a program in the current folder now needs `.\name`, as PowerShell already required. This was the release blocker that kept native Windows a preview.
- **Everything a session starts ends with the session** (#1915, PR #1959). A program left behind by an agent command that timed out, typically a drive-wide `find`, kept running after its session closed, because Git Bash moved every program it started out of the session's job. Session jobs no longer allow that, so closing a session or running `afx cleanup` ends everything it started, and Tower refuses to start inside a session's job. A GUI program or background server started from a Codev terminal now ends with that terminal; start it from outside Codev to keep it running.
- **No console windows flash while an agent works** (#1919, PR #1932). Tower runs without a console on Windows, so every console program it started without hiding got a window of its own, about twice a second while the Team view refreshed. Every spawn reachable from Tower, `afx` and the extension host is now hidden, the Team view refreshes only while visible and at most every 30 seconds, and a guard test fails CI on any new unhidden spawn.
- **Mail to the architect is delivered after a Tower restart** (#1920, PR #1928). Architect sessions started with no `TERM`, so Claude drew its ASCII prompt marker and the delivery gate never saw an idle prompt. Every Tower-launched terminal now gets `TERM=xterm-256color`, and the gate also accepts the ASCII marker for sessions already drawn that way.
- **One cursor in the dashboard terminal** (#1917, PR #1934). Reopening or reloading the dashboard re-showed a cursor Claude had hidden, because the attach snapshot did not carry cursor visibility; on Windows that cursor sat away from Claude's own. The snapshot now carries it.
- **The test suite no longer stops your live Tower** (#1922, PR #1926). Running the full suite on a native Windows machine could stop a Tower it had not started, and `codev update` and `codev adopt` launched their merge session without waiting for it. Both now wait for the session, start an npm-installed `claude.cmd` on Windows, and the suite skips the Tower launch test when port 4100 is already in use.
- **Running the repository's pnpm scripts on native Windows** (PR #1918). The contributor notes in the `codev` skill explain the one-time `script-shell` setting that lets the `.sh` scripts run under Git Bash.

## The claude review lane runs on your installed Claude Code

`consult -m claude` now runs your installed `claude` CLI on your subscription login instead of the bundled Agent SDK (#1912, PR #1913). It needs Claude Code 2.1.141 or newer on `PATH`, or pinned with `CODEV_CLAUDE_BIN`; `codev doctor` now reports the installed version and whether it is logged in. The lane runs read-only (Read, Glob and Grep only), on a budget, with your API keys withheld from the child by default; set `consult.claudeAuth` to `api-key` to use a key instead. The SDK dependency is gone from the install.

## Drop a plan phase after implementation has started

`porch skip-phase <id> <plan-phase> --reason "..."` removes one unbuilt phase from a project's state so review becomes reachable again when the owner drops a phase from an approved plan (#1900, PR #1908). The skip and its reason stay visible in `porch status`, and builder progress counts leave the skipped phase out. It is a human decision, so the command takes the same explicit-approval flag as a gate.

## Open the IDE from the dashboard over Codev Cloud

The dashboard's **Open IDE** link now appears when the dashboard is reached through Codev Cloud, not only on a local Tower (#1914, PR #1931). The IDE signal travels with the dashboard's regular status poll, the link opens the workbench relative to the page's own address so a cloud-side Tower rename cannot strand it, and over the cloud the page skips the local-only cookie step and lets the cloud session authorize the request. The forward also scopes the IDE's token cookie to this Tower's cloud prefix so Towers sharing the cloud origin cannot overwrite each other's, and the public prefix follows the cloud relay's stamp rather than a stored name. Locally nothing changes except that the dashboard no longer runs a blocking port probe on load.

## Other fixes (dashboard, porch, infrastructure)

- **Tower no longer retries a shellper whose pid was reused after a reboot** (#1877, PR #1878). A persisted terminal row whose process id now belongs to an unrelated program was kept and retried every couple of seconds, growing the Tower log without bound (354 MB on one machine). The row is now deleted the first time Tower sees it, with one log line, and the unrelated process is never signalled.
- **Mobile keyboards no longer duplicate text in the dashboard terminal** (#1883, PR #1884). Accepting a suggestion, autocorrect or smart punctuation on a phone resent the partial word and the clause before it. On touch devices every soft-keyboard edit is now sent as a replace: deletes for the text being replaced, then the new text. Desktop typing is unchanged.
- **Repeated hardware keys arrive on touch devices** (#1886, PR #1888). On an iPad with a hardware keyboard, holding Backspace or an arrow key, or typing a fast double letter, dropped keys. The duplicate guard that caused it is off on touch devices now that the keyboard bridge owns soft-keyboard input there.
- **The codex review lane runs a current Codex CLI and says which one** (#1880, PR #1889). The bundled Codex CLI is now 0.167.0, every codex run prints the binary it used, and `consult.codexPath` in `.codev/config.json` points the lane at a CLI of your own. A missing or unusable path fails the run rather than falling back silently. The lane still runs on the ChatGPT subscription and never passes an API key.
- **`consult` finds the project from a slugless builder worktree** (#1898, PR #1899). Running consult by hand inside `.builders/bugfix-N` or `.builders/spir-N` exited with a project list thousands of characters long. It now resolves the worktree's project the way porch does, and every not-found error is one short line that says what to pass.
- **PIR prompts match porch, and issue numbers and titles render in prompts** (#1903, PR #1904). PIR's review prompt disagreed with its protocol definition, so builders following it stalled or skipped steps, and porch never substituted the issue number and title placeholders in PIR, AIR and BUGFIX prompts. Both are fixed; the BUGFIX goal header now shows the real issue title.
- **The CI health cron no longer sends false "CI failing" alerts** (#1921, PR #1929). On Windows the task's command was mis-parsed by `cmd.exe` and its error text was delivered as the failing-workflow list; on every platform a missing or unauthenticated `gh` read the same way. The shipped task and the skeleton example are quoted for both shells and alert only on a clean run with real failures, and the cron docs say how to write conditions.
- **Browser tests run on a pinned Ubuntu image** (#1935, PR #1936). GitHub's floating Ubuntu runner moved to 26.04, which the Playwright release this repository uses has no Chromium build for, so the dashboard and browser test jobs failed with no browser to launch. Those jobs are pinned to Ubuntu 24.04 with a note on when to move the pin, a step that runs after the suite no longer runs when the browser install itself failed, and a test keeps any new Playwright job pinned and gated.
- **`afx status` shows what each builder is doing** (#1893, PR #1955). Every builder used to read `implementing / init`. The table now shows each builder's live porch phase, the gate it waits at and for how long, and when its terminal last printed; `afx status --activity` adds the session's last messages, an API-error flag and any running test or review process. `--json` keeps its existing fields and adds the new ones.
- **`afx send`, `afx cleanup`, `afx spawn` and `porch` gain small options** (#1950, PR #1954). `afx send --message-file` reads the message from a file so it never passes through a shell, `--exit-code` reports delivered, held, unverified or failed in the exit status, and `--retry` retries only when Tower was never reached. `afx cleanup --keep-ignored` saves a worktree's untracked and selected ignored files before removing it, `afx spawn --max-load` with `--wait` holds a spawn while the machine is busy, and `porch -C <dir>` runs porch against another directory.
- **Workspace images render in the Decisions tab** (#1938, PR #1939). A decision item can show an image saved in the workspace, for example `![Compact layout](decision-assets/web-4-compact.png)`, in its body, its question and answer entries and the ruled section. Only image files inside the workspace are served, up to 10 MB each; `http(s)` images work as before.
- **Follow-ups to the claude review lane** (#1941, PR #1942). The not-logged-in advice now matches the configured mode (`claude auth login`, or check the key when `consult.claudeAuth` is `api-key`), the install hint names the npm route as well, and a duplicate entry in the reviewer's tool list no longer aborts the run. New `consult.claudeMaxTurns` (default 200) and `consult.claudeMaxBudgetUsd` (default 25) set the lane's caps. The docs state the Claude Code 2.1.141 minimum and that withholding the API key is a billing guarantee, not secrecy.
- **Prompts no longer name framework files by a path adopters do not have** (#1910, PR #1949). Shipped prompts and templates pointed at files such as `codev/protocols/spir/protocol.md`, which exist only inside the installed package, so agents searched the disk for them. Those paths are gone, and the builder and architect roles now say never to search from the filesystem root.
- **Prompt sweep across roles, skills and protocols** (#1902, PR #1905). Commands that no longer exist, the contradiction over who runs `porch approve`, stale gate lists and copied-then-diverged rules are fixed across every tree. BUGFIX and AIR consultations now honour the project's configured reviewer models. Found and fixed on the way: `porch <command> --help` used to run the command; it now prints help.

## Breaking changes

- **Node.js 20 is no longer supported** (#1944). Upgrade to Node.js 22 before installing this release. On macOS and Linux an older Node still installs with a warning, but `codev doctor` reports it as failing and nothing is tested there.
- **On native Windows, a program started from a Codev terminal ends with that terminal** (#1915), and in a `cmd.exe` session a program in the current folder needs `.\name` (#1911). Both apply only to native Windows, which is new in this release.

## Install

```bash
npm install -g @cluesmith/codev@3.3.8
afx tower stop && afx tower start
```

The VS Code extension ships separately via the Marketplace — `Codev` extension by `cluesmith.codev`, version `3.3.8`.

## Contributors

- **Amr Elsayed (@amrmelsayed)**: native Windows support and its follow-ups (Spec 1658, PRs #1859, #1918, #1926, #1928, #1932, #1934, #1948, #1959); Open IDE over Codev Cloud (PR #1931); the Node.js 22 floor (PR #1962); the CI health cron, pinned browser-test image and framework-path prompt fixes (PRs #1929, #1936, #1949).
- **M Waleed Kadous (@waleedkadous)**: the claude review lane on the installed CLI and its follow-ups (PRs #1913, #1942); the codex lane and consult worktree fixes (PRs #1889, #1899); `porch skip-phase` (PR #1908); `afx status` live phases and the new CLI options (PRs #1955, #1954); Decisions tab images (PR #1939); mobile keyboard and touch-device terminal fixes (PRs #1884, #1888); the reused-pid shellper fix (PR #1878); the PIR prompt fix and prompt sweep (PRs #1904, #1905).
- Builders working under AIR, BUGFIX, PIR and SPIR protocols across the PRs in this release.
