# air-1043 thread

## IMPLEMENT phase

Implementing #1043: `codev.referencePRInArchitect` — mirror of `codev.referenceIssueInArchitect` for the Pull Requests sidebar.

### Changes

- `packages/vscode/src/views/pull-requests.ts`: Added `PullRequestTreeItem` subclass (carries `prId`, `prTitle`); updated `PullRequestsProvider.getChildren()` to construct `PullRequestTreeItem` instead of bare `vscode.TreeItem`.
- `packages/vscode/package.json`: Declared `codev.referencePRInArchitect` command with `$(mention)` icon; added `commandPalette` `when: false` entry; added `view/item/context` inline entry for `view == codev.pullRequests && viewItem == pull-request` at `inline@1`.
- `packages/vscode/src/extension.ts`: Imported `PullRequestTreeItem`; registered `codev.referencePRInArchitect` handler using existing `buildArchitectReferenceInjection` plumbing.
- `packages/vscode/src/__tests__/reference-pr-in-architect.test.ts`: 11 unit tests covering command declaration, menu wiring, palette hiding, extension.ts registration, and injection format.

### Build/test status

Unit tests: 11/11 pass. Pre-existing 8 test-suite import failures (for `@cluesmith/codev-core` subpaths) are unrelated to this change.

Sending PR for review.
