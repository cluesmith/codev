import * as assert from 'assert';
import * as vscode from 'vscode';
import { SSEClient } from '../sse-client.js';

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

function envelope(type: string, body: object = {}): string {
	return JSON.stringify({ type, body: JSON.stringify(body) });
}

function feed(client: SSEClient, eventType: string, data: string): void {
	(client as unknown as { handleEvent(t: string, d: string): void }).handleEvent(eventType, data);
}

suite('SSEClient.handleEvent', () => {
	test('drops heartbeat and ping events', () => {
		const received: Array<[string, string]> = [];
		const client = new SSEClient('http://localhost:0', fakeOutputChannel(), () => {});
		client.onEvent((t, d) => received.push([t, d]));

		feed(client, 'heartbeat', '');
		feed(client, 'ping', '');

		assert.strictEqual(received.length, 0);
		client.dispose();
	});

	test('dispatches every non-heartbeat event without coalescing', () => {
		// Regression for PR #682 review #1: a same-window builder-spawned must
		// not be dropped behind a coalesced overview-changed.
		const received: Array<[string, string]> = [];
		const client = new SSEClient('http://localhost:0', fakeOutputChannel(), () => {});
		client.onEvent((t, d) => received.push([t, d]));

		feed(client, '', envelope('overview-changed'));
		feed(client, '', envelope('builder-spawned', { terminalId: 't1', roleId: 'builder-spir-1', workspacePath: '/x' }));
		feed(client, '', envelope('overview-changed'));

		assert.strictEqual(received.length, 3);
		assert.match(received[0][1], /overview-changed/);
		assert.match(received[1][1], /builder-spawned/);
		assert.match(received[2][1], /overview-changed/);
		client.dispose();
	});

	test('malformed and empty data are dispatched verbatim (no throw)', () => {
		const received: Array<[string, string]> = [];
		const client = new SSEClient('http://localhost:0', fakeOutputChannel(), () => {});
		client.onEvent((t, d) => received.push([t, d]));

		assert.doesNotThrow(() => feed(client, '', 'not-json'));
		assert.doesNotThrow(() => feed(client, '', ''));

		assert.strictEqual(received.length, 2);
		client.dispose();
	});

	test('listener exceptions do not break the dispatch loop', () => {
		const ok: string[] = [];
		const client = new SSEClient('http://localhost:0', fakeOutputChannel(), () => {});
		client.onEvent(() => { throw new Error('boom'); });
		client.onEvent((t) => ok.push(t));

		feed(client, '', envelope('overview-changed'));

		assert.deepStrictEqual(ok, ['']);
		client.dispose();
	});
});
