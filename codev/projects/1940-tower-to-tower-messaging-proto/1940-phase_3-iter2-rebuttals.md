# Phase 3, iteration 2: response to the reviews

Codex: REQUEST_CHANGES (one issue). Claude: APPROVE (four non-blocking notes).

## Codex

### The naming route refuses a Windows UNC workspace path: true, not changed in this phase

The finding is accurate: `handleSetWorkspaceAddressName` accepts a path that starts with `/` or
with a drive letter, so `\\server\share\repo` gets 400 `INVALID_PARAMS`.

It is not this phase's doing, and the architect decided (2026-11-24) that it is not fixed here:

- The check is the same line the four existing `/api/workspaces/:encodedPath/…` routes use
  (`tower-routes.ts`: add-architect, remove-architect, activate/deactivate/status, and the
  workspace dashboard route). `afx workspace start` goes through the activate route, so a UNC
  workspace cannot be started through Tower today either. The naming route matches its siblings;
  accepting UNC in it alone would name a workspace that cannot be started.
- Changing it means changing four routes outside this spec, on a platform this project cannot
  run (no Windows machine with a share), and it raises a question that is the owner's: whether
  Tower should open a network path named in a request.
- It is tracked: issue #1960, "tower: workspace routes refuse Windows UNC workspace paths; the
  path check is copied inline in every route". The review names it as a known boundary.

No code change for this point.

## Claude (non-blocking)

1. **`everyWorkspace` told workspaces apart by the text of a path, not by `workspaceKey`.**
   Fixed, on the architect's instruction (the key is a standing invariant of this codebase). The
   naming module now builds one list of known workspaces keyed by `workspaceKey`: a row and a
   running workspace that spell one directory two ways are one workspace, with the row's name. A
   lookup returns a running workspace in the spelling it runs under, which is the key of the live
   terminal map. Five tests force the Windows path rules and cover: the name reaches it; it does
   not also answer to its directory name as a second, unnamed workspace; its directory name is
   free for another workspace; its own name and re-setting its name work under either spelling.
2. **`findWorkspaceByAddressName` trusted its caller to lower-case.** Fixed: it lower-cases the
   name at entry, with a test, so phase 5's callers cannot get it wrong.
3. **`Access-Control-Allow-Methods` does not list `PUT`.** Left on purpose: the only caller is the
   CLI, and no browser caller exists. Listed in the review.
4. **`quoted()` is duplicated between the SDK parser and the naming module.** Left on purpose:
   eight lines across a package boundary. Listed in the review.

## Verification

- The four tests that pin the two fixes fail against the previous version of the module.
- The `packages/codev` test files that touch the resolver, the route, the naming module or the
  address parser, the type-check and the package build pass; the counts are in the thread log.
