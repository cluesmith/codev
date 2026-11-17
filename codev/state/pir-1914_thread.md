# pir-1914 thread

## 2026-11-18 plan
- Plan: carry IDE availability in GET /api/status (`ide: {available, viaTunnel}`), tunnel-borne availability requires a live port (no mint to respawn); dashboard drops the separate ./api/ide poll; openIde() skips the mint when viaTunnel. api/ide stays tunnel-blocked.
- Open item: Codev Cloud relay verification of /t/<tower>/ide/* (HTTP, WS, vscode-tkn cookie, asset paths) asked of architect at plan-approval.

## 2026-11-18 plan revision 1
- Architect relayed the Cloud confirmation (#1914 comment): relay checks all YES, the fallback switch is dropped. Added: tunnel-borne vscode-tkn Set-Cookie rewritten to Path=/t/<tower>/ide (HTTP + WS 101), local still strips. Made explicit that the link is relative to location.href with no stored slug, and that the tunnel branch carries no key/cookie. Cloud dev-approval check depends on a cloud-registered Tower running this build.

## 2026-11-18 implement
- plan-approval approved by owner (relayed by architect 20:36Z).
- Server: ideAvailability(viaTunnel) in ide-server.ts; /api/status carries ide:{available, viaTunnel}. ide-forward: TokenCookiePolicy (strip | scope) shared by HTTP and the WS 101; tunnel-borne vscode-tkn gets Path=/t/<tower>/ide; getPublicAuthority rejects unsafe tower_name.
- Dashboard: refreshIdeStatus + ./api/ide poll removed; refresh() reads data.ide; openIde skips the mint when viaTunnel; ideTargetUrl relative to location.href.
- Note: the tower name from `afx tower connect` is prompted without validation (tower-cloud.ts:134); normalized names pass the check.
