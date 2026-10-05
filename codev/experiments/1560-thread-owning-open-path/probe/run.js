// Launch the 1560 probe in an Extension Development Host.
//   node run.js <executable> <out.json> [--proposed]
// --proposed passes --enable-proposed-api for the probe, standing in for the
// built-in-extension case (a built-in keeps its declared API proposals).
const path = require('path');
const os = require('os');
const fs = require('fs');
const { runTests } = require(path.resolve(__dirname, '../../../../apps/vscode/node_modules/@vscode/test-electron'));

async function main() {
  const [exe, out, flag] = process.argv.slice(2);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'probe1560-'));
  const launchArgs = [
    path.join(__dirname, 'ws'),
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--user-data-dir', userData,
  ];
  if (flag === '--proposed') { launchArgs.push('--enable-proposed-api', 'codev-probe.probe-1560'); }
  await runTests({
    vscodeExecutablePath: exe,
    extensionDevelopmentPath: path.join(__dirname, 'ext'),
    extensionTestsPath: path.join(__dirname, 'ext', 'runner.js'),
    launchArgs,
    extensionTestsEnv: { PROBE_OUT: path.resolve(out), PROBE_ROUTES: process.env.PROBE_ROUTES || '' },
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
