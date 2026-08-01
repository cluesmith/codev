/**
 * Guarded real-`agy` integration smoke for the gemini consult lane (Phase 1, #778).
 *
 * Runs the REAL Antigravity CLI (this file deliberately does NOT mock
 * node:child_process). When agy is unavailable or unauthenticated (e.g. CI),
 * the lane's non-blocking COMMENT skip is detected and the assertion is bypassed
 * — so the test is a no-op there rather than a failure. When agy is installed
 * and signed in, it provides real acceptance evidence that `consult -m gemini`
 * (agy backend) returns a review that actually used file contents.
 *
 * OPT-IN ONLY (#1323). This file is the one place in the suites that means to
 * spawn the real binary, and a real spawn against a lapsed agy login opens a
 * browser window per invocation. Without the opt-in the vitest harness pins a
 * fake agy, which would make these assertions meaningless anyway, so every case
 * no-ops instead:
 *
 *   CODEV_ALLOW_REAL_AGY=1 pnpm --filter @cluesmith/codev test:e2e:cli
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveAgyBin, _runAgyConsultation } from '../../commands/consult/index.js';
import { realAgyOptIn } from '../../lib/test-env.js';
import { CONSULT_BIN } from './helpers.js';

/** A review file is the non-blocking skip artifact (agy unavailable/unauthed/timeout). */
function isSkip(out: string): boolean {
  return out.includes('VERDICT: COMMENT') && /Skipped/i.test(out);
}

/** True when a real, usable agy is available AND the suite is allowed to spawn it. */
function realAgyAvailable(): boolean {
  return realAgyOptIn() && Boolean(resolveAgyBin());
}

describe('agy lane integration (guarded; real agy)', () => {
  it('delivers the complete inline prompt under the agy 1.0.10 argument contract', async () => {
    if (!realAgyAvailable()) return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-print-contract-'));
    try {
      const marker = `PRINT_CONTRACT_${Date.now()}`;
      const outputPath = path.join(dir, 'review.txt');
      await _runAgyConsultation(
        `Reply with exactly: ${marker}`,
        'Follow the response format exactly.',
        dir,
        outputPath,
      );

      const out = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';
      if (isSkip(out)) return;
      expect(out).toContain(marker);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('returns a review that used file contents, or skips non-blockingly', async () => {
    if (!realAgyAvailable()) {
      // agy CLI not installed, or the real-agy opt-in is off — nothing to verify.
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-integ-'));
    try {
      const marker = `PLANTED_${Date.now()}`;
      fs.writeFileSync(path.join(dir, 'planted.txt'), `The codeword is ${marker}.\n`);
      const outputPath = path.join(dir, 'review.txt');

      await _runAgyConsultation(
        'Read the file planted.txt in this directory and reply with ONLY the codeword it contains.',
        'You are a terse reviewer.',
        dir,
        outputPath,
      );

      const out = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';
      if (isSkip(out)) {
        // agy unavailable/unauthenticated here — the non-blocking skip is the
        // correct behavior; no further assertion in this environment.
        return;
      }

      // Authed run: the review must reflect the file's contents (agentic reading).
      expect(out).toContain(marker);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000); // generous: real agy network round-trip

  // Front-door coverage: exercise the actual `consult -m gemini` CLI (not the
  // internal runAgyConsultation), so the whole dispatch path is proven —
  // arg parsing → model alias/MODEL_CONFIGS resolution → runAgyConsultation →
  // agy. Guarded the same way: a missing/unauthed agy yields the non-blocking
  // skip and the assertion is bypassed.
  it('`consult -m gemini --prompt` (real binary) reads files or skips non-blockingly', async () => {
    if (!realAgyAvailable() || !fs.existsSync(CONSULT_BIN)) {
      // agy not installed / opt-in off, or the CLI hasn't been built — nothing to verify.
      return;
    }

    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-frontdoor-')));
    try {
      // Make the temp dir a workspace root so findWorkspaceRoot() resolves here
      // and agy's --add-dir grants read access to the planted file.
      execFileSync('git', ['init', '-q'], { cwd: dir });
      const marker = `FRONTDOOR_${Date.now()}`;
      fs.writeFileSync(path.join(dir, 'planted.txt'), `The codeword is ${marker}.\n`);
      const outputPath = path.join(dir, 'review.txt');

      // Drive the built consult CLI directly — the genuine `-m gemini` front door.
      // Alias is also covered by passing the canonical id; resolution is unit-tested.
      execFileSync(
        'node',
        [
          CONSULT_BIN,
          '-m', 'gemini',
          '--prompt', 'Read the file planted.txt in this directory and reply with ONLY the codeword it contains.',
          '--output', outputPath,
        ],
        { cwd: dir, env: { ...process.env, HOME: path.join(dir, 'home') }, stdio: 'pipe', timeout: 150_000 },
      );

      const out = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';
      if (isSkip(out)) return; // non-blocking skip — correct when agy is unavailable
      expect(out).toContain(marker);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000); // real agy round-trip via a freshly-spawned node CLI process
});
