/**
 * Mode-aware diff codelenses (#1037): exactly one lens per anchor, whose
 * title + command follow `codev.diffCodelensMode` — `Comment for Builder` /
 * `codev.commentForBuilder` in comment mode, `Forward to Builder` /
 * `codev.forwardToBuilder` in forward mode (the default, preserving #789).
 * A configuration change must re-emit lenses (and re-sync the mode context
 * key) so the flip is live.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  class EventEmitter<T> {
    private handlers: Array<(e: T) => void> = [];
    event = (fn: (e: T) => void): { dispose(): void } => {
      this.handlers.push(fn);
      return { dispose() {} };
    };
    fire(value: T): void {
      for (const fn of this.handlers) { fn(value); }
    }
    dispose(): void {}
  }
  const state = {
    mode: 'comment' as string,
    configListeners: [] as Array<(e: unknown) => void>,
    setContextCalls: [] as Array<{ key: string; value: unknown }>,
    capturedProvider: undefined as unknown,
  };
  return { EventEmitter, state };
});

vi.mock('vscode', () => ({
  EventEmitter: h.EventEmitter,
  Range: class {
    constructor(
      public startLine: number,
      public startChar: number,
      public endLine: number,
      public endChar: number,
    ) {}
  },
  CodeLens: class {
    constructor(public range: unknown, public command: { title: string; command: string; arguments: unknown[] }) {}
  },
  languages: {
    registerCodeLensProvider: (_sel: unknown, prov: unknown) => {
      h.state.capturedProvider = prov;
      return { dispose() {} };
    },
  },
  commands: {
    executeCommand: (cmd: string, ...args: unknown[]) => {
      if (cmd === 'setContext') {
        h.state.setContextCalls.push({ key: args[0] as string, value: args[1] });
      }
      return Promise.resolve(undefined);
    },
  },
  window: {
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
  },
  workspace: {
    getConfiguration: () => ({ get: () => h.state.mode }),
    onDidChangeConfiguration: (fn: (e: unknown) => void) => {
      h.state.configListeners.push(fn);
      return { dispose() {} };
    },
  },
}));

const {
  activateDiffInjectCodeLens,
  setDiffInjectSession,
  DIFF_CODELENS_MODE_KEY,
} = await import('../diff-inject-codelens.js');

interface Lens { command: { title: string; command: string; arguments: unknown[] } }

const ENTRY = {
  fsPath: '/wt/pkg/src/a.ts',
  builderId: 'pir-9',
  relPath: 'pkg/src/a.ts',
  hunks: [{ start: 5, end: 8 }],
};

const DOC = { uri: { fsPath: ENTRY.fsPath, toString: () => `file://${ENTRY.fsPath}` }, lineCount: 100 };
const TOKEN = { isCancellationRequested: false };

async function lenses(): Promise<Lens[]> {
  const provider = h.state.capturedProvider as {
    provideCodeLenses(doc: unknown, token: unknown): Promise<Lens[]>;
  };
  return provider.provideCodeLenses(DOC, TOKEN);
}

beforeEach(() => {
  h.state.mode = 'comment';
  h.state.configListeners.length = 0;
  h.state.setContextCalls.length = 0;
  activateDiffInjectCodeLens({ subscriptions: [] } as never);
  setDiffInjectSession([ENTRY]);
});

describe('diff codelens mode (#1037)', () => {
  it('comment mode emits Comment for Builder lenses with the comment command', async () => {
    const all = await lenses();
    expect(all.length).toBeGreaterThan(0);
    for (const lens of all) {
      expect(lens.command.command).toBe('codev.commentForBuilder');
      expect(lens.command.title).toMatch(/^Comment for Builder/);
    }
    // File-level lens carries a null range (whole-file comment); the hunk lens
    // carries its 1-based range for the queued comment's anchor.
    expect(all[0]!.command.arguments).toEqual(['pir-9', ENTRY.fsPath, ENTRY.relPath, null]);
    const hunkLens = all.find(l => l.command.title.includes('lines 5-8'));
    expect(hunkLens?.command.arguments).toEqual(['pir-9', ENTRY.fsPath, ENTRY.relPath, { start: 5, end: 8 }]);
  });

  it('forward mode emits the original #789 lenses untouched', async () => {
    h.state.mode = 'forward';
    const all = await lenses();
    for (const lens of all) {
      expect(lens.command.command).toBe('codev.forwardToBuilder');
      expect(lens.command.title).toMatch(/^Forward to Builder/);
    }
    expect(all[0]!.command.arguments).toEqual(['pir-9', 'pkg/src/a.ts ']);
  });

  it('an unset or unrecognized setting value falls back to forward (the default)', async () => {
    h.state.mode = undefined as never;
    let all = await lenses();
    expect(all[0]!.command.command).toBe('codev.forwardToBuilder');
    h.state.mode = 'garbage';
    all = await lenses();
    expect(all[0]!.command.command).toBe('codev.forwardToBuilder');
  });

  it('exactly one lens per anchor line in either mode', async () => {
    for (const mode of ['comment', 'forward']) {
      h.state.mode = mode;
      const all = (await lenses()) as Array<Lens & { range: { startLine: number } }>;
      const anchorLines = all.map(l => l.range.startLine);
      expect(new Set(anchorLines).size).toBe(anchorLines.length);
    }
  });

  it('a configuration change re-emits lenses and re-syncs the mode context key', () => {
    const provider = h.state.capturedProvider as {
      onDidChangeCodeLenses(fn: () => void): { dispose(): void };
    };
    let fired = 0;
    provider.onDidChangeCodeLenses(() => { fired += 1; });

    h.state.mode = 'forward';
    for (const listener of h.state.configListeners) {
      listener({ affectsConfiguration: (section: string) => section === DIFF_CODELENS_MODE_KEY });
    }
    expect(fired).toBeGreaterThan(0);
    const modeSyncs = h.state.setContextCalls.filter(c => c.key === DIFF_CODELENS_MODE_KEY);
    expect(modeSyncs[modeSyncs.length - 1]!.value).toBe('forward');
  });

  it('an unrelated configuration change does not re-emit lenses', () => {
    const provider = h.state.capturedProvider as {
      onDidChangeCodeLenses(fn: () => void): { dispose(): void };
    };
    let fired = 0;
    provider.onDidChangeCodeLenses(() => { fired += 1; });
    for (const listener of h.state.configListeners) {
      listener({ affectsConfiguration: () => false });
    }
    expect(fired).toBe(0);
  });
});
