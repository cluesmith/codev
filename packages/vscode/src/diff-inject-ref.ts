/**
 * Pure helpers for the "Forward to Builder" CodeLens actions in the builder
 * diff (#789). No `vscode` import — same precedent as
 * `architect-reference-injection.ts`, so the symbol-selection and ref-string
 * logic is unit-tested directly without mocking the editor API.
 *
 * Lenses are driven by **document symbols**, not git hunks: granularity follows
 * the code (functions/classes/interfaces/methods), so a brand-new file is just
 * as forwardable as a modified one. The provider
 * (`diff-inject-codelens.ts`) resolves symbols via VSCode and adapts them to
 * the `SymbolNode` shape below; all selection/anchor logic lives here.
 */

/**
 * Editor-agnostic description of one CodeLens to render: the 0-based line to
 * anchor it on, the label, and the text to inject into the builder prompt.
 */
export interface LensDescriptor {
  /** 0-based anchor line (the provider clamps to the document bounds). */
  line: number;
  title: string;
  /** Text typed into the builder terminal — always ends with a space, no Enter. */
  refText: string;
}

/**
 * Minimal, `vscode`-free projection of `vscode.DocumentSymbol` — just the
 * fields the selection logic needs. `kind` is the numeric `vscode.SymbolKind`
 * value; `startLine`/`endLine` are the symbol's full range (0-based).
 */
export interface SymbolNode {
  kind: number;
  startLine: number;
  endLine: number;
  children: SymbolNode[];
}

/**
 * Numeric `vscode.SymbolKind` values (stable API enum). Kept here so the pure
 * module needs no `vscode` import; the provider passes `symbol.kind` straight
 * through.
 */
const KIND = {
  Module: 1,
  Namespace: 2,
  Class: 4,
  Method: 5,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  Struct: 22,
} as const;

/** Top-level structural declarations that always get a lens. */
const TOP_LEVEL_KINDS = new Set<number>([
  KIND.Function,
  KIND.Class,
  KIND.Interface,
  KIND.Enum,
  KIND.Struct,
  KIND.Namespace,
  KIND.Module,
]);

/**
 * A contiguous run of added new-side lines (1-based, inclusive) — a single
 * visible change block. git groups nearby edits into one `@@` hunk, so each
 * hunk is split into one `ChangedRange` per run of `+` lines (broken by
 * unchanged context lines), and each run gets its own lens. `-` lines don't
 * break a run (they don't occupy a new-side line); a pure-deletion hunk yields
 * no range (nothing to point a new-side lens at).
 */
