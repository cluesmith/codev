# Phase 3, iteration 1: response to the reviews

Codex: REQUEST_CHANGES (one issue). Claude: APPROVE (four non-blocking notes).

## Codex

### The 64-character limit on a workspace name is not in the spec: accepted, removed

The reviewer is right. Decision 2 defines a name by the component rule, the reserved words and
the collision rule, and nothing else. The limit was my addition.

- `utils/workspace-address.ts`: the length check and the exported `MAX_WORKSPACE_NAME_LENGTH`
  are gone. A private `MAX_QUOTED_LENGTH` (64) remains only for cutting short a *refused* value
  when an error quotes it back.
- Tests: the two that pinned the limit now pin its absence (`workspace-address.test.ts`, a
  300-character name is accepted; `tower-routes.test.ts`, a 200-character name is stored and
  reported), and a separate test keeps the quoting cut.

One consequence, stated so nobody is surprised: an address is at most 512 characters
(`MAX_ADDRESS_LENGTH`, phase 1). A name too long to fit in one can be set and then cannot be
written by a sender, who gets the parser's length error. I have not added a rule for that, since
it would again be a limit the spec does not give. Raised with the architect in case the owner
wants one.

## Claude (non-blocking, all fixed in place except the last)

1. **The route ignored the write's result.** Fixed: `handleSetWorkspaceAddressName` answers 500
   `INTERNAL_ERROR` ("The name was not stored…") when the update matches no row, where it used to
   answer 200 with a name that was never stored.
2. **A unique-index refusal would have been an uncaught throw.** Fixed: a
   `SQLITE_CONSTRAINT_UNIQUE` from the write is answered 409 `NAME_TAKEN`; any other error still
   throws.
   Neither state can be reached through the route on POSIX (each needs a row stored under another
   spelling of the path), so the two tests use a SQLite trigger on the real test database to
   stand in for the disagreement: one takes the name between check and write, one makes the
   update skip its row.
3. **Errors named the workspace by its directory, not by what the sender wrote.** Fixed with one
   helper, `workspaceLabel(target)`, used by the six "…in workspace '<x>'" errors in both
   resolvers. A sender who wrote `cloud:architect:ghost` is now told "not found in workspace
   'cloud'", agreeing with the front-door hint in the same message. The one remaining
   `path.basename` there is a server log line, left as it is.
4. **The 64-character limit should be documented.** Superseded: the limit is removed (above).
5. **`getRegisteredWorkspaces()` is called twice in the handler.** Left: the second read is what
   reports the stored state, and the route is not a hot path.

## Verification

- Each new test fails when its fix is removed (three mutations, restored afterwards).
- The affected test files, the wider set of files that touch the resolver, the route or the
  naming module, the type-check and the package build: results are in the thread log.
