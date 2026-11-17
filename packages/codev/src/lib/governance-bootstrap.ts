/**
 * Governance-doc bootstrap: the deterministic half (Spec 1797).
 *
 * `codev bootstrap-docs` hands the drafting of the four governance files to an agent, but
 * every judgement that must be repeatable lives here, as pure functions:
 *
 * - which files are still untouched starters (and so may be rewritten),
 * - whether the project holds anything to document at all,
 * - whether a draft respects the hot-tier cap and points its map at real cold sections.
 *
 * The hot-cap and map rules are the same ones `hot-tier.test.ts` enforces on our own files;
 * that test imports them from here so there is one definition.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOT_TIER_FILES, COLD_TIER_FILES } from './scaffold.js';
import { isIgnored, readRootIgnore, type IgnoreRule } from './tree-snapshot.js';

// =============================================================================
// The four files
// =============================================================================

export type GovernanceKind = 'hot' | 'cold';

export interface GovernanceFile {
  /** File name under `codev/resources/`. */
  name: string;
  kind: GovernanceKind;
  /** Starter file name under the skeleton's `templates/`. */
  starter: string;
  /** For a hot file, the cold doc its map points into. */
  coldDoc?: string;
}

export const GOVERNANCE_FILES: readonly GovernanceFile[] = [
  { name: HOT_TIER_FILES[0], kind: 'hot', starter: HOT_TIER_FILES[0], coldDoc: COLD_TIER_FILES[0].dest },
  { name: HOT_TIER_FILES[1], kind: 'hot', starter: HOT_TIER_FILES[1], coldDoc: COLD_TIER_FILES[1].dest },
  { name: COLD_TIER_FILES[0].dest, kind: 'cold', starter: COLD_TIER_FILES[0].src },
  { name: COLD_TIER_FILES[1].dest, kind: 'cold', starter: COLD_TIER_FILES[1].src },
];

/**
 * Earlier shipped starter texts, keyed by destination file name.
 *
 * The cold starters gained their `<!-- STARTER: … -->` comment in 9fa9c2316; before that
 * (8ef441cc2, and the inline constants it replaced) they were the same lines without the
 * comment. The hot starters have had a single version since 1a8c63b27.
 */
const EARLIER_STARTERS: Record<string, string[]> = {
  'arch.md': [
    '# Architecture\n\n' +
      'This document evolves as the project grows. Update it during the review phase of any work that introduces or changes architectural patterns.\n\n' +
      '_No architecture documented yet._\n',
  ],
  'lessons-learned.md': [
    '# Lessons Learned\n\n' +
      "Durable engineering wisdom captured across the project's work. Update it during the review phase of any work that surfaces a generally-applicable pattern, gotcha, or constraint.\n\n" +
      '_No lessons captured yet._\n',
  ],
};

/**
 * Every starter text ever shipped for `file`: the current skeleton starter first.
 *
 * Throws when the current starter is absent: with no starters every file would classify
 * as curated, and a mis-resolved templates directory would pass for a legitimate no-op.
 */
export function knownStarterTexts(file: GovernanceFile, templatesDir: string): string[] {
  const current = path.join(templatesDir, file.starter);
  if (!fs.existsSync(current)) {
    throw new Error(`Governance starter not found: ${current}`);
  }
  return [fs.readFileSync(current, 'utf-8'), ...(EARLIER_STARTERS[file.name] ?? [])];
}

// =============================================================================
// Placeholder classification
// =============================================================================

export type GovernanceClass = 'missing' | 'placeholder' | 'curated';

// A `- <…>` slot; a bullet that opens with a markdown autolink (`- <https://…>`) is content.
const SLOT_LINE = /^- <(?!(?:https?|mailto):)[^>]+>/;
const NOTHING_YET_LINE = /^_No .+ yet\._$/;

/**
 * A line that only a starter carries: a `- <…>` slot, `_No … yet._`, or `STARTER:` text.
 * Surrounding whitespace is ignored, so re-indenting or padding a marker does not hide it
 * from the validator.
 */
export function isStarterMarker(line: string): boolean {
  const trimmed = line.trim();
  return SLOT_LINE.test(trimmed) || NOTHING_YET_LINE.test(trimmed) || trimmed.includes('STARTER:');
}

function toLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').split('\n');
}

/**
 * Classify a governance file as an untouched starter (`placeholder`, eligible for the
 * bootstrap to rewrite) or anything else (`curated`).
 *
 * Placeholder iff some ONE starter version contains every non-blank line verbatim, and at
 * least one starter marker survives. Lines are compared exactly (only CRLF is normalised,
 * so an autocrlf checkout is not misread); a line mixed in from another version, an edited
 * slot, an added line, or a starter with every marker deleted all mean someone touched it,
 * and every doubt resolves to `curated`.
 */
export function classifyGovernanceFile(content: string | null, starters: string[]): GovernanceClass {
  if (content === null) return 'missing';

  const lines = toLines(content).filter(line => line.trim() !== '');
  if (!lines.some(isStarterMarker)) return 'curated';

  const fromOneStarter = starters.some(starter => {
    const starterLines = new Set(toLines(starter));
    return lines.every(line => starterLines.has(line));
  });
  if (fromOneStarter) return 'placeholder';
  return 'curated';
}

/**
 * The first directory on the way to `relPath` (relative to `root`, the file itself
 * excluded) that exists but is not a real directory, described for a report (`a symlinked
 * codev/`), else undefined. A missing directory is not irregular: it is simply created.
 */
export function irregularAncestor(root: string, relPath: string): string | undefined {
  const parts = relPath.split(/[\\/]/).slice(0, -1);
  let current = '';
  for (const part of parts) {
    current = current === '' ? part : `${current}/${part}`;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(path.join(root, current));
    } catch {
      return undefined;
    }
    if (stat.isSymbolicLink()) return `a symlinked ${current}/`;
    if (!stat.isDirectory()) return `${current}, which is not a directory`;
  }
  return undefined;
}

/**
 * What a governance path is when it is not a regular file (`a symlink`, `not a regular
 * file`), else undefined. Read with lstat, never through the link: change detection hashes
 * a symlink by its target, so a write through the link would go unseen.
 */
export function governancePathKind(root: string, file: GovernanceFile): string | undefined {
  // A symlinked `codev/` or `codev/resources/` would carry every write, and every read,
  // outside the project just as surely as a symlinked file.
  const ancestor = irregularAncestor(root, path.join('codev', 'resources', file.name));
  if (ancestor !== undefined) return `inside ${ancestor}`;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(path.join(root, 'codev', 'resources', file.name));
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink()) return 'a symlink';
  if (!stat.isFile()) return 'not a regular file';
  return undefined;
}

/**
 * Read and classify one governance file of the project at `root`. A symlink or any other
 * non-regular path is `curated`: it is never rewritten, whatever it points at.
 */
export function classifyProjectFile(root: string, file: GovernanceFile, templatesDir: string): GovernanceClass {
  const starters = knownStarterTexts(file, templatesDir);
  const filePath = path.join(root, 'codev', 'resources', file.name);
  if (governancePathKind(root, file) !== undefined) return 'curated';
  let content: string | null = null;
  if (fs.existsSync(filePath)) content = fs.readFileSync(filePath, 'utf-8');
  return classifyGovernanceFile(content, starters);
}

export interface GovernanceStatus {
  file: GovernanceFile;
  class: GovernanceClass;
  /** Set when the path is not a regular file (`a symlink`); such a path is never eligible. */
  pathKind?: string;
  /** Why a placeholder is not rewritten this run (its paired cold doc is missing). */
  heldBack?: string;
}

/**
 * Classify all four governance files of the project at `root`.
 *
 * A hot map is built from its cold doc's sections; with the cold doc missing there is
 * nothing to build it from, so that hot placeholder is held back until `codev update`
 * restores the cold starter.
 */
export function classifyProjectGovernance(root: string, templatesDir: string): GovernanceStatus[] {
  const statuses: GovernanceStatus[] = GOVERNANCE_FILES.map(file => {
    const status: GovernanceStatus = { file, class: classifyProjectFile(root, file, templatesDir) };
    const pathKind = governancePathKind(root, file);
    if (pathKind !== undefined) status.pathKind = pathKind;
    return status;
  });
  for (const status of statuses) {
    if (status.class !== 'placeholder' || !status.file.coldDoc) continue;
    const cold = statuses.find(other => other.file.name === status.file.coldDoc);
    if (cold?.class === 'missing') status.heldBack = `${status.file.coldDoc} is missing`;
  }
  return statuses;
}

