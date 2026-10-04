/**
 * Issue #1747: source-level sentinel for status-bar theme colors.
 *
 * `statusBarItem.{prominent,warning,error}Foreground` are the foreground halves
 * of paired tokens, designed to sit on their matching `*Background`. Applied as
 * a lone `StatusBarItem.color` they render on the default status-bar background,
 * where themes resolve them to white: illegible in light themes (the dev chip
 * under 2026 Light; Reconnecting/Offline under every built-in light theme).
 * Activating the extension to observe `.color` would mean mocking the whole
 * `vscode` module, so this scans the source instead.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXT_SRC = readFileSync(resolve(__dirname, '../extension.ts'), 'utf8');

describe('#1747 status-bar items use no lone paired foreground token', () => {
  it('never sets .color to a prominent/warning/error status-bar foreground', () => {
    const lone = EXT_SRC.match(
      /\.color\s*=\s*new vscode\.ThemeColor\(\s*['"]statusBarItem\.(?:prominent|warning|error)Foreground['"]/g,
    );
    expect(lone).toBeNull();
  });
});
