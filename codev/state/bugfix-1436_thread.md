# bugfix-1436 — streamdeck validate CI flake on transient network errors

Issue #1436. BUGFIX protocol, strict mode.

## Investigate (iter 1)

### Root cause (traced from source, not assumed)

The flake is NOT a schema-update fetch as the issue title guessed. The exact failure
path is the Elgato CLI validation rule `manifestUrlsExist`
(`@elgato/cli` dist, rule from `src/validation/plugin/rules/manifest-urls-exist.ts`):

```js
const { status } = await fetch(url.value, { method: "HEAD" });   // url = manifest top-level "URL"
...
} catch (err) {
  if (err.cause?.code === "ENOTFOUND") {
    this.addError(..., "must be resolvable", url);   // graceful validation error
  } else {
    throw err;   // <-- ANY other fetch error (UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT,
                  //     "fetch failed") is RETHROWN → crashes `streamdeck validate` → CI job fails
  }
}
```

Our manifest declares `"URL": "https://github.com/cluesmith/codev"`
(`com.cluesmith.codev.sdPlugin/manifest.json:10`). `streamdeck validate` does a live
HEAD request to that URL every run. A transient socket error (not ENOTFOUND) is
rethrown unhandled and fails the whole validate step — exactly the observed
`UND_ERR_SOCKET` / `fetch failed` on PRs #1432, #1434, with no code defect.

### Offline fallback verified NOT viable
CLI `--help` empirically checked: `streamdeck validate` has `--no-update-check`
("Disables updating schemas") and `--force-update-check`. But those only gate the
SCHEMA update; they do NOT disable the manifest-URL reachability probe. So offline /
`--no-update-check` would NOT remove this flake. Retry is the correct and only clean fix.
Schemas themselves are bundled locally via `@elgato/schemas`.

### Fix (architect preference: bounded retry with backoff)
Wrap the `streamdeck validate` invocation in a bounded retry (3 attempts, exp backoff),
retrying ONLY on transient/network error signatures; fail fast on real validation errors.
Place a small testable helper `apps/streamdeck/scripts/validate-with-retry.mjs` (mirrors
the existing `scripts/render-action-icons.mjs` + matching vitest test pattern) and point
the `validate` npm script at it. Both CI workflows call `pnpm validate`
(test.yml:113, sdk-canary.yml:57), so this fixes the flake at both sites. Local `package`
script inlines `streamdeck validate` — swap that one call for the helper too (no script
restructuring).

Regression test: simulate a transient failure then success against the retry helper;
fails without retry (single-shot throws), passes with it. Real validation errors must
NOT be retried.

Scope: << 300 LOC. Fits BUGFIX.
