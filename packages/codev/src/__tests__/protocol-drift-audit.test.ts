/**
 * Tests for the protocol-file drift audit (#1210).
 *
 * Strategy: diff project-local copies against the REAL installed skeleton
 * (`getSkeletonDir()`), using a temp workspace root (injectable). A byte-identical
 * copy of a real skeleton file must classify `identical`; a one-byte mutation must
 * classify `differs`. Staleness is exercised via the injectable `fetchLatest` seam
 * (no network).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  auditProtocolDrift,
  hasFrameworkShadows,
  checkSkeletonStaleness,
  formatDriftFinding,
  formatStaleness,
  FRAMEWORK_DRIFT_DIRS,
  type OverrideTier,
} from '../lib/protocol-drift-audit.js';
import { getSkeletonDir, listSkeletonFiles } from '../lib/skeleton.js';
import { version as installedVersion } from '../version.js';

/** Pick a real skeleton `.md` framework file (relative path) to use as the baseline. */
function pickSkeletonMd(): string {
  for (const sub of FRAMEWORK_DRIFT_DIRS) {
    const files = listSkeletonFiles(sub).filter((f) => f.endsWith('.md'));
    if (files.length) return files[0];
  }
  throw new Error('no skeleton framework .md files found — build the skeleton first');
}

/** Read a skeleton file's raw bytes. */
function skeletonBytes(rel: string): Buffer {
  return fs.readFileSync(path.join(getSkeletonDir(), rel));
}

