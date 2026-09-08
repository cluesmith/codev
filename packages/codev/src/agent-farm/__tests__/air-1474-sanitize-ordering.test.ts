/**
 * The capture harness's sanitizer must refuse BEFORE it writes (#1474 review).
 *
 * `codev/air-1474-captures/sanitize.py` redacts the account email and cwd out of a real agy
 * PTY capture before it is committed as a fixture. Its first version wrote the output file and
 * then checked for leaks, so a capture that still carried an identifier landed on disk and the
 * "REFUSING to sanitize" message was false by the time it printed — `git add` could reach the
 * unsafe file in the window between the two. The ordering is now check-then-write.
 *
 * That guarantee is worth nothing asserted in a comment, so the script carries a `--selftest`
 * that stubs out the redaction, runs a leaking capture through, and stats the output path to
 * prove no file was created. This test is what makes CI run it. The rest of the harness
 * deliberately does not run in CI (it needs an authenticated `agy` and a PTY); this does,
 * because it is the one part whose failure mode is committing someone's username.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SANITIZE = fileURLToPath(
  new URL('../../../../../codev/air-1474-captures/sanitize.py', import.meta.url)
);

/** python3 is present on every GitHub runner; a dev box without it skips rather than fails. */
const hasPython = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

describe('air-1474 capture harness — sanitize.py refuses before writing', () => {
  it.runIf(hasPython)('passes its own selftest (leak ⇒ no file on disk)', () => {
    const run = spawnSync('python3', [SANITIZE, '--selftest'], { encoding: 'utf8' });
    // On failure surface the script's own output — the assertion messages inside the selftest
    // name which property broke, which a bare exit code would throw away.
    expect(`${run.stdout}${run.stderr}`.trim(), `${run.stdout}${run.stderr}`).toContain('selftest: ok');
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  });
});
