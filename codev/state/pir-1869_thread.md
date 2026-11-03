# pir-1869 thread

## 2026-11-03 plan
- Gap confirmed: isRequestAllowed + isForwardAuthorized read the key only from headers; /ide/ navigations, assets, and WS upgrades carry none.
- Plan: HMAC(localKey)-derived `codev-ide-session` cookie (HttpOnly, SameSite=Strict, Path=/ide), minted by key-gated POST /api/ide/session (already tunnel-blocked by api/ide/ segment); isForwardAuthorized accepts it; isRequestAllowed delegates /ide* to that seam; cookie stripped before forwarding; Open IDE row in tower.html per workspace.
- Chose HMAC over raw key (keeps API key out of cookie jar) and over random in-memory token (survives Tower restart).

## 2026-11-03 pending security suggestions (HOLD until the security architect replies)
Owner said: wait for the security architect's feedback, then suggest these. Not yet in the plan, not yet sent.
1. Origin check on the cookie branch only: localhost ports count as one site, so SameSite=Strict lets a localhost:3000 page open /ide/ WS with our cookie (WS has no CORS). Require Origin == Tower's own origin when the cookie authorizes; missing Origin allowed.
2. Order in isForwardAuthorized: Host -> header -> cookie+Origin; header wins with no Origin check, so tunnel/cloud is unaffected.
3. Reword: cookie is RCE-equivalent via the IDE terminal, not "only /ide".
4. Accepted risk: on a multi-user host, another user's localhost server can collect and replay the cookie; expiry or a revocable value would mitigate, at the cost of surviving a Tower restart.
5. Tests: cross-port Origin WS -> 401; same-origin -> ok; header + cloud Origin -> ok (HTTP+WS); tunnel-auth suites green.

## 2026-11-03 security review folded
Security architect REQUEST_CHANGES on 1b0d2ec28: M1 (cross-port localhost WS hijack via ambient cookie, the item held above) plus M2-M4 and S1-S4. All folded: M1-M4 in ccdfd3f7d, S1-S4 in b0f461cbe. My extra items sent for confirmation: header-first order with a cloud-Origin test, and the multi-user replay accepted risk. Framing hygiene (S3) is out of scope; asked main to file it.

## 2026-11-03 implement: BLOCKED on browser finding
Implementation committed in 5 commits (seam, strip, mint/routes, dashboard, docs). Tests green except protocol-drift-audit (npm registry reachability, env-dependent, unrelated).
Playwright via harness (:4199, real handleRequest/setupUpgradeHandler, live Tower untouched) found: the workbench WS dials :8200 directly (remoteAuthority comes from the rewritten Host), and the IDE server's Set-Cookie vscode-tkn (7d, Lax) is forwarded to the browser; :8200 accepts a WS with that cookie from Origin localhost:3000 (101). Together these bypass M1. Proposed: strip Set-Cookie vscode-tkn from forwarded responses, and stamp x-forwarded-host/proto locally (probe confirms remoteAuthority becomes Tower's). Escalated to main and security; holding.

## 2026-11-03 amendment 1 implemented
Fix (a), stripping the vscode-tkn Set-Cookie, broke the workbench with "auth mismatch": the client reads connectionToken from options first, then from the cookie. Replaced it with (a'): strip the cookie AND inject the token into the workbench config meta. Security ruled it acceptable for local requests only, with conditions: 200/text-html/uncompressed/2 MB bound, safe token, empty {} handled, JSON-validated, fail-safe unchanged. Also in: (b) stamp x-forwarded-host/proto with Tower's Host locally; C1 strip client x-forwarded-*; C2 Tower's vscode-tkn replaces the incoming one; C3 Set-Cookie strip on HTTP and 101; token rotation on every spawn (never on adopt); /ide 401 logs pathname only; docs line against hand-built ?tkn=.
Playwright C4: the jar holds only codev-ide-session after Open IDE and after reload; both workbench WS go to Tower's port and stay open; a cross-port WS gets 4401. Cloud variant is a follow-up filed by main.
Lesson: verify the third-party client's own credential path (here the workbench JS reads the token) before stripping a credential it hands out.
