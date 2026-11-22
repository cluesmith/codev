/**
 * Audit a codev root for resolver-bypassing shell reads of framework files by
 * literal path (issue #1011, Layer 3 — regression guard).
 *
 * Used against two roots, for two purposes:
 *   - the framework's `codev-skeleton/` source, in the framework's own CI/unit
 *     test (guards what the package *ships*);
 *   - a project's local `codev/` overrides, by `codev doctor` (guards what the
 *     *user* customizes — the shipped skeleton is the framework's responsibility,
 *     not the end user's).
 *
 * The bug class: a builder-side consumer instructs `cat`/`cp` of a framework
 * doc by literal `codev/...` path. Shell commands bypass the four-tier resolver
 * (`resolveCodevFile`), so the read fails in fresh installs where the file
 * lives only in the embedded skeleton. Framework content is delivered to the
 * builder via the spawn prompt and porch JSON instead — never fetched by shell.
 *
 * Scope is deliberately NARROW to avoid false positives (the skeleton is full
 * of legitimate `codev/...` mentions):
 *   - Only shell-fetch verbs (cat/cp/less/more/head/tail/source) reading a
 *     `codev/protocols/...` or `codev/roles/...` path are flagged.
 *   - `codev/resources/` is NOT scanned: it mixes framework docs with
 *     user-evolved files (`arch.md`, `lessons-learned.md`) that builders and
 *     architects reference and write by path legitimately.
 *   - Plain documentation references (backtick mentions, "see codev/…") are
 *     NOT flagged here. The rule is about *fetching*, not *referencing*. A
 *     reference that reads as "the file is at this path" still sends agents
 *     searching the disk for it (#1910); the framework's own test
 *     `bugfix-1910-framework-paths.test.ts` guards the shipped text for that.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface FrameworkRefFinding {
  /** Path relative to the scanned codev root. */
  file: string;
  line: number;
  /** The offending line, trimmed. */
  text: string;
}

/** Framework subdirectories whose docs ship in the skeleton and resolve via the resolver. */
const FRAMEWORK_DIRS = ['protocols', 'roles'] as const;

/**
 * A shell command that reads/copies a framework file by literal `codev/` path.
 * Matches e.g. `cat codev/protocols/spir/protocol.md`, `cp codev/roles/builder.md x`.
 */
const SHELL_FETCH_RE =
  /(?:^|[\s|;&(])(?:cat|cp|less|more|head|tail|source)\s+codev\/(?:protocols|roles)\/\S+\.md/;

function collectMarkdown(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectMarkdown(full, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
}

/**
 * Scan `<rootDir>/{protocols,roles}` for shell-fetch-by-literal-path violations.
 * `rootDir` is a codev root: the framework's `codev-skeleton/` (CI) or a project's
 * `codev/` (doctor). Returns one finding per offending line; empty when the
 * protocols/roles dirs don't exist (e.g. a project with no local overrides).
 */
export function auditFrameworkRefs(rootDir: string): FrameworkRefFinding[] {
  const findings: FrameworkRefFinding[] = [];
  for (const sub of FRAMEWORK_DIRS) {
    const base = join(rootDir, sub);
    if (!existsSync(base)) continue;
    const files: string[] = [];
    collectMarkdown(base, files);
    for (const file of files) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((text, i) => {
        if (SHELL_FETCH_RE.test(text)) {
          findings.push({ file: relative(rootDir, file), line: i + 1, text: text.trim() });
        }
      });
    }
  }
  return findings;
}

/**
 * Whether the project has any local framework overrides to scan, i.e. a
 * `codev/protocols` or `codev/roles` directory exists. doctor uses this to stay
 * a true no-op (no output) for projects that ship no overrides: an empty audit
 * result alone cannot distinguish "nothing to scan" from "scanned, all clean".
 */
export function hasFrameworkOverrides(codevRoot: string): boolean {
  return FRAMEWORK_DIRS.some((sub) => existsSync(join(codevRoot, sub)));
}

export function formatFrameworkRefFinding(f: FrameworkRefFinding): string {
  return `${f.file}:${f.line} shell-fetches a framework file by literal path: ${f.text}`;
}
