/**
 * prompt-ownership.ts — the machine-readable ownership map and its
 * completeness machinery (Spec 1252, M1/M4 — Appendix A).
 *
 * The single-owner rule: every instruction has exactly one owning surface;
 * other surfaces reference, never restate. This module provides:
 *
 *   - the mechanical CANDIDATE EXTRACTOR: normative statements (MUST/NEVER/
 *     ALWAYS/DO NOT/Don't/Never …) collected from the declared inventory
 *     boundary, each with a stable id;
 *   - the map loader/validator for codev/resources/prompt-ownership.yaml;
 *   - disposition resolution: every candidate must be `mapped`, `scar`, or
 *     `out-of-scope` (with justification) — there is no fourth state, so the
 *     map cannot rot silently as the prompt surface grows (T12).
 *
 * Why dispositions support pattern matching rather than per-line ids: the
 * boundary yields hundreds of normative lines, most of them phase-prompt
 * process instructions that are individually owned by their file. Requiring a
 * one-to-one disposition per line would make the map unmaintainable, which is
 * how maps die. A disposition entry covers a family via `match` (substring or
 * /regex/), carries one justification, and first-match-wins keeps resolution
 * deterministic.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Types (mirror Appendix A)
// ---------------------------------------------------------------------------

export interface OwnedSurface {
  id: string;
  path: string;
  load: 'always-on' | 'spawn' | 'phase-prompt' | 'on-demand';
}

export interface InstructionClass {
  id: string;
  summary: string;
  /** Surface id — exactly one owner. */
  owner: string;
  scar: boolean;
  /** Detection pattern: substring, or /regex/ when slash-delimited. */
  pattern: string;
  enforcement: 'automated' | 'manual';
  /** For scar rules: surfaces that must all carry it (mirrors scar-rules.yaml). */
  must_appear_on?: string[];
  /** For non-scar: surfaces allowed to carry a one-line reference. */
  references?: string[];
  /** Required for enforcement: manual — why no reliable pattern exists. */
  manual_justification?: string;
}

export interface Disposition {
  /** Substring, or /regex/ when slash-delimited. Matched against the LINE. */
  match: string;
  disposition: 'mapped' | 'scar' | 'out-of-scope';
  /** Instruction-class id (required when disposition is `mapped`). */
  class?: string;
  /** Justification (required when disposition is `out-of-scope`). */
  note?: string;
  /**
   * A catch-all may only absorb SINGLE-FILE candidates. Any candidate whose
   * text appears on 2+ files must resolve via a specific entry — otherwise
   * the catch-all would make completeness vacuous for exactly the failure
   * class (cross-surface duplication) the single-owner rule targets.
   */
  catch_all?: boolean;
}

export interface OwnershipMap {
  inventory_boundary: string[];
  surfaces: OwnedSurface[];
  instructions: InstructionClass[];
  dispositions: Disposition[];
}

export interface Candidate {
  file: string;
  line: number;
  text: string;
  /** sha1 of file-relative normalized text — stable across line-number drift. */
  id: string;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * A line is a normative candidate when it contains an imperative/prohibitive
 * construction. Deliberately coarse — over-collecting is safe (a candidate
 * just needs a disposition), under-collecting silently exempts content.
 */
const NORMATIVE = /\b(MUST(?:\s+NOT)?|NEVER|ALWAYS|DO NOT|Don't|don't|Never|never use|Do not)\b/;

/** Lines that are markdown noise, not instructions. */
const NOISE = /^\s*(#|```|\||<!--|\/\/)/;

export function extractCandidates(root: string, boundary: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const rel of boundary) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf-8').split('\n');
    lines.forEach((text, i) => {
      if (NOISE.test(text)) return;
      if (!NORMATIVE.test(text)) return;
      const norm = text.trim();
      out.push({
        file: rel,
        line: i + 1,
        text: norm.slice(0, 240),
        id: createHash('sha1').update(`${rel}:${norm}`).digest('hex').slice(0, 12),
      });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Map loading + validation
// ---------------------------------------------------------------------------

export function loadOwnershipMap(root: string): OwnershipMap {
  const p = path.join(root, 'codev', 'resources', 'prompt-ownership.yaml');
  const doc = yaml.load(fs.readFileSync(p, 'utf-8')) as OwnershipMap;
  return doc;
}

/** Structural validation — throws with a list of every violation. */
export function validateMap(map: OwnershipMap): string[] {
  const problems: string[] = [];
  const surfaceIds = new Set(map.surfaces.map((s) => s.id));
  const classIds = new Set<string>();

  for (const c of map.instructions) {
    if (classIds.has(c.id)) problems.push(`duplicate instruction id: ${c.id}`);
    classIds.add(c.id);
    if (!surfaceIds.has(c.owner)) problems.push(`${c.id}: owner "${c.owner}" is not a declared surface`);
    if (c.enforcement === 'manual' && !c.manual_justification) {
      problems.push(`${c.id}: enforcement:manual requires manual_justification`);
    }
    for (const ref of [...(c.must_appear_on ?? []), ...(c.references ?? [])]) {
      if (!surfaceIds.has(ref)) problems.push(`${c.id}: unknown surface "${ref}"`);
    }
  }
  for (const d of map.dispositions) {
    if (d.disposition === 'mapped' && !(d.class && classIds.has(d.class))) {
      problems.push(`disposition "${d.match}": mapped but class "${d.class}" unknown`);
    }
    if (d.disposition === 'out-of-scope' && !d.note?.trim()) {
      problems.push(`disposition "${d.match}": out-of-scope requires a justification note`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Disposition resolution (T12)
// ---------------------------------------------------------------------------

function matches(matcher: string, line: string): boolean {
  if (matcher.startsWith('/') && matcher.endsWith('/') && matcher.length > 2) {
    return new RegExp(matcher.slice(1, -1)).test(line);
  }
  return line.includes(matcher);
}

/** First matching disposition, or null — null is the T12 failure state. */
export function resolveDisposition(map: OwnershipMap, c: Candidate): Disposition | null {
  for (const d of map.dispositions) {
    if (matches(d.match, c.text)) return d;
  }
  return null;
}

export interface CompletenessReport {
  total: number;
  undispositioned: Candidate[];
  /** Multi-file candidate texts that only resolved via a catch-all entry. */
  multiFileViaCatchAll: Candidate[];
  byDisposition: Record<string, number>;
}

export function checkCompleteness(root: string): CompletenessReport {
  const map = loadOwnershipMap(root);
  const candidates = extractCandidates(root, map.inventory_boundary);

  // Group candidate texts across files to detect cross-surface duplication.
  const filesByText = new Map<string, Set<string>>();
  for (const c of candidates) {
    if (!filesByText.has(c.text)) filesByText.set(c.text, new Set());
    filesByText.get(c.text)!.add(c.file);
  }

  const undispositioned: Candidate[] = [];
  const multiFileViaCatchAll: Candidate[] = [];
  const byDisposition: Record<string, number> = { mapped: 0, scar: 0, 'out-of-scope': 0 };
  for (const c of candidates) {
    const d = resolveDisposition(map, c);
    if (!d) {
      undispositioned.push(c);
      continue;
    }
    byDisposition[d.disposition]++;
    if (d.catch_all && (filesByText.get(c.text)?.size ?? 0) > 1) {
      multiFileViaCatchAll.push(c);
    }
  }
  return { total: candidates.length, undispositioned, multiFileViaCatchAll, byDisposition };
}
