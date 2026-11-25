// Prevention for ide-server mode (the tripwire incident of 2026-11-24): the VS Code server, and
// every process it starts, runs under a macOS sandbox profile that denies outbound TCP to the
// owner's Tower port on any host. The kernel refuses the connect() with EPERM, so an extension
// that resolves the wrong port cannot reach the owner's Tower at all. The tripwire stays as the
// second line: it detects a connection and stops the run.
//
// The profile also denies a canary port: a throwaway listener the harness opens for the launch.
// The launch wrapper, already inside the sandbox, connects to it before it execs the server, and
// stops unless the connect is refused. So every launch proves that the profile applies to the
// server's process tree without ever connecting to the owner's port.

import fs from 'node:fs';
import { Refusal } from './preflight.mjs';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
/** The wrapper's exit status when the canary connect was not refused. */
export const CANARY_EXIT_CODE = 97;

/** The profile: allow everything, except outbound TCP to each of `ports` on any host (IPv4 and IPv6). */
export function networkDenyProfile(ports) {
  return ['(version 1)', '(allow default)', ...ports.map((p) => `(deny network-outbound (remote tcp "*:${p}"))`)].join('\n') + '\n';
}

/** Refuse (gate 5) unless sandbox-exec exists and `file` holds exactly the profile denying `ports`. */
export function gateSandbox(file, ports) {
  if (!fs.existsSync(SANDBOX_EXEC)) throw new Refusal(5, `${SANDBOX_EXEC} is missing; ide-server mode runs the server only inside its network sandbox`);
  const want = networkDenyProfile(ports);
  const got = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
  if (got !== want) throw new Refusal(5, `the sandbox profile ${file} is not the one denying ${ports.join(', ')}`);
}

const CANARY_JS = [
  "const s=require('net').connect(Number(process.argv[1]),'127.0.0.1');",
  `s.on('connect',()=>process.exit(${CANARY_EXIT_CODE}));`,
  "s.on('error',(e)=>process.exit(e.code==='EPERM'?0:98));",
].join('');

/**
 * The command that runs `cmd args` inside the sandbox `profile`, after the canary: `node` (an
 * absolute path) connects to `canaryPort`, and only a refused connect (EPERM) lets `cmd` start.
 * The wrapper is a /bin/sh that execs `cmd`, so the recorded pid's command line keeps `cmd`'s args.
 */
export function sandboxedCommand({ profile, node, canaryPort, cmd, args }) {
  const script = [
    'node="$1"; port="$2"; shift 2',
    `"$node" -e "$COCKPIT_SANDBOX_CANARY" "$port"; rc=$?`,
    `if [ "$rc" != 0 ]; then echo "sandbox canary: the connect to :$port was not refused (exit $rc); not starting $1" >&2; exit ${CANARY_EXIT_CODE}; fi`,
    'exec "$@"',
  ].join('\n');
  return {
    cmd: SANDBOX_EXEC,
    args: ['-f', profile, '/bin/sh', '-c', script, 'cockpit-sandbox', node, String(canaryPort), cmd, ...args],
    env: { COCKPIT_SANDBOX_CANARY: CANARY_JS },
  };
}
