// Tests for tower-cron.ts (Spec 399 Phase 2)
// Core scheduler: YAML loading, task execution, condition evaluation, message delivery

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ============================================================================
// Mocks
// ============================================================================

const mockExec = vi.fn();
vi.mock('node:child_process', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}));

const { mockGetGlobalDb, mockDb } = vi.hoisted(() => {
  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
      run: vi.fn(),
    }),
  };
  return {
    mockGetGlobalDb: vi.fn(() => mockDb),
    mockDb,
  };
});

vi.mock('../db/index.js', () => ({
  getGlobalDb: mockGetGlobalDb,
}));

// Mock tower-messages — broadcastMessage and isResolveError
const mockBroadcastMessage = vi.fn();
vi.mock('../servers/tower-messages.js', () => ({
  broadcastMessage: (...args: unknown[]) => mockBroadcastMessage(...args),
  isResolveError: (r: unknown) => typeof r === 'object' && r !== null && 'code' in r,
}));

// Mock message-format
const mockFormatBuilderMessage = vi.fn((id: string, msg: string) => `[${id}] ${msg}`);
vi.mock('../utils/message-format.js', () => ({
  formatBuilderMessage: (...args: unknown[]) => mockFormatBuilderMessage(...(args as [string, string])),
}));

import {
  loadWorkspaceTasks,
  getTaskId,
  evaluateCondition,
  executeTask,
  initCron,
  shutdownCron,
  getAllTasks,
  tick,
} from '../servers/tower-cron.js';
import type { CronTask, CronDeps } from '../servers/tower-cron.js';

// ============================================================================
// Helpers
// ============================================================================

let testDir: string;

function createTestWorkspace(): string {
  const ws = join(testDir, 'test-workspace');
  mkdirSync(join(ws, '.af-cron'), { recursive: true });
  return ws;
}

function writeTaskFile(ws: string, filename: string, content: string): void {
  writeFileSync(join(ws, '.af-cron', filename), content, 'utf-8');
}

