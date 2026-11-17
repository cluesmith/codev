# pir-1914 thread

## 2026-11-18 plan
- Plan: carry IDE availability in GET /api/status (`ide: {available, viaTunnel}`), tunnel-borne availability requires a live port (no mint to respawn); dashboard drops the separate ./api/ide poll; openIde() skips the mint when viaTunnel. api/ide stays tunnel-blocked.
- Open item: Codev Cloud relay verification of /t/<tower>/ide/* (HTTP, WS, vscode-tkn cookie, asset paths) asked of architect at plan-approval.
