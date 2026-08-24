const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/** Extension host bundle — Node / CJS, loaded by VS Code. */
const extensionConfig = {
	entryPoints: ['src/extension.ts'],
	bundle: true,
	format: 'cjs',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'node',
	outfile: 'dist/extension.js',
	external: ['vscode', 'bufferutil', 'utf-8-validate'],
	logLevel: 'silent',
	plugins: [esbuildProblemMatcherPlugin],
};

/**
 * Review-canvas webview bundle (#859) — a browser IIFE that mounts the React
 * `@cluesmith/codev-artifact-canvas` surface inside the custom editor's webview.
 * React + the canvas + its deps are bundled (the canvas package is not
 * npm-published; each host bundles it). `process.env.NODE_ENV` is defined so
 * React's dev/prod branch resolves in the browser (no Node `process` there).
 * The imported `default-theme.css` is emitted next to the JS as
 * `dist/webview/markdown-preview.css`.
 */
const webviewConfig = {
	entryPoints: ['src/markdown-preview/webview/main.ts'],
	bundle: true,
	format: 'iife',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'browser',
	outfile: 'dist/webview/markdown-preview.js',
	loader: { '.css': 'css' },
	define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
	logLevel: 'silent',
	plugins: [esbuildProblemMatcherPlugin],
};

/**
 * Contextual panel webview bundle (#1049) — a browser IIFE mounting the React shell for the
 * contextual `Codev` bottom-panel view. Same shape as the markdown-preview `webviewConfig`
 * (its `default-theme.css` analogue here is the local `styles.css`, emitted next to the JS as
 * `dist/webview/contextual-panel.css`).
 */
const contextualPanelWebviewConfig = {
	entryPoints: ['src/contextual-panel/webview/main.ts'],
	bundle: true,
	format: 'iife',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'browser',
	outfile: 'dist/webview/contextual-panel.js',
	loader: { '.css': 'css' },
	define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
	logLevel: 'silent',
	plugins: [esbuildProblemMatcherPlugin],
};

async function main() {
	const configs = [extensionConfig, webviewConfig, contextualPanelWebviewConfig];
	if (watch) {
		const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
		await Promise.all(contexts.map((c) => c.watch()));
	} else {
		await Promise.all(
			configs.map(async (c) => {
				const ctx = await esbuild.context(c);
				await ctx.rebuild();
				await ctx.dispose();
			}),
		);
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
