import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

// Bundle the plugin into the .sdPlugin bundle's bin/ entry the manifest's
// CodePath points at. The Elgato runtime launches this as a Node process and
// hands it the Stream Deck WebSocket port via argv; everything (incl. the SDK
// and its `ws` dependency) is bundled into the single file.
const config = {
  entryPoints: ['src/plugin.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: 'com.cluesmith.codev.sdPlugin/bin/plugin.js',
  sourcemap: true,
  sourcesContent: false,
  // esm output of CJS deps (ws) needs these shims so `require`/__dirname resolve.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log('[watch] esbuild watching…');
} else {
  await esbuild.build(config);
}