/** The files a bootstrap pass may rewrite: untouched starters that are not held back. */
export function bootstrapEligibleFiles(statuses: readonly GovernanceStatus[]): GovernanceFile[] {
  return statuses.filter(status => status.class === 'placeholder' && !status.heldBack).map(status => status.file);
}

/**
 * Whether `codev bootstrap-docs` has work to do at `root`: some governance file is still an
 * eligible starter and the project holds something to document. Adopt and update use this
 * to decide whether to offer or mention the pass.
 */
export function shouldOfferBootstrap(root: string, templatesDir: string): boolean {
  let statuses: GovernanceStatus[];
  try {
    statuses = classifyProjectGovernance(root, templatesDir);
  } catch {
    // A starter missing from the installed package: `codev bootstrap-docs` reports that
    // loudly; an offer or a hint must not fail adopt or update over it.
    return false;
  }
  if (bootstrapEligibleFiles(statuses).length === 0) return false;
  return isNonEmptyRepo(root);
}

// =============================================================================
// Non-empty repository
// =============================================================================

/** Top-level directories and root files Codev itself generates; they are not the project. */
const CODEV_GENERATED_DIRS = ['codev', '.codev', '.claude', '.codex'];
const CODEV_GENERATED_FILES = ['CLAUDE.md', 'AGENTS.md', '.gitignore'];

function isCodevGenerated(relPath: string): boolean {
  const normalized = relPath.split(path.sep).join('/');
  const first = normalized.split('/')[0];
  if (CODEV_GENERATED_DIRS.includes(first)) return true;
  if (CODEV_GENERATED_FILES.includes(normalized)) return true;
  return normalized.endsWith('.codev-new');
}

function isGitWorkTree(root: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Whether the project at `root` holds anything beyond what Codev generated.
 *
 * In a git work tree: any tracked or untracked-but-not-ignored path (submodule gitlinks
 * included) outside the Codev-generated set. Outside git: a filesystem walk honouring the
 * root `.gitignore` and the same exclusions.
 */
export function isNonEmptyRepo(root: string): boolean {
  if (isGitWorkTree(root)) {
    try {
      const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 256 * 1024 * 1024,
      });
      return out.split('\0').some(rel => rel !== '' && !isCodevGenerated(rel));
    } catch {
      // git present but unable to list (corrupt index, huge tree): judge from the filesystem.
    }
  }
  return walkFindsProjectFile(root, readRootIgnore(root));
}

function walkFindsProjectFile(root: string, rules: IgnoreRule[], dir = ''): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    // An unreadable directory holds nothing we can see; keep walking the rest.
    return false;
  }
  for (const entry of entries) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.name === '.git' || isCodevGenerated(rel)) continue;
    if (isIgnored(rel, entry.isDirectory(), rules)) continue;
    if (entry.isDirectory()) {
      if (walkFindsProjectFile(root, rules, rel)) return true;
    } else {
      return true;
    }
  }
  return false;
}

// =============================================================================
// Hot cap and map rules (shared with hot-tier.test.ts)
// =============================================================================

export const HOT_CAP_LINES = 35;
export const HOT_CAP_ENTRIES = 10;
export const HOT_CAP_MAP_TOPICS = 12;

/** `- ` entries under the `## <headingPrefix>…` section, up to the next `## `. */
/**
 * Whether a `## ` heading text is the section `name` itself: exactly `name`, or `name`
 * followed by a parenthetical (`Critical facts (consult before deciding)`). Unlike a
 * prefix test, `Critical facts appendix` is not `Critical facts`.
 */
export function isSectionHeading(heading: string, name: string): boolean {
  return heading === name || heading.startsWith(`${name} (`);
}

/**
 * Bullets under every `## ` heading starting with `headingPrefix`, or with `exact`, under
 * the section `headingPrefix` names exactly (`isSectionHeading`).
 */
