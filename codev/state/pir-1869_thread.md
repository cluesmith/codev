# pir-1869 thread

## 2026-11-03 plan
- Gap confirmed: isRequestAllowed + isForwardAuthorized read the key only from headers; /ide/ navigations, assets, and WS upgrades carry none.
- Plan: HMAC(localKey)-derived `codev-ide-session` cookie (HttpOnly, SameSite=Strict, Path=/ide), minted by key-gated POST /api/ide/session (already tunnel-blocked by api/ide/ segment); isForwardAuthorized accepts it; isRequestAllowed delegates /ide* to that seam; cookie stripped before forwarding; Open IDE row in tower.html per workspace.
- Chose HMAC over raw key (keeps API key out of cookie jar) and over random in-memory token (survives Tower restart).
