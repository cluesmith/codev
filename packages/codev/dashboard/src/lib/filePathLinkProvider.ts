/**
 * Custom xterm.js ILinkProvider for file paths in terminal output (Spec 0101).
 *
 * Detects file paths using FILE_PATH_REGEX and creates clickable links
 * with Cmd+Click (macOS) / Ctrl+Click (others) activation.
 */

import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { FILE_PATH_REGEX, looksLikeFilePath } from './filePaths.js';

type FileOpenCallback = (path: string, line?: number, column?: number, terminalId?: string) => void;

const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');

export class FilePathLinkProvider implements ILinkProvider {
  constructor(
    private terminal: Terminal,
    private onFileOpen: FileOpenCallback,
    private terminalId?: string,
  ) {}

  provideLinks(lineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const bufferLine = this.terminal.buffer.active.getLine(lineNumber - 1);
    if (!bufferLine) { callback(undefined); return; }
    const text = bufferLine.translateToString();

    // Create fresh regex each call to avoid /g lastIndex statefulness
    const regex = new RegExp(FILE_PATH_REGEX.source, FILE_PATH_REGEX.flags);
    const links: ILink[] = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      // FILE_PATH_REGEX capture groups:
      //   Group 1: file path (e.g., "src/foo.ts")
      //   Group 2: line number, colon format (e.g., "42" from ":42")
      //   Group 3: column number, colon format (e.g., "15" from ":15")
      //   Group 4: line number, paren format (e.g., "42" from "(42,15)")
      //   Group 5: column number, paren format (e.g., "15" from "(42,15)")
      const filePath = match[1];
      if (!filePath || !looksLikeFilePath(filePath)) continue;

      const line = match[2] ? parseInt(match[2], 10)
                 : match[4] ? parseInt(match[4], 10)
                 : undefined;
      const column = match[3] ? parseInt(match[3], 10)
                   : match[5] ? parseInt(match[5], 10)
                   : undefined;

      // Link range covers the file path + line/col suffix, excluding the
      // leading delimiter (space, quote, bracket, etc.) matched by the regex.
      const fullMatch = match[0];
      const capturedOffset = fullMatch.indexOf(filePath);
      const linkStart = match.index + capturedOffset;
      const linkEnd = match.index + fullMatch.length;

      // xterm.js ILink.range uses 1-based inclusive coordinates
      links.push({
        range: {
          start: { x: linkStart + 1, y: lineNumber },
          end: { x: linkEnd, y: lineNumber },
        },
        text: fullMatch.substring(capturedOffset),
        decorations: { pointerCursor: true, underline: true },
        activate: (event: MouseEvent, _linkText: string) => {
          // Platform-aware modifier: Cmd on macOS, Ctrl on others
          if (isMac ? !event.metaKey : !event.ctrlKey) return;
          this.onFileOpen(filePath, line, column, this.terminalId);
        },
      });
    }

    callback(links.length > 0 ? links : undefined);
  }
}
