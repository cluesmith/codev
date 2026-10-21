# Plan 1819 — iteration 1 rebuttal

Both reviewers requested changes. Every point was accepted; none is disputed. The plan now has
seven phases (claude's suggested split of the old Phase 4).

## Codex (REQUEST_CHANGES)

1. **`useDecisions` stale-response protection.** Accepted. Phase 4's hook skips a tick while a
   fetch is in flight, so fetches never overlap. A generation counter is bumped at each fetch
   start and by `applyDocument`, and a response is applied only if its generation is still the
   latest, so a poll that started before a write can't overwrite the write's document. A hook test
   with a deliberately delayed old response is in Phase 4's test plan; a risk row is added.
2. **E2E writes the real workspace's default path.** Accepted. Phase 7 now uses throwaway
   `mkdtemp` workspaces only, driven via `/workspace/<enc>/` (activation through the workspaces
   API only if it turns out to be required) and removed in `afterAll`. Nothing is written under
   the repo, and a post-run acceptance check confirms the tree is unchanged.
3. **Option tokenization vs ` / ` in descriptions.** Accepted. Phase 1 defines it precisely: a
   ` / ` starts a new option only when immediately followed by a backticked span; any other
   ` / ` is part of the current description. This is the reading of the spec's "split on ` / `"
   that satisfies the spec's own ` / `-in-description test scenario.

## Claude (REQUEST_CHANGES)

1. **E2E against the live Tower / repo workspace.** Accepted. As well as the throwaway workspaces
   (codex 2), the suite requires an explicit `TOWER_TEST_PORT` and refuses when it is unset or
   `4100` (precedent `issue-1482-held-popover-detail.test.ts`, #1630). Verified: `codev/state/*.md`
   is gitignored, which is a further reason not to write there.
2. **File-disappears requirement unreachable under Team-style gating.** Accepted. Phase 4 makes
   the tab conditional to *appear* and then sticky for the page session (a ref records it was
   enabled), so the view stays mounted, the not-found state renders, and held drafts survive.
   A reload of a workspace without the file shows no tab. Acceptance criteria in Phases 4, 6 and
   7 cover it.
3. **`decisionsEnabled` costs `loadConfig` on every 1 s state poll.** Accepted (verified
   `POLL_INTERVAL_MS = 1000`). The state flag uses a per-workspace memo of the *configured
   relative path* only, refreshed at most every 5 s; each poll then costs a `realpath` plus an
   existence check. The read/write routes always load config fresh. The memo never holds
   decisions-file content, so baked decision 2 is untouched. A config-load error makes the flag
   false and is logged, rather than failing `/api/state`. I chose a TTL over the
   `codev-config-watcher`: that module only broadcasts SSE and has no in-process invalidation
   hook, and adding one is more machinery than the cost warrants.
4. **Theme CSS import location.** Accepted. It is imported from `apps/web/src/main.tsx` (VS Code
   precedent), so component tests don't depend on `dist/`.
5. **`structure-changed` coverage by mocking.** Accepted. It is reached with a real input instead.
   The explicit checks validate the comment, not the word, so an option like `` `##` ``
   (written on its own line it becomes an ATX heading) or a fence-like option passes them, and
   only the re-parse verification refuses it. No mocks are needed, and the catch-all is shown to
   be reachable.
6. **Split Phase 4.** Accepted. The new Phase 4 is the shell (dependency, race-safe polling hook,
   tab wiring, list/not-found/error), and the new Phase 5 is the read-only cards. Ruling is
   Phase 6 and browser verification + docs is Phase 7.
