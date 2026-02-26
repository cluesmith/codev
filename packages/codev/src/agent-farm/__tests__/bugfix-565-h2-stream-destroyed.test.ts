/**
 * Regression test for Bugfix #565: Tower crash on ERR_HTTP2_INVALID_STREAM
 *
 * When the tunnel WebSocket disconnects while a proxy request is in-flight,
 * the H2 stream is destroyed but the local HTTP response callback still fires,
 * calling stream.respond() on the dead stream. This must not throw.
 *
 * The fix adds `if (stream.destroyed) return;` guards before every
 * stream.respond() call in handleH2Stream, handleWebSocketConnect, and
 * proxyHttpRequest.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Readable } from 'node:stream';
import { TunnelClient } from '../lib/tunnel-client.js';

/** Minimal mock of ServerHttp2Stream with destroyed=true */
function createDestroyedStream() {
  const stream = new EventEmitter() as any;
  stream.destroyed = true;
  stream.respond = vi.fn(() => {
    throw new Error('ERR_HTTP2_INVALID_STREAM: The stream has been destroyed');
  });
  stream.end = vi.fn();
  stream.write = vi.fn();
  stream.destroy = vi.fn();
  stream.pipe = vi.fn(() => stream);
  return stream;
}

/** Minimal mock of ServerHttp2Stream with destroyed=false */
function createLiveStream() {
  const stream = new EventEmitter() as any;
  stream.destroyed = false;
  stream.respond = vi.fn();
  stream.end = vi.fn();
  stream.write = vi.fn();
  stream.destroy = vi.fn();
  stream.pipe = vi.fn(() => stream);
  return stream;
}

function createTunnelClient(): TunnelClient {
  return new TunnelClient({
    serverUrl: 'https://codevos.ai',
    apiKey: 'ctk_test',
    towerId: 'test-tower',
    localPort: 4100,
  });
}

describe('Bugfix #565: stream.destroyed guard before stream.respond()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handleH2Stream: blocklist respond is skipped when stream is destroyed', () => {
    const client = createTunnelClient();
    const stream = createDestroyedStream();

    // Call handleH2Stream with a blocked path on a destroyed stream
    // handleH2Stream is private, so we access it directly
    (client as any).handleH2Stream(stream, {
      ':method': 'GET',
      ':path': '/api/tunnel/something',
    });

    // stream.respond should NOT have been called (guard prevented it)
    expect(stream.respond).not.toHaveBeenCalled();
  });

  it('handleH2Stream: metadata respond is skipped when stream is destroyed', () => {
    const client = createTunnelClient();
    const stream = createDestroyedStream();

    (client as any).handleH2Stream(stream, {
      ':method': 'GET',
      ':path': '/__tower/metadata',
    });

    expect(stream.respond).not.toHaveBeenCalled();
  });

  it('proxyHttpRequest: respond is skipped when stream is destroyed during proxy', async () => {
    const client = createTunnelClient();
    const stream = createDestroyedStream();

    // Mock http.request to capture the callback and invoke it with a mock response
    const mockProxyRes = new Readable({ read() { this.push(null); } }) as any;
    mockProxyRes.statusCode = 200;
    mockProxyRes.headers = { 'content-type': 'text/plain' };
    // Track if resume was called (the guard calls proxyRes.resume() to drain)
    mockProxyRes.resume = vi.fn();

    const mockReq = new EventEmitter() as any;
    mockReq.end = vi.fn();
    mockReq.destroy = vi.fn();
    mockReq.destroyed = false;

    vi.spyOn(http, 'request').mockImplementation((_opts: any, cb: any) => {
      // Invoke the response callback synchronously
      if (cb) cb(mockProxyRes);
      return mockReq;
    });

    // stream.pipe is called to pipe request body — make it a no-op
    stream.pipe = vi.fn();
    stream.on = vi.fn();

    (client as any).proxyHttpRequest(stream, {
      ':method': 'GET',
      ':path': '/test',
    }, 'GET', '/test');

    // stream.respond should NOT have been called (guard prevented it)
    expect(stream.respond).not.toHaveBeenCalled();
    // proxyRes.resume() should have been called to drain the response
    expect(mockProxyRes.resume).toHaveBeenCalled();
  });

  it('proxyHttpRequest: respond works normally when stream is alive', async () => {
    const client = createTunnelClient();
    const stream = createLiveStream();

    const mockProxyRes = new Readable({ read() { this.push(null); } }) as any;
    mockProxyRes.statusCode = 200;
    mockProxyRes.headers = { 'content-type': 'text/plain' };
    mockProxyRes.pipe = vi.fn();
    mockProxyRes.on = vi.fn();

    const mockReq = new EventEmitter() as any;
    mockReq.end = vi.fn();
    mockReq.destroy = vi.fn();
    mockReq.destroyed = false;

    vi.spyOn(http, 'request').mockImplementation((_opts: any, cb: any) => {
      if (cb) cb(mockProxyRes);
      return mockReq;
    });

    stream.pipe = vi.fn();
    stream.on = vi.fn();

    (client as any).proxyHttpRequest(stream, {
      ':method': 'GET',
      ':path': '/test',
    }, 'GET', '/test');

    // stream.respond SHOULD have been called (stream is alive)
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ':status': 200 })
    );
  });
});
