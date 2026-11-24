### Iteration 1 Reviews
- codex: REQUEST_CHANGES — Phase 3 is well covered, but it introduces an unapproved 64-character workspace-name limit.
- claude: APPROVE — Phase 3 fully implements the Decision-2 naming rules with a pure rules module, a correctly gated v20 migration and unusually strong tests; only small Windows-edge and message-wording nits remain.

### Builder Response to Iteration 1
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

Removing it left one hole, which I raised with the architect: an address is at most 512
characters (`MAX_ADDRESS_LENGTH`, phase 1), so a name too long to fit in one could be set and
then never written by a sender. **Architect's decision (2026-11-24), implemented:** the name is
refused at set time when the shortest address to the workspace, its front door
`<name>:architect`, would not pass the shared parser. This follows from the address limit the
parser already enforces; it is not a second limit.

- `packages/sdk/src/address.ts`: `tryFormatAddress`, the formatter's answer as a value (the
  text, and the parser's refusal of it if any). `formatAddress` now calls it and throws exactly
  as before.
- `utils/workspace-address.ts`: `validateProposedName` formats the front door with it and
  refuses with `INVALID_NAME`: "'<name>…' is too long to be used in an address: an address is at
  most 512 characters, and this one has 513 (the shortest address to this workspace would be
  <name>:architect)." The sentence with the number is the parser's own. The module holds no
  length constant.
- Tests: the longest name that fits is accepted and one character more is refused
  (`workspace-address.test.ts`, with the bound computed from the SDK's exported limit); the same
  pair at the formatter (`packages/sdk/src/__tests__/address.test.ts`); a 600-character name is
  refused through the route (`tower-routes.test.ts`).

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
- The SDK suite (404 tests), the 39 `packages/codev` test files that touch the resolver, the
  route, the naming module or the address parser (1178 tests), the VS Code extension's address
  conformance test (122), the type-check and the package build all pass.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
