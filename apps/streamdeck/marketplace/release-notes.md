**Initial release of Codev for Stream Deck.**

Drive Codev's AI agent workflows from your desk. This plugin pairs with Codev (https://codevos.ai/) and its Tower server running locally.

**Keys**

- **Builder Action**: a live tile, one builder per key, showing its issue and phase; press selects the builder and opens the artifact for its current phase (spec / plan / diff), or a fixed verb you choose.
- **Architect Action**: a live tile, one architect per key; press opens that architect's terminal.
- **Approve Gate**: shows the selected builder's pending gate; press to surface that gate's review in VS Code.
- **Send Feedback**: flushes the selected builder's queued review feedback; the badge counts what's queued.
- **Open Builder Terminal** / **Open Architect Terminal**: jump straight to a builder's or an architect's terminal.
- **Codev Action**: run Codev commands (open terminals, view diff, send, spawn, refresh).
- **Run Dev**: start and stop dev for the selected builder's worktree.

**Dials (Stream Deck +)**

- **Zoom Navigator**: browse workspaces and builders, zoom into the diff.
- **Review: Files / Headings** and **Review: Changes / Blocks**: step through a review — files and changes in a diff, headings and blocks in a spec or plan — and forward what's under the cursor to the builder.
- **Scroll & Forward Selection**: scroll the active editor; press to forward the current selection.
- **PR Navigator**: browse open pull requests and open the selected one.
- **Spawn from Backlog**: browse the issue backlog and spawn a builder.

**Included profile**

A ready-made Stream Deck + profile — a review cockpit page and an architects page — installs automatically on first run.

Requires a local Codev installation with Tower running.
