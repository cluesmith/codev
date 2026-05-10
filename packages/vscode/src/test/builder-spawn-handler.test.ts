import * as assert from 'assert';
import * as vscode from 'vscode';
import { BuilderSpawnHandler } from '../builder-spawn-handler.js';
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

interface OpenCall {
	terminalId: string;
	roleId: string;
	label: string;
}

function makeHarness(activeWorkspace: string | null = '/Users/x/repo') {
	const opens: OpenCall[] = [];
	const terminalManager = {
		openBuilder: async (terminalId: string, roleId: string, label: string) => {
			opens.push({ terminalId, roleId, label });
		},
	} as unknown as TerminalManager;

	const connectionManager = {
		getWorkspacePath: () => activeWorkspace,
	} as unknown as ConnectionManager;

	const handler = new BuilderSpawnHandler(connectionManager, terminalManager, fakeOutputChannel());
	return { handler, opens };
}

function spawnEnvelope(payload: object): string {
	return JSON.stringify({ type: 'builder-spawned', body: JSON.stringify(payload) });
}

const validPayload = {
	terminalId: 't-1',
	roleId: 'builder-spir-42',
	workspacePath: '/Users/x/repo',
};

async function flush(): Promise<void> {
	// `notify` mode chains through .then() on showInformationMessage —
	// give microtasks a tick to settle before assertions.
	await new Promise((r) => setTimeout(r, 0));
}

suite('BuilderSpawnHandler', () => {
	let originalShowInfo: typeof vscode.window.showInformationMessage;
	let originalGetConfig: typeof vscode.workspace.getConfiguration;
	let infoChoice: string | undefined;
	let configMode: 'off' | 'notify' | 'auto' = 'notify';

	setup(() => {
		originalShowInfo = vscode.window.showInformationMessage;
		originalGetConfig = vscode.workspace.getConfiguration;

		(vscode.window as any).showInformationMessage = async (..._args: unknown[]) => infoChoice;

		(vscode.workspace as any).getConfiguration = (section?: string) => {
			if (section === 'codev') {
				return {
					get: <T>(_k: string, fallback: T) => (configMode as unknown as T) ?? fallback,
				} as unknown as vscode.WorkspaceConfiguration;
			}
			return originalGetConfig.call(vscode.workspace, section);
		};
	});

	teardown(() => {
		(vscode.window as any).showInformationMessage = originalShowInfo;
		(vscode.workspace as any).getConfiguration = originalGetConfig;
		infoChoice = undefined;
		configMode = 'notify';
	});

	test('ignores non-builder-spawned envelope', async () => {
		const { handler, opens } = makeHarness();
		handler.handle('', JSON.stringify({ type: 'overview-changed', body: '{}' }));
		await flush();
		assert.strictEqual(opens.length, 0);
	});

	test('ignores malformed envelope JSON without throwing', async () => {
		const { handler, opens } = makeHarness();
		assert.doesNotThrow(() => handler.handle('', 'not-json'));
		await flush();
		assert.strictEqual(opens.length, 0);
	});

	test('logs and ignores malformed payload body', async () => {
		const { handler, opens } = makeHarness();
		handler.handle('', JSON.stringify({ type: 'builder-spawned', body: 'not-json' }));
		await flush();
		assert.strictEqual(opens.length, 0);
	});

	test('ignores payload missing required fields', async () => {
		const { handler, opens } = makeHarness();
		const cases: Array<Partial<typeof validPayload>> = [
			{ ...validPayload, terminalId: '' },
			{ ...validPayload, roleId: '' },
			{ ...validPayload, workspacePath: '' },
		];
		for (const p of cases) { handler.handle('', spawnEnvelope(p)); }
		await flush();
		assert.strictEqual(opens.length, 0);
	});

	test('ignores payload from a different workspace', async () => {
		const { handler, opens } = makeHarness('/Users/x/repo');
		handler.handle('', spawnEnvelope({ ...validPayload, workspacePath: '/Users/x/other' }));
		await flush();
		assert.strictEqual(opens.length, 0);
	});

	test('accepts payload with trailing-slash workspace mismatch (path normalization)', async () => {
		// Regression for PR #682 review #5.
		configMode = 'auto';
		const { handler, opens } = makeHarness('/Users/x/repo');
		handler.handle('', spawnEnvelope({ ...validPayload, workspacePath: '/Users/x/repo/' }));
		await flush();
		assert.strictEqual(opens.length, 1);
	});

	test('dedups by terminalId', async () => {
		configMode = 'auto';
		const { handler, opens } = makeHarness();
		handler.handle('', spawnEnvelope(validPayload));
		handler.handle('', spawnEnvelope(validPayload));
		await flush();
		assert.strictEqual(opens.length, 1);
	});

	test('mode "off" skips dispatch', async () => {
		configMode = 'off';
		const { handler, opens } = makeHarness();
		handler.handle('', spawnEnvelope(validPayload));
		await flush();
		assert.strictEqual(opens.length, 0);
	});

	test('mode "auto" opens immediately', async () => {
		configMode = 'auto';
		const { handler, opens } = makeHarness();
		handler.handle('', spawnEnvelope(validPayload));
		await flush();
		assert.strictEqual(opens.length, 1);
		assert.deepStrictEqual(opens[0], {
			terminalId: 't-1',
			roleId: 'builder-spir-42',
			label: 'Codev: builder-spir-42',
		});
	});

	test('mode "notify" + Open Terminal click opens', async () => {
		configMode = 'notify';
		infoChoice = 'Open Terminal';
		const { handler, opens } = makeHarness();
		handler.handle('', spawnEnvelope(validPayload));
		await flush();
		assert.strictEqual(opens.length, 1);
	});

	test('mode "notify" + dismissed toast does not open', async () => {
		configMode = 'notify';
		infoChoice = undefined;
		const { handler, opens } = makeHarness();
		handler.handle('', spawnEnvelope(validPayload));
		await flush();
		assert.strictEqual(opens.length, 0);
	});
});
