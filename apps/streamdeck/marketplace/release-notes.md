**Initial release of Codev for Stream Deck.**

Drive Codev's AI agent workflows from your desk. This plugin pairs with Codev (https://codevos.ai/) and its Tower server running locally.

**Keys**

- **Approve Gate**: a live badge counts pending approval gates; press to surface the next review in VS Code.
- **Builder Action**: a live tile, one builder per key, showing its issue and phase; press selects the builder and opens the artifact for its current phase (spec / plan / diff), or a fixed verb you choose.
- **Codev Action**: run Codev commands (open terminals, view diff, send, spawn, refresh).
- **Dev Server**: start and stop the workspace dev server.

**Dials (Stream Deck +)**

- **Zoom Navigator**: browse workspaces and builders, zoom into the diff.
- **Diff File and Diff Hunk Navigators**: step through a builder's diff review and forward changes to the builder.
- **PR Navigator**: browse open pull requests and open the selected one.
- **Spawn from Backlog**: browse the issue backlog and spawn a builder.
- **Scroll & Forward**: scroll the active editor and forward the current selection.

Requires a local Codev installation with Tower running.
