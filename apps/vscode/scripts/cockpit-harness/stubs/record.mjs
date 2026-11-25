// Shared body of the afx / porch / codev recording stubs. Appends one JSON line per call to
// $COCKPIT_STUB_LOG and exits 0 without doing anything else, so a CLI-shelling action is verified
// by its recorded argv and cwd. `codev --version` prints $COCKPIT_CODEV_VERSION so the extension's
// preflight passes. Outside the harness (no log configured) it refuses loudly.

import fs from 'node:fs';

const [tool, ...argv] = process.argv.slice(2);
const log = process.env.COCKPIT_STUB_LOG;
if (!log) {
  console.error(`cockpit-harness stub '${tool}' was invoked outside the harness (COCKPIT_STUB_LOG unset)`);
  process.exit(97);
}

const entry = {
  at: new Date().toISOString(),
  tool,
  argv,
  cwd: process.cwd(),
  caller: process.env.COCKPIT_STUB_CALLER ?? 'unknown',
};
fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);

if (tool === 'codev' && argv.length === 1 && argv[0] === '--version') {
  const version = process.env.COCKPIT_CODEV_VERSION;
  if (!version) {
    console.error('cockpit-harness stub: COCKPIT_CODEV_VERSION is unset');
    process.exit(97);
  }
  console.log(version);
}
