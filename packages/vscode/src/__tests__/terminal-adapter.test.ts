import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Keep this regression suite in the Vitest harness so fake timers come from the
// package's existing dev dependency instead of introducing a Sinon dependency.
const wsMock = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;

    readonly listeners = new Map<string, Listener[]>();
    readyState = MockWebSocket.OPEN;
    binaryType = '';

    constructor(readonly url: string) {
      sockets.push(this);
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      // Real WebSocket close events are asynchronous relative to the caller.
      // Tests explicitly emit `close` when they need to exercise handlers.
    }

    send(): void {}
  }

  const sockets: MockWebSocket[] = [];

  return { MockWebSocket, sockets };
});

vi.mock('ws', () => ({ default: wsMock.MockWebSocket }));

vi.mock('@cluesmith/codev-types', () => ({
  FRAME_DATA: 0x00,
  FRAME_CONTROL: 0x01,
}));

vi.mock('@cluesmith/codev-core/escape-buffer', () => ({
  EscapeBuffer: class {
    write(text: string): string {
      return text;
    }
  },
}));

vi.mock('vscode', () => {
  class FakeEventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];

    readonly event = (listener: (e: T) => void): { dispose: () => void } => {
      this.listeners.push(listener);
      return {
        dispose: () => {
          this.listeners = this.listeners.filter((l) => l !== listener);
        },
      };
    };

    fire(e: T): void {
      this.listeners.forEach((listener) => listener(e));
    }

    dispose(): void {
      this.listeners = [];
    }
  }

  return { EventEmitter: FakeEventEmitter };
});

const { CodevPseudoterminal } = await import('../terminal-adapter.js');

type TerminalInternals = {
  ws: InstanceType<typeof wsMock.MockWebSocket> | null;
  disposed: boolean;
  decoder: TextDecoder;
  escapeBuffer: unknown;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  maxReconnectAttempts: number;
  connect(): void;
  reconnect(wsUrl?: string): void;
  scheduleReconnect(): void;
};

const fakeOutputChannel = (): vscode.OutputChannel => ({
  name: 'test',
  append: () => {},
  appendLine: () => {},
  clear: () => {},
  show: () => {},
  hide: () => {},
  dispose: () => {},
  replace: () => {},
});

function makeTerminal(): TerminalInternals {
  return new CodevPseudoterminal(
    'ws://localhost:0',
    null,
    fakeOutputChannel(),
  ) as unknown as TerminalInternals;
}

afterEach(() => {
  vi.useRealTimers();
  wsMock.sockets.length = 0;
});

describe('CodevPseudoterminal reconnect close handling', () => {
  it('intentional reconnect does not schedule a stray retry from stale close', () => {
    vi.useFakeTimers();

    const terminal = makeTerminal();
    terminal.connect();
    const oldSocket = wsMock.sockets[0]!;

    terminal.reconnect();
    const replacementSocket = wsMock.sockets[1]!;
    expect(terminal.ws).toBe(replacementSocket);

    oldSocket.emit('close');

    expect(terminal.reconnectAttempts).toBe(0);
    expect(terminal.reconnectTimer).toBeNull();
  });

  it('genuine close schedules reconnect', () => {
    vi.useFakeTimers();

    const terminal = makeTerminal();
    terminal.connect();
    const socket = wsMock.sockets[0]!;

    socket.emit('close');

    expect(terminal.reconnectAttempts).toBe(1);
    expect(terminal.reconnectTimer).not.toBeNull();
  });
});

describe('CodevPseudoterminal scheduled reconnect state reset', () => {
  it('resets decoder and EscapeBuffer before connect()', () => {
    vi.useFakeTimers();

    const terminal = makeTerminal();
    const originalDecoder = terminal.decoder;
    const originalEscapeBuffer = terminal.escapeBuffer;

    let decoderAtConnectTime: TextDecoder | undefined;
    let escapeBufferAtConnectTime: unknown;
    terminal.connect = function () {
      decoderAtConnectTime = terminal.decoder;
      escapeBufferAtConnectTime = terminal.escapeBuffer;
    };

    terminal.scheduleReconnect();
    vi.advanceTimersByTime(1000);

    expect(decoderAtConnectTime).toBeDefined();
    expect(escapeBufferAtConnectTime).toBeDefined();
    expect(decoderAtConnectTime).not.toBe(originalDecoder);
    expect(escapeBufferAtConnectTime).not.toBe(originalEscapeBuffer);
  });
});

describe('CodevPseudoterminal backoff cadence and max attempts', () => {
  it('records the expected 1s, 2s, 4s, 8s, 16s, then 30s-capped cadence', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const terminal = makeTerminal();
    const connectTimes: number[] = [];
    terminal.connect = function () {
      connectTimes.push(Date.now());
    };

    const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000];

    for (const delay of expectedDelays) {
      terminal.scheduleReconnect();
      vi.advanceTimersByTime(delay);
    }

    expect(terminal.reconnectAttempts).toBe(10);
    expect(connectTimes).toEqual([1000, 3000, 7000, 15000, 31000, 61000, 91000, 121000, 151000, 181000]);
  });

  it('gives up after maxReconnectAttempts', () => {
    vi.useFakeTimers();

    const terminal = makeTerminal();
    let connectCount = 0;
    terminal.connect = function () {
      connectCount += 1;
    };

    for (let i = 0; i < terminal.maxReconnectAttempts; i++) {
      terminal.scheduleReconnect();
      vi.advanceTimersByTime(60_000);
    }

    terminal.scheduleReconnect();

    expect(terminal.reconnectAttempts).toBe(terminal.maxReconnectAttempts + 1);
    expect(connectCount).toBe(terminal.maxReconnectAttempts);
    expect(terminal.reconnectTimer).toBeNull();
  });
});
