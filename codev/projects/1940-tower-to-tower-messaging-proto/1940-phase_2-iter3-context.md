### Iteration 1 Reviews
- codex: REQUEST_CHANGES — Phase 2 is largely aligned, but the registry fallback can misroute a builder’s mail to an unrelated architect.
- claude: APPROVE — Phase 2 delivers the cross-workspace named-architect form and the builder rule exactly as planned, with both resolvers sharing one lookup and one permission check and strong route-level and unit coverage.

### Builder Response to Iteration 1
# Phase 2, review iteration 1: responses

Codex: REQUEST_CHANGES. Claude: APPROVE, with comments. One issue was raised by both.

## Codex: the registry fallback can hold a builder's mail for an unrelated architect

**Agreed and fixed.** I checked the path before changing anything, and it is as described:

1. A builder sends to bare `architect`. Its spawning architect has gone (or it is a legacy
   builder with none), and the workspace has no `main`.
2. The live resolver refuses, correctly, with the Spec 755 message. Its code is `NOT_FOUND`.
3. `NOT_FOUND` is what sends `/api/send` to the registry resolver.
4. `resolveRegistryArchitect` answered "the first registered", so the route held the mail
   (`no-live-pty`) for that architect, and the drainer then delivered it there.

The sender was told `held`, and an architect that had nothing to do with the builder received its
message. That is a misroute, which the spec forbids outright ("never falls back to a different
recipient").

The fault is older than this phase: the registry resolver has answered this way since the
mailbox work, and the old code had the same lines. I fixed it here anyway, because this phase's
claim is that the two resolvers cannot disagree, and this was a place where they did.

**What changed**

- `resolveRegistryArchitect` (`servers/tower-messages.ts`) now gives the live resolver's answer: a
  builder in the workspace gets its spawning architect, else `main`, else the Spec 755
  legacy-builder or architect-gone error. Anyone else gets the front door, as before.
- The starved-mail notice (`escalateHeldToOwner`, `servers/mailbox-wiring.ts`) used the same
  function and relied on "else the first registered", which an existing test pins
  (`air-1477-owner-escalation-wiring.test.ts`). That behaviour is deliberate: the notice is
  Tower's, not the builder's, and someone has to hear that mail is starving. It is kept, and is
  now written where it belongs: the notice asks for the builder's own architect first and, when
  the builder has none, for the workspace's front door. Its results are the same as before in
  every case.

**Tests added**

- `spec-1940-cross-workspace-resolve.test.ts`: against both resolvers, a builder whose architect
  has gone and a legacy builder, in a workspace with no `main`, are refused with the Spec 755
  messages; a non-builder and a sender from another workspace still get the first registered;
  with a `main` present, both builders reach `main`.
- `tower-routes.test.ts`, with the real resolvers behind `/api/send`: the same send is a 404 with
  the Spec 755 message on the immediate and the `--delay` path, nothing is stored, and no
  architect's terminal is written to.

I ran the new tests against the resolver as it was before the fix: three fail, including the
route test, which found mail stored for the wrong architect. They pass with the fix.

## Claude's comments

1. **The same divergence.** Claude recommended recording it as a known boundary and not widening
   the phase. I fixed it, for the reason above: on reading the route, it is reachable whenever the
   live resolver refuses, not only when the target has no live terminal, and the result is mail
   delivered to the wrong architect.
2. **`resolveTarget` looks up the workspace's terminals before it applies the builder rule**, so a
   builder in a workspace with no registered terminals would see the workspace error and not the
   Spec 755 refusal. Not changed. The order is the one the code had before this phase; a builder
   that is sending has a workspace with terminals; and either way the builder is refused.
3. **Interior whitespace in a local address** (`architect: review`) fails as not found and not as
   malformed. Not changed: local components are deliberately unvalidated so that no address that
   works today stops working, and the not-found error now lists the workspace's real architects.
4. **`codev/resources/arch.md` still describes the old two-slot parser.** Agreed; that file is in
   phase 6's list, and I have noted this line for it.


### Iteration 2 Reviews
- codex: REQUEST_CHANGES — The prior registry misroute is fixed, but offline front-door resolution can still select a different architect than live resolution.
- claude: APPROVE — Phase 2 delivers the cross-workspace named-architect form and the builder rule as planned, and the iteration-1 registry misroute is genuinely fixed without disturbing the starved-mail notice it shared code with.

### Builder Response to Iteration 2
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


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
