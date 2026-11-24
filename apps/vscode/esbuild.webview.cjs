/**
 * The Work and Decisions panels' webview bundles (Spec 1963), as esbuild options. A module of its
 * own so `esbuild.js` builds from it and `decisions-webview-bundle.test.ts` builds the very same
 * bundle, with no `dist` from an earlier build: CI runs the unit tests without one.
 *
 * - `jsx: 'automatic'` is explicit: these are the first TSX sources under `apps/vscode`, and
 *   esbuild would otherwise read the nearest `tsconfig.json`, which sets no `jsx`;
 * - the imported stylesheets (the shared views', the markdown theme and `vscode-theme.css`) are
 *   emitted next to the script as one `.css`;
 * - `process.env.NODE_ENV` is defined so React's dev/prod branch resolves in the browser.
 */

const path = require('node:path');

/** @param {{ production: boolean }} options @returns {import('esbuild').BuildOptions} */
function decisionsWebviewConfig({ production }) {
	return {
		absWorkingDir: __dirname,
		entryPoints: ['src/workspace-views/webview/decisions-main.tsx'],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outfile: 'dist/webview/decisions.js',
		loader: { '.css': 'css' },
		jsx: 'automatic',
		tsconfig: path.join(__dirname, 'tsconfig.webview.json'),
		define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
		logLevel: 'silent',
	};
}

module.exports = { decisionsWebviewConfig };
