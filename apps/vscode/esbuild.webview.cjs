/**
 * The Work and Decisions panels' webview bundles (Spec 1963), as esbuild options. A module of its
 * own so `esbuild.js` builds from it and the bundle tests (`decisions-webview-bundle.test.ts`,
 * `work-webview-bundle.test.ts`) build the very same bundles, with no `dist` from an earlier build:
 * CI runs the unit tests without one.
 *
 * - `jsx: 'automatic'` is explicit: these are the first TSX sources under `apps/vscode`, and
 *   esbuild would otherwise read the nearest `tsconfig.json`, which sets no `jsx`;
 * - the imported stylesheets (the shared views', `vscode-theme.css` and, for Decisions, the
 *   markdown theme) are emitted next to the script as one `.css`;
 * - `process.env.NODE_ENV` is defined so React's dev/prod branch resolves in the browser.
 */

const path = require('node:path');

/**
 * One panel's bundle: `src/workspace-views/webview/<name>-main.tsx` → `dist/webview/<name>.{js,css}`.
 * @param {string} name @param {{ production: boolean }} options @returns {import('esbuild').BuildOptions}
 */
function workspaceViewWebviewConfig(name, { production }) {
	return {
		absWorkingDir: __dirname,
		entryPoints: [`src/workspace-views/webview/${name}-main.tsx`],
		bundle: true,
		format: 'iife',
		minify: production,
		// Inline, as the panel inlines the bundle itself (panel-template.ts): a map file beside it
		// could not be fetched by the webview.
		sourcemap: production ? false : 'inline',
		sourcesContent: false,
		platform: 'browser',
		outfile: `dist/webview/${name}.js`,
		loader: { '.css': 'css' },
		jsx: 'automatic',
		tsconfig: path.join(__dirname, 'tsconfig.webview.json'),
		define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
		logLevel: 'silent',
	};
}

/** The Decisions panel's bundle. @param {{ production: boolean }} options */
const decisionsWebviewConfig = (options) => workspaceViewWebviewConfig('decisions', options);

/** The Work panel's bundle. @param {{ production: boolean }} options */
const workWebviewConfig = (options) => workspaceViewWebviewConfig('work', options);

module.exports = { decisionsWebviewConfig, workWebviewConfig };
