# Plan 1963: harness revision, review responses

This round reviewed the harness rewrite, made at the architect's request because `afx spawn`
cannot target a non-default Tower.

- Codex: REQUEST_CHANGES.
- Claude: COMMENT.

I checked every point against the code. All are accepted except one, Codex 1, which is partly
accepted (below).

## Codex (REQUEST_CHANGES)

1. **The spike must be run before plan approval.** Partly accepted.
   - **The spec's wording.** Spec §Assumptions says the layout behaviour is "to be confirmed in
     the plan by a spike against a running instance", and gives a fallback only for (a).
   - **Why it is not run now.** The architect has already checked this plan against the spec,
     with the spike scheduled inside implementation. Running it now would also mean starting a
     VS Code server before the harness exists, or the architect is told.
   - **Change:**
     - The spike moves out of the last phase into **Phase 1**, so it runs before any
       increment-1 code.
     - The outcomes are now explicit. If (a) fails, the spec's add/reuse-only rule applies. If
       (b), (c) or (d) fails, the architect gets the result at once, with the options. Phase 9
       waits for the owner, and Phases 2–8 continue.
   - **Offered to the architect:** running the spike before the plan is approved, if they want
     the strict reading.
2. **The bundle smoke test needs `dist`, which CI never builds.**
   - **Confirmed:** CI's `apps/vscode` step runs `check-types` and `test:unit` only
     (`.github/workflows/test.yml:102-107`).
   - **Change:** the smoke test builds its own entry in `beforeAll` through esbuild's API, into
     a temp dir. It uses the options object `esbuild.js` uses, shared from `esbuild.webview.mjs`.
3. **The package's test devDependencies and lockfile.**
   - **Change:** the package declares its own devDependencies, at `apps/web`'s versions:
     - `react` and `react-dom`;
     - `@types/react` and `@types/react-dom`;
     - `@testing-library/react` and `@testing-library/jest-dom`;
     - `jsdom`, `vitest` and `typescript`.
   - `pnpm-lock.yaml` is updated in the same commit, and the package's tests are checked to run
     in CI's workspace test step.

## Claude (COMMENT)

1. **An uncached `getWorktreeConfig` breaks request-count parity.**
   - **Confirmed:**
     - the fleet re-emits on every non-heartbeat SSE event and on a 20 s poll
       (`tower-cache.ts:53-64`);
     - the Cockpit re-renders on those, and the Workspace view does not;
     - `loadWorktreeConfig` is a bare call.
   - **Change:**
     - The Cockpit holds the resolved config. It drops it on `codev-config-updated`, on a
       connection-state change and on a workspace change.
     - A test asserts that fleet ticks cause no fetch, and that one `codev-config-updated` causes
       exactly one.
     - The request-count criterion now measures an idle window plus a scripted burst.
2. **The driver and the Tower can disagree on the db file.**
   - **Confirmed:** `getGlobalDbPath()` switches to `AF_TEST_DB` or `test.db` under
     `NODE_ENV=test` (`db/index.ts:123-129`).
   - **Change:**
     - `NODE_ENV` and `AF_TEST_DB` are pinned the same for both, and the driver never runs under
       vitest.
     - Pre-flight 3 asserts that the driver's `getGlobalDbPath()` equals the `.db` file the
       isolated Tower holds open (`lsof`).
     - Phase 1's self-test proves the mismatch is refused.
3. **A fallback host for the isolated VS Code.**
   - **Confirmed:** `code` is on PATH here.
   - **Change:**
     - `serve-web` stays the primary.
     - The fallback is the IDE server binary, launched directly with `ide-server.ts`'s flags,
       scratch dirs and its own port. It never goes through any Tower's `/api/ide`.
4. **WorkView's `DashboardState` coupling and the file-panel chrome.**
   - **Confirmed:**
     - `state` feeds the loading gate, `architectCount` and `findBuilderTab`
       (`WorkView.tsx:15,35,41,53`);
     - the file panel is a wrapper with its own toggle, label and search box (`:151-176`).
   - **Change:**
     - `state` leaves the shared prop surface. The loading gate keys on the overview,
       `architectCount` comes from `OverviewData.architects`, and builder opening goes through
       the host's `openBuilder`.
     - The slot is the whole `work-file-panel` wrapper plus the root class, and a test covers it.
5. **Smaller points**, all accepted:
   - **Held and queued counts** for this window's workspace come from
     `deriveAttention(overviewCache.getData())`. Other workspaces use the fleet's retained
     overview.
   - **Relocated commands get a Cockpit tree node.** A unit test invokes each handler with the
     Cockpit node its entry is attached to.
   - **Package shape:**
     - the risk row now says canvas is a built package;
     - the risk sits in `apps/web`'s `tsc -b` and in the webview tsconfig;
     - Phase 6 runs both type-checks before moving anything.
   - **Phase sizing:** the harness is now **Phase 1** and has its own acceptance criteria:
     - green on an empty fixture;
     - every pre-flight gate shown to refuse;
     - the tripwire shown to fire, aimed at a throwaway listener and never at `:4100`.

     The spike runs in it. The phases renumber from 1–8 to 1–9.
