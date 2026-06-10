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

/** The whole file: `<repo-relative-path> ` (trailing space, no Enter). */
export function buildBuilderFileRef(relPath: string): string {
  return `${relPath} `;
}

/** A line range: `<repo-relative-path>:L<start>-L<end> ` (trailing space, no Enter). */
export function buildBuilderRangeRef(relPath: string, start: number, end: number): string {
  return `${relPath}:L${start}-L${end} `;
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
    lenses.push({
      line,
      title: 'Forward to Builder',
      refText: buildBuilderRangeRef(relPath, s.startLine + 1, s.endLine + 1),
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
