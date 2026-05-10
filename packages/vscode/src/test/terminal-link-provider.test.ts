import * as assert from 'assert';
import * as vscode from 'vscode';
import { BuilderTerminalLinkProvider } from '../terminal-link-provider.js';
import type { ConnectionManager } from '../connection-manager.js';
import type { TerminalManager } from '../terminal-manager.js';

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

function fakeContext(line: string): vscode.TerminalLinkContext {
	return { line, terminal: undefined as unknown as vscode.Terminal };
}

suite('BuilderTerminalLinkProvider.provideTerminalLinks', () => {
	test('matches a single builder role name', () => {
		const provider = new BuilderTerminalLinkProvider(
			{} as ConnectionManager,
			{} as TerminalManager,
			fakeOutputChannel(),
		);
		const links = provider.provideTerminalLinks(fakeContext('starting builder-spir-153 now'));
		assert.strictEqual(links.length, 1);
		assert.strictEqual(links[0].roleId, 'builder-spir-153');
		assert.strictEqual(links[0].length, 'builder-spir-153'.length);
	});

	test('matches multiple builder role names on one line', () => {
		const provider = new BuilderTerminalLinkProvider(
			{} as ConnectionManager,
			{} as TerminalManager,
			fakeOutputChannel(),
		);
		const links = provider.provideTerminalLinks(
			fakeContext('builders: builder-spir-153, builder-bugfix-42, builder-air-7'),
		);
		assert.deepStrictEqual(
			links.map((l) => l.roleId),
			['builder-spir-153', 'builder-bugfix-42', 'builder-air-7'],
		);
	});

	test('does not match non-builder text', () => {
		const provider = new BuilderTerminalLinkProvider(
			{} as ConnectionManager,
			{} as TerminalManager,
			fakeOutputChannel(),
		);
		assert.strictEqual(provider.provideTerminalLinks(fakeContext('no role here')).length, 0);
		assert.strictEqual(provider.provideTerminalLinks(fakeContext('foo-bar-baz')).length, 0);
	});

	test('does not call into ConnectionManager during render', () => {
		// Regression pin for PR #682 review #2: provideTerminalLinks fires per
		// terminal paint, so it must stay pure. Tower lookup belongs in
		// handleTerminalLink (click handler).
		const guarded = {
			getClient: () => { throw new Error('getClient called from provideTerminalLinks'); },
			getWorkspacePath: () => { throw new Error('getWorkspacePath called from provideTerminalLinks'); },
		} as unknown as ConnectionManager;
		const provider = new BuilderTerminalLinkProvider(guarded, {} as TerminalManager, fakeOutputChannel());

		assert.doesNotThrow(() =>
			provider.provideTerminalLinks(fakeContext('builder-spir-1 builder-spir-2 builder-spir-3')),
		);
	});

	test('regex re-resets between calls (statefulness check)', () => {
		const provider = new BuilderTerminalLinkProvider(
			{} as ConnectionManager,
			{} as TerminalManager,
			fakeOutputChannel(),
		);
		// Module-level regex with /g flag carries lastIndex; provider must reset.
		const a = provider.provideTerminalLinks(fakeContext('builder-spir-1'));
		const b = provider.provideTerminalLinks(fakeContext('builder-spir-2'));
		assert.strictEqual(a.length, 1);
		assert.strictEqual(b.length, 1);
	});
});
