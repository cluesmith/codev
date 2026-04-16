import * as vscode from 'vscode';

const REVIEW_PATTERN = /\bREVIEW\s*\([^)]*\)\s*:\s*.*/g;

const decorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
  gutterIconPath: new vscode.ThemeIcon('comment').id ? undefined : undefined,
  gutterIconSize: 'contain',
  isWholeLine: true,
  overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.infoForeground'),
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

/**
 * Highlights REVIEW(...) comment lines with a colored background.
 */
export function activateReviewDecorations(context: vscode.ExtensionContext): void {
  // Decorate on open and change
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) { updateDecorations(editor); }
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      const editor = vscode.window.activeTextEditor;
      if (editor && event.document === editor.document) {
        updateDecorations(editor);
      }
    }),
  );

  // Decorate current editor
  if (vscode.window.activeTextEditor) {
    updateDecorations(vscode.window.activeTextEditor);
  }
}

function updateDecorations(editor: vscode.TextEditor): void {
  const text = editor.document.getText();
  const ranges: vscode.DecorationOptions[] = [];

  let match: RegExpExecArray | null;
  REVIEW_PATTERN.lastIndex = 0;
  while ((match = REVIEW_PATTERN.exec(text)) !== null) {
    const startPos = editor.document.positionAt(match.index);
    const endPos = editor.document.positionAt(match.index + match[0].length);
    ranges.push({
      range: new vscode.Range(startPos, endPos),
      hoverMessage: 'Codev review comment',
    });
  }

  editor.setDecorations(decorationType, ranges);
}
