/**
 * ReviewQueueStore against a real filesystem (temp dirs): create-on-first-
 * write, per-builder isolation, stale/missing worktree handling, the
 * `info/exclude` managed-block write (once, idempotent), and watcher echo
 * suppression (#1037). `vscode` is mocked minimally; fs and git are real —
 * each temp worktree is a real `git init` repo so the exclude path resolves
 * through `git rev-parse --git-common-dir` exactly as in production.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const w = vi.hoisted(() => ({
  // Captured FileSystemWatcher handlers so tests can simulate OS events.
  handlers: [] as Array<(uri: { fsPath: string }) => void>,
}));

vi.mock('vscode', () => {
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
  class RelativePattern {
    constructor(public base: string, public pattern: string) {}
  }
  const capture = (fn: (uri: { fsPath: string }) => void): { dispose(): void } => {
    w.handlers.push(fn);
    return { dispose() {} };
  };
  return {
    EventEmitter,
    RelativePattern,
    workspace: {
      createFileSystemWatcher: vi.fn(() => ({
        onDidCreate: capture,
        onDidChange: capture,
        onDidDelete: capture,
        dispose: vi.fn(),
      })),
    },
  };
});

const { ReviewQueueStore } = await import('../review-queue/store.js');
const { QUEUE_FILE_RELPATH } = await import('../review-queue/queue.js');

let tmpRoot: string;

function makeComment(id: string, file = 'src/a.ts') {
  return {
    id,
    createdAt: '2026-08-06T10:00:00Z',
    file,
    lineRange: { start: 1, end: 2 },
    body: `note ${id}`,
  };
}

/** A real git repo posing as a builder worktree. */
async function makeWorktree(name: string): Promise<string> {
  const dir = path.join(tmpRoot, name);
  await fs.mkdir(dir, { recursive: true });
  execFileSync('git', ['-C', dir, 'init', '-q']);
  return dir;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-queue-'));
  w.handlers.length = 0;
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('ReviewQueueStore', () => {
  it('creates the queue file on first add and round-trips through load', async () => {
    const wt = await makeWorktree('pir-1');
    const store = new ReviewQueueStore(undefined);
    store.registerWorktree('pir-1', wt);

    await store.add('pir-1', makeComment('c1'));
    const onDisk = JSON.parse(await fs.readFile(path.join(wt, QUEUE_FILE_RELPATH), 'utf8'));
    expect(onDisk.builderId).toBe('pir-1');
    expect(onDisk.comments).toHaveLength(1);

    const fresh = new ReviewQueueStore(undefined);
    fresh.registerWorktree('pir-1', wt);
    expect(await fresh.load('pir-1')).toEqual([makeComment('c1')]);
    store.dispose();
    fresh.dispose();
  });

  it('keeps two builders’ queues isolated', async () => {
    const wtA = await makeWorktree('pir-a');
    const wtB = await makeWorktree('pir-b');
    const store = new ReviewQueueStore(undefined);
    store.registerWorktree('pir-a', wtA);
    store.registerWorktree('pir-b', wtB);

    await store.add('pir-a', makeComment('a1'));
    await store.add('pir-b', makeComment('b1'));
    await store.add('pir-a', makeComment('a2'));

    expect(store.getComments('pir-a').map(c => c.id)).toEqual(['a1', 'a2']);
    expect(store.getComments('pir-b').map(c => c.id)).toEqual(['b1']);
    expect(store.buildersWithPending().sort()).toEqual(['pir-a', 'pir-b']);
    store.dispose();
  });

  it('edit and remove persist through the file', async () => {
    const wt = await makeWorktree('pir-1');
    const store = new ReviewQueueStore(undefined);
    store.registerWorktree('pir-1', wt);
    await store.add('pir-1', makeComment('c1'));
    await store.add('pir-1', makeComment('c2'));

    await store.edit('pir-1', 'c1', 'revised');
    await store.remove('pir-1', ['c2']);

    const fresh = new ReviewQueueStore(undefined);
    fresh.registerWorktree('pir-1', wt);
    const loaded = await fresh.load('pir-1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.body).toBe('revised');
    store.dispose();
    fresh.dispose();
  });

  it('loads a vanished worktree (afx cleanup) as an empty queue', async () => {
    const wt = await makeWorktree('pir-1');
    const store = new ReviewQueueStore(undefined);
    store.registerWorktree('pir-1', wt);
    await store.add('pir-1', makeComment('c1'));

    await fs.rm(wt, { recursive: true, force: true });
    expect(await store.load('pir-1')).toEqual([]);
    expect(store.count('pir-1')).toBe(0);
    store.dispose();
  });

  it('mutation without a registered worktree throws instead of writing nowhere', async () => {
    const store = new ReviewQueueStore(undefined);
    await expect(store.add('ghost', makeComment('c1'))).rejects.toThrow(/no worktree/i);
    store.dispose();
  });

  it('writes the info/exclude managed block exactly once', async () => {
    const wt = await makeWorktree('pir-1');
    const store = new ReviewQueueStore(undefined);
    store.registerWorktree('pir-1', wt);

    await store.add('pir-1', makeComment('c1'));
    await store.add('pir-1', makeComment('c2'));

    const exclude = await fs.readFile(path.join(wt, '.git', 'info', 'exclude'), 'utf8');
    const hits = exclude.split('\n').filter(l => l.trim() === QUEUE_FILE_RELPATH);
    expect(hits).toHaveLength(1);
    expect(exclude).toContain('.builder-*');

    // The block makes git actually ignore both the queue file and the family.
    await fs.writeFile(path.join(wt, '.builder-prompt.txt'), 'x');
    const status = execFileSync('git', ['-C', wt, 'status', '--porcelain'], { encoding: 'utf8' });
    expect(status).not.toContain(QUEUE_FILE_RELPATH);
    expect(status).not.toContain('.builder-prompt.txt');
    store.dispose();
  });

  it('a second session merges idempotently into an existing exclude file', async () => {
    const wt = await makeWorktree('pir-1');
    const first = new ReviewQueueStore(undefined);
    first.registerWorktree('pir-1', wt);
    await first.add('pir-1', makeComment('c1'));
    first.dispose();

    const second = new ReviewQueueStore(undefined);
    second.registerWorktree('pir-1', wt);
    await second.add('pir-1', makeComment('c2'));
    second.dispose();

    const exclude = await fs.readFile(path.join(wt, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter(l => l.includes('managed block'))).toHaveLength(1);
  });

  it('preloadFromDisk surfaces persisted queues before any diff is opened (reload gap)', async () => {
    // Two builders under `.builders/` wrote queues in a previous session.
    for (const id of ['pir-a', 'pir-b']) {
      const dir = path.join(tmpRoot, '.builders', id, '.codev');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(tmpRoot, '.builders', id, QUEUE_FILE_RELPATH),
        JSON.stringify({ version: 1, builderId: id, comments: [makeComment(`${id}-c1`)] }),
        'utf8',
      );
    }
    // One worktree without a queue file must not register.
    await fs.mkdir(path.join(tmpRoot, '.builders', 'pir-empty'), { recursive: true });

    const store = new ReviewQueueStore(tmpRoot);
    await store.preloadFromDisk();
    expect(store.buildersWithPending().sort()).toEqual(['pir-a', 'pir-b']);
    expect(store.getComments('pir-a')[0]!.id).toBe('pir-a-c1');
    store.dispose();
  });

  it('preloadFromDisk is a no-op without a .builders directory', async () => {
    const store = new ReviewQueueStore(tmpRoot);
    await store.preloadFromDisk();
    expect(store.buildersWithPending()).toEqual([]);
    store.dispose();
  });

  it('suppresses watcher echoes of its own writes but honors external changes', async () => {
    // Real timers: the 200ms debounce chains into real fs I/O, so the test
    // waits past the window instead of faking the clock.
    const pastDebounce = (): Promise<void> => new Promise(r => setTimeout(r, 300));
    const wt = await makeWorktree('pir-1');
    const store = new ReviewQueueStore(tmpRoot);
    store.registerWorktree('pir-1', wt);
    const events: string[] = [];
    store.onDidChangeQueue(id => events.push(id));

    await store.add('pir-1', makeComment('c1'));
    expect(events).toEqual(['pir-1']);

    // The OS watcher reports our own write back — must not re-fire.
    const queuePath = path.join(wt, QUEUE_FILE_RELPATH);
    for (const fire of w.handlers) { fire({ fsPath: queuePath }); }
    await pastDebounce();
    expect(events).toEqual(['pir-1']);

    // A genuinely external write (another window) must fire.
    await fs.writeFile(
      queuePath,
      JSON.stringify({ version: 1, builderId: 'pir-1', comments: [makeComment('c1'), makeComment('c2')] }),
      'utf8',
    );
    for (const fire of w.handlers) { fire({ fsPath: queuePath }); }
    await pastDebounce();
    expect(events).toEqual(['pir-1', 'pir-1']);
    expect(store.getComments('pir-1').map(c => c.id)).toEqual(['c1', 'c2']);
    store.dispose();
  });

  it('fires onDidChangeQueue on mutations with the builder id', async () => {
    const wt = await makeWorktree('pir-1');
    const store = new ReviewQueueStore(undefined);
    store.registerWorktree('pir-1', wt);
    const events: string[] = [];
    store.onDidChangeQueue(id => events.push(id));

    await store.add('pir-1', makeComment('c1'));
    await store.remove('pir-1', ['c1']);
    expect(events).toEqual(['pir-1', 'pir-1']);
    store.dispose();
  });
});
