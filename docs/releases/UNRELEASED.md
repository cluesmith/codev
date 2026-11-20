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

## Native Windows (preview)

Codev now runs natively on Windows 11, no WSL required (#1658, PR #1859). Install needs Node.js 22 or 24, Git for Windows and `jq`, with no admin rights or Developer Mode. Builders, Tower, the dashboard, `consult`, `codev doctor` and the Codev IDE server all work from a native checkout; the Windows Terminal is PowerShell while Codev's own plumbing runs in Git Bash. Platform-specific behaviour now lives behind a small set of capabilities with POSIX and Windows implementations, so macOS and Linux behaviour is unchanged. Native support is a preview until the remaining release blocker lands (#1911): until then, use it only in repositories you trust. WSL 2 remains a supported path.

Follow-ups since the preview landed:

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

## Polish

<!-- Small vscode items as bullets:
       - **<Headline>** (#<issue>, PR #<pr>). <One short paragraph of context.>
     Move out to its own ## section if the entry grows past ~3 sentences. -->

## Other fixes (dashboard, porch, infrastructure)

<!-- Non-vscode work that ships in the npm release. Same bullet shape as Polish. -->

- **Tower no longer retries a shellper whose pid was reused after a reboot** (#1877, PR #1878). A persisted terminal row whose process id now belongs to an unrelated program was kept and retried every couple of seconds, growing the Tower log without bound (354 MB on one machine). The row is now deleted the first time Tower sees it, with one log line, and the unrelated process is never signalled.
- **Mobile keyboards no longer duplicate text in the dashboard terminal** (#1883, PR #1884). Accepting a suggestion, autocorrect or smart punctuation on a phone resent the partial word and the clause before it. On touch devices every soft-keyboard edit is now sent as a replace: deletes for the text being replaced, then the new text. Desktop typing is unchanged.
- **Repeated hardware keys arrive on touch devices** (#1886, PR #1888). On an iPad with a hardware keyboard, holding Backspace or an arrow key, or typing a fast double letter, dropped keys. The duplicate guard that caused it is off on touch devices now that the keyboard bridge owns soft-keyboard input there.
- **The codex review lane runs a current Codex CLI and says which one** (#1880, PR #1889). The bundled Codex CLI is now 0.167.0, every codex run prints the binary it used, and `consult.codexPath` in `.codev/config.json` points the lane at a CLI of your own. A missing or unusable path fails the run rather than falling back silently. The lane still runs on the ChatGPT subscription and never passes an API key.
- **`consult` finds the project from a slugless builder worktree** (#1898, PR #1899). Running consult by hand inside `.builders/bugfix-N` or `.builders/spir-N` exited with a project list thousands of characters long. It now resolves the worktree's project the way porch does, and every not-found error is one short line that says what to pass.
- **PIR prompts match porch, and issue numbers and titles render in prompts** (#1903, PR #1904). PIR's review prompt disagreed with its protocol definition, so builders following it stalled or skipped steps, and porch never substituted the issue number and title placeholders in PIR, AIR and BUGFIX prompts. Both are fixed; the BUGFIX goal header now shows the real issue title.
- **The CI health cron no longer sends false "CI failing" alerts** (#1921, PR #1929). On Windows the task's command was mis-parsed by `cmd.exe` and its error text was delivered as the failing-workflow list; on every platform a missing or unauthenticated `gh` read the same way. The shipped task and the skeleton example are quoted for both shells and alert only on a clean run with real failures, and the cron docs say how to write conditions.
- **Prompt sweep across roles, skills and protocols** (#1902, PR #1905). Commands that no longer exist, the contradiction over who runs `porch approve`, stale gate lists and copied-then-diverged rules are fixed across every tree. BUGFIX and AIR consultations now honour the project's configured reviewer models. Found and fixed on the way: `porch <command> --help` used to run the command; it now prints help.

## Breaking changes

None.

## Install

```bash
npm install -g @cluesmith/codev@X.Y.Z
afx tower stop && afx tower start
```

The VS Code extension ships separately via the Marketplace — `Codev` extension by `cluesmith.codev`, version `X.Y.Z`.

## Contributors

<!-- Filled at release time. Use the topic-first voice from prior release notes:
       - **<Name> (@<handle>)** — <topic>: <what they did across which PRs>.
       - Builders working under AIR / BUGFIX / PIR / SPIR protocols across the PRs in this release.
     Source: git log v<prev>..HEAD --merges --pretty=format:"%h %an %s" -->
