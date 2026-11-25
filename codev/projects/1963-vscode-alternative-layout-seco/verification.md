# Spec 1963 rendered verification: index

Every run below is on one of two heads; each folder's `head.txt` names its head:
- `d31df3a84`, with the vsix built at `7cdc24716`: every script that renders the Work or Decisions
  panel. On 1.147.0 that is `decisions`, `work`, `arrange` and `webviews`; on 1.138.0 and 1.128.0,
  every run.
- `35334efbf`, with the vsix built at `4ab7ed1d4`: the nine scripts that render no panel (`render`,
  `reveal`, `windows`, `requests`, `actions`, `reconnect`, `dashboard`, `profile-seed`,
  `profile-existing`).

In each pair, the one commit between the build and the head changes only the harness, which is not
a vsix input.

Between the two heads, the vsix inputs (`apps/vscode` without the harness, `packages`,
`pnpm-lock.yaml`) changed only in the panels' stylesheet and its test (`7cdc24716`; `d31df3a84`
after it changes only the harness):

```
$ git diff --stat=110 35334efbf d31df3a84 -- apps/vscode ':(exclude)apps/vscode/scripts/cockpit-harness' packages pnpm-lock.yaml
 apps/vscode/src/__tests__/workspace-views-theme.test.ts  | 92 ++++++++++++++++++++++++++++++++++++++++++++++
 apps/vscode/src/workspace-views/webview/vscode-theme.css | 64 ++++++++++++++++++++++++++++++++
 2 files changed, 156 insertions(+)
```

