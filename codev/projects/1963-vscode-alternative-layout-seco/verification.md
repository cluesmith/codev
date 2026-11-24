# Spec 1963 rendered verification: index

The evidence for Spec 1963 lives on the branch `evidence/spir-1963`, which is never merged:
screenshots, results JSON, dashboard snapshots and the layout spike's screenshots. Every link
below is pinned to its commit, [`51e2bbf17`](https://github.com/cluesmith/codev/tree/51e2bbf17814e860df4adf3a50e34edab149c0c0/).
The isolated harness that produced it is `apps/vscode/scripts/cockpit-harness/`, on VS Code
1.147.0 serve-web with its own Tower.

**127 of 127 checks passed** across every run below. Each run's last check reads every screenshot it took with
OCR, and fails on a machine shell prompt; runs before the review phase predate that check, and an
OCR pass over all their screenshots found none.

## `verification-increment1/`

[Browse the folder](https://github.com/cluesmith/codev/tree/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1): 6 result files, 29 screenshots, and [`README.md`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/README.md), [`requests-table.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/requests-table.json).

### `actions`: 28/28

[`verify-actions.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/verify-actions.json), run 2026-11-24T16:25:28.111Z.

- PASS scenario 12: a builder row's menu shows the Agents entries (blocked and waiting rows)
- PASS the same builder's menu in the Agents view matches the Cockpit's
- PASS Approve Gate is inline on the blocked row only
- PASS builder menu › Codev: Open Builder Terminal ([actions-01-open-builder-terminal](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/actions-01-open-builder-terminal.png))
- PASS builder menu › Codev: View Spec File ([actions-02-view-spec](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/actions-02-view-spec.png))
- PASS builder menu › Codev: View Plan File
- PASS builder menu › Codev: View Review File
- PASS builder menu › Codev: View Diff ([actions-03-view-diff](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/actions-03-view-diff.png))
- PASS builder menu › Codev: Open Worktree in New Window
- PASS builder menu › Codev: Open Worktree Folder
- PASS builder menu › Codev: Run Worktree Setup
- PASS builder menu › Codev: Run Dev, then the workspace row offers Stop Dev; then Codev: Stop Dev ([actions-04-worktree-dev-running](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/actions-04-worktree-dev-running.png))
- PASS Approve Gate (inline) on #101 relays to its architect
- PASS workspace row: inline and context entries ([actions-05-workspace-row](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/actions-05-workspace-row.png))
- PASS workspace row › Spawn Builder (inline) runs `afx spawn` through the stub
- PASS workspace row › New Shell (inline) ([actions-06-new-shell](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/actions-06-new-shell.png))
- PASS workspace row › Add Architect (inline) asks main
- PASS workspace row › Open Web Interface opens the isolated Tower's dashboard
- PASS workspace row › Start Dev, then Stop Dev replaces it, then Stop Dev ([actions-07-workspace-dev-running](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/actions-07-workspace-dev-running.png))
- PASS workspace row › Open Dev URL lists both URLs and opens the picked one
- PASS Remove Architect is offered on siblings only; a childless sibling's row goes with it ([actions-08-qa-added](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/actions-08-qa-added.png), [actions-09-qa-removed](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/actions-09-qa-removed.png))
- PASS Remove Architect on a sibling with a builder: the header stays as the builder's owner ([actions-10-web-removed](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/actions-10-web-removed.png))
- PASS another workspace's rows carry no builder or architect actions
- PASS scenario 12: another workspace's architect row opens that workspace's window
- PASS scenario 12: another workspace's builder row opens that workspace's window
- PASS another workspace row: inline Open opens it, as in the Tower view
- PASS another workspace row: inline Deactivate moves it to Dormant ([actions-11-gamma-dormant](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/actions-11-gamma-dormant.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `reconnect`: 4/4

[`verify-reconnect.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/verify-reconnect.json), run 2026-11-24T16:25:51.374Z.

- PASS a loaded Cockpit keeps its content while the isolated Tower is down ([reconnect-01-connected](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/reconnect-01-connected.png), [reconnect-02-tower-down-loaded](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/reconnect-02-tower-down-loaded.png))
- PASS a window loaded while Tower is down shows Not connected to Tower ([reconnect-03-not-connected](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/reconnect-03-not-connected.png))
- PASS Tower back + the row's Reconnect → the hierarchy returns ([reconnect-04-reconnected](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/reconnect-04-reconnected.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `render`: 5/5

[`verify-render.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/verify-render.json), run 2026-11-24T10:34:14.755Z.

- PASS scenario 11: the Cockpit button sits directly below Codev ([render-01-activity-bar](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/render-01-activity-bar.png))
- PASS scenario 11: the existing Codev container is unchanged ([render-02-codev-container](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/render-02-codev-container.png))
- PASS scenario 12: hierarchy with N>1, N=1 and N=0 builders across workspaces ([render-03-hierarchy-light](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/render-03-hierarchy-light.png))
- PASS the Dormant group ([render-04-dormant](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/render-04-dormant.png))
- PASS scenario 18 (hierarchy part): dark theme, then a live switch back to light ([render-05-hierarchy-dark](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/render-05-hierarchy-dark.png), [render-06-hierarchy-light-again](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/render-06-hierarchy-light-again.png))

### `requests`: 4/4

[`verify-requests.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/verify-requests.json), run 2026-11-24T10:41:41.788Z.

- PASS scenario 21: cockpit-alone ([requests-01-cockpit-alone](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/requests-01-cockpit-alone.png))
- PASS scenario 21: source-views-alone ([requests-02-source-views-alone](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/requests-02-source-views-alone.png))
- PASS scenario 21: both ([requests-03-both](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/requests-03-both.png))
- PASS scenario 21: the request counts match

### `reveal`: 1/1

[`verify-reveal.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/verify-reveal.json), run 2026-11-24T10:34:26.334Z.

- PASS active-file reveal expands collapsed workspace and architect rows ([reveal-01-collapsed](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/reveal-01-collapsed.png), [reveal-02-revealed](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/reveal-02-revealed.png))

### `windows`: 3/3

[`verify-windows.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/verify-windows.json), run 2026-11-24T10:35:40.083Z.

- PASS scenario 19: builder-worktree window — the parent row carries worktree-scoped actions only ([windows-01-worktree-window](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/windows-01-worktree-window.png))
- PASS scenario 19: no-workspace window — the state row explains and offers Open Folder ([windows-02-no-workspace-window](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/windows-02-no-workspace-window.png))
- PASS scenario 19: Codev container hidden, Cockpit visible — a builder change appears within one refresh interval ([windows-03-cockpit-only-fresh](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-increment1/shots/windows-03-cockpit-only-fresh.png))

## `verification-phase6/`

[Browse the folder](https://github.com/cluesmith/codev/tree/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase6): 2 result files, 8 screenshots, and [`after/dashboard-snapshot.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase6/after/dashboard-snapshot.json), [`before/dashboard-snapshot.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase6/before/dashboard-snapshot.json).

### `dashboard`: 6/6

[`after/verify-dashboard.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase6/after/verify-dashboard.json), run 2026-11-24T11:43:09.639Z.

- PASS scenario 20: the dashboard Work tab renders ([dashboard-01-work](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase6/after/dashboard-01-work.png))
- PASS scenario 20: the dashboard Decisions tab renders ([dashboard-02-decisions](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase6/after/dashboard-02-decisions.png))
- PASS scenario 20: a Decisions link and image open in a new tab
- PASS scenario 20: a ruling round-trips ([dashboard-03-decisions-draft](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase6/after/dashboard-03-decisions-draft.png), [dashboard-04-decisions-ruled](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase6/after/dashboard-04-decisions-ruled.png))
- PASS scenario 20: Work actions (Open, + Shell, Refresh, spec link, issue link)
- PASS scenario 20: computed styles and DOM unchanged from the baseline

### `dashboard`: 5/5

[`before/verify-dashboard.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase6/before/verify-dashboard.json), run 2026-11-24T11:19:26.814Z.

- PASS scenario 20: the dashboard Work tab renders ([dashboard-01-work](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase6/before/dashboard-01-work.png))
- PASS scenario 20: the dashboard Decisions tab renders ([dashboard-02-decisions](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase6/before/dashboard-02-decisions.png))
- PASS scenario 20: a Decisions link and image open in a new tab
- PASS scenario 20: a ruling round-trips ([dashboard-03-decisions-draft](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase6/before/dashboard-03-decisions-draft.png), [dashboard-04-decisions-ruled](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase6/before/dashboard-04-decisions-ruled.png))
- PASS scenario 20: Work actions (Open, + Shell, Refresh, spec link, issue link)

## `verification-phase7/`

[Browse the folder](https://github.com/cluesmith/codev/tree/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7): 1 result files, 17 screenshots.

### `decisions`: 15/15

[`verify-decisions.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/verify-decisions.json), run 2026-11-24T12:47:40.135Z.

- PASS scenario 12: a Decisions entry under every active workspace, none under the dormant one ([decisions-01-entries](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/shots/decisions-01-entries.png))
- PASS scenario 12: another workspace's Decisions entry opens that workspace's window
- PASS scenario 12: this workspace's Decisions entry opens the panel, which renders the items ([decisions-02-panel](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/shots/decisions-02-panel.png))
- PASS scenario 15: a workspace image (bytes through the host), an https image, and two not loaded (the browser's 404, Tower's refusal) ([decisions-03-images](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/shots/decisions-03-images.png))
- PASS scenario 15: the full-size view opens over the panel; Escape and Close each close it ([decisions-04-full-size](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/shots/decisions-04-full-size.png))
- PASS scenario 15: an http(s) link opens in the browser, through the extension host
- PASS scenario 15: rule an item — the file is updated, the card shows the ruling, the architect is notified ([decisions-05-draft](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/shots/decisions-05-draft.png), [decisions-06-ruled](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/shots/decisions-06-ruled.png))
- PASS scenario 15: a stale fingerprint is refused, and the draft is kept ([decisions-07-stale-refused](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/shots/decisions-07-stale-refused.png))
- PASS scenario 21: the Decisions poll stops while its panel is hidden, and resumes when shown
- PASS scenario 18: light, dark and high-contrast themes, switched live with the panel open ([decisions-08-theme-vs-dark](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/shots/decisions-08-theme-vs-dark.png), [decisions-09-theme-hc-black](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/shots/decisions-09-theme-hc-black.png), [decisions-10-theme-hc-light](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/shots/decisions-10-theme-hc-light.png), [decisions-11-theme-vs](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/shots/decisions-11-theme-vs.png))
- PASS the panel is restored after a window reload ([decisions-12-restored](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/shots/decisions-12-restored.png))
- PASS scenario 19: in a builder-worktree window, Open Decisions explains, and the entry navigates to the parent ([decisions-13-worktree-explains](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/shots/decisions-13-worktree-explains.png))
- PASS scenario 19: in a no-workspace window, Open Decisions explains ([decisions-14-no-workspace-explains](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/shots/decisions-14-no-workspace-explains.png))
- PASS scenario 16: no decisions file shows the empty state; afx decisions init, then an item, and it appears ([decisions-15-empty-state](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/shots/decisions-15-empty-state.png), [decisions-16-initialized](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/shots/decisions-16-initialized.png), [decisions-17-item-appears](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase7/shots/decisions-17-item-appears.png))
- PASS scenario 22: the webview never contacts Tower; the key is in no request; remote item images are its only network loads

## `verification-phase8/`

[Browse the folder](https://github.com/cluesmith/codev/tree/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8): 3 result files, 32 screenshots, and [`dashboard/after-dashboard-snapshot.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/dashboard/after-dashboard-snapshot.json), [`dashboard/before-dashboard-snapshot.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/dashboard/before-dashboard-snapshot.json).

### `dashboard`: 6/6

[`dashboard/verify-dashboard.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/dashboard/verify-dashboard.json), run 2026-11-24T14:11:03.870Z.

- PASS scenario 20: the dashboard Work tab renders
- PASS scenario 20: the dashboard Decisions tab renders
- PASS scenario 20: a Decisions link and image open in a new tab
- PASS scenario 20: a ruling round-trips
- PASS scenario 20: Work actions (Open, + Shell, Refresh, spec link, issue link)
- PASS scenario 20: computed styles and DOM unchanged from the baseline

### `decisions`: 15/15

[`verify-decisions.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/verify-decisions.json), run 2026-11-24T14:09:38.923Z.

- PASS scenario 12: a Decisions entry under every active workspace, none under the dormant one ([decisions-01-entries](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/decisions-01-entries.png))
- PASS scenario 12: another workspace's Decisions entry opens that workspace's window
- PASS scenario 12: this workspace's Decisions entry opens the panel, which renders the items ([decisions-02-panel](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/decisions-02-panel.png))
- PASS scenario 15: a workspace image (bytes through the host), an https image, and two not loaded (the browser's 404, Tower's refusal) ([decisions-03-images](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/decisions-03-images.png))
- PASS scenario 15: the full-size view opens over the panel; Escape and Close each close it ([decisions-04-full-size](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/decisions-04-full-size.png))
- PASS scenario 15: an http(s) link opens in the browser, through the extension host
- PASS scenario 15: rule an item — the file is updated, the card shows the ruling, the architect is notified ([decisions-05-draft](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/decisions-05-draft.png), [decisions-06-ruled](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/decisions-06-ruled.png))
- PASS scenario 15: a stale fingerprint is refused, and the draft is kept ([decisions-07-stale-refused](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/decisions-07-stale-refused.png))
- PASS scenario 21: the Decisions poll stops while its panel is hidden, and resumes when shown
- PASS scenario 18: light, dark and high-contrast themes, switched live with the panel open ([decisions-08-theme-vs-dark](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/decisions-08-theme-vs-dark.png), [decisions-09-theme-hc-black](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/decisions-09-theme-hc-black.png), [decisions-10-theme-hc-light](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/decisions-10-theme-hc-light.png), [decisions-11-theme-vs](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/decisions-11-theme-vs.png))
- PASS the panel is restored after a window reload ([decisions-12-restored](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/decisions-12-restored.png))
- PASS scenario 19: in a builder-worktree window, Open Decisions explains, and the entry navigates to the parent ([decisions-13-worktree-explains](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/decisions-13-worktree-explains.png))
- PASS scenario 19: in a no-workspace window, Open Decisions explains ([decisions-14-no-workspace-explains](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/decisions-14-no-workspace-explains.png))
- PASS scenario 16: no decisions file shows the empty state; afx decisions init, then an item, and it appears ([decisions-15-empty-state](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/decisions-15-empty-state.png), [decisions-16-initialized](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/decisions-16-initialized.png), [decisions-17-item-appears](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/decisions-17-item-appears.png))
- PASS scenario 22: the webview never contacts Tower; the key is in no request; remote item images are its only network loads

### `work`: 14/14

[`verify-work.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/verify-work.json), run 2026-11-24T14:08:14.580Z.

- PASS scenario 17: Open Work opens one panel; builders, Needs Attention, Backlog and Recently Closed render; no dropped affordance ([work-01-panel](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/work-01-panel.png))
- PASS scenario 17: a builder's progress bar is drawn at its width under the panel's CSP
- PASS scenario 17: Open opens the builder's terminal ([work-02-open-builder](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/work-02-open-builder.png))
- PASS scenario 17: + Shell opens a Tower shell ([work-03-new-shell](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/work-03-new-shell.png))
- PASS scenario 17: Refresh drops Tower's overview cache, then re-reads the overview
- PASS scenario 17: a spec link opens the workspace file in an editor ([work-04-spec-link](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/work-04-spec-link.png))
- PASS scenario 17: an issue link and a PR link open in the browser, through the extension host
- PASS scenario 18: light, dark and high-contrast themes, switched live with the panel open ([work-05-theme-vs-dark](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/work-05-theme-vs-dark.png), [work-06-theme-hc-black](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/work-06-theme-hc-black.png), [work-07-theme-hc-light](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/work-07-theme-hc-light.png), [work-08-theme-vs](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/work-08-theme-vs.png))
- PASS increment 2: the Cockpit's Decisions entries, with the Work and Decisions panels side by side ([work-09-both-panels-dark](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/work-09-both-panels-dark.png), [work-10-both-panels-light](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/work-10-both-panels-light.png))
- PASS the panel is restored after a window reload ([work-11-restored](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/work-11-restored.png))
- PASS scenario 22: the webview never contacts Tower; the key is in no request
- PASS scenario 19: Tower unreachable — both panels keep their content under a not-connected notice, no error toast, and recover ([work-12-tower-down](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/work-12-tower-down.png), [work-13-tower-back](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/work-13-tower-back.png))
- PASS scenario 19: in a builder-worktree window, Open Work explains ([work-14-worktree-explains](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/work-14-worktree-explains.png))
- PASS scenario 19: in a no-workspace window, Open Work explains ([work-15-no-workspace-explains](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase8/shots/work-15-no-workspace-explains.png))

## `verification-phase9/`

[Browse the folder](https://github.com/cluesmith/codev/tree/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9): 3 result files, 22 screenshots.

### `arrange`: 19/19

[`verify-arrange.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/verify-arrange.json), run 2026-11-24T17:41:24.306Z.

- PASS fresh profile: the Cockpit button sits directly below Codev
- PASS scenario 13 setup: editors across four groups, two dirty files, a clean file and two untitled buffers ([arrange-01-before](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-01-before.png))
- PASS scenario 7 / 9: the first show of the Cockpit arranges main | (Work over Decisions), each active in its group ([arrange-02-arranged-dark](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-02-arranged-dark.png))
- PASS scenario 7: the one-time notice offers Don't arrange automatically; dismissing it changes nothing ([arrange-03-notice](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-03-notice.png))
- PASS scenario 13: every pre-existing editor survives the arrange with its unsaved content; the architect is the live session; both panels render ([arrange-04-editors-kept](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-04-editors-kept.png))
- PASS scenario 13: re-running Arrange Cockpit (title bar, then palette) changes nothing; a typed Decisions draft persists; no notice ([arrange-05-rerun-draft](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-05-rerun-draft.png))
- PASS the architect's 14:00Z ruling: at the split's Work width the view fits and a typical title stays readable (20+ of 44 characters)
- PASS rendered: the split with a pending decision, in Light Modern and Dark Modern ([arrange-06-split-vs](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-06-split-vs.png), [arrange-07-split-vs-dark](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-07-split-vs-dark.png))
- PASS scenario 7: showing the Cockpit again leaves the editor area alone; the command arranges on demand ([arrange-08-rearranged](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-08-rearranged.png))
- PASS the architect terminal moved into the panel comes back to the left group: the same session ([arrange-09-from-panel](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-09-from-panel.png))
- PASS another terminal named like the architect: arrange stops before moving an editor and says why; with that terminal closed, it arranges (codex review) ([arrange-10-namesake-refused](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-10-namesake-refused.png), [arrange-11-namesake-closed-arranged](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-11-namesake-closed-arranged.png))
- PASS existing profile: after a reload the restored Cockpit arranges again, the architect reopened on the left; no notice; the button is still below Codev ([arrange-12-reloaded](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-12-reloaded.png))
- PASS scenario 14: main not live — the existing warning, no other architect opened, Work and Decisions still arranged ([arrange-13-main-not-live](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-13-main-not-live.png))
- PASS scenario 7 (second fresh profile): Don't arrange automatically turns codev.cockpit.autoArrange off at the user level; the command still arranges ([arrange-14-dont-arrange](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-14-dont-arrange.png), [arrange-15-setting-off-command](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-15-setting-off-command.png))
- PASS scenario 19: in a builder-worktree window, no auto-arrange, no title-bar action, and the command explains ([arrange-16-worktree-explains](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-16-worktree-explains.png))
- PASS scenario 19: in a no-workspace window, no auto-arrange, no title-bar action, and the command explains ([arrange-17-no-workspace-explains](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-17-no-workspace-explains.png))
- PASS a reload with Tower down and the Cockpit showing: the automatic arrange places Work over Decisions and shows no error toast (claude review) ([arrange-18-auto-tower-down](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-18-auto-tower-down.png))
- PASS a restored, not yet revived panel tab counts: with no architect and only Work and Decisions in the first group after a reload, arrange keeps an empty left column (claude review) ([arrange-19-restored-tab-empty-left](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/arrange-19-restored-tab-empty-left.png))
- PASS no screenshot shows the machine's shell prompt (host:dir user$)

### `profile-existing`: 1/1

[`verify-profile-existing.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/verify-profile-existing.json), run 2026-11-24T15:06:26.285Z.

- PASS existing profile: where VS Code places the Cockpit button for a profile that used Codev before the Cockpit existed ([profile-existing-activity-bar](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/profile-existing-activity-bar.png))

### `profile-seed`: 1/1

[`verify-profile-seed.json`](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/verify-profile-seed.json), run 2026-11-24T15:06:20.157Z.

- PASS existing profile, seeded: a new browser profile uses Codev on a build without the Cockpit container (origin/main's activity bar) ([profile-seed-activity-bar](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/profile-seed-activity-bar.png), [profile-seed-01-seeded](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/verification-phase9/shots/profile-seed-01-seeded.png))

## `layout-spike/`

The plan's layout spike. Its driver, extension and `results.json` stay on the PR branch in `layout-spike/`; its screenshots are here: [a-after](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/layout-spike/a-after.png), [a-before](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/layout-spike/a-before.png), [b-after](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/layout-spike/b-after.png), [c-after](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/layout-spike/c-after.png), [d-after](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/layout-spike/d-after.png), [run1-trust-prompt](https://github.com/cluesmith/codev/blob/51e2bbf17814e860df4adf3a50e34edab149c0c0/layout-spike/run1-trust-prompt.png).