function makeMockDeps(overrides?: Partial<CronDeps>): CronDeps {
  const mockSession = { write: vi.fn() };
  return {
    log: vi.fn(),
    getKnownWorkspacePaths: () => [],
    resolveTarget: vi.fn().mockReturnValue({
      terminalId: 'term-123',
      workspacePath: '/test/ws',
      agent: 'architect',
    }),
    getTerminalManager: () => ({
      getSession: vi.fn().mockReturnValue(mockSession),
    }),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  testDir = join(tmpdir(), `cron-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  vi.clearAllMocks();
  // Reset mockDb.prepare to default
  mockDb.prepare.mockReturnValue({
    get: vi.fn().mockReturnValue(undefined),
    run: vi.fn(),
  });
});

afterEach(() => {
  shutdownCron();
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
});

describe('loadWorkspaceTasks', () => {
  it('loads a valid YAML task file', () => {
    const ws = createTestWorkspace();
    writeTaskFile(ws, 'ci-health.yaml', `
name: CI Health Check
schedule: "*/30 * * * *"
command: echo test
message: "CI has issues"
`);

    const tasks = loadWorkspaceTasks(ws);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe('CI Health Check');
    expect(tasks[0].schedule).toBe('*/30 * * * *');
    expect(tasks[0].command).toBe('echo test');
    expect(tasks[0].message).toBe('CI has issues');
    expect(tasks[0].enabled).toBe(true);
    expect(tasks[0].target).toBe('architect');
    expect(tasks[0].timeout).toBe(30);
    expect(tasks[0].workspacePath).toBe(ws);
  });

  it('sets default values for optional fields', () => {
    const ws = createTestWorkspace();
    writeTaskFile(ws, 'task.yaml', `
name: Test Task
schedule: "@hourly"
command: echo hi
message: "Hello"
`);

    const tasks = loadWorkspaceTasks(ws);
    expect(tasks[0].target).toBe('architect');
    expect(tasks[0].timeout).toBe(30);
    expect(tasks[0].enabled).toBe(true);
    expect(tasks[0].condition).toBeUndefined();
    expect(tasks[0].cwd).toBeUndefined();
  });

  it('respects explicit field values', () => {
    const ws = createTestWorkspace();
    writeTaskFile(ws, 'task.yaml', `
name: Custom
schedule: "@daily"
command: ls
message: "Done"
target: builder-42
timeout: 60
enabled: false
condition: "output !== '0'"
cwd: /tmp
`);

    const tasks = loadWorkspaceTasks(ws);
    expect(tasks[0].target).toBe('builder-42');
    expect(tasks[0].timeout).toBe(60);
    expect(tasks[0].enabled).toBe(false);
    expect(tasks[0].condition).toBe("output !== '0'");
    expect(tasks[0].cwd).toBe('/tmp');
  });

  it('skips files missing required fields', () => {
    const ws = createTestWorkspace();
    const mockDeps = makeMockDeps({ getKnownWorkspacePaths: () => [ws] });
    initCron(mockDeps);

    writeTaskFile(ws, 'bad.yaml', `
name: Missing command
schedule: "@hourly"
message: "No command"
`);

    const tasks = loadWorkspaceTasks(ws);
    expect(tasks).toHaveLength(0);
    shutdownCron();
  });

  it('skips files with invalid cron schedule', () => {
    const ws = createTestWorkspace();
    const mockDeps = makeMockDeps({ getKnownWorkspacePaths: () => [ws] });
    initCron(mockDeps);

    writeTaskFile(ws, 'bad-schedule.yaml', `
name: Bad Schedule
schedule: "not a cron"
command: echo test
message: "Hello"
`);

    const tasks = loadWorkspaceTasks(ws);
    expect(tasks).toHaveLength(0);
    shutdownCron();
  });

  it('returns empty for workspace without .af-cron directory', () => {
    const ws = join(testDir, 'no-cron');
    mkdirSync(ws, { recursive: true });
    const tasks = loadWorkspaceTasks(ws);
    expect(tasks).toHaveLength(0);
  });

  it('skips non-yaml files', () => {
    const ws = createTestWorkspace();
    writeFileSync(join(ws, '.af-cron', 'README.md'), '# README', 'utf-8');
    writeTaskFile(ws, 'task.yaml', `
name: Valid Task
schedule: "@hourly"
command: echo ok
message: "OK"
`);

    const tasks = loadWorkspaceTasks(ws);
    expect(tasks).toHaveLength(1);
  });

  it('loads multiple task files', () => {
    const ws = createTestWorkspace();
    writeTaskFile(ws, 'a.yaml', `
name: Task A
schedule: "@hourly"
command: echo a
message: "A"
`);
    writeTaskFile(ws, 'b.yml', `
name: Task B
schedule: "@daily"
command: echo b
message: "B"
`);

    const tasks = loadWorkspaceTasks(ws);
    expect(tasks).toHaveLength(2);
  });
});

describe('getTaskId', () => {
  it('generates deterministic IDs', () => {
    const id1 = getTaskId('/ws', 'task');
    const id2 = getTaskId('/ws', 'task');
    expect(id1).toBe(id2);
  });

  it('generates different IDs for different tasks', () => {
    const id1 = getTaskId('/ws', 'task-a');
    const id2 = getTaskId('/ws', 'task-b');
    expect(id1).not.toBe(id2);
  });

  it('generates different IDs for different workspaces', () => {
    const id1 = getTaskId('/ws-1', 'task');
    const id2 = getTaskId('/ws-2', 'task');
    expect(id1).not.toBe(id2);
  });
});

describe('evaluateCondition', () => {
  it('evaluates simple comparison', () => {
    expect(evaluateCondition("output !== '0'", '3')).toBe(true);
    expect(evaluateCondition("output !== '0'", '0')).toBe(false);
  });

  it('evaluates numeric comparison', () => {
    expect(evaluateCondition("parseInt(output) > 0", '5')).toBe(true);
    expect(evaluateCondition("parseInt(output) > 0", '0')).toBe(false);
  });

  it('returns falsy for empty output when condition checks for content', () => {
    expect(evaluateCondition("output.length > 0", '')).toBe(false);
  });

  it('throws on invalid condition', () => {
    expect(() => evaluateCondition("this is not valid js }{", 'test')).toThrow();
  });
});

describe('executeTask', () => {
  it('executes command and updates state on success', async () => {
    const ws = createTestWorkspace();
    const mockDeps = makeMockDeps({ getKnownWorkspacePaths: () => [ws] });
    initCron(mockDeps);

    // Mock exec to succeed
    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: Function) => {
      cb(null, 'output-text', '');
    });

    const task: CronTask = {
      name: 'Test Task',
      schedule: '*/30 * * * *',
      enabled: true,
      command: 'echo test',
      message: 'Result: ${output}',
      target: 'architect',
      timeout: 30,
      workspacePath: ws,
    };

    const { result, output } = await executeTask(task);
    expect(result).toBe('success');
    expect(output).toBe('output-text');

    // Should have called exec
    expect(mockExec).toHaveBeenCalledWith(
      'echo test',
      expect.objectContaining({
        cwd: ws,
        timeout: 30000,
      }),
      expect.any(Function),
    );

    // Should update DB
    expect(mockDb.prepare).toHaveBeenCalled();
  });

  it('handles command failure', async () => {
    const ws = createTestWorkspace();
    const mockDeps = makeMockDeps({ getKnownWorkspacePaths: () => [ws] });
    initCron(mockDeps);

    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: Function) => {
      const err = new Error('command failed') as Error & { stdout: string; stderr: string };
      err.stdout = 'partial output';
      err.stderr = 'error output';
      cb(err, 'partial output', 'error output');
    });

    const task: CronTask = {
      name: 'Failing Task',
      schedule: '*/30 * * * *',
      enabled: true,
      command: 'false',
      message: 'Task failed',
      target: 'architect',
      timeout: 30,
      workspacePath: ws,
    };

    const { result, output } = await executeTask(task);
    expect(result).toBe('failure');
    expect(output).toBe('partial output');
  });

  it('skips notification when condition is falsy', async () => {
    const ws = createTestWorkspace();
    const mockSession = { write: vi.fn() };
    const mockDeps = makeMockDeps({
      getKnownWorkspacePaths: () => [ws],
      getTerminalManager: () => ({
        getSession: () => mockSession,
      }),
    });
    initCron(mockDeps);

    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: Function) => {
      cb(null, '0', '');
    });

    const task: CronTask = {
      name: 'Conditional',
      schedule: '*/30 * * * *',
      enabled: true,
      command: 'echo 0',
      condition: "output !== '0'",
      message: 'Should not be sent',
      target: 'architect',
      timeout: 30,
      workspacePath: ws,
    };

    await executeTask(task);
    // Session.write should NOT be called (condition is false)
    expect(mockSession.write).not.toHaveBeenCalled();
  });

  it('sends notification when condition is truthy', async () => {
    const ws = createTestWorkspace();
    const mockSession = { write: vi.fn() };
    const mockDeps = makeMockDeps({
      getKnownWorkspacePaths: () => [ws],
      getTerminalManager: () => ({
        getSession: () => mockSession,
      }),
    });
    initCron(mockDeps);

    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: Function) => {
      cb(null, '3', '');
    });

    const task: CronTask = {
      name: 'Notify',
      schedule: '*/30 * * * *',
      enabled: true,
      command: 'echo 3',
      condition: "output !== '0'",
      message: 'Found ${output} issues',
      target: 'architect',
      timeout: 30,
      workspacePath: ws,
    };

    await executeTask(task);
    // Session.write should be called (condition met)
    expect(mockSession.write).toHaveBeenCalled();
    // Verify broadcastMessage was called
    expect(mockBroadcastMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message',
        from: expect.objectContaining({ agent: 'af-cron' }),
        content: 'Found 3 issues',
      }),
    );
  });

  it('replaces ${output} in message template', async () => {
    const ws = createTestWorkspace();
    const mockSession = { write: vi.fn() };
    const mockDeps = makeMockDeps({
      getKnownWorkspacePaths: () => [ws],
      getTerminalManager: () => ({
        getSession: () => mockSession,
      }),
    });
    initCron(mockDeps);

    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: Function) => {
      cb(null, '42', '');
    });

    const task: CronTask = {
      name: 'Template',
      schedule: '*/30 * * * *',
      enabled: true,
      command: 'echo 42',
      message: 'Count is ${output} items',
      target: 'architect',
      timeout: 30,
      workspacePath: ws,
    };

    await executeTask(task);
    expect(mockFormatBuilderMessage).toHaveBeenCalledWith('af-cron', 'Count is 42 items');
  });

  it('uses custom cwd when specified', async () => {
    const ws = createTestWorkspace();
    const mockDeps = makeMockDeps({ getKnownWorkspacePaths: () => [ws] });
    initCron(mockDeps);

    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: Function) => {
      cb(null, '', '');
    });

    const task: CronTask = {
      name: 'Custom CWD',
      schedule: '*/30 * * * *',
      enabled: true,
      command: 'ls',
      message: 'Done',
      target: 'architect',
      timeout: 30,
      cwd: '/custom/path',
      workspacePath: ws,
    };

    await executeTask(task);
    expect(mockExec).toHaveBeenCalledWith(
      'ls',
      expect.objectContaining({ cwd: '/custom/path' }),
      expect.any(Function),
    );
  });
});

describe('tick', () => {
  it('executes due tasks and skips non-due tasks', async () => {
    const ws = createTestWorkspace();

    // Create a task with "@startup" which tick should skip
    writeTaskFile(ws, 'startup.yaml', `
name: Startup Only
schedule: "@startup"
command: echo startup
message: "Started"
`);

    // Create a task with "* * * * *" which is always due
    writeTaskFile(ws, 'always.yaml', `
name: Always Run
schedule: "* * * * *"
command: echo always
message: "Always"
`);

    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: Function) => {
      cb(null, 'ok', '');
    });

    const mockDeps = makeMockDeps({ getKnownWorkspacePaths: () => [ws] });
    initCron(mockDeps);

    // Wait for startup tasks to finish, then clear call count
    await new Promise(resolve => setTimeout(resolve, 50));
    mockExec.mockClear();

    await tick();

    // Only the "Always Run" task should have been executed by tick (not startup)
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith(
      'echo always',
      expect.any(Object),
      expect.any(Function),
    );
  });
});

describe('initCron / shutdownCron', () => {
  it('starts and stops the scheduler', () => {
    vi.useFakeTimers();
    const ws = createTestWorkspace();
    const mockDeps = makeMockDeps({ getKnownWorkspacePaths: () => [ws] });

    initCron(mockDeps);
    expect(mockDeps.log).toHaveBeenCalledWith('INFO', 'Cron scheduler initialized');

    shutdownCron();
    expect(mockDeps.log).toHaveBeenCalledWith('INFO', 'Cron scheduler stopped');
    vi.useRealTimers();
  });

  it('runs startup tasks on init', async () => {
    const ws = createTestWorkspace();
    writeTaskFile(ws, 'startup.yaml', `
name: Boot Task
schedule: "@startup"
command: echo booted
message: "Booted up"
`);

    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: Function) => {
      cb(null, 'booted', '');
    });

    const mockDeps = makeMockDeps({ getKnownWorkspacePaths: () => [ws] });
    initCron(mockDeps);

    // Give the async startup a moment to run
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mockExec).toHaveBeenCalledWith(
      'echo booted',
      expect.any(Object),
      expect.any(Function),
    );
  });
});

describe('getAllTasks', () => {
  it('returns tasks across all workspaces', () => {
    const ws1 = join(testDir, 'ws1');
    const ws2 = join(testDir, 'ws2');
    mkdirSync(join(ws1, '.af-cron'), { recursive: true });
    mkdirSync(join(ws2, '.af-cron'), { recursive: true });
    writeFileSync(join(ws1, '.af-cron', 'a.yaml'), `
name: Task A
schedule: "@hourly"
command: echo a
message: "A"
`, 'utf-8');
    writeFileSync(join(ws2, '.af-cron', 'b.yaml'), `
name: Task B
schedule: "@daily"
command: echo b
message: "B"
`, 'utf-8');

    const mockDeps = makeMockDeps({ getKnownWorkspacePaths: () => [ws1, ws2] });
    initCron(mockDeps);

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.name).sort()).toEqual(['Task A', 'Task B']);
  });

  it('returns empty when cron not initialized', () => {
    shutdownCron(); // Ensure not initialized
    expect(getAllTasks()).toEqual([]);
  });
});