/** Write a project-local copy under a given override tier. */
function writeLocal(root: string, tier: OverrideTier, rel: string, content: Buffer | string): void {
  const p = path.join(root, tier, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe('protocol-drift-audit', () => {
  let root: string;
  let rel: string; // a real skeleton framework file

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'drift-audit-'));
    // A bare codev/ dir so this is recognizably a project root.
    fs.mkdirSync(path.join(root, 'codev'), { recursive: true });
    rel = pickSkeletonMd();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('auditProtocolDrift — shadow classification', () => {
    it('classifies a byte-identical local copy as identical (redundant)', () => {
      writeLocal(root, 'codev', rel, skeletonBytes(rel));
      const findings = auditProtocolDrift(root);
      const f = findings.find((x) => x.relativePath === rel && x.tier === 'codev');
      expect(f).toBeDefined();
      expect(f!.status).toBe('identical');
      expect(f!.isResolvedWinner).toBe(true);
    });

    it('classifies a differing local copy as differs', () => {
      writeLocal(root, 'codev', rel, Buffer.concat([skeletonBytes(rel), Buffer.from('\nDRIFT\n')]));
      const findings = auditProtocolDrift(root);
      const f = findings.find((x) => x.relativePath === rel && x.tier === 'codev');
      expect(f).toBeDefined();
      expect(f!.status).toBe('differs');
    });

    it('emits no finding for a skeleton file with no local copy', () => {
      // Fresh root with only a different local copy present → the untouched file has no finding.
      const findings = auditProtocolDrift(root);
      expect(findings.find((x) => x.relativePath === rel)).toBeUndefined();
      expect(findings).toHaveLength(0);
    });

    it('detects a tier-1 .codev copy the same as a codev copy', () => {
      writeLocal(root, '.codev', rel, Buffer.concat([skeletonBytes(rel), Buffer.from('X')]));
      const findings = auditProtocolDrift(root);
      const f = findings.find((x) => x.relativePath === rel && x.tier === '.codev');
      expect(f).toBeDefined();
      expect(f!.status).toBe('differs');
      expect(f!.isResolvedWinner).toBe(true); // .codev wins resolution
    });

    it('reports BOTH tiers when a file exists in .codev and codev, marking .codev the winner', () => {
      writeLocal(root, '.codev', rel, Buffer.concat([skeletonBytes(rel), Buffer.from('A')]));
      writeLocal(root, 'codev', rel, Buffer.concat([skeletonBytes(rel), Buffer.from('B')]));
      const findings = auditProtocolDrift(root).filter((x) => x.relativePath === rel);
      expect(findings).toHaveLength(2);
      const dotCodev = findings.find((x) => x.tier === '.codev')!;
      const codev = findings.find((x) => x.tier === 'codev')!;
      expect(dotCodev.isResolvedWinner).toBe(true);
      expect(codev.isResolvedWinner).toBe(false); // shadowed by .codev, but still reported (still rot)
    });

    it('does NOT scan codev/resources (user-evolved files)', () => {
      const resourcePath = path.join(root, 'codev', 'resources', 'arch.md');
      fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
      fs.writeFileSync(resourcePath, 'heavily customized arch doc');
      const findings = auditProtocolDrift(root);
      expect(findings.some((x) => x.relativePath.startsWith('resources'))).toBe(false);
    });

    it('classifies an EOL-only difference as differs (conservative raw-byte compare)', () => {
      const crlf = skeletonBytes(rel).toString('utf-8').replace(/\n/g, '\r\n');
      writeLocal(root, 'codev', rel, crlf);
      const f = auditProtocolDrift(root).find((x) => x.relativePath === rel);
      // Only meaningful if the file actually contained a newline to convert.
      if (skeletonBytes(rel).includes(0x0a)) {
        expect(f!.status).toBe('differs');
      }
    });
  });

  describe('hasFrameworkShadows — no-op gate over both tiers', () => {
    it('is false when the project has no local framework copies', () => {
      expect(hasFrameworkShadows(root)).toBe(false);
    });

    it('is true for a tier-2 codev copy', () => {
      writeLocal(root, 'codev', rel, skeletonBytes(rel));
      expect(hasFrameworkShadows(root)).toBe(true);
    });

    it('is true for a tier-1 .codev copy (which hasLocalOverride would miss)', () => {
      writeLocal(root, '.codev', rel, skeletonBytes(rel));
      expect(hasFrameworkShadows(root)).toBe(true);
    });
  });

  describe('checkSkeletonStaleness', () => {
    it('reports behind when installed < latest', () => {
      const bumped = installedVersion.replace(/^(\d+)\.(\d+)\.(\d+)/, (_m, a, b, c) => `${a}.${b}.${Number(c) + 1}`);
      const s = checkSkeletonStaleness(() => bumped);
      expect(s.installed).toBe(installedVersion);
      expect(s.latest).toBe(bumped);
      expect(s.behind).toBe(true);
    });

    it('reports not-behind when installed === latest', () => {
      const s = checkSkeletonStaleness(() => installedVersion);
      expect(s.behind).toBe(false);
      expect(s.latest).toBe(installedVersion);
    });

    it('is offline-tolerant when latest cannot be fetched (null)', () => {
      const s = checkSkeletonStaleness(() => null);
      expect(s.latest).toBeNull();
      expect(s.behind).toBe(false);
      expect(s.note).toMatch(/offline|could not check/i);
    });

    it('never throws even if the fetcher throws', () => {
      const s = checkSkeletonStaleness(() => {
        throw new Error('network down');
      });
      expect(s.latest).toBeNull();
      expect(s.behind).toBe(false);
    });
  });

  describe('formatters', () => {
    it('names the skeleton version in a differs line', () => {
      const line = formatDriftFinding(
        { relativePath: rel, tier: 'codev', status: 'differs', isResolvedWinner: true },
        '9.9.9',
      );
      expect(line).toContain('v9.9.9');
      expect(line).toContain('adjudicate');
      expect(line).toContain('[resolved');
    });

    it('marks an identical line as safe to remove', () => {
      const line = formatDriftFinding(
        { relativePath: rel, tier: 'codev', status: 'identical', isResolvedWinner: true },
        '9.9.9',
      );
      expect(line).toContain('safe to remove');
    });

    it('renders staleness states explicitly', () => {
      expect(formatStaleness({ installed: '1.0.0', latest: '1.0.1', behind: true })).toContain('behind');
      expect(formatStaleness({ installed: '1.0.0', latest: '1.0.0', behind: false })).toContain('up to date');
      expect(
        formatStaleness({ installed: '1.0.0', latest: null, behind: false, note: 'could not check (offline?)' }),
      ).toContain('could not check');
    });
  });

  describe('safety & integrity', () => {
    it('performs no writes — skeleton and local copies are unchanged after an audit', () => {
      writeLocal(root, 'codev', rel, skeletonBytes(rel));
      const localPath = path.join(root, 'codev', rel);
      const beforeLocal = sha(fs.readFileSync(localPath));
      const beforeSkeleton = sha(skeletonBytes(rel));
      auditProtocolDrift(root);
      hasFrameworkShadows(root);
      expect(sha(fs.readFileSync(localPath))).toBe(beforeLocal);
      expect(sha(skeletonBytes(rel))).toBe(beforeSkeleton);
    });

    it('every scan-set dir exists in the installed skeleton', () => {
      for (const sub of FRAMEWORK_DRIFT_DIRS) {
        expect(fs.existsSync(path.join(getSkeletonDir(), sub))).toBe(true);
      }
    });
  });
});