The PR's commits after `d31df3a84` change only documents, none of them a vsix input. The
harness is `apps/vscode/scripts/cockpit-harness/`: its own Tower on its own port, headless
Chromium, and fixture workspaces. The two fenced servers ran inside its network sandbox, which
refuses outbound TCP to the owner's Tower port (a canary proves it at every start), with the
tripwire watching. The evidence is on the never-merged branch `evidence/spir-1963`, pinned here
to its commit [`8b7def1ed`](https://github.com/cluesmith/codev/tree/8b7def1ed5248a1831919869328c17c3623db2ee/).

- **VS Code 1.147.0, serve-web:** 115 of 115 checks passed.
- **Codev IDE 1.138.0 (its VS Code Server), fenced:** 53 of 56 checks passed; the 3 failures are the three webviews outside this PR that the IDE leaves blank (below).
- **VS Code Server 1.128.0 (the engine floor), fenced:** 50 of 50 checks passed.

Each run's last check reads every screenshot it took with OCR and fails on a machine shell prompt.

**Codev IDE 1.138.0 blanks every webview that loads its files by URL**
([cluesmith/codev-ide#67](https://github.com/cluesmith/codev-ide/issues/67): its product.json pins a
webview host page whose service worker cannot deliver a webview's resources). The Work and Decisions
panels carry their code inline, so they render there. VS Code's own Markdown preview, the contextual
panel and the Codev Markdown preview do not, until the IDE is fixed; `webviews` records them.

**The same old host page left `code` white on white in High Contrast Light.** The first fenced
1.138.0 `decisions` run, on `35334efbf`, passed 15 of 16: the Decisions file path measured contrast 1.
That page's default styles give `code` the theme's preformatted foreground (white in High Contrast
Light) without its dark blue background, and they are unlayered; 1.128's and 1.147's set both, in
`@layer vscode-default`. `7cdc24716` states, in the panels' own stylesheet, 1.147's value for every
default that differs on that page, for every element the panels render (code, `a code`, `pre code`,
`p > a`, `kbd`, `video`, the body's `overscroll-behavior-x`). Under each page's defaults, measured
in headless Chromium, the panels' computed styles then match 1.147's on the old page and on 1.128,
and 1.147 renders exactly as before. The panel scripts were then run again. On that head, fenced
1.138.0 `work` failed one check on a harness race: after the reload it counted Decisions' cards before
the window's automatic arrange had brought the panel on screen (0 before Tower went down, 2 while down
and 2 after). `d31df3a84` makes the check wait for them, and every panel script ran again on it.

**Earlier counts were per phase.** The index before this one listed 127 of 127 checks, each script
counted from its own phase's run. The runs below replace them.
- Run here for the first time since the phase that built them: `decisions`, `work` and `dashboard`
  (Phase 8), and `profile-seed` and `profile-existing` (Phase 9).
- `render`, `reveal`, `windows` and `requests` were counted from increment 1. They ran again in the
  review phase's evidence run (16:11–16:30Z), but the index kept their increment-1 files.
- `actions` and `reconnect` were counted from that review-phase run, and `arrange` from its run on the
  pre-rewrite head `c79b1c7e1` (17:41Z).
- `webviews` is new: the 1.138 diagnostic.
- Counts from before the review phase lack the screenshot prompt check added then, so those scripts
  count one check more here.

**Gaps in the 1.147 run times.** The nine scripts that render no panel ran from 22:21Z to 22:37Z on
`35334efbf`; the panel scripts ran from 23:37Z on `d31df3a84`, after the two fixes above. The first
gap, inside the `35334efbf` run, was serve-web's own update check. `code serve-web` asks Microsoft's
update service for the latest server whenever a window connects. At 22:37:37Z that request failed
(the server log: `Could not check for update: error requesting
https://update.code.visualstudio.com/api/latest/server-darwin-arm64-web/stable: ... connection
closed via error`), and the page showed that text instead of the workbench. The first `decisions`
attempt (22:37–22:44Z) therefore failed 3 of 16: its first check timed out waiting for the
workbench, and every later check followed from it. The service answered normally at 22:42Z. The
run stopped, as ordered; the architect ruled to keep the seven scripts already passed and resume
at `decisions` on the same head, and that a failure showing this error may be re-run once. The
resumed runs passed (`decisions` 16/16, `work` 15/15, `arrange` 19/19, `profile-seed` 2/2,
`profile-existing` 2/2, `webviews` 6/6); the panel scripts among them were then run again on
`d31df3a84`, and the profile scripts' runs are the ones listed here.
No later script met that error.

**`dashboard` runs its five checks, without the snapshot comparison.** That comparison (computed
style and DOM, element by element) was last made in Phase 8: `432d706c0`, the build before that
phase's change, against `d51e28eea` (`b9e5af0f` and `b3aa8873` before the history rewrite), and
found every element identical. The dashboard has changed on purpose since: the Work review fixes
in `ce43aeb7f` (each section shows *Loading…* when the first read fails, instead of claiming an
empty workspace; two-line rows at narrow widths; late refusals dropped) and `ccd025a50`. It is
otherwise covered by the web unit tests, the two dashboard-host tests
(`apps/web/__tests__/WorkView.dashboard-host.test.tsx`, `DecisionsView.dashboard-host.test.tsx`)
and the browser tests in CI.

## VS Code 1.147.0, serve-web

[Browse the folder](https://github.com/cluesmith/codev/tree/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web). Server commit `8a14f0cc1b08d531eb83255ea3764ae22aa932b5`. Ran every verify script.

### `render`: 6/6

[`verify-render.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/render/verify-render.json), run 2026-11-24T22:22:11.631Z on `35334efbf`.

- PASS scenario 11: the Cockpit button sits directly below Codev ([render-01-activity-bar](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/render/render-01-activity-bar.png))
- PASS scenario 11: the existing Codev container is unchanged ([render-02-codev-container](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/render/render-02-codev-container.png))
- PASS scenario 12: hierarchy with N>1, N=1 and N=0 builders across workspaces ([render-03-hierarchy-light](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/render/render-03-hierarchy-light.png))
- PASS the Dormant group ([render-04-dormant](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/render/render-04-dormant.png))
- PASS scenario 18 (hierarchy part): dark theme, then a live switch back to light ([render-05-hierarchy-dark](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/render/render-05-hierarchy-dark.png), [render-06-hierarchy-light-again](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/render/render-06-hierarchy-light-again.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `reveal`: 2/2

[`verify-reveal.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/reveal/verify-reveal.json), run 2026-11-24T22:22:29.155Z on `35334efbf`.

- PASS active-file reveal expands collapsed workspace and architect rows ([reveal-01-collapsed](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/reveal/reveal-01-collapsed.png), [reveal-02-revealed](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/reveal/reveal-02-revealed.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `windows`: 4/4

[`verify-windows.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/windows/verify-windows.json), run 2026-11-24T22:23:52.484Z on `35334efbf`.

- PASS scenario 19: builder-worktree window — the parent row carries worktree-scoped actions only ([windows-01-worktree-window](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/windows/windows-01-worktree-window.png))
- PASS scenario 19: no-workspace window — the state row explains and offers Open Folder ([windows-02-no-workspace-window](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/windows/windows-02-no-workspace-window.png))
- PASS scenario 19: Codev container hidden, Cockpit visible — a builder change appears within one refresh interval ([windows-03-cockpit-only-fresh](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/windows/windows-03-cockpit-only-fresh.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `requests`: 5/5

[`verify-requests.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/requests/verify-requests.json), run 2026-11-24T22:29:58.891Z on `35334efbf`.

- PASS scenario 21: cockpit-alone ([requests-01-cockpit-alone](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/requests/requests-01-cockpit-alone.png))
- PASS scenario 21: source-views-alone ([requests-02-source-views-alone](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/requests/requests-02-source-views-alone.png))
- PASS scenario 21: both ([requests-03-both](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/requests/requests-03-both.png))
- PASS scenario 21: the request counts match
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `actions`: 28/28

[`verify-actions.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/actions/verify-actions.json), run 2026-11-24T22:35:29.750Z on `35334efbf`.

- PASS scenario 12: a builder row's menu shows the Agents entries (blocked and waiting rows)
- PASS the same builder's menu in the Agents view matches the Cockpit's
- PASS Approve Gate is inline on the blocked row only
- PASS builder menu › Codev: Open Builder Terminal ([actions-01-open-builder-terminal](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/actions/actions-01-open-builder-terminal.png))
- PASS builder menu › Codev: View Spec File ([actions-02-view-spec](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/actions/actions-02-view-spec.png))
- PASS builder menu › Codev: View Plan File
- PASS builder menu › Codev: View Review File
- PASS builder menu › Codev: View Diff ([actions-03-view-diff](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/actions/actions-03-view-diff.png))
- PASS builder menu › Codev: Open Worktree in New Window
- PASS builder menu › Codev: Open Worktree Folder
- PASS builder menu › Codev: Run Worktree Setup
- PASS builder menu › Codev: Run Dev, then the workspace row offers Stop Dev; then Codev: Stop Dev ([actions-04-worktree-dev-running](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/actions/actions-04-worktree-dev-running.png))
- PASS Approve Gate (inline) on #101 relays to its architect
- PASS workspace row: inline and context entries ([actions-05-workspace-row](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/actions/actions-05-workspace-row.png))
- PASS workspace row › Spawn Builder (inline) runs `afx spawn` through the stub
- PASS workspace row › New Shell (inline) ([actions-06-new-shell](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/actions/actions-06-new-shell.png))
- PASS workspace row › Add Architect (inline) asks main
- PASS workspace row › Open Web Interface opens the isolated Tower's dashboard
- PASS workspace row › Start Dev, then Stop Dev replaces it, then Stop Dev ([actions-07-workspace-dev-running](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/actions/actions-07-workspace-dev-running.png))
- PASS workspace row › Open Dev URL lists both URLs and opens the picked one
- PASS Remove Architect is offered on siblings only; a childless sibling's row goes with it ([actions-08-qa-added](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/actions/actions-08-qa-added.png), [actions-09-qa-removed](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/actions/actions-09-qa-removed.png))
- PASS Remove Architect on a sibling with a builder: the header stays as the builder's owner ([actions-10-web-removed](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/actions/actions-10-web-removed.png))
- PASS another workspace's rows carry no builder or architect actions
- PASS scenario 12: another workspace's architect row opens that workspace's window
- PASS scenario 12: another workspace's builder row opens that workspace's window
- PASS another workspace row: inline Open opens it, as in the Tower view
- PASS another workspace row: inline Deactivate moves it to Dormant ([actions-11-gamma-dormant](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/actions/actions-11-gamma-dormant.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `reconnect`: 4/4

[`verify-reconnect.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/reconnect/verify-reconnect.json), run 2026-11-24T22:35:56.184Z on `35334efbf`.

- PASS a loaded Cockpit keeps its content while the isolated Tower is down ([reconnect-01-connected](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/reconnect/reconnect-01-connected.png), [reconnect-02-tower-down-loaded](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/reconnect/reconnect-02-tower-down-loaded.png))
- PASS a window loaded while Tower is down shows Not connected to Tower ([reconnect-03-not-connected](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/reconnect/reconnect-03-not-connected.png))
- PASS Tower back + the row's Reconnect → the hierarchy returns ([reconnect-04-reconnected](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/reconnect/reconnect-04-reconnected.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `dashboard`: 6/6

[`verify-dashboard.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/dashboard/verify-dashboard.json), run 2026-11-24T22:37:07.992Z on `35334efbf`; also [`dashboard-snapshot.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/dashboard/dashboard-snapshot.json).

- PASS scenario 20: the dashboard Work tab renders ([dashboard-01-work](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/dashboard/dashboard-01-work.png))
- PASS scenario 20: the dashboard Decisions tab renders ([dashboard-02-decisions](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/dashboard/dashboard-02-decisions.png))
- PASS scenario 20: a Decisions link and image open in a new tab
- PASS scenario 20: a ruling round-trips ([dashboard-03-decisions-draft](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/dashboard/dashboard-03-decisions-draft.png), [dashboard-04-decisions-ruled](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/dashboard/dashboard-04-decisions-ruled.png))
- PASS scenario 20: Work actions (Open, + Shell, Refresh, spec link, issue link)
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `decisions`: 16/16

[`verify-decisions.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/verify-decisions.json), run 2026-11-24T23:38:46.006Z on `d31df3a84`.

- PASS scenario 12: a Decisions entry under every active workspace, none under the dormant one ([decisions-01-entries](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/decisions-01-entries.png))
- PASS scenario 12: another workspace's Decisions entry opens that workspace's window
- PASS scenario 12: this workspace's Decisions entry opens the panel, which renders the items ([decisions-02-panel](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/decisions-02-panel.png))
- PASS scenario 15: a workspace image (bytes through the host), an https image, and two not loaded (the browser's 404, Tower's refusal) ([decisions-03-images](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/decisions-03-images.png))
- PASS scenario 15: the full-size view opens over the panel; Escape and Close each close it ([decisions-04-full-size](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/decisions-04-full-size.png))
- PASS scenario 15: an http(s) link opens in the browser, through the extension host
- PASS scenario 15: rule an item — the file is updated, the card shows the ruling, the architect is notified ([decisions-05-draft](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/decisions-05-draft.png), [decisions-06-ruled](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/decisions-06-ruled.png))
- PASS scenario 15: a stale fingerprint is refused, and the draft is kept ([decisions-07-stale-refused](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/decisions-07-stale-refused.png))
- PASS scenario 21: the Decisions poll stops while its panel is hidden, and resumes when shown
- PASS scenario 18: light, dark and high-contrast themes, switched live with the panel open ([decisions-08-theme-vs-dark](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/decisions-08-theme-vs-dark.png), [decisions-09-theme-hc-black](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/decisions-09-theme-hc-black.png), [decisions-10-theme-hc-light](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/decisions-10-theme-hc-light.png), [decisions-11-theme-vs](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/decisions-11-theme-vs.png))
- PASS the panel is restored after a window reload ([decisions-12-restored](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/decisions-12-restored.png))
- PASS scenario 19: in a builder-worktree window, Open Decisions explains, and the entry navigates to the parent ([decisions-13-worktree-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/decisions-13-worktree-explains.png))
- PASS scenario 19: in a no-workspace window, Open Decisions explains ([decisions-14-no-workspace-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/decisions-14-no-workspace-explains.png))
- PASS scenario 16: no decisions file shows the empty state; afx decisions init, then an item, and it appears ([decisions-15-empty-state](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/decisions-15-empty-state.png), [decisions-16-initialized](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/decisions-16-initialized.png), [decisions-17-item-appears](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/decisions/decisions-17-item-appears.png))
- PASS scenario 22: the webview never contacts Tower; the key is in no request; remote item images are its only network loads
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `work`: 15/15

[`verify-work.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/work/verify-work.json), run 2026-11-24T23:41:11.655Z on `d31df3a84`.

- PASS scenario 17: Open Work opens one panel; builders, Needs Attention, Backlog and Recently Closed render; no dropped affordance ([work-01-panel](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/work/work-01-panel.png))
- PASS scenario 17: a builder's progress bar is drawn at its width under the panel's CSP
- PASS scenario 17: Open opens the builder's terminal ([work-02-open-builder](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/work/work-02-open-builder.png))
- PASS scenario 17: + Shell opens a Tower shell ([work-03-new-shell](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/work/work-03-new-shell.png))
- PASS scenario 17: Refresh drops Tower's overview cache, then re-reads the overview
- PASS scenario 17: a spec link opens the workspace file in an editor ([work-04-spec-link](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/work/work-04-spec-link.png))
- PASS scenario 17: an issue link and a PR link open in the browser, through the extension host
- PASS scenario 18: light, dark and high-contrast themes, switched live with the panel open ([work-05-theme-vs-dark](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/work/work-05-theme-vs-dark.png), [work-06-theme-hc-black](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/work/work-06-theme-hc-black.png), [work-07-theme-hc-light](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/work/work-07-theme-hc-light.png), [work-08-theme-vs](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/work/work-08-theme-vs.png))
- PASS increment 2: the Cockpit's Decisions entries, with the Work and Decisions panels side by side ([work-09-both-panels-dark](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/work/work-09-both-panels-dark.png), [work-10-both-panels-light](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/work/work-10-both-panels-light.png))
- PASS the panel is restored after a window reload ([work-11-restored](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/work/work-11-restored.png))
- PASS scenario 22: the webview never contacts Tower; the key is in no request
- PASS scenario 19: Tower unreachable — both panels keep their content under a not-connected notice, no error toast, and recover ([work-12-tower-down](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/work/work-12-tower-down.png), [work-13-tower-back](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/work/work-13-tower-back.png))
- PASS scenario 19: in a builder-worktree window, Open Work explains ([work-14-worktree-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/work/work-14-worktree-explains.png))
- PASS scenario 19: in a no-workspace window, Open Work explains ([work-15-no-workspace-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/work/work-15-no-workspace-explains.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `arrange`: 19/19

[`verify-arrange.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/verify-arrange.json), run 2026-11-24T23:44:54.931Z on `d31df3a84`.

- PASS fresh profile: the Cockpit button sits directly below Codev
- PASS scenario 13 setup: editors across four groups, two dirty files, a clean file and two untitled buffers ([arrange-01-before](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-01-before.png))
- PASS scenario 7 / 9: the first show of the Cockpit arranges main | (Work over Decisions), each active in its group ([arrange-02-arranged-dark](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-02-arranged-dark.png))
- PASS scenario 7: the one-time notice offers Don't arrange automatically; dismissing it changes nothing ([arrange-03-notice](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-03-notice.png))
- PASS scenario 13: every pre-existing editor survives the arrange with its unsaved content; the architect is the live session; both panels render ([arrange-04-editors-kept](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-04-editors-kept.png))
- PASS scenario 13: re-running Arrange Cockpit (title bar, then palette) changes nothing; a typed Decisions draft persists; no notice ([arrange-05-rerun-draft](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-05-rerun-draft.png))
- PASS the architect's 14:00Z ruling: at the split's Work width the view fits and a typical title stays readable (20+ of 44 characters)
- PASS rendered: the split with a pending decision, in Light Modern and Dark Modern ([arrange-06-split-vs](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-06-split-vs.png), [arrange-07-split-vs-dark](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-07-split-vs-dark.png))
- PASS scenario 7: showing the Cockpit again leaves the editor area alone; the command arranges on demand ([arrange-08-rearranged](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-08-rearranged.png))
- PASS the architect terminal moved into the panel comes back to the left group: the same session ([arrange-09-from-panel](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-09-from-panel.png))
- PASS another terminal named like the architect: arrange stops before moving an editor and says why; with that terminal closed, it arranges (codex review) ([arrange-10-namesake-refused](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-10-namesake-refused.png), [arrange-11-namesake-closed-arranged](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-11-namesake-closed-arranged.png))
- PASS existing profile: after a reload the restored Cockpit arranges again, the architect reopened on the left; no notice; the button is still below Codev ([arrange-12-reloaded](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-12-reloaded.png))
- PASS scenario 14: main not live — the existing warning, no other architect opened, Work and Decisions still arranged ([arrange-13-main-not-live](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-13-main-not-live.png))
- PASS scenario 7 (second fresh profile): Don't arrange automatically turns codev.cockpit.autoArrange off at the user level; the command still arranges ([arrange-14-dont-arrange](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-14-dont-arrange.png), [arrange-15-setting-off-command](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-15-setting-off-command.png))
- PASS scenario 19: in a builder-worktree window, no auto-arrange, no title-bar action, and the command explains ([arrange-16-worktree-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-16-worktree-explains.png))
- PASS scenario 19: in a no-workspace window, no auto-arrange, no title-bar action, and the command explains ([arrange-17-no-workspace-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-17-no-workspace-explains.png))
- PASS a reload with Tower down and the Cockpit showing: the automatic arrange places Work over Decisions and shows no error toast (claude review) ([arrange-18-auto-tower-down](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-18-auto-tower-down.png))
- PASS a restored, not yet revived panel tab counts: with no architect and only Work and Decisions in the first group after a reload, arrange keeps an empty left column (claude review) ([arrange-19-restored-tab-empty-left](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/arrange/arrange-19-restored-tab-empty-left.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `profile-seed`: 2/2

[`verify-profile-seed.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/profile-seed/verify-profile-seed.json), run 2026-11-24T22:54:48.405Z on `35334efbf`.

- PASS existing profile, seeded: a new browser profile uses Codev on a build without the Cockpit container (origin/main's activity bar) ([profile-seed-activity-bar](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/profile-seed/profile-seed-activity-bar.png), [profile-seed-01-seeded](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/profile-seed/profile-seed-01-seeded.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `profile-existing`: 2/2

[`verify-profile-existing.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/profile-existing/verify-profile-existing.json), run 2026-11-24T22:54:55.098Z on `35334efbf`.

- PASS existing profile: where VS Code places the Cockpit button for a profile that used Codev before the Cockpit existed ([profile-existing-activity-bar](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/profile-existing/profile-existing-activity-bar.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `webviews`: 6/6

[`verify-webviews.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/webviews/verify-webviews.json), run 2026-11-24T23:45:30.899Z on `d31df3a84`; also [`verify-webviews-capture.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/webviews/verify-webviews-capture.json).

- PASS workbench loads on alpha
- PASS built-in webview: VS Code's own Markdown preview of a fixture .md renders styled content ([webviews-01-builtin-markdown-preview](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/webviews/webviews-01-builtin-markdown-preview.png))
- PASS existing Codev webview: the contextual panel (codev.contextualPanel) renders ([webviews-02-codev-contextual-panel](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/webviews/webviews-02-codev-contextual-panel.png))
- PASS existing Codev webview: the Codev Markdown preview (codev.markdownPreview) renders ([webviews-03-codev-markdown-preview](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/webviews/webviews-03-codev-markdown-preview.png))
- PASS this PR's Work panel renders ([webviews-04-work-panel](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.147.0-serve-web/webviews/webviews-04-work-panel.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

## Codev IDE 1.138.0 (its VS Code Server), fenced

[Browse the folder](https://github.com/cluesmith/codev/tree/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0). Server commit `50cad256c2ef6d8d156631d1386f12befae4f5f2`. Ran `webviews`, then `arrange`, `work`, `decisions`.

### `decisions`: 16/16

[`verify-decisions.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/verify-decisions.json), run 2026-11-24T23:56:27.741Z on `d31df3a84`.

- PASS scenario 12: a Decisions entry under every active workspace, none under the dormant one ([decisions-01-entries](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/decisions-01-entries.png))
- PASS scenario 12: another workspace's Decisions entry opens that workspace's window
- PASS scenario 12: this workspace's Decisions entry opens the panel, which renders the items ([decisions-02-panel](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/decisions-02-panel.png))
- PASS scenario 15: a workspace image (bytes through the host), an https image, and two not loaded (the browser's 404, Tower's refusal) ([decisions-03-images](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/decisions-03-images.png))
- PASS scenario 15: the full-size view opens over the panel; Escape and Close each close it ([decisions-04-full-size](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/decisions-04-full-size.png))
- PASS scenario 15: an http(s) link opens in the browser, through the extension host
- PASS scenario 15: rule an item — the file is updated, the card shows the ruling, the architect is notified ([decisions-05-draft](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/decisions-05-draft.png), [decisions-06-ruled](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/decisions-06-ruled.png))
- PASS scenario 15: a stale fingerprint is refused, and the draft is kept ([decisions-07-stale-refused](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/decisions-07-stale-refused.png))
- PASS scenario 21: the Decisions poll stops while its panel is hidden, and resumes when shown
- PASS scenario 18: light, dark and high-contrast themes, switched live with the panel open ([decisions-08-theme-vs-dark](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/decisions-08-theme-vs-dark.png), [decisions-09-theme-hc-black](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/decisions-09-theme-hc-black.png), [decisions-10-theme-hc-light](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/decisions-10-theme-hc-light.png), [decisions-11-theme-vs](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/decisions-11-theme-vs.png))
- PASS the panel is restored after a window reload ([decisions-12-restored](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/decisions-12-restored.png))
- PASS scenario 19: in a builder-worktree window, Open Decisions explains, and the entry navigates to the parent ([decisions-13-worktree-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/decisions-13-worktree-explains.png))
- PASS scenario 19: in a no-workspace window, Open Decisions explains ([decisions-14-no-workspace-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/decisions-14-no-workspace-explains.png))
- PASS scenario 16: no decisions file shows the empty state; afx decisions init, then an item, and it appears ([decisions-15-empty-state](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/decisions-15-empty-state.png), [decisions-16-initialized](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/decisions-16-initialized.png), [decisions-17-item-appears](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/decisions/decisions-17-item-appears.png))
- PASS scenario 22: the webview never contacts Tower; the key is in no request; remote item images are its only network loads
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `work`: 15/15

[`verify-work.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/work/verify-work.json), run 2026-11-24T23:54:47.670Z on `d31df3a84`.

- PASS scenario 17: Open Work opens one panel; builders, Needs Attention, Backlog and Recently Closed render; no dropped affordance ([work-01-panel](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/work/work-01-panel.png))
- PASS scenario 17: a builder's progress bar is drawn at its width under the panel's CSP
- PASS scenario 17: Open opens the builder's terminal ([work-02-open-builder](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/work/work-02-open-builder.png))
- PASS scenario 17: + Shell opens a Tower shell ([work-03-new-shell](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/work/work-03-new-shell.png))
- PASS scenario 17: Refresh drops Tower's overview cache, then re-reads the overview
- PASS scenario 17: a spec link opens the workspace file in an editor ([work-04-spec-link](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/work/work-04-spec-link.png))
- PASS scenario 17: an issue link and a PR link open in the browser, through the extension host
- PASS scenario 18: light, dark and high-contrast themes, switched live with the panel open ([work-05-theme-vs-dark](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/work/work-05-theme-vs-dark.png), [work-06-theme-hc-black](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/work/work-06-theme-hc-black.png), [work-07-theme-hc-light](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/work/work-07-theme-hc-light.png), [work-08-theme-vs](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/work/work-08-theme-vs.png))
- PASS increment 2: the Cockpit's Decisions entries, with the Work and Decisions panels side by side ([work-09-both-panels-dark](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/work/work-09-both-panels-dark.png), [work-10-both-panels-light](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/work/work-10-both-panels-light.png))
- PASS the panel is restored after a window reload ([work-11-restored](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/work/work-11-restored.png))
- PASS scenario 22: the webview never contacts Tower; the key is in no request
- PASS scenario 19: Tower unreachable — both panels keep their content under a not-connected notice, no error toast, and recover ([work-12-tower-down](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/work/work-12-tower-down.png), [work-13-tower-back](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/work/work-13-tower-back.png))
- PASS scenario 19: in a builder-worktree window, Open Work explains ([work-14-worktree-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/work/work-14-worktree-explains.png))
- PASS scenario 19: in a no-workspace window, Open Work explains ([work-15-no-workspace-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/work/work-15-no-workspace-explains.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `arrange`: 19/19

[`verify-arrange.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/verify-arrange.json), run 2026-11-24T23:52:18.717Z on `d31df3a84`.

- PASS fresh profile: the Cockpit button sits directly below Codev
- PASS scenario 13 setup: editors across four groups, two dirty files, a clean file and two untitled buffers ([arrange-01-before](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-01-before.png))
- PASS scenario 7 / 9: the first show of the Cockpit arranges main | (Work over Decisions), each active in its group ([arrange-02-arranged-dark](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-02-arranged-dark.png))
- PASS scenario 7: the one-time notice offers Don't arrange automatically; dismissing it changes nothing ([arrange-03-notice](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-03-notice.png))
- PASS scenario 13: every pre-existing editor survives the arrange with its unsaved content; the architect is the live session; both panels render ([arrange-04-editors-kept](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-04-editors-kept.png))
- PASS scenario 13: re-running Arrange Cockpit (title bar, then palette) changes nothing; a typed Decisions draft persists; no notice ([arrange-05-rerun-draft](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-05-rerun-draft.png))
- PASS the architect's 14:00Z ruling: at the split's Work width the view fits and a typical title stays readable (20+ of 44 characters)
- PASS rendered: the split with a pending decision, in Light Modern and Dark Modern ([arrange-06-split-vs](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-06-split-vs.png), [arrange-07-split-vs-dark](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-07-split-vs-dark.png))
- PASS scenario 7: showing the Cockpit again leaves the editor area alone; the command arranges on demand ([arrange-08-rearranged](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-08-rearranged.png))
- PASS the architect terminal moved into the panel comes back to the left group: the same session ([arrange-09-from-panel](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-09-from-panel.png))
- PASS another terminal named like the architect: arrange stops before moving an editor and says why; with that terminal closed, it arranges (codex review) ([arrange-10-namesake-refused](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-10-namesake-refused.png), [arrange-11-namesake-closed-arranged](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-11-namesake-closed-arranged.png))
- PASS existing profile: after a reload the restored Cockpit arranges again, the architect reopened on the left; no notice; the button is still below Codev ([arrange-12-reloaded](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-12-reloaded.png))
- PASS scenario 14: main not live — the existing warning, no other architect opened, Work and Decisions still arranged ([arrange-13-main-not-live](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-13-main-not-live.png))
- PASS scenario 7 (second fresh profile): Don't arrange automatically turns codev.cockpit.autoArrange off at the user level; the command still arranges ([arrange-14-dont-arrange](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-14-dont-arrange.png), [arrange-15-setting-off-command](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-15-setting-off-command.png))
- PASS scenario 19: in a builder-worktree window, no auto-arrange, no title-bar action, and the command explains ([arrange-16-worktree-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-16-worktree-explains.png))
- PASS scenario 19: in a no-workspace window, no auto-arrange, no title-bar action, and the command explains ([arrange-17-no-workspace-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-17-no-workspace-explains.png))
- PASS a reload with Tower down and the Cockpit showing: the automatic arrange places Work over Decisions and shows no error toast (claude review) ([arrange-18-auto-tower-down](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-18-auto-tower-down.png))
- PASS a restored, not yet revived panel tab counts: with no architect and only Work and Decisions in the first group after a reload, arrange keeps an empty left column (claude review) ([arrange-19-restored-tab-empty-left](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/arrange/arrange-19-restored-tab-empty-left.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `webviews`: 3/6

[`verify-webviews.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/webviews/verify-webviews.json), run 2026-11-24T23:48:25.008Z on `d31df3a84`; also [`verify-webviews-capture.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/webviews/verify-webviews-capture.json).

- PASS workbench loads on alpha
- FAIL (expected: codev-ide#67) built-in webview: VS Code's own Markdown preview of a fixture .md renders styled content ([webviews-02-failure](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/webviews/webviews-02-failure.png), [webviews-01-builtin-markdown-preview](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/webviews/webviews-01-builtin-markdown-preview.png))
- FAIL (expected: codev-ide#67) existing Codev webview: the contextual panel (codev.contextualPanel) renders ([webviews-04-failure](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/webviews/webviews-04-failure.png), [webviews-03-codev-contextual-panel](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/webviews/webviews-03-codev-contextual-panel.png))
- FAIL (expected: codev-ide#67) existing Codev webview: the Codev Markdown preview (codev.markdownPreview) renders ([webviews-06-failure](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/webviews/webviews-06-failure.png), [webviews-05-codev-markdown-preview](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/webviews/webviews-05-codev-markdown-preview.png))
- PASS this PR's Work panel renders ([webviews-07-work-panel](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.138.0/webviews/webviews-07-work-panel.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

## VS Code Server 1.128.0 (the engine floor), fenced

[Browse the folder](https://github.com/cluesmith/codev/tree/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0). Server commit `fc3def6774c76082adf699d366f31a557ce5573f`. Ran `arrange`, `work`, `decisions`.

### `decisions`: 16/16

[`verify-decisions.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/verify-decisions.json), run 2026-11-25T00:05:20.835Z on `d31df3a84`.

- PASS scenario 12: a Decisions entry under every active workspace, none under the dormant one ([decisions-01-entries](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/decisions-01-entries.png))
- PASS scenario 12: another workspace's Decisions entry opens that workspace's window
- PASS scenario 12: this workspace's Decisions entry opens the panel, which renders the items ([decisions-02-panel](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/decisions-02-panel.png))
- PASS scenario 15: a workspace image (bytes through the host), an https image, and two not loaded (the browser's 404, Tower's refusal) ([decisions-03-images](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/decisions-03-images.png))
- PASS scenario 15: the full-size view opens over the panel; Escape and Close each close it ([decisions-04-full-size](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/decisions-04-full-size.png))
- PASS scenario 15: an http(s) link opens in the browser, through the extension host
- PASS scenario 15: rule an item — the file is updated, the card shows the ruling, the architect is notified ([decisions-05-draft](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/decisions-05-draft.png), [decisions-06-ruled](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/decisions-06-ruled.png))
- PASS scenario 15: a stale fingerprint is refused, and the draft is kept ([decisions-07-stale-refused](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/decisions-07-stale-refused.png))
- PASS scenario 21: the Decisions poll stops while its panel is hidden, and resumes when shown
- PASS scenario 18: light, dark and high-contrast themes, switched live with the panel open ([decisions-08-theme-vs-dark](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/decisions-08-theme-vs-dark.png), [decisions-09-theme-hc-black](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/decisions-09-theme-hc-black.png), [decisions-10-theme-hc-light](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/decisions-10-theme-hc-light.png), [decisions-11-theme-vs](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/decisions-11-theme-vs.png))
- PASS the panel is restored after a window reload ([decisions-12-restored](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/decisions-12-restored.png))
- PASS scenario 19: in a builder-worktree window, Open Decisions explains, and the entry navigates to the parent ([decisions-13-worktree-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/decisions-13-worktree-explains.png))
- PASS scenario 19: in a no-workspace window, Open Decisions explains ([decisions-14-no-workspace-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/decisions-14-no-workspace-explains.png))
- PASS scenario 16: no decisions file shows the empty state; afx decisions init, then an item, and it appears ([decisions-15-empty-state](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/decisions-15-empty-state.png), [decisions-16-initialized](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/decisions-16-initialized.png), [decisions-17-item-appears](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/decisions/decisions-17-item-appears.png))
- PASS scenario 22: the webview never contacts Tower; the key is in no request; remote item images are its only network loads
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `work`: 15/15

[`verify-work.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/work/verify-work.json), run 2026-11-25T00:03:28.699Z on `d31df3a84`.

- PASS scenario 17: Open Work opens one panel; builders, Needs Attention, Backlog and Recently Closed render; no dropped affordance ([work-01-panel](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/work/work-01-panel.png))
- PASS scenario 17: a builder's progress bar is drawn at its width under the panel's CSP
- PASS scenario 17: Open opens the builder's terminal ([work-02-open-builder](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/work/work-02-open-builder.png))
- PASS scenario 17: + Shell opens a Tower shell ([work-03-new-shell](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/work/work-03-new-shell.png))
- PASS scenario 17: Refresh drops Tower's overview cache, then re-reads the overview
- PASS scenario 17: a spec link opens the workspace file in an editor ([work-04-spec-link](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/work/work-04-spec-link.png))
- PASS scenario 17: an issue link and a PR link open in the browser, through the extension host
- PASS scenario 18: light, dark and high-contrast themes, switched live with the panel open ([work-05-theme-vs-dark](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/work/work-05-theme-vs-dark.png), [work-06-theme-hc-black](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/work/work-06-theme-hc-black.png), [work-07-theme-hc-light](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/work/work-07-theme-hc-light.png), [work-08-theme-vs](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/work/work-08-theme-vs.png))
- PASS increment 2: the Cockpit's Decisions entries, with the Work and Decisions panels side by side ([work-09-both-panels-dark](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/work/work-09-both-panels-dark.png), [work-10-both-panels-light](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/work/work-10-both-panels-light.png))
- PASS the panel is restored after a window reload ([work-11-restored](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/work/work-11-restored.png))
- PASS scenario 22: the webview never contacts Tower; the key is in no request
- PASS scenario 19: Tower unreachable — both panels keep their content under a not-connected notice, no error toast, and recover ([work-12-tower-down](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/work/work-12-tower-down.png), [work-13-tower-back](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/work/work-13-tower-back.png))
- PASS scenario 19: in a builder-worktree window, Open Work explains ([work-14-worktree-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/work/work-14-worktree-explains.png))
- PASS scenario 19: in a no-workspace window, Open Work explains ([work-15-no-workspace-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/work/work-15-no-workspace-explains.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `arrange`: 19/19

[`verify-arrange.json`](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/verify-arrange.json), run 2026-11-25T00:00:44.109Z on `d31df3a84`.

- PASS fresh profile: the Cockpit button sits directly below Codev
- PASS scenario 13 setup: editors across four groups, two dirty files, a clean file and two untitled buffers ([arrange-01-before](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-01-before.png))
- PASS scenario 7 / 9: the first show of the Cockpit arranges main | (Work over Decisions), each active in its group ([arrange-02-arranged-dark](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-02-arranged-dark.png))
- PASS scenario 7: the one-time notice offers Don't arrange automatically; dismissing it changes nothing ([arrange-03-notice](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-03-notice.png))
- PASS scenario 13: every pre-existing editor survives the arrange with its unsaved content; the architect is the live session; both panels render ([arrange-04-editors-kept](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-04-editors-kept.png))
- PASS scenario 13: re-running Arrange Cockpit (title bar, then palette) changes nothing; a typed Decisions draft persists; no notice ([arrange-05-rerun-draft](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-05-rerun-draft.png))
- PASS the architect's 14:00Z ruling: at the split's Work width the view fits and a typical title stays readable (20+ of 44 characters)
- PASS rendered: the split with a pending decision, in Light Modern and Dark Modern ([arrange-06-split-vs](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-06-split-vs.png), [arrange-07-split-vs-dark](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-07-split-vs-dark.png))
- PASS scenario 7: showing the Cockpit again leaves the editor area alone; the command arranges on demand ([arrange-08-rearranged](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-08-rearranged.png))
- PASS the architect terminal moved into the panel comes back to the left group: the same session ([arrange-09-from-panel](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-09-from-panel.png))
- PASS another terminal named like the architect: arrange stops before moving an editor and says why; with that terminal closed, it arranges (codex review) ([arrange-10-namesake-refused](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-10-namesake-refused.png), [arrange-11-namesake-closed-arranged](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-11-namesake-closed-arranged.png))
- PASS existing profile: after a reload the restored Cockpit arranges again, the architect reopened on the left; no notice; the button is still below Codev ([arrange-12-reloaded](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-12-reloaded.png))
- PASS scenario 14: main not live — the existing warning, no other architect opened, Work and Decisions still arranged ([arrange-13-main-not-live](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-13-main-not-live.png))
- PASS scenario 7 (second fresh profile): Don't arrange automatically turns codev.cockpit.autoArrange off at the user level; the command still arranges ([arrange-14-dont-arrange](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-14-dont-arrange.png), [arrange-15-setting-off-command](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-15-setting-off-command.png))
- PASS scenario 19: in a builder-worktree window, no auto-arrange, no title-bar action, and the command explains ([arrange-16-worktree-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-16-worktree-explains.png))
- PASS scenario 19: in a no-workspace window, no auto-arrange, no title-bar action, and the command explains ([arrange-17-no-workspace-explains](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-17-no-workspace-explains.png))
- PASS a reload with Tower down and the Cockpit showing: the automatic arrange places Work over Decisions and shows no error toast (claude review) ([arrange-18-auto-tower-down](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-18-auto-tower-down.png))
- PASS a restored, not yet revived panel tab counts: with no architect and only Work and Decisions in the first group after a reload, arrange keeps an empty left column (claude review) ([arrange-19-restored-tab-empty-left](https://github.com/cluesmith/codev/blob/8b7def1ed5248a1831919869328c17c3623db2ee/verification-final/1.128.0/arrange/arrange-19-restored-tab-empty-left.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)
