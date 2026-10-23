// Stub Codev IDE server for Spec 1658 Phase 9 tests (run via codev-ide-server.cmd).
//
// `--version` prints the version line the real server prints (bare semver on
// line 1, a commit on line 2, CRLF), from STUB_IDE_VERSION or 1.128.0.
// `--install-extension <vsix> --force --extensions-dir <dir>` records
// STUB_IDE_EXTENSION_ID at STUB_IDE_EXTENSION_VERSION in <dir>/extensions.json,
// the index Tower reads back, and appends its argv to STUB_IDE_INSTALL_LOG.
// Otherwise it starts one long-lived child (standing in for the extension
// host), listens on --host/--port, answers every request with its URL and
// argv as JSON, and writes { pid, childPid, argv } to STUB_IDE_STATE_FILE
// once listening. With STUB_IDE_NO_LISTEN set it writes the state file and
// never listens (a server that hangs before binding).

import http from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  process.stdout.write(`${process.env.STUB_IDE_VERSION || '1.128.0'}\r\nstubcommit0000\r\nx64\r\n`);
  process.exit(0);
}

if (argv.includes('--install-extension')) {
  const dir = argv[argv.indexOf('--extensions-dir') + 1];
  const index = [{ identifier: { id: process.env.STUB_IDE_EXTENSION_ID }, version: process.env.STUB_IDE_EXTENSION_VERSION }];
  writeFileSync(join(dir, 'extensions.json'), JSON.stringify(index));
  if (process.env.STUB_IDE_INSTALL_LOG) {
    appendFileSync(process.env.STUB_IDE_INSTALL_LOG, JSON.stringify(argv) + '\n');
  }
  process.exit(0);
}

function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) return fallback;
  return argv[index + 1];
}

const host = option('--host', '127.0.0.1');
const port = Number(option('--port', '0'));

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
  stdio: 'ignore',
  windowsHide: true,
});

if (process.env.STUB_IDE_NO_LISTEN) {
  writeFileSync(process.env.STUB_IDE_STATE_FILE, JSON.stringify({ pid: process.pid, childPid: child.pid, argv }));
  setInterval(() => {}, 1 << 30);
} else {
  serve();
}

function serve() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ url: req.url, argv }));
  });

  server.listen(port, host, () => {
    const stateFile = process.env.STUB_IDE_STATE_FILE;
    if (stateFile) {
      writeFileSync(stateFile, JSON.stringify({ pid: process.pid, childPid: child.pid, argv }));
    }
  });
}