export function bulletsUnder(content: string, headingPrefix: string, exact = false): string[] {
  let inSection = false;
  const bullets: string[] = [];
  for (const line of toLines(content)) {
    if (line.startsWith('## ')) {
      if (exact) {
        inSection = isSectionHeading(line.slice(3).trim(), headingPrefix);
      } else {
        inSection = line.startsWith(`## ${headingPrefix}`);
      }
    } else if (inSection && line.startsWith('- ')) {
      bullets.push(line);
    }
  }
  return bullets;
}

/** Top-level `## ` heading texts of a markdown doc. */
export function topLevelHeadings(content: string): string[] {
  return toLines(content)
    .filter(line => line.startsWith('## '))
    .map(line => line.slice(3).trim());
}

/** Separators between a map topic and its `consult when…` guidance, em dash first. */
const MAP_SEPARATORS = [' — ', ' – ', ' - '];

/** The topic each map entry points at: its text before the `consult when…` guidance. */
export function mapTopics(content: string, headingPrefix = 'Map', exact = false): string[] {
  return bulletsUnder(content, headingPrefix, exact).map(line => {
    const entry = line.slice(2);
    const cuts = MAP_SEPARATORS.map(sep => entry.indexOf(sep)).filter(index => index >= 0);
    if (cuts.length === 0) return entry.trim();
    return entry.slice(0, Math.min(...cuts)).trim();
  });
}

/**
 * The cold-doc headings a map topic names: an exact heading, or one it is a word-boundary
 * prefix of (so `Critical` names `Critical (Prevent Major Failures)`). An exact match wins,
 * so `Data` still names `## Data` alone when `## Data Flow` also exists. A valid topic
 * names exactly one.
 */
export function sectionsNamedBy(topic: string, headings: string[]): string[] {
  if (headings.includes(topic)) return [topic];
  return headings.filter(heading => heading.startsWith(`${topic} `));
}

