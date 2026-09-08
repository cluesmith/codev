/**
 * Shared fake ports for the Spec 1470 self-refresh tests.
 *
 * Extracted at Phase 8 so the porch↔orchestrator integration test drives the
 * SAME fakes the unit tests do, rather than a second set that could drift into
 * behaving differently from the ones every other assertion is written against.
 *
 * These are behavioural fakes, not spies: `FakeFs` really stores what is
 * written, `FakeTerminal` really records what was scheduled. That is what lets
 * an integration test assert the refresh actually happened rather than that a
 * function was called.
 */

import type {
  SelfRefreshClockPort,
  SelfRefreshFsPort,
  SelfGitPort,
  SelfTerminalPort,
} from '../../commands/reset/self.js';
import type { ResolvedBuilderContext } from '../../commands/reset/context.js';

export const WORKTREE = '/tmp/fake-worktree';
export const NONCE = 'abc123def456';

export class FakeFs implements SelfRefreshFsPort {
  files = new Map<string, string>();
  /** Paths whose write() should throw, to exercise the R1 failure. */
  failWrites = new Set<string>();
  /** Paths whose remove() should throw. */
  failRemoves = new Set<string>();

  sizeOf(path: string): number | null {
    const v = this.files.get(path);
    return v === undefined ? null : Buffer.byteLength(v, 'utf-8');
  }
  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }
  write(path: string, content: string): void {
    if (this.failWrites.has(path)) throw new Error(`simulated write failure: ${path}`);
    this.files.set(path, content);
  }
  remove(path: string): void {
    if (this.failRemoves.has(path)) throw new Error(`simulated remove failure: ${path}`);
    this.files.delete(path);
  }
  exists(path: string): boolean {
    return this.files.has(path);
  }
}

export class FakeClock implements SelfRefreshClockPort {
  t = 1_000;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

export class FakeTerminal implements SelfTerminalPort {
  scheduled: Array<{ message: string; delaySeconds: number }> = [];
  raw: string[] = [];
  failSchedule = false;
  failRaw = false;

  async scheduleReentry(message: string, delaySeconds: number): Promise<void> {
    if (this.failSchedule) throw new Error('simulated Tower unreachable');
    this.scheduled.push({ message, delaySeconds });
  }
  async sendRaw(text: string): Promise<void> {
    if (this.failRaw) throw new Error('simulated PTY write failure');
    this.raw.push(text);
  }
}

export class FakeGit implements SelfGitPort {
  dirty = false;
  hasUncommittedTrackedChanges(): boolean {
    return this.dirty;
  }
}

export function makeContext(overrides: Partial<ResolvedBuilderContext> = {}): ResolvedBuilderContext {
  return {
    builderId: 'spir-1470',
    worktree: WORKTREE,
    branch: 'builder/spir-1470',
    protocol: 'spir',
    protocolSource: 'status.yaml',
    mode: 'strict',
    modeSource: 'builder-prompt',
    harnessName: 'claude',
    harness: {} as ResolvedBuilderContext['harness'],
    porch: {
      projectId: '1470',
      projectName: 'automatic-builder-context-refr',
      phase: 'implement',
    } as ResolvedBuilderContext['porch'],
    specName: '1470-automatic-builder-context-refr',
    specPath: 'codev/specs/1470-automatic-builder-context-refr.md',
    planPath: 'codev/plans/1470-automatic-builder-context-refr.md',
    issueNumber: '1470',
    ...overrides,
  } as ResolvedBuilderContext;
}

