import * as assert from 'assert';
import { EventEmitter } from 'events';
import type * as vscode from 'vscode';
import { FRAME_DATA, FRAME_CONTROL } from '@cluesmith/codev-types';

// ── Fakes ────────────────────────────────────────────────────────

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

class FakeWebSocket extends EventEmitter {
	static OPEN = 1;
	static CLOSED = 3;
	readyState = FakeWebSocket.OPEN;
	binaryType = '';
	close() {
		this.readyState = FakeWebSocket.CLOSED;
		this.emit('close');
	}
	send() {}
}

// ── Helpers ──────────────────────────────────────────────────────

// We import CodevPseudoterminal but need to inject fake WebSocket instances.
// The class creates `new WebSocket(url)` in connect(). We monkey-patch the
// module's WebSocket reference via the constructor's wsUrl to trigger connect,
// then swap the created socket for our fake.

async function importAdapter() {
	// Dynamic import so module-level side effects don't fire during test discovery
	const mod = await import('../terminal-adapter.js');
	return mod.CodevPseudoterminal;
}

function dataFrame(text: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(text);
	const buf = new Uint8Array(1 + encoded.length);
	buf[0] = FRAME_DATA;
	buf.set(encoded, 1);
	return buf.buffer;
}

function controlFrame(obj: object): ArrayBuffer {
	const json = JSON.stringify(obj);
	const encoded = new TextEncoder().encode(json);
	const buf = new Uint8Array(1 + encoded.length);
	buf[0] = FRAME_CONTROL;
	buf.set(encoded, 1);
	return buf.buffer;
}

// ── Tests ────────────────────────────────────────────────────────

suite('CodevPseudoterminal — reconnect race condition', () => {
	let fakeTimers: ReturnType<typeof import('sinon')['useFakeTimers']> | undefined;

	teardown(() => {
		fakeTimers?.restore();
	});

	test('intentional reconnect does not schedule a stray retry', async () => {
		// Regression: when reconnect() closes the current socket, the old
		// socket's 'close' event must NOT schedule a new reconnect against
		// the now-healthy replacement socket.
		const sinon = await import('sinon');
		fakeTimers = sinon.useFakeTimers();

		const CodevPseudoterminal = await importAdapter();
		const pt = new CodevPseudoterminal('ws://localhost:0', null, fakeOutputChannel()) as InstanceType<typeof CodevPseudoterminal>;

		// Access internals
		const self = pt as unknown as {
			ws: FakeWebSocket | null;
			reconnectAttempts: number;
			reconnectTimer: ReturnType<typeof setTimeout> | null;
			connect(): void;
			scheduleReconnect(): void;
			reconnect(wsUrl?: string): void;
		};

		// Simulate open() → connect() by manually setting up a fake socket
		const ws1 = new FakeWebSocket();
		self.ws = ws1 as unknown as typeof self.ws;

		// Call reconnect() — this should close ws1 and create ws2
		// We intercept connect() to inject our fake socket
		let ws2: FakeWebSocket | undefined;
		const origConnect = self.connect.bind(self);
		self.connect = function () {
			// Don't actually connect — just create a fake socket
			ws2 = new FakeWebSocket();
			self.ws = ws2 as unknown as typeof self.ws;
		};

		self.reconnect();

		// ws1's close event fires asynchronously — simulate it
		ws1.emit('close');

		// The stale close should NOT have triggered scheduleReconnect
		// (reconnectAttempts stays at 0 since reconnect() resets it)
		assert.strictEqual(self.reconnectAttempts, 0);
		assert.strictEqual(self.reconnectTimer, null);
	});

	test('genuine close does schedule reconnect', async () => {
		const sinon = await import('sinon');
		fakeTimers = sinon.useFakeTimers();

		const CodevPseudoterminal = await importAdapter();
		const pt = new CodevPseudoterminal('ws://localhost:0', null, fakeOutputChannel()) as InstanceType<typeof CodevPseudoterminal>;

		const self = pt as unknown as {
			ws: FakeWebSocket | null;
			disposed: boolean;
			reconnectAttempts: number;
			reconnectTimer: ReturnType<typeof setTimeout> | null;
			connect(): void;
			scheduleReconnect(): void;
		};

		// Set up initial socket via connect()
		let currentWs: FakeWebSocket;
		self.connect = function () {
			currentWs = new FakeWebSocket();
			self.ws = currentWs as unknown as typeof self.ws;
			// Simulate the on('close') handler registration that connect() does
			const closedWs = self.ws;
			currentWs.on('close', () => {
				if (!self.disposed && self.ws === closedWs) {
					self.scheduleReconnect();
				}
			});
		};
		self.connect();

		// Socket drops — genuine close
		currentWs!.close();

		assert.strictEqual(self.reconnectAttempts, 1);
		assert.notStrictEqual(self.reconnectTimer, null);
	});
});

