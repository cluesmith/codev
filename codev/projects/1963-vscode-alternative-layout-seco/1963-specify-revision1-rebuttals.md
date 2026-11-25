# Spec 1963 — hierarchy revision, review round 1: rebuttals

Reviews of commit `76e1dc498`, the owner's single-hierarchy revision. During the review, HEAD moved
only by the thread-log commit `af957cf37`, which touched no spec text, so both reviews apply to the
spec as committed.

All points were accepted except the two items addressed to the architect (Claude 9, and Claude 7,
which is offered rather than specced). Nothing is disputed.

## Codex (REQUEST_CHANGES)

1. **Images vs CSP vs "no Tower request".** Accepted. Remote item images are **direct webview
   `<img>` loads**, as in the dashboard.
   - The CSP `img-src` is `${cspSource} blob: http: https:` (`data:` only if the plan encodes
     images). There is no `connect-src`.
   - The criterion now reads "no fetch / XHR / WebSocket to Tower; the only webview network loads
     are http(s) `<img>` sources written in items". A Tower URL image gets 401 without the key and
     shows the "Image not loaded" note, as does an `http:` image blocked by mixed content in the IDE.
   - Constraints, §3, the criterion and scenario 22 are aligned.
2. **Source `contextValue`s vs navigate-only remote rows.** Accepted. Source `contextValue`s and
   commands apply to this window's workspace rows only. Other workspaces' rows get distinct
   navigate-only `contextValue`s, and the parity test fails if one matches a builder or architect
   menu's `viewItem`.
3. **Parity oracle.** Accepted. A checked-in mapping holds one record per source entry: same
   command at a combined-view `viewItem`, relocated to a named entry, or excluded with a reason. Only
   the three `codev.agentsCycleGroupFrom*` title entries are excluded. The relocations are named.
4. **Gate date.** Accepted. It is labelled as UTC, as relayed by the architect, and recorded on
   issue #1963. The relay messages are timestamped `2026-11-24T01:38Z`.

## Claude (COMMENT)

1. **Increments.** Accepted. A new *Increments* subsection names three independently shippable
   slices: button + hierarchy, then the shared package + panels, then *Arrange Cockpit*. The plan
   phases against them.
2. **The workspace level is not identical.** Accepted. Clicking an active workspace row now expands
   it, and *Open* is the inline/context action; dormant rows keep click-to-open. This is stated in
   §2 Levels and in the placement table, and tested in scenario 5.
3. **Global toggle settings.** Accepted. `codev.buildersAutoCollapse` and
   `codev.buildersFileViewAsTree` are shared and global. Only row-id versioning, the reveal map and
   expansion are per view.
4. **`architectCount`.** Accepted as a stated divergence. VS Code counts live architects; the
   dashboard counts registered ones.
5. **"Connecting…" forever.** Accepted, with a correction found while applying it:
   `ConnectionManager` never gives up; it retries with backoff indefinitely. So the Tower root shows
   *Connecting to Tower…* only on the first attempt. After that it shows *Not connected to Tower*,
   which is clickable and runs `codev.reconnect`. It is a state row rather than `viewsWelcome`, so
   it sits inside the same tree.
6. **Own workspace before its overview.** Accepted. A single *Loading…* child shows until the
   overview arrives, for any active workspace.
7. **First auto-arrange notice.** Not specced, because the trigger is owner-ruled and a notice is
   new behaviour. Added as Open Question 6 (nice-to-know) for the owner.
8. **Test gaps.** Accepted:
   - badge parity and suppression are added to scenario 5;
   - `localResourceRoots` narrowed to `dist` is added to Constraints.
9. **Verify the owner's ruling.** For the architect. The ruling was relayed by the architect, who
   is checking this revision against the owner's words before giving the go for `porch approve`.

Factual corrections also folded in:

- `requestPreservingBody` is named as the precedent;
- B2 notes that `apps/web` exports only `./src/*.ts`.
