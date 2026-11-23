# Phase 2, review iteration 2: responses

Codex: REQUEST_CHANGES, one point. Claude: APPROVE, with four observations. The iteration 1
misroute is confirmed fixed by both.

## Codex: with no `main`, the registry picks the alphabetically first architect

**Agreed and fixed.** The two reviewers disagree on scope here: claude calls this divergence
"correctly out of scope" because it is tracked as issue #1633 and pinned by an existing test. I
checked the issue and the code and sided with codex, for three reasons:

- The spec's address table says `<workspace>:architect` is "`main`, else the first registered".
  With terminals down, this phase's own front door answered with a different architect than
  with terminals up. That is a second recipient for one address, which the spec forbids.
- The fix is the one issue #1633 itself proposes, and it is one line.
- The test that pinned the old answer says, in its own comment, that it should fail and be
  flipped when the query is fixed.

**What changed**

- `getArchitects` (`agent-farm/state.ts`) now orders `main` first, then by `started_at`, the
  same order `loadState` uses and the same "first" `getArchitect` returns. It sorted by id,
  which is the architect's name.
- I checked the other production callers of `getArchitects` before changing it, as the issue
  asks. There are two. `commands/stop.ts` stops every architect and does not care about order.
  `servers/tower-instances.ts` relaunches a workspace's sibling architects in this order, which
  is also what fills the live terminal map after a Tower restart; relaunching in registration
  order keeps the same architect first across a restart, where name order did not. No caller
  wants a display order.
- The three comments the issue lists as wrong ("first registered") are now true and unchanged.

**Tests**

- `air-1477-owner-escalation-wiring.test.ts`: the pinned test now expects `zeta` (registered
  first), with its comment rewritten to say what it guards.
- `state.test.ts`: `getArchitects` is in registration order and not name order; `main` is first
  whenever it was registered; `getArchitects`, `getArchitect` and `loadState` agree on who is
  first.
- `tower-routes.test.ts`, real resolvers behind `/api/send`: in a workspace with no `main` where
  `zeta` was registered before `alpha`, `<workspace>:architect` is delivered to `zeta` when its
  terminal is live, and held for `zeta`, not `alpha`, when no architect there has one.

Run against the old query, five of these fail, including the held-mail route test. They pass
with the fix.

## Claude's observations

1. **A builder that omits its own workspace but writes it explicitly is refused.** Deliberate, and
   recorded here as asked. With no sender workspace, no target can be shown to be the sender's
   own, so the builder gets no affinity and no right to name an architect there. `afx send`
   always supplies the workspace, so only a caller of the SDK that leaves it out can reach this,
   and it fails closed. A test pins it.
2. **The route reports the live resolver's `NOT_FOUND` when the registry says `REFUSED`.** No
   change. Both carry the Spec 755 text in the only case where this happens, and nothing is
   stored.
3. **Error strings carry a local workspace name that was not checked against the component
   rule.** No change in this phase: they go only to the sender, in the HTTP error body, as
   "Project 'x' not found" already did. Carried into phase 4 as a note: the rule there, that a
   basename enters a frame only if it fits the component rule, does not cover these strings.
4. **The front-door ordering divergence.** Fixed; see above.

The one point claude could not settle by reading, whether `bugfix-1094-tower-guard.test.ts`'s
partial mock of `state.js` survives the new imports: it does. That file passed in the targeted
runs and in GitHub's run of the whole suite.
