**Initial release of Codev for Stream Deck.**

Drive Codev's AI agent workflows from your desk. Pairs with Codev (https://codevos.ai/) and its Tower server running locally.

**Keys**

- **Builder Action**: a live tile per builder showing its issue and phase; press selects it and opens its current spec, plan, or diff (or a fixed verb).
- **Architect Action**: a live tile per architect; press opens its terminal.
- **Approve Gate**: shows the selected builder's pending gate; press surfaces its review in VS Code.
- **Send Feedback**: flushes queued review feedback to the selected builder; the badge counts what's queued.
- **Open Builder / Architect Terminal**: jump straight to the right terminal.
- **Codev Action**: run Codev commands (open terminals, view diff, send, spawn, refresh).
- **Run Dev**: start and stop dev for the selected builder's worktree.

**Dials (Stream Deck +)**

- **Zoom Navigator**: browse workspaces and builders, zoom into the diff.
- **Review: Files / Headings** and **Review: Changes / Blocks**: step through files/changes in a diff or headings/blocks in a spec; press forwards the current item to the builder.
- **Scroll & Forward Selection**: scroll the editor; press forwards the selection.
- **PR Navigator**: browse open pull requests; press opens the selected one.
- **Spawn from Backlog**: browse the backlog and spawn a builder.

**Included profile**: a ready-made Stream Deck + layout (review cockpit + architects pages) installs automatically.