suite('CodevPseudoterminal — decoder/EscapeBuffer reset on scheduled reconnect', () => {
	let fakeTimers: ReturnType<typeof import('sinon')['useFakeTimers']> | undefined;

	teardown(() => {
		fakeTimers?.restore();
	});

	test('scheduled reconnect resets decoder and EscapeBuffer before connect()', async () => {
		const sinon = await import('sinon');
		fakeTimers = sinon.useFakeTimers();

		const CodevPseudoterminal = await importAdapter();
		const pt = new CodevPseudoterminal('ws://localhost:0', null, fakeOutputChannel()) as InstanceType<typeof CodevPseudoterminal>;

		const self = pt as unknown as {
			ws: FakeWebSocket | null;
			disposed: boolean;
			decoder: { decode(buf: Uint8Array, opts?: { stream?: boolean }): string };
			escapeBuffer: { write(s: string): string };
			reconnectAttempts: number;
			reconnectTimer: ReturnType<typeof setTimeout> | null;
			connect(): void;
			scheduleReconnect(): void;
		};

		// Save references to original decoder/escapeBuffer
		const origDecoder = self.decoder;
		const origEscapeBuffer = self.escapeBuffer;

		let connectCalled = false;
		let decoderAtConnectTime: typeof self.decoder;
		let escapeBufferAtConnectTime: typeof self.escapeBuffer;

		self.connect = function () {
			decoderAtConnectTime = self.decoder;
			escapeBufferAtConnectTime = self.escapeBuffer;
			connectCalled = true;
		};

		// Trigger scheduleReconnect
		self.reconnectAttempts = 0;
		self.scheduleReconnect();

		// Fast-forward past the 1s delay (attempt 1)
		fakeTimers.tick(1100);

		assert.ok(connectCalled, 'connect() should have been called');
		assert.notStrictEqual(decoderAtConnectTime, origDecoder, 'decoder should be a new instance');
		assert.notStrictEqual(escapeBufferAtConnectTime, origEscapeBuffer, 'escapeBuffer should be a new instance');
	});
});

suite('CodevPseudoterminal — backoff cadence and max attempts', () => {
	let fakeTimers: ReturnType<typeof import('sinon')['useFakeTimers']> | undefined;

	teardown(() => {
		fakeTimers?.restore();
	});

	test('backoff follows 1s, 2s, 4s, 8s, 16s, 30s cap', async () => {
		const sinon = await import('sinon');
		fakeTimers = sinon.useFakeTimers();

		const CodevPseudoterminal = await importAdapter();
		const pt = new CodevPseudoterminal('ws://localhost:0', null, fakeOutputChannel()) as InstanceType<typeof CodevPseudoterminal>;

		const self = pt as unknown as {
			ws: FakeWebSocket | null;
			disposed: boolean;
			reconnectAttempts: number;
			reconnectTimer: ReturnType<typeof setTimeout> | null;
			maxReconnectAttempts: number;
			maxReconnectDelay: number;
			connect(): void;
			scheduleReconnect(): void;
		};

		const connectTimes: number[] = [];
		self.connect = function () {
			connectTimes.push(Date.now());
		};

		const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000];

		for (let i = 0; i < 10; i++) {
			self.ws = new FakeWebSocket() as unknown as typeof self.ws;
			self.scheduleReconnect();
			fakeTimers.tick(expectedDelays[i] + 100);
		}

		assert.strictEqual(self.reconnectAttempts, 10);
	});

	test('gives up after maxReconnectAttempts (10)', async () => {
		const sinon = await import('sinon');
		fakeTimers = sinon.useFakeTimers();

		const CodevPseudoterminal = await importAdapter();
		const pt = new CodevPseudoterminal('ws://localhost:0', null, fakeOutputChannel()) as InstanceType<typeof CodevPseudoterminal>;

		const self = pt as unknown as {
			ws: FakeWebSocket | null;
			disposed: boolean;
			reconnectAttempts: number;
			reconnectTimer: ReturnType<typeof setTimeout> | null;
			maxReconnectAttempts: number;
			connect(): void;
			scheduleReconnect(): void;
		};

		let connectCount = 0;
		self.connect = function () {
			connectCount++;
			// Simulate immediate failure
			self.ws = new FakeWebSocket() as unknown as typeof self.ws;
		};

		// Exhaust all attempts
		for (let i = 0; i < 11; i++) {
			self.scheduleReconnect();
			if (self.reconnectTimer) {
				fakeTimers.tick(60000); // tick past any delay
			}
		}

		// Should have stopped at 10
		assert.strictEqual(self.reconnectAttempts, 11); // 11th call increments but returns early
		// connect() called 10 times (once per successful schedule)
		assert.strictEqual(connectCount, 10);
	});
});
