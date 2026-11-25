// Preloaded into the isolated Tower (`node --require`) by harness.mjs, never into any other Tower.
// Appends one JSON line per HTTP request and WebSocket upgrade the Tower receives to
// $COCKPIT_REQUEST_LOG, so spec scenario 21 can compare the request counts of two view layouts.
// The product is unchanged; the Tower has no request log of its own.

const fs = require('node:fs');
const http = require('node:http');

const log = process.env.COCKPIT_REQUEST_LOG;
if (!log) throw new Error('request-log.cjs: COCKPIT_REQUEST_LOG is not set (preload it only from harness.mjs)');

const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function emitWithLog(event, req, ...rest) {
  if (event === 'request' || event === 'upgrade') {
    const line = { at: Date.now(), kind: event, method: req.method, url: req.url };
    fs.appendFileSync(log, `${JSON.stringify(line)}\n`);
  }
  return emit.call(this, event, req, ...rest);
};