export interface ChangedRange {
  start: number;
  end: number;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff into one `ChangedRange` per contiguous run of added
 * (`+`) new-side lines, tracking the new-side line number across each hunk.
 * Context lines break a run; deletions don't (they have no new-side line).
 */
export function parseHunkRanges(patch: string): ChangedRange[] {
  const ranges: ChangedRange[] = [];
  let inHunk = false;
  let cur = 0;        // next new-side line number
  let runStart = -1;
  let runEnd = -1;
  const flush = (): void => {
    if (runStart !== -1) {
      ranges.push({ start: runStart, end: runEnd });
      runStart = -1;
      runEnd = -1;
    }
  };

  for (const l of patch.split('\n')) {
    const m = HUNK_HEADER.exec(l);
    if (m) {
      flush();
      cur = Number(m[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) { continue; }
    if (l.startsWith('diff --git')) { flush(); inHunk = false; continue; }
    if (l.startsWith('\\')) { continue; } // "\ No newline at end of file"
    if (l.startsWith('+')) {
      if (runStart === -1) { runStart = cur; }
      runEnd = cur;
      cur++;
    } else if (l.startsWith('-')) {
      // old-side only — does not advance the new-side counter, does not break the run
    } else {
      flush(); // context line ends the current run
      cur++;
    }
  }
  flush();
  return ranges;
}

/**
 * Split a multi-file unified diff (`git diff -M --unified=N <ref>`) into a map
 * from each file's **new** path to its changed ranges. The new path is read
 * from the `+++ b/<path>` line; deleted files (`+++ /dev/null`) are omitted.
 */
export function parseUnifiedDiff(patch: string): Map<string, ChangedRange[]> {
  const out = new Map<string, ChangedRange[]>();
  const sections = patch.split(/^diff --git .*$/m).slice(1);
  for (const section of sections) {
    const newPath = newPathFromSection(section);
    if (!newPath) { continue; }
    out.set(newPath, parseHunkRanges(section));
  }
  return out;
}

/** Extract the new-side path from a single file section's `+++ b/<path>` line. */
function newPathFromSection(section: string): string | null {
  for (const line of section.split('\n')) {
    if (!line.startsWith('+++ ')) { continue; }
    const target = line.slice(4).trim();
    if (target === '/dev/null') { return null; }
    return target.startsWith('b/') ? target.slice(2) : target;
  }
  return null;
}

/** The whole file: `<repo-relative-path> ` (trailing space, no Enter). */
export function buildBuilderFileRef(relPath: string): string {
  return `${relPath} `;
}

/** A line range: `<path>:L<start>-L<end> `, or `<path>:L<n> ` for a single line
 *  (trailing space, no Enter). */
export function buildBuilderRangeRef(relPath: string, start: number, end: number): string {
  return start === end ? `${relPath}:L${start} ` : `${relPath}:L${start}-L${end} `;
}

/** Label suffix for a line range: `(line N)` for one line, `(lines N-M)` otherwise. */
function rangeLabel(start: number, end: number): string {
  return start === end ? `(line ${start})` : `(lines ${start}-${end})`;
}

/**
 * Build the lens descriptors for a file from its document symbols:
 *
 * - A **file-level** lens at line 0 (forward the whole file).
 * - A lens on each **top-level** structural declaration (the allowlist above),
 *   plus **top-level multi-line** Variable/Constant (catches arrow-function
 *   components/handlers reported as Variable, while skipping scalar consts).
 * - One level into **Class/Struct** for Method/Constructor lenses, so a single
 *   method can be forwarded. No deeper recursion.
 *
 * A symbol lens that would anchor on line 0 is skipped — the file-level lens
 * already occupies that line.
 */
export function buildSymbolLensDescriptors(relPath: string, symbols: SymbolNode[]): LensDescriptor[] {
  const lenses: LensDescriptor[] = [
    { line: 0, title: 'Forward to Builder', refText: buildBuilderFileRef(relPath) },
  ];

  const addLens = (s: SymbolNode): void => {
    const line = Math.max(s.startLine, 0);
    if (line === 0) { return; } // collides with the file-level lens
    const start = s.startLine + 1;
    const end = s.endLine + 1;
    lenses.push({
      line,
      title: `Forward to Builder ${rangeLabel(start, end)}`,
      refText: buildBuilderRangeRef(relPath, start, end),
    });
  };

  for (const s of symbols) {
    if (TOP_LEVEL_KINDS.has(s.kind)) {
      addLens(s);
      if (s.kind === KIND.Class || s.kind === KIND.Struct) {
        for (const child of s.children) {
          if (child.kind === KIND.Method || child.kind === KIND.Constructor) {
            addLens(child);
          }
        }
      }
    } else if (
      (s.kind === KIND.Variable || s.kind === KIND.Constant) &&
      s.endLine > s.startLine
    ) {
      addLens(s);
    }
  }

  return lenses;
}

/**
 * Combine the symbol lenses (file-level + declarations, bare "Forward to
 * Builder") with per-hunk lenses (labeled "Forward to Builder (lines N-M)" on
 * each changed region). A hunk lens is skipped when its anchor line already has
 * a symbol/file lens — declaration-line changes show the structural lens; body
 * changes show the hunk lens — so no two lenses stack on one line.
 */
export function buildAllLensDescriptors(
  relPath: string,
  symbols: SymbolNode[],
  ranges: ChangedRange[],
): LensDescriptor[] {
  const lenses = buildSymbolLensDescriptors(relPath, symbols);
  const usedLines = new Set(lenses.map(l => l.line));
  for (const r of ranges) {
    const line = Math.max(r.start - 1, 0);
    if (usedLines.has(line)) { continue; } // file-level (line 0) or a symbol lens already here
    usedLines.add(line);
    lenses.push({
      line,
      title: `Forward to Builder ${rangeLabel(r.start, r.end)}`,
      refText: buildBuilderRangeRef(relPath, r.start, r.end),
    });
  }
  return lenses;
}
