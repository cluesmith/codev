# PIR Plan: Extract transport-agnostic reconnect policy into `@cluesmith/codev-core`

> Issue #961. Pays down the debt #936 added: four copies of the exponential-backoff
> reconnect curve across three packages, with divergent tuning (6-vs-50 max-attempts)
> and divergent session-unknown handling (yes-vs-no recovery affordance).

## Understanding

The `Math.min(1000 * 2^attempt, cap)` backoff curve is reimplemented at four call sites:

| Location | Surface | curve | cap | max-attempts | session-unknown fast-path | counter ordering |
|---|---|---|---|---|---|---|
| `packages/vscode/src/connection-manager.ts:177` | SSE / health-check | `1000·2^n` | 30s | ∞ | — | delay→increment |
| `packages/vscode/src/terminal-adapter.ts:208` | VSCode terminal WS | `1000·2^n` | 30s | 6 (give-up + #939 link) | yes (`/Unexpected server response: 4\d\d/`) | delay→increment |
| `packages/dashboard/src/components/Terminal.tsx:533` | Web terminal WS | `1000·2^n` | 30s | 50 (→ silent `'disconnected'`) | no (`onerror` no-op) | delay→increment |
| `packages/codev/src/agent-farm/lib/tunnel-client.ts:69` | Tunnel control channel | `1000·2^n` **+ jitter(0–1000)** | **60s** | ∞ (**5-min floor after 10**) | no (JSON auth vocabulary) | **increment→delay** |

Two user-visible divergences matter: **max-attempts (6 vs 50)** and **session-unknown detection (VSCode yes, web no)** — the same "terminal stopped reconnecting" state means different things depending on where it's viewed, and the web side lacks the one-click recovery #939 gives VSCode.

The precedent for the fix is `packages/core/src/escape-buffer.ts`: pure logic, no `vscode`/DOM/Node-socket dependency, consumed by both `vscode/terminal-adapter.ts` (direct import) and `dashboard/Terminal.tsx` (via a `src/lib/escapeBuffer.ts` re-export). The reconnect curve is the same *shape* of thing.

### Two constraints discovered during investigation that shape the design

1. **The browser cannot see Tower's session-unknown rejection.** Tower 404s an unknown session at the **HTTP-upgrade stage** (`packages/codev/src/agent-farm/servers/tower-websocket.ts:164,196,236,248` → `socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy()`). Node's `ws` client surfaces this as `"Unexpected server response: 404"` (what terminal-adapter's regex catches). A **browser `WebSocket`** that fails its upgrade fires `onerror` + `onclose` with code `1006` and **no access to the HTTP status** — browsers deliberately hide failed-upgrade response details from JS. So the web terminal *cannot* fast-path session-unknown today without a Tower-side change (accept-then-close with an app close code the browser can read via `CloseEvent.code/.reason`). That is out of scope here (it changes the VSCode rejection path too). → drives design-call #2.

2. **The tunnel's curve genuinely differs and increments in the opposite order.** `calculateBackoff` adds jitter, caps at 60s (not 30s), floors at 300s after 10 attempts, and is called with the *post-increment* counter (close handler does `consecutiveFailures++` *then* `scheduleReconnect()`). The terminals compute the delay *then* increment. A naïve shared controller with one internal counter would silently re-tune the tunnel. → drives the factoring (a pure delay function with an explicit `attempt` arg, so each site keeps its own counter ordering) and design-call #4.

## Proposed Change

Add a new pure module `packages/core/src/reconnect-policy.ts` with three exports, then adopt it at all four sites. The module has **no** `vscode`, DOM, or socket dependency (same discipline as `escape-buffer.ts`).

### `backoffDelayMs(attempt, opts)` — the one shared curve (de-dup target)

```ts
export interface BackoffOptions {
  baseMs?: number;       // default 1000
  capMs?: number;        // default 30_000
  maxAttempts?: number;  // default 6 (terminals); Infinity for SSE/tunnel
  jitterMs?: number;     // default 0; tunnel sets 1000
  floor?: { afterAttempts: number; delayMs: number };  // tunnel: {10, 300_000}
  random?: () => number; // injectable RNG for deterministic jitter tests; default Math.random
}

// Pure: min(base·2^attempt + jitter, cap), with the floor short-circuit applied first.
export function backoffDelayMs(attempt: number, opts?: BackoffOptions): number;
```

Because `attempt` is an explicit argument, **each call site preserves its own counter ordering** — the function only owns the curve math, not the counter. This is the single primitive that replaces all four `Math.min(...)` copies plus tunnel's `calculateBackoff` body.

### `BackoffController` — counter + status + give-up (for the two terminal surfaces)

```ts
export type BackoffStatus = 'idle' | 'connecting' | 'connected' | 'giving-up';
export type FailureAction = 'retry' | 'give-up';

export class BackoffController {
  constructor(opts?: BackoffOptions);
  get status(): BackoffStatus;
  get attempt(): number;            // failures recorded since last success/reset (post-increment, 1..N)
  start(): void;                    // idle/connected → connecting
  recordSuccess(): void;            // → connected; attempt = 0
  recordFailure(): FailureAction;   // exhausted (attempt ≥ maxAttempts) → 'giving-up'/'give-up'; else attempt++, 'retry'
  nextDelayMs(): number;            // delay for the retry just authorized = backoffDelayMs(attempt - 1, opts)
  reset(): void;                    // manual reconnect: attempt = 0, status = 'connecting' (clears give-up)
  stop(): void;                     // → idle
}
```

**Sequencing matches terminal-adapter exactly** (verified, will be asserted in tests): with `maxAttempts: 6`, the six `recordFailure()`/`nextDelayMs()` pairs yield delays `[1000, 2000, 4000, 8000, 16000, 30000]`, and the 7th `recordFailure()` returns `'give-up'` — identical to today's `scheduleReconnect()` (give-up fires on the close *after* the 30s retry). The `attempt` getter returns the post-increment value (1..6) so the existing `(attempt/MAX)` notice text is unchanged.

### `classifyUpgradeError(reason)` — session-unknown classification

```ts
export type UpgradeErrorReason = string | { code?: number; message?: string };
export function classifyUpgradeError(reason: UpgradeErrorReason): 'permanent' | 'transient';
```

Default rule encapsulates the Tower close-code convention: a 4xx upgrade rejection → `'permanent'` (give up now — the session/resource is gone), anything else → `'transient'`. Accepts both the Node-`ws` string form (`/Unexpected server response: 4\d\d/`, the only live producer today) and a numeric `{ code }` form (`400 ≤ code < 500` → permanent) so the web terminal can adopt it the day Tower grows a browser-visible close code — without an API change.

### Adoption per call site (the four "shrinks")

1. **`terminal-adapter.ts`** — replace `MAX_RECONNECT_ATTEMPTS` / `MAX_RECONNECT_DELAY` / the inline `Math.min` / `UPGRADE_CLIENT_ERROR` regex / the `reconnectAttempt`+`gaveUp` bookkeeping with a `BackoffController({ maxAttempts: 6 })` and `classifyUpgradeError`. `on('open')` → `recordSuccess()`; `on('close')` → `recordFailure()` (`'give-up'` → `giveUp(...)`); `on('error')` → `classifyUpgradeError(err.message) === 'permanent'` → `giveUp(...)`; `reconnect()` → `reset()`. **`RECONNECT_LINK_TEXT` stays exactly where it is** (consumed by `#939`'s link provider) — only the backoff/classifier internals move. Net behavior preserved bit-for-bit (#936/#939 no-regression).

2. **`connection-manager.ts`** — `scheduleReconnect()` adopts `backoffDelayMs(this.reconnectAttempt, { capMs: 30_000, maxAttempts: Infinity })` in place of the inline `Math.min`. Keeps its own `reconnectAttempt` counter and `delay→increment` order (no give-up — SSE retries forever). Smallest change; just de-dups the curve.

3. **`Terminal.tsx`** — adopt `BackoffController({ maxAttempts: 6 })` in place of the `rc.attempts` + `MAX_ATTEMPTS=50` + inline `Math.min` block. **6-vs-50 resolved to 6** (design-call #1). On give-up → `setConnStatus('disconnected')` (as today) **plus** enrich the existing toolbar reconnect button (`reconnectRef`) so that, when disconnected, it tears down and calls `connect()` fresh via `controller.reset()` — a true recovery, not just refit+SIGWINCH (design-call #3). `onclose` wires `classifyUpgradeError(closeEvent.code)`, which is `'transient'` for today's `1006` → **web session-unknown behavior is unchanged (blind retry)**, explicitly kept-as-is (design-call #2).

4. **`tunnel-client.ts`** — reimplement the body of the existing exported `calculateBackoff(attempt, randomFn)` as `backoffDelayMs(attempt, { baseMs: 1000, capMs: 60_000, jitterMs: 1000, floor: { afterAttempts: 10, delayMs: 300_000 }, random: randomFn })`. Signature and behavior preserved → `tunnel-client.test.ts` stays green. The duplicated curve is gone; the auth/rate-limit circuit-breaker stays host-side (not in scope). Does **not** adopt the controller (it never gives up) or the classifier (different vocabulary) — per design-call #4.

### Design-call resolutions (the plan-gate decisions)

- **#1 — 6 vs 50:** unify on **6**. Faster surfacing of "not recovering, intervene"; consistent cross-surface semantics. The "browsers see more transient closes" pressure is mitigated because (a) `recordSuccess()` resets the counter so only *consecutive* failures count (~61s of trying), and (b) give-up is now recoverable on web via the enriched button (#3).
- **#2 — web session-unknown:** **explicitly kept-as-is (blind retry)**, per the hard browser constraint above. Classifier ships code-aware so future adoption is a one-liner once Tower emits a browser-visible close code. No silent change.
- **#3 — web recovery affordance:** **adopt a minimal one** (enrich the existing button), because it's coupled to #1 — dropping web to 6 without real recovery would regress UX (post-give-up recovery is otherwise page-reload only). Not a new UI; reuses the existing control.
- **#4 — SSE/tunnel:** **share the curve, not the controller, not the classifier.** SSE and tunnel keep bespoke counters/escalation; only the `backoffDelayMs` primitive is shared.

### Where the core unit tests live (open decision — recommendation below)

Core has **no test suite** today; the cited precedent (`EscapeBuffer`) is unit-tested from the *dashboard* package via re-export, and CI's unit job runs only `packages/codev` vitest. The acceptance asks for "full unit-test coverage in the core package's test suite."

- **Recommended:** bootstrap a minimal vitest in `packages/core` (`vitest` devDep + `test` script + `src/__tests__/reconnect-policy.test.ts`), exclude `**/*.test.ts` from the `tsc` build (`tsconfig.json`), and add one CI step in `.github/workflows/test.yml` (`working-directory: packages/core`, after the existing "Build core package" step). This gives the policy its proper home, satisfies the acceptance literally, and adds the test infra core was missing. Modest one-time cost.
- **Lighter alternative (flagged for the gate):** co-locate the tests in `packages/codev` (importing `@cluesmith/codev-core/reconnect-policy`) — runs in the existing CI job with zero config/CI churn, and is exactly the EscapeBuffer-tested-from-a-consumer precedent. Loses the "in core" literal reading.

I'll implement the **recommended** option unless the reviewer redirects at the gate.

## Files to Change

- `packages/core/src/reconnect-policy.ts` — **new.** `backoffDelayMs`, `BackoffController`, `classifyUpgradeError`, types.
- `packages/core/package.json` — add `./reconnect-policy` to `exports`; add `vitest` devDep + `"test": "vitest run"` script.
- `packages/core/vitest.config.ts` — **new** (minimal; node env).
- `packages/core/src/__tests__/reconnect-policy.test.ts` — **new.** Curve values, jitter (injected RNG), floor, give-up sequencing `[1s,2s,4s,8s,16s,30s]→give-up`, success-reset, reset(), classifier (string + code forms).
- `packages/core/tsconfig.json` — exclude `**/*.test.ts` / `__tests__` from the build so dist stays clean.
- `.github/workflows/test.yml` — add a "Run core unit tests" step (`working-directory: packages/core`).
- `packages/vscode/src/terminal-adapter.ts:9-21,57-63,175-268` — adopt controller + classifier; drop local curve/regex; keep `RECONNECT_LINK_TEXT`.
- `packages/vscode/src/connection-manager.ts:24-25,172-185` — adopt `backoffDelayMs`.
- `packages/dashboard/src/components/Terminal.tsx:395-406,522-543,656-666` — adopt controller; 50→6; enrich reconnect button; wire classifier on `CloseEvent.code`.
- `packages/codev/src/agent-farm/lib/tunnel-client.ts:62-74` — reimplement `calculateBackoff` over `backoffDelayMs`.
- `packages/vscode/src/__tests__/terminal-adapter.test.ts`, `packages/vscode/src/__tests__/reconnect-link-provider.test.ts` — update the `@cluesmith/codev-core/...` mock to also mock `reconnect-policy`.
- `packages/dashboard/__tests__/` — add/extend a Terminal reconnect test if feasible under the existing jsdom config (best-effort; the give-up logic is fully covered by the core suite regardless).
- `codev/resources/arch.md` — note the new core primitive if it warrants a line (review phase).

## Risks & Alternatives Considered

- **Risk — regressing #936/#939 in the VSCode terminal.** Mitigation: the controller is designed to reproduce the exact delay sequence and give-up timing; tests assert `[1000,2000,4000,8000,16000,30000]` then give-up; `RECONNECT_LINK_TEXT` and the link provider are untouched. The `dev-approval` gate exercises a forced give-up in the running VSCode terminal.
- **Risk — silently re-tuning the tunnel.** Mitigation: `backoffDelayMs` takes an explicit `attempt`, so the tunnel keeps its increment→delay order; `calculateBackoff`'s signature is preserved and its existing unit tests are the guardrail.
- **Risk — dropping web 50→6 increases give-up frequency.** Mitigation: paired with the enriched recovery button (#3); `recordSuccess()` resets so only consecutive failures count.
- **Risk — core test infra is new surface (vitest + CI step).** Mitigation: minimal config mirroring the other packages' vitest; flagged as a gate decision with a zero-infra alternative.
- **Alternative — one stateful controller shared by all four (rejected):** can't preserve the tunnel's opposite counter ordering or its jitter/floor without bloating the controller; the curve-function + thin-controller split is cleaner and lower-risk.
- **Alternative — adopt web session-unknown now via a Tower close-code change (rejected for this issue):** changes the VSCode rejection path and Tower's WS server — larger blast radius than a consolidation issue should carry; deferred to a follow-up.

## Test Plan

**Unit (core suite — the bulk of coverage):**
- `backoffDelayMs`: exact values for attempts 0..6 at 30s cap; 60s-cap branch; jitter with an injected deterministic RNG; floor short-circuit at `afterAttempts`.
- `BackoffController`: give-up sequencing `[1000,2000,4000,8000,16000,30000]` then `recordFailure()==='give-up'`; `recordSuccess()` resets to attempt 0 / `'connected'`; `reset()` clears give-up; status transitions.
- `classifyUpgradeError`: `"Unexpected server response: 404"`→permanent, `"...502"`→permanent, transient strings→transient, `{code:404}`→permanent, `{code:1006}`→transient.

**Unit (consumers):** `tunnel-client.test.ts` and `terminal-adapter.test.ts` stay green after adoption (the regression guard for "no behavior change").

**Manual (the `dev-approval` gate — both surfaces, forced give-up):**
- `afx dev pir-961`, open a VSCode terminal AND the web dashboard terminal against the worktree.
- Kill Tower mid-session. Confirm **both** surface their give-up state with consistent timing (~the same ~61s budget over 6 attempts) — the cross-package smoke test from the acceptance.
- VSCode: confirm the #939 reconnect link still appears and reconnects.
- Web: confirm the toolbar reconnect button now performs a true reconnect after give-up (not just a refit).
- Restart Tower; confirm a fresh connect resets the counter on both.