/** Lines that count toward the hot cap: everything outside HTML comments. */
export function nonCommentLineCount(content: string): number {
  // A comment occupying whole lines removes those lines entirely (not one blank in their
  // place); an inline comment only removes itself.
  const body = content
    .replace(/\r\n/g, '\n')
    .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*(?:\n|$)/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const lines = body.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

// =============================================================================
// Validation
// =============================================================================

export type ViolationKind =
  | 'leftover-marker'
  | 'missing-section'
  | 'empty-section'
  | 'too-many-entries'
  | 'too-many-map-topics'
  | 'too-many-lines'
  | 'unknown-map-section'
  | 'ambiguous-map-section'
  | 'unmapped-section'
  | 'too-many-cold-sections'
  | 'missing-guidance'
  | 'not-regular';

export interface Violation {
  kind: ViolationKind;
  message: string;
}

export interface HotValidation {
  violations: Violation[];
  /** Cold sections the map does not name; a violation only when the cold doc has ≤12. */
  unmappedSections: string[];
}

function leftoverMarkers(content: string): Violation[] {
  return toLines(content)
    .filter(isStarterMarker)
    .map(line => ({ kind: 'leftover-marker' as const, message: `starter text left in place: ${line.trim()}` }));
}

/** The `## Critical …` section name for a hot file kind. */
function entriesHeading(file: GovernanceFile): string {
  if (file.name === 'lessons-critical.md') return 'Critical lessons';
  return 'Critical facts';
}

/**
 * The lines of a hot starter's guidance comment a bootstrapped draft must keep: every line
 * of the starter's first HTML comment except the one carrying the `STARTER:` sentence.
 */
export function guidanceCommentLines(starter: string): string[] {
  const lines = toLines(starter).map(line => line.trim());
  const start = lines.findIndex(line => line.startsWith('<!--'));
  if (start === -1) return [];
  const end = lines.findIndex((line, i) => i >= start && line.includes('-->'));
  const comment = lines.slice(start, end === -1 ? lines.length : end + 1);
  return comment.filter(line => line !== '' && !line.includes('STARTER:'));
}

/**
 * Check a drafted hot file: no starter text, both sections present and non-empty, the cap
 * (per section, comment lines excluded), and every map topic naming exactly one real cold
 * section. Given the file's starter, also check the draft kept the starter's guidance
 * comment (the cap and displacement rules for whoever edits the file next).
 */
export function validateHotFile(
  content: string,
  coldContent: string,
  file: GovernanceFile,
  starter?: string,
): HotValidation {
  const violations = leftoverMarkers(content);

  if (starter !== undefined) {
    // Where the closing `-->` lands (own line, or the end of the last kept line) is free.
    const unclosed = (line: string): string => line.trim().replace(/\s*-->$/, '');
    const kept = new Set(toLines(content).map(unclosed));
    const dropped = guidanceCommentLines(starter).filter(line => !kept.has(unclosed(line)));
    if (dropped.length > 0) {
      violations.push({ kind: 'missing-guidance', message: `the starter's guidance comment was dropped or edited: ${dropped[0]}` });
    }
  }

  const heading = entriesHeading(file);
  const mapHeading = `Map of ${file.coldDoc}`;
  const hasEntries = topLevelHeadings(content).some(h => isSectionHeading(h, heading));
  const hasMap = topLevelHeadings(content).some(h => isSectionHeading(h, mapHeading));
  if (!hasEntries) violations.push({ kind: 'missing-section', message: `missing "## ${heading}" section` });
  if (!hasMap) violations.push({ kind: 'missing-section', message: `missing "## Map of ${file.coldDoc}" section` });

  // Count only the required sections, so a similarly named extra section ("## Critical
  // notes", "## Mapping") can neither fill an empty one nor dodge the caps.
  const entries = bulletsUnder(content, heading, true).length;
  const topics = mapTopics(content, mapHeading, true);
  // A heading with nothing under it is a draft that was never filled in, not a pass.
  if (hasEntries && entries === 0) {
    violations.push({ kind: 'empty-section', message: `"## ${heading}" has no entries` });
  }
  if (hasMap && topics.length === 0) {
    violations.push({ kind: 'empty-section', message: `"## Map of ${file.coldDoc}" has no entries` });
  }
  if (entries > HOT_CAP_ENTRIES) {
    violations.push({ kind: 'too-many-entries', message: `${entries} entries under "${heading}" (cap ${HOT_CAP_ENTRIES})` });
  }
  if (topics.length > HOT_CAP_MAP_TOPICS) {
    violations.push({ kind: 'too-many-map-topics', message: `${topics.length} map entries (cap ${HOT_CAP_MAP_TOPICS})` });
  }
  const lines = nonCommentLineCount(content);
  if (lines > HOT_CAP_LINES) {
    violations.push({ kind: 'too-many-lines', message: `${lines} lines outside comments (cap ${HOT_CAP_LINES})` });
  }

  const headings = topLevelHeadings(coldContent);
  const mapped = new Set<string>();
  for (const topic of topics) {
    const named = sectionsNamedBy(topic, headings);
    if (named.length === 0) {
      violations.push({ kind: 'unknown-map-section', message: `map entry "${topic}" names no "## " section of ${file.coldDoc}` });
    } else if (named.length > 1) {
      violations.push({ kind: 'ambiguous-map-section', message: `map entry "${topic}" matches several sections of ${file.coldDoc}: ${named.join(', ')}` });
    } else {
      mapped.add(named[0]);
    }
  }

  const unmappedSections = headings.filter(h => !mapped.has(h));
  if (headings.length <= HOT_CAP_MAP_TOPICS) {
    for (const section of unmappedSections) {
      violations.push({ kind: 'unmapped-section', message: `${file.coldDoc} section "${section}" is missing from the map` });
    }
  }

  return { violations, unmappedSections };
}

/**
 * Check a drafted cold file: no starter text, and — for a file the bootstrap itself wrote —
 * between 1 and 12 top-level sections, so its hot map has something to cover and can cover
 * all of it.
 */
export function validateColdFile(content: string, writtenByBootstrap: boolean): Violation[] {
  const violations = leftoverMarkers(content);
  const sections = topLevelHeadings(content).length;
  if (writtenByBootstrap && sections === 0) {
    violations.push({ kind: 'empty-section', message: 'no top-level "## " sections for a hot map to point at' });
  }
  if (writtenByBootstrap && sections > HOT_CAP_MAP_TOPICS) {
    violations.push({ kind: 'too-many-cold-sections', message: `${sections} top-level sections (keep to ${HOT_CAP_MAP_TOPICS} so the map can cover them)` });
  }
  return violations;
}
