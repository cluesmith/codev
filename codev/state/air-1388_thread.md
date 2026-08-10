# Builder thread — air-1388

## 2026-08-10 — AIR #1388: vendor sdpi-components.js

- Downloaded sdpi-components v4.0.1 release build from https://sdpi-components.dev/releases/v4/sdpi-components.js
  into `com.cluesmith.codev.sdPlugin/ui/lib/sdpi-components.js` (sha256
  f6c0dfd2ed68e18084b9952842b86e3850cf837d674704700c2a0718e0a24f6b, re-download verified identical).
- Switched all three PI pages (codev-action, builder-action, fleet-slot) to `<script src="lib/sdpi-components.js">`.
- README: new "Vendored dependencies" section documenting version + upstream + bump procedure.
- New guard test `src/__tests__/vendored-ui-lib.test.ts`: vendored file exists, every ui/*.html uses the
  relative path, no remote src/href in any PI page, README version matches the file's license header.
- Verified: vitest 63/63 pass; `streamdeck validate` OK; `streamdeck pack` includes ui/lib/sdpi-components.js
  (confirmed via unzip -l of the packed artifact).
- Offline render: Playwright check loading each PI via file:// with all http(s) aborted — custom elements
  register and options render with zero remote requests. Settings *persistence* needs the live Stream Deck
  app websocket, so that part remains a hardware smoke test; the vendored file is byte-identical to what
  the CDN served, so runtime behavior is unchanged.
