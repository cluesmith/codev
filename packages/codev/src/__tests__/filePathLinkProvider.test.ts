/**
 * Unit tests for FilePathLinkProvider (Spec 0101)
 *
 * Tests:
 * - FILE_PATH_REGEX pattern matching (match and reject)
 * - Line/col extraction from regex capture groups
 * - looksLikeFilePath filtering
 * - Multiple paths on one line
 * - Regex /g flag doesn't cause alternating match/miss
 * - Platform-aware modifier key detection
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FILE_PATH_REGEX, parseFilePath, looksLikeFilePath } from '../../dashboard/src/lib/filePaths.js';
import { FilePathLinkProvider, FilePathDecorationManager } from '../../dashboard/src/lib/filePathLinkProvider.js';
import type { ILink } from '@xterm/xterm';

// ──────────────────────────────────────────────────────────────
// FILE_PATH_REGEX tests
// ──────────────────────────────────────────────────────────────

describe('FILE_PATH_REGEX', () => {
  function matchAll(input: string): string[] {
    const regex = new RegExp(FILE_PATH_REGEX.source, FILE_PATH_REGEX.flags);
    const results: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(input)) !== null) {
      results.push(m[0].trim());
    }
    return results;
  }

  function extractGroup1(input: string): string[] {
    const regex = new RegExp(FILE_PATH_REGEX.source, FILE_PATH_REGEX.flags);
    const results: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(input)) !== null) {
      if (m[1]) results.push(m[1]);
    }
    return results;
  }

  describe('should match file path patterns', () => {
    it('relative path', () => {
      expect(extractGroup1('error in src/lib/foo.ts')).toContain('src/lib/foo.ts');
    });

    it('with line number', () => {
      const regex = new RegExp(FILE_PATH_REGEX.source, FILE_PATH_REGEX.flags);
      const m = regex.exec('error in src/lib/foo.ts:42');
      expect(m).not.toBeNull();
      expect(m![1]).toBe('src/lib/foo.ts');
      expect(m![2]).toBe('42');
    });

    it('with line and column', () => {
      const regex = new RegExp(FILE_PATH_REGEX.source, FILE_PATH_REGEX.flags);
      const m = regex.exec('error in src/lib/foo.ts:42:15');
      expect(m).not.toBeNull();
      expect(m![1]).toBe('src/lib/foo.ts');
      expect(m![2]).toBe('42');
      expect(m![3]).toBe('15');
    });

    it('VS Code style (parens)', () => {
      const regex = new RegExp(FILE_PATH_REGEX.source, FILE_PATH_REGEX.flags);
      const m = regex.exec('src/lib/foo.ts(42,15)');
      expect(m).not.toBeNull();
      expect(m![1]).toBe('src/lib/foo.ts');
      expect(m![4]).toBe('42');
      expect(m![5]).toBe('15');
    });

    it('absolute path', () => {
      expect(extractGroup1('/Users/mwk/project/foo.ts:42')).toContain('/Users/mwk/project/foo.ts');
    });

    it('dot-relative path', () => {
      expect(extractGroup1('./src/lib/foo.ts')).toContain('./src/lib/foo.ts');
    });

    it('parent-relative path', () => {
      expect(extractGroup1('../shared/types.ts')).toContain('../shared/types.ts');
    });
  });

  describe('should NOT match non-file patterns', () => {
    it('URLs (https)', () => {
      expect(extractGroup1('https://example.com/path')).not.toContain('example.com/path');
    });

    it('URLs (http)', () => {
      expect(extractGroup1('http://example.com/path')).not.toContain('example.com/path');
    });
  });

  describe('multiple paths in one line', () => {
    it('detects two paths', () => {
      const result = extractGroup1('error in src/a.ts:1 and src/b.ts:2');
      expect(result).toContain('src/a.ts');
      expect(result).toContain('src/b.ts');
    });
  });

  describe('/g flag handling', () => {
    it('does not cause alternating match/miss when creating fresh regex', () => {
      // Simulate what provideLinks does: create fresh regex each call
      for (let i = 0; i < 5; i++) {
        const regex = new RegExp(FILE_PATH_REGEX.source, FILE_PATH_REGEX.flags);
        const m = regex.exec('src/foo.ts:42');
        expect(m).not.toBeNull();
        expect(m![1]).toBe('src/foo.ts');
      }
    });
  });
});

// ──────────────────────────────────────────────────────────────
// parseFilePath tests
// ──────────────────────────────────────────────────────────────

describe('parseFilePath', () => {
  it('parses colon format with line', () => {
    const result = parseFilePath('src/foo.ts:42');
    expect(result).toEqual({ path: 'src/foo.ts', line: 42 });
  });

  it('parses colon format with line and column', () => {
    const result = parseFilePath('src/foo.ts:42:15');
    expect(result).toEqual({ path: 'src/foo.ts', line: 42, column: 15 });
  });

  it('parses paren format', () => {
    const result = parseFilePath('src/foo.ts(42,15)');
    expect(result).toEqual({ path: 'src/foo.ts', line: 42, column: 15 });
  });

  it('returns bare path when no line/col', () => {
    const result = parseFilePath('src/foo.ts');
    expect(result).toEqual({ path: 'src/foo.ts' });
  });
});

// ──────────────────────────────────────────────────────────────
// looksLikeFilePath tests
// ──────────────────────────────────────────────────────────────

describe('looksLikeFilePath', () => {
  it('accepts valid file paths', () => {
    expect(looksLikeFilePath('src/foo.ts')).toBe(true);
    expect(looksLikeFilePath('./src/foo.ts')).toBe(true);
    expect(looksLikeFilePath('../shared/types.ts')).toBe(true);
    expect(looksLikeFilePath('/absolute/path/file.js')).toBe(true);
    expect(looksLikeFilePath('src/foo.ts:42')).toBe(true);
    expect(looksLikeFilePath('src/foo.ts:42:15')).toBe(true);
  });

  it('rejects URLs', () => {
    expect(looksLikeFilePath('https://example.com/path')).toBe(false);
    expect(looksLikeFilePath('http://example.com/path')).toBe(false);
  });

  it('rejects domain names', () => {
    expect(looksLikeFilePath('github.com')).toBe(false);
    expect(looksLikeFilePath('npmjs.org')).toBe(false);
    expect(looksLikeFilePath('example.io')).toBe(false);
  });

  it('rejects strings without extensions', () => {
    expect(looksLikeFilePath('no-extension')).toBe(false);
    expect(looksLikeFilePath('just/a/path')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────
// FilePathLinkProvider tests
// ──────────────────────────────────────────────────────────────

describe('FilePathLinkProvider', () => {
  function createMockTerminal(lineText: string) {
    return {
      buffer: {
        active: {
          getLine: vi.fn((lineIndex: number) => {
            if (lineIndex === 0) {
              return { translateToString: () => lineText };
            }
            return null;
          }),
        },
      },
    } as unknown as import('@xterm/xterm').Terminal;
  }

  function getLinks(lineText: string, terminalId?: string): Promise<ILink[] | undefined> {
    return new Promise((resolve) => {
      const mockCallback = vi.fn();
      const terminal = createMockTerminal(lineText);
      const provider = new FilePathLinkProvider(terminal, mockCallback, terminalId);
      provider.provideLinks(1, (links) => resolve(links));
    });
  }

  describe('link detection', () => {
    it('detects a simple file path', async () => {
      const links = await getLinks('error in src/foo.ts here');
      expect(links).toBeDefined();
      expect(links!.length).toBe(1);
      expect(links![0].text).toBe('src/foo.ts');
    });

    it('detects file path with line number', async () => {
      const links = await getLinks('error in src/foo.ts:42 here');
      expect(links).toBeDefined();
      expect(links!.length).toBe(1);
      expect(links![0].text).toBe('src/foo.ts:42');
    });

    it('detects file path with line and column', async () => {
      const links = await getLinks('error in src/foo.ts:42:15 here');
      expect(links).toBeDefined();
      expect(links!.length).toBe(1);
      expect(links![0].text).toBe('src/foo.ts:42:15');
    });

    it('detects VS Code style path', async () => {
      const links = await getLinks('src/foo.ts(42,15): error');
      expect(links).toBeDefined();
      expect(links!.length).toBe(1);
      expect(links![0].text).toBe('src/foo.ts(42,15)');
    });

    it('detects absolute path', async () => {
      const links = await getLinks('/Users/mwk/project/foo.ts:42');
      expect(links).toBeDefined();
      expect(links!.length).toBe(1);
      expect(links![0].text).toContain('foo.ts:42');
    });

    it('detects dot-relative path', async () => {
      const links = await getLinks('in ./src/lib/foo.ts');
      expect(links).toBeDefined();
      expect(links!.length).toBe(1);
      expect(links![0].text).toBe('./src/lib/foo.ts');
    });

    it('detects parent-relative path', async () => {
      const links = await getLinks('in ../shared/types.ts');
      expect(links).toBeDefined();
      expect(links!.length).toBe(1);
      expect(links![0].text).toBe('../shared/types.ts');
    });

    it('detects multiple paths on one line', async () => {
      const links = await getLinks('error in src/a.ts:1 and src/b.ts:2');
      expect(links).toBeDefined();
      expect(links!.length).toBe(2);
    });

    it('returns undefined for lines with no file paths', async () => {
      const links = await getLinks('just some regular text here');
      expect(links).toBeUndefined();
    });

    it('returns undefined for null buffer line', async () => {
      const terminal = createMockTerminal('');
      // Override to return null for any line
      (terminal.buffer.active.getLine as ReturnType<typeof vi.fn>).mockReturnValue(null);
      const links = await new Promise<ILink[] | undefined>((resolve) => {
        const provider = new FilePathLinkProvider(terminal, vi.fn());
        provider.provideLinks(1, resolve);
      });
      expect(links).toBeUndefined();
    });
  });

  describe('false positive rejection', () => {
    it('does not match package specifiers like @xterm/xterm', async () => {
      const links = await getLinks('using @xterm/xterm package');
      // @xterm/xterm should not produce any links — the @ prefix prevents matching
      expect(links).toBeUndefined();
    });

    it('does not match version strings like v2.0.0', async () => {
      const links = await getLinks('version v2.0.0-rc.62 released');
      // v2.0.0-rc.62 has no valid file extension (digits after dots), so no links
      expect(links).toBeUndefined();
    });
  });

  describe('line/col extraction from regex groups', () => {
    it('extracts line from colon format', async () => {
      const onFileOpen = vi.fn();
      const terminal = createMockTerminal('error in src/foo.ts:42 here');
      const provider = new FilePathLinkProvider(terminal, onFileOpen);

      const links = await new Promise<ILink[] | undefined>((resolve) => {
        provider.provideLinks(1, resolve);
      });
      expect(links).toBeDefined();

      // Simulate Cmd+Click
      links![0].activate({ metaKey: true, ctrlKey: true } as MouseEvent, links![0].text);
      expect(onFileOpen).toHaveBeenCalledWith('src/foo.ts', 42, undefined, undefined);
    });

    it('extracts line and column from colon format', async () => {
      const onFileOpen = vi.fn();
      const terminal = createMockTerminal('error in src/foo.ts:42:15 here');
      const provider = new FilePathLinkProvider(terminal, onFileOpen);

      const links = await new Promise<ILink[] | undefined>((resolve) => {
        provider.provideLinks(1, resolve);
      });
      expect(links).toBeDefined();

      links![0].activate({ metaKey: true, ctrlKey: true } as MouseEvent, links![0].text);
      expect(onFileOpen).toHaveBeenCalledWith('src/foo.ts', 42, 15, undefined);
    });

    it('extracts line and column from paren format', async () => {
      const onFileOpen = vi.fn();
      const terminal = createMockTerminal('src/foo.ts(42,15): error');
      const provider = new FilePathLinkProvider(terminal, onFileOpen);

      const links = await new Promise<ILink[] | undefined>((resolve) => {
        provider.provideLinks(1, resolve);
      });
      expect(links).toBeDefined();

      links![0].activate({ metaKey: true, ctrlKey: true } as MouseEvent, links![0].text);
      expect(onFileOpen).toHaveBeenCalledWith('src/foo.ts', 42, 15, undefined);
    });

    it('passes undefined line/col for bare path', async () => {
      const onFileOpen = vi.fn();
      const terminal = createMockTerminal('error in src/foo.ts here');
      const provider = new FilePathLinkProvider(terminal, onFileOpen);

      const links = await new Promise<ILink[] | undefined>((resolve) => {
        provider.provideLinks(1, resolve);
      });
      expect(links).toBeDefined();

      links![0].activate({ metaKey: true, ctrlKey: true } as MouseEvent, links![0].text);
      expect(onFileOpen).toHaveBeenCalledWith('src/foo.ts', undefined, undefined, undefined);
    });
  });

  describe('terminalId propagation', () => {
    it('passes terminalId to onFileOpen callback', async () => {
      const onFileOpen = vi.fn();
      const terminal = createMockTerminal('error in src/foo.ts here');
      const provider = new FilePathLinkProvider(terminal, onFileOpen, 'term-123');

      const links = await new Promise<ILink[] | undefined>((resolve) => {
        provider.provideLinks(1, resolve);
      });
      expect(links).toBeDefined();

      links![0].activate({ metaKey: true, ctrlKey: true } as MouseEvent, links![0].text);
      expect(onFileOpen).toHaveBeenCalledWith('src/foo.ts', undefined, undefined, 'term-123');
    });
  });

  describe('modifier key behavior', () => {
    it('does not activate on plain click (no modifier)', async () => {
      const onFileOpen = vi.fn();
      const terminal = createMockTerminal('error in src/foo.ts here');
      const provider = new FilePathLinkProvider(terminal, onFileOpen);

      const links = await new Promise<ILink[] | undefined>((resolve) => {
        provider.provideLinks(1, resolve);
      });

      links![0].activate({ metaKey: false, ctrlKey: false } as MouseEvent, links![0].text);
      expect(onFileOpen).not.toHaveBeenCalled();
    });

    // Note: platform-aware modifier behavior (metaKey on macOS, ctrlKey on others)
    // depends on navigator.platform which is set at module load time.
    // We pass both metaKey and ctrlKey so the test works on both platforms.
    it('activates with modifier key (Cmd on macOS, Ctrl on Linux)', async () => {
      const onFileOpen = vi.fn();
      const terminal = createMockTerminal('error in src/foo.ts here');
      const provider = new FilePathLinkProvider(terminal, onFileOpen);

      const links = await new Promise<ILink[] | undefined>((resolve) => {
        provider.provideLinks(1, resolve);
      });

      links![0].activate({ metaKey: true, ctrlKey: true } as MouseEvent, links![0].text);
      expect(onFileOpen).toHaveBeenCalled();
    });
  });

  describe('link range coordinates', () => {
    it('uses 1-based inclusive coordinates', async () => {
      // "error in src/foo.ts here"
      // "src/foo.ts" starts at index 9 (0-based)
      const links = await getLinks('error in src/foo.ts here');
      expect(links).toBeDefined();
      const link = links![0];
      // 1-based: start.x = 10 (9+1), end.x = 19 (9+10, inclusive)
      expect(link.range.start.x).toBe(10);
      expect(link.range.end.x).toBe(19);
      expect(link.range.start.y).toBe(1);
      expect(link.range.end.y).toBe(1);
    });

    it('includes line/col suffix in range', async () => {
      // "error in src/foo.ts:42 here"
      // "src/foo.ts:42" starts at index 9, length 13
      const links = await getLinks('error in src/foo.ts:42 here');
      expect(links).toBeDefined();
      const link = links![0];
      expect(link.range.start.x).toBe(10);
      // end.x should cover the ":42" part too
      expect(link.range.end.x).toBe(22); // 9 + 13 = 22
    });
  });

  describe('ILink.decorations', () => {
    it('sets pointerCursor true and underline false (overlay handles underline)', async () => {
      const links = await getLinks('error in src/foo.ts here');
      expect(links).toBeDefined();
      expect(links![0].decorations).toEqual({
        pointerCursor: true,
        underline: false,
      });
    });
  });

  describe('per-link hover via decorationManager', () => {
    it('calls decorationManager.highlightAt on hover', async () => {
      const terminal = createMockTerminal('error in src/foo.ts here');
      const mockManager = { highlightAt: vi.fn(), unhighlightAll: vi.fn(), dispose: vi.fn() };

      const provider = new FilePathLinkProvider(
        terminal, vi.fn(), undefined,
        mockManager as unknown as FilePathDecorationManager,
      );
      const links = await new Promise<ILink[] | undefined>((resolve) => {
        provider.provideLinks(1, resolve);
      });
      expect(links).toBeDefined();
      expect(links![0].hover).toBeDefined();

      links![0].hover!({} as MouseEvent, links![0].text);
      // bufferLineIndex = lineNumber - 1 = 0, x = linkStart for "src/foo.ts" = 9
      expect(mockManager.highlightAt).toHaveBeenCalledWith(0, 9);
    });

    it('calls decorationManager.unhighlightAll on leave', async () => {
      const terminal = createMockTerminal('error in src/foo.ts here');
      const mockManager = { highlightAt: vi.fn(), unhighlightAll: vi.fn(), dispose: vi.fn() };

      const provider = new FilePathLinkProvider(
        terminal, vi.fn(), undefined,
        mockManager as unknown as FilePathDecorationManager,
      );
      const links = await new Promise<ILink[] | undefined>((resolve) => {
        provider.provideLinks(1, resolve);
      });
      expect(links).toBeDefined();
      expect(links![0].leave).toBeDefined();

      links![0].leave!({} as MouseEvent, links![0].text);
      expect(mockManager.unhighlightAll).toHaveBeenCalled();
    });

    it('does not throw without decorationManager', async () => {
      const terminal = createMockTerminal('error in src/foo.ts here');
      const provider = new FilePathLinkProvider(terminal, vi.fn());
      const links = await new Promise<ILink[] | undefined>((resolve) => {
        provider.provideLinks(1, resolve);
      });
      expect(links).toBeDefined();

      // Should not throw when no decorationManager
      expect(() => links![0].hover!({} as MouseEvent, links![0].text)).not.toThrow();
      expect(() => links![0].leave!({} as MouseEvent, links![0].text)).not.toThrow();
    });
  });
});

// ──────────────────────────────────────────────────────────────
// FilePathDecorationManager tests
// ──────────────────────────────────────────────────────────────

describe('FilePathDecorationManager', () => {
  let onWriteParsedCallback: (() => void) | null;

  function createMockTerminalForDecoration(lines: string[]) {
    onWriteParsedCallback = null;
    const markers: Array<{ dispose: ReturnType<typeof vi.fn>; line: number }> = [];
    const decorations: Array<{
      dispose: ReturnType<typeof vi.fn>;
      onRender: ReturnType<typeof vi.fn>;
      element: HTMLElement | undefined;
    }> = [];

    const terminal = {
      buffer: {
        active: {
          getLine: vi.fn((lineIndex: number) => {
            if (lineIndex >= 0 && lineIndex < lines.length) {
              return { translateToString: () => lines[lineIndex] };
            }
            return null;
          }),
          baseY: 0,
          cursorY: Math.max(0, lines.length - 1),
        },
      },
      onWriteParsed: vi.fn((cb: () => void) => {
        onWriteParsedCallback = cb;
        return { dispose: vi.fn() };
      }),
      registerMarker: vi.fn((offset: number) => {
        const cursorLine = terminal.buffer.active.baseY + terminal.buffer.active.cursorY;
        const line = cursorLine + offset;
        const marker = { dispose: vi.fn(), line, isDisposed: false, onDispose: vi.fn() };
        markers.push(marker);
        return marker;
      }),
      registerDecoration: vi.fn((opts: { marker: { line: number }; x: number; width: number }) => {
        const decoration = {
          dispose: vi.fn(),
          onRender: vi.fn((cb: (el: HTMLElement) => void) => {
            // Minimal mock element (no jsdom needed)
            const classSet = new Set<string>();
            const el = {
              classList: {
                add: (cls: string) => classSet.add(cls),
                remove: (cls: string) => classSet.delete(cls),
                contains: (cls: string) => classSet.has(cls),
              },
              style: {},
            } as unknown as HTMLElement;
            cb(el);
            decoration.element = el;
            return { dispose: vi.fn() };
          }),
          element: undefined as HTMLElement | undefined,
          marker: opts.marker,
          options: {},
          isDisposed: false,
          onDispose: vi.fn(),
        };
        decorations.push(decoration);
        return decoration;
      }),
    } as unknown as import('@xterm/xterm').Terminal;

    return { terminal, markers, decorations };
  }

  it('creates decorations for file paths on onWriteParsed', () => {
    const { terminal, decorations } = createMockTerminalForDecoration([
      'error in src/foo.ts:42 here',
    ]);

    const manager = new FilePathDecorationManager(terminal);
    expect(onWriteParsedCallback).toBeDefined();

    // Simulate data written
    onWriteParsedCallback!();

    expect(terminal.registerMarker).toHaveBeenCalled();
    expect(terminal.registerDecoration).toHaveBeenCalled();
    expect(decorations.length).toBe(1);

    manager.dispose();
  });

  it('does not create decorations for lines without file paths', () => {
    const { terminal, decorations } = createMockTerminalForDecoration([
      'just some regular text',
    ]);

    const manager = new FilePathDecorationManager(terminal);
    onWriteParsedCallback!();

    expect(decorations.length).toBe(0);

    manager.dispose();
  });

  it('creates multiple decorations for multiple file paths', () => {
    const { terminal, decorations } = createMockTerminalForDecoration([
      'error in src/a.ts:1 and src/b.ts:2',
    ]);

    const manager = new FilePathDecorationManager(terminal);
    onWriteParsedCallback!();

    expect(decorations.length).toBe(2);

    manager.dispose();
  });

  it('adds file-path-decoration class via onRender', () => {
    const { terminal, decorations } = createMockTerminalForDecoration([
      'error in src/foo.ts here',
    ]);

    const manager = new FilePathDecorationManager(terminal);
    onWriteParsedCallback!();

    expect(decorations.length).toBe(1);
    expect(decorations[0].element).toBeDefined();
    expect(decorations[0].element!.classList.contains('file-path-decoration')).toBe(true);

    manager.dispose();
  });

  it('does not re-scan already scanned lines', () => {
    const { terminal, decorations } = createMockTerminalForDecoration([
      'error in src/foo.ts here',
    ]);

    const manager = new FilePathDecorationManager(terminal);
    onWriteParsedCallback!();
    expect(decorations.length).toBe(1);

    // Trigger again without cursor moving — no new decorations
    onWriteParsedCallback!();
    expect(decorations.length).toBe(1);

    manager.dispose();
  });

  it('scans new lines when cursor advances', () => {
    const lines = [
      'error in src/a.ts here',
      'error in src/b.ts here',
    ];
    const { terminal, decorations } = createMockTerminalForDecoration(lines);

    // Start with cursor at line 0
    (terminal.buffer.active as unknown as { cursorY: number }).cursorY = 0;
    const manager = new FilePathDecorationManager(terminal);
    onWriteParsedCallback!();
    expect(decorations.length).toBe(1);

    // Cursor advances to line 1
    (terminal.buffer.active as unknown as { cursorY: number }).cursorY = 1;
    onWriteParsedCallback!();
    expect(decorations.length).toBe(2);

    manager.dispose();
  });

  it('disposes all markers and decorations on dispose', () => {
    const { terminal, markers, decorations } = createMockTerminalForDecoration([
      'error in src/foo.ts here',
    ]);

    const manager = new FilePathDecorationManager(terminal);
    onWriteParsedCallback!();

    expect(markers.length).toBeGreaterThan(0);
    expect(decorations.length).toBeGreaterThan(0);

    manager.dispose();

    for (const m of markers) expect(m.dispose).toHaveBeenCalled();
    for (const d of decorations) expect(d.dispose).toHaveBeenCalled();
  });

  describe('per-link hover highlighting', () => {
    it('highlightAt adds file-path-decoration-hover to the matching decoration', () => {
      const { terminal, decorations } = createMockTerminalForDecoration([
        'error in src/foo.ts here',
      ]);

      const manager = new FilePathDecorationManager(terminal);
      onWriteParsedCallback!();

      expect(decorations.length).toBe(1);
      const el = decorations[0].element!;
      expect(el.classList.contains('file-path-decoration-hover')).toBe(false);

      // "src/foo.ts" starts at column 9 in "error in src/foo.ts here"
      manager.highlightAt(0, 9);
      expect(el.classList.contains('file-path-decoration-hover')).toBe(true);

      manager.dispose();
    });

    it('highlightAt does not affect non-matching decorations', () => {
      const { terminal, decorations } = createMockTerminalForDecoration([
        'error in src/a.ts and src/b.ts here',
      ]);

      const manager = new FilePathDecorationManager(terminal);
      onWriteParsedCallback!();

      expect(decorations.length).toBe(2);
      const elA = decorations[0].element!;
      const elB = decorations[1].element!;

      // Highlight only the first path (src/a.ts at column 9)
      manager.highlightAt(0, 9);
      expect(elA.classList.contains('file-path-decoration-hover')).toBe(true);
      expect(elB.classList.contains('file-path-decoration-hover')).toBe(false);

      manager.dispose();
    });

    it('unhighlightAll removes hover class from all decorations', () => {
      const { terminal, decorations } = createMockTerminalForDecoration([
        'error in src/a.ts and src/b.ts here',
      ]);

      const manager = new FilePathDecorationManager(terminal);
      onWriteParsedCallback!();

      // Highlight both
      manager.highlightAt(0, 9);
      const elA = decorations[0].element!;
      expect(elA.classList.contains('file-path-decoration-hover')).toBe(true);

      manager.unhighlightAll();
      expect(elA.classList.contains('file-path-decoration-hover')).toBe(false);

      manager.dispose();
    });
  });
});
