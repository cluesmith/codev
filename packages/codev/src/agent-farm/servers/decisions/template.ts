// The decisions file a workspace starts from (Issue #1840). `afx decisions init` writes
// it; section 4 of resources/decision-protocol.md shows it, and a test pins the two equal.

export const DECISIONS_FILE_TEMPLATE = `# Pending owner decisions — all architects (hub: main)

Rule inline: one word on the line under an item's **Your word:** line, or in the Decisions tab.
Newest first. Only main edits this file; architects send items with \`afx send architect:main 'DECISION …'\`.

_Status: 0 open._
_Zone: UTC_

## Open

## Ruled
`;
