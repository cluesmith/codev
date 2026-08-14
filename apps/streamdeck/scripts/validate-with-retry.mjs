// Run `streamdeck validate` with a bounded retry + backoff around transient network errors (#1436).
//
// WHY: the Elgato CLI's `manifestUrlsExist` validation rule does a live HEAD request to the
// manifest's top-level `URL` (ours is https://github.com/cluesmith/codev). Its catch block turns
// only `ENOTFOUND` into a graceful validation error; ANY other fetch failure (UND_ERR_SOCKET,
// ECONNRESET, "fetch failed", …) is rethrown and crashes the whole `validate` run. That put the
// network on CI's pass/fail path and flaked unrelated PRs (#1432, #1434) with no code defect.
//
// FIX: retry the WHOLE validate command a few times with exponential backoff, but ONLY when the
// failure output matches a transient-network signature. Real validation errors fail fast on the
// first attempt (no masking, no wasted backoff). `--no-update-check` does NOT help here — it only
// gates the separate schema-update fetch, not this URL-reachability probe.
//
// The retry core is exported and unit-tested (see src/__tests__/validate-with-retry.test.ts);
// `main()` only wires it to the real child process. Mirrors scripts/render-action-icons.mjs.

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = 'com.cluesmith.codev.sdPlugin';

// Case-insensitive signatures of a transient network failure worth retrying. These are the
// error shapes the CLI rethrows from a failed `fetch(URL, { method: 'HEAD' })`. Each is a specific
// error code/phrase, not a loose word, so a plugin description that merely mentions "network"
// can't trigger a false retry.
//
// EAI_AGAIN (temporary DNS failure) IS here but ENOTFOUND (permanent "host doesn't exist") is
// NOT — and that asymmetry is deliberate: the CLI already converts ENOTFOUND into a graceful
// "must be resolvable" validation error rather than rethrowing it, so a genuinely bad URL fails
// loudly on attempt 1, while a transient DNS blip retries.
export const TRANSIENT_SIGNATURES = [
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'fetch failed',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'socket hang up',
];

export const DEFAULTS = { attempts: 3, baseBackoffMs: 1000 };

/** Does this combined stdout+stderr look like a transient network failure? */
export function isTransientError(output) {
  const haystack = String(output ?? '').toLowerCase();
  return TRANSIENT_SIGNATURES.some((sig) => haystack.includes(sig.toLowerCase()));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bounded retry loop. `run()` resolves to { code, output }. We retry only when a non-zero result
 * is transient AND attempts remain; otherwise we return the last result (fail fast on real
 * errors, and still surface the failure after exhausting transient retries). Injectable `run`,
 * `sleep`, and `log` keep this deterministic under test.
 */
export async function runWithRetry({
  run,
  attempts = DEFAULTS.attempts,
  baseBackoffMs = DEFAULTS.baseBackoffMs,
  isTransient = isTransientError,
  sleep = defaultSleep,
  log = () => {},
} = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await run(attempt);
    if (last.code === 0) {
      return { ...last, attempts: attempt };
    }
    const transient = isTransient(last.output);
    const hasMore = attempt < attempts;
    if (!transient || !hasMore) {
      return { ...last, attempts: attempt };
    }
    const backoff = baseBackoffMs * 2 ** (attempt - 1);
    log(
      `streamdeck validate: transient network error on attempt ${attempt}/${attempts}; ` +
        `retrying in ${backoff}ms…`,
    );
    await sleep(backoff);
  }
  return { ...last, attempts };
}

/** Spawn `streamdeck validate <plugin>` once, capturing combined output. */
function runValidateOnce() {
  return new Promise((resolve) => {
    const child = execFile(
      'streamdeck',
      ['validate', PLUGIN_DIR],
      { cwd: join(HERE, '..'), encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        let output = `${stdout ?? ''}${stderr ?? ''}`;
        // A spawn failure (e.g. the CLI isn't on PATH) yields empty stdio; surface the error
        // message so CI shows *why* rather than an exit 1 with no diagnostic. ENOENT and the like
        // aren't in TRANSIENT_SIGNATURES, so appending it won't trigger a spurious retry.
        if (error && output.trim() === '') {
          output = `${error.message}\n`;
        }
        resolve({ code: error ? (error.code ?? 1) : 0, output });
      },
    );
    // The execFile callback already receives spawn errors; this handler just prevents an
    // unhandled 'error' event from crashing the process before the callback resolves.
    child.on('error', () => {});
  });
}

async function main() {
  const result = await runWithRetry({ run: runValidateOnce, log: (m) => console.warn(m) });
  process.stdout.write(result.output);
  process.exit(result.code === 0 ? 0 : 1);
}

// Only run when invoked as a script, not when imported by the test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
