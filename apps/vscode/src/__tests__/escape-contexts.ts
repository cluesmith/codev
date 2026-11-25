/**
 * Where `inlineScriptText` rewrites a script (Spec 1963, cluesmith/codev-ide issue #67), and what
 * JavaScript sits there, read with TypeScript's parser (already a dev dependency).
 *
 * The rewrite (`<` as `\x3C` before `!--` or `/script`) keeps the program's meaning only inside a
 * string literal, a regular-expression literal, an untagged template or a comment. In code it is a
 * syntax error, and in a tagged template the tag can read `.raw`, which the rewrite changes. Each
 * rewritten position is classified, so a bundle that puts one anywhere else fails its test.
 */

import * as ts from 'typescript';

export type EscapeContext = 'string' | 'regex' | 'template' | 'comment' | 'tagged-template' | 'code';

/** Where `inlineScriptText` rewrites: each `<` before `!--` or `/script`, in any case. */
export function rewrittenPositions(script: string): number[] {
  return [...script.matchAll(/<(?=!--|\/script)/gi)].map(match => match.index);
}

const TEMPLATE_PIECES = new Set([
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

function isJSDocKind(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstJSDocNode && kind <= ts.SyntaxKind.LastJSDocNode;
}

/** What sits at `position` in `source`: the token that holds it, or the trivia (a comment) before one. */
export function contextAt(source: ts.SourceFile, position: number): EscapeContext {
  let node: ts.Node = source;
  // Whether `position` is in a tagged template's own text, not in one of its substitutions.
  let tagged = false;
  for (;;) {
    if (isJSDocKind(node.kind)) { return 'comment'; }
    const children = node.getChildren(source);
    if (children.length === 0) {
      if (node.kind === ts.SyntaxKind.StringLiteral) { return 'string'; }
      if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) { return 'regex'; }
      if (TEMPLATE_PIECES.has(node.kind)) { return tagged ? 'tagged-template' : 'template'; }
      return 'code';
    }
    const child = children.find(c => c.pos <= position && position < c.end);
    if (!child) { return 'code'; }
    // Before the child's first token is its leading trivia: whitespace and comments. A `<` is not
    // whitespace, so it is in a comment.
    if (position < child.getStart(source, true) && !isJSDocKind(child.kind)) { return 'comment'; }
    if (ts.isTaggedTemplateExpression(node) && child === node.template) { tagged = true; }
    if (ts.isTemplateSpan(node) && child === node.expression) { tagged = false; }
    node = child;
  }
}

/** Every position the rewrite touches in `script`, with what sits there. */
export function escapeContexts(script: string): Array<{ position: number; context: EscapeContext; excerpt: string }> {
  const source = ts.createSourceFile('bundle.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return rewrittenPositions(script).map(position => ({
    position,
    context: contextAt(source, position),
    excerpt: script.slice(Math.max(0, position - 30), position + 30),
  }));
}

/** The contexts where the rewrite keeps the program's meaning. */
export const SAFE_CONTEXTS: ReadonlySet<EscapeContext> = new Set(['string', 'regex', 'template', 'comment']);
