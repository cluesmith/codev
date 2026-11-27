/**
 * Fixtures for the sending Tower's cloud tests (Spec 1967, plan phase 7): a clock whose
 * timers a test fires by moving it on, a bare Tower session on the stand-in relay (so a peer
 * is listed online, and answers `delivered`), and loopback servers that misbehave in the ways
 * something in front of the cloud might.
 *
 * Test code: it writes the protocol's answer itself, as the stand-in's own tests do.
 */

import http from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocket, createWebSocketStream } from 'ws';
import type { CloudTimers } from '../../peer/cloud-client.js';
import type { StandInRelay } from './stand-in-relay.js';

// ===========================================================================
// A clock with timers
// ===========================================================================

/** A clock that only moves when told, with timers that fire as it passes them. */
export class ManualClock {
  private nextId = 0;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  constructor(public now: number) {}

  readonly timers: CloudTimers = {
    setTimeout: (callback, ms) => {
      const id = ++this.nextId;
      this.pending.set(id, { at: this.now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => {
      this.pending.delete(handle as number);
    },
  };

  /** How long each waiting timer has left, shortest first. */
  waiting(): number[] {
    return [...this.pending.values()].map((t) => t.at - this.now).sort((a, b) => a - b);
  }

  /** Move the clock on, firing each timer that falls due, earliest first. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = end;
  }
}

// ===========================================================================
// A bare Tower session on the stand-in
// ===========================================================================

export interface BareSession {
  authOk: Record<string, unknown>;
  /** Requests that came down the tunnel, by path. */
  received: string[];
  close(): void;
}

/**
 * Connect as a Tower: `auth` stating protocol 1 and the switch, then an HTTP/2 server over
 * the socket that answers every forwarded request `delivered`. Resolves once `auth_ok` (or
 * `auth_error`) has arrived; the stand-in has the session by then.
 */
export function connectBareSession(relay: StandInRelay, apiKey: string, remoteMessaging: 'on' | 'off' = 'on'): Promise<BareSession> {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/tunnel`, { perMessageDeflate: false });
  const received: string[] = [];
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', apiKey, peer: { protocols: [1], remoteMessaging } })));
    ws.once('message', (data) => {
      const authOk = JSON.parse(data.toString()) as Record<string, unknown>;
      if (authOk.type === 'auth_ok') {
        const socketStream = createWebSocketStream(ws);
        socketStream.on('error', () => {});
        const server = http2.createServer();
        server.on('session', (session) => session.on('error', () => {}));
        server.on('stream', (stream, headers) => {
          stream.on('error', () => {});
          received.push(String(headers[':path']));
          stream.resume();
          stream.on('end', () => {
            if (stream.destroyed) return;
            stream.respond({ ':status': 200, 'content-type': 'application/json', 'x-codev-peer-outcome': 'delivered' });
            stream.end('{"v":1,"outcome":"delivered"}');
          });
        });
        server.emit('connection', socketStream);
      }
      resolve({ authOk, received, close: () => ws.terminate() });
    });
  });
}

// ===========================================================================
// Servers that misbehave
// ===========================================================================

export interface FaultServer {
  url: string;
  /** Requests received, oldest first. */
  requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders }>;
  close(): Promise<void>;
}

/** A loopback HTTP server with the given handler; `close` also drops any connection it holds open. */
export async function faultServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<FaultServer> {
  const requests: FaultServer['requests'] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers });
    handler(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
