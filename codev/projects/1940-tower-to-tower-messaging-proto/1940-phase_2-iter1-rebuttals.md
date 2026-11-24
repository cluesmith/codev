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
