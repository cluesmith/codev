/**
 * A Node `tail -f` (Spec 1658): native Windows has no `tail`, so
 * `afx tower log --follow` follows the log through this instead.
 *
 * Like `tail -f`: the last `initialLines` lines first, then every appended
 * byte as it arrives. A file that shrinks (rotated or truncated) is followed
 * again from its start.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export interface FollowFileOptions {
  /** Lines printed before following. Default 10, as `tail`. */
  initialLines?: number;
  /** Poll interval in milliseconds. Default 500. */
  intervalMs?: number;
}

const INITIAL_TAIL_BYTES = 64 * 1024;

export interface FileFollower {
  stop(): void;
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** Bytes `[start, end)` of `file`, or an empty buffer when it cannot be read. */
function readRange(file: string, start: number, end: number): Buffer {
  if (end <= start) {
    return Buffer.alloc(0);
  }
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const buffer = Buffer.alloc(end - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** The text of the last `count` lines of `content`. */
function lastLines(content: string, count: number): string {
  if (count <= 0 || content === '') {
    return '';
  }
  let body = content;
  if (body.endsWith('\n')) {
    body = body.slice(0, -1);
  }
  const lines = body.split('\n');
  return `${lines.slice(-count).join('\n')}\n`;
}

export function followFile(file: string, onData: (text: string) => void, options: FollowFileOptions = {}): FileFollower {
  const initialLines = options.initialLines ?? 10;
  const intervalMs = options.intervalMs ?? 500;

  let offset = sizeOf(file);
  // The initial lines come from the file's tail only, so a large log is not read whole.
  const tailStart = Math.max(0, offset - INITIAL_TAIL_BYTES);
  const initial = lastLines(readRange(file, tailStart, offset).toString('utf-8'), initialLines);
  if (initial !== '') {
    onData(initial);
  }

  // A chunk boundary can split a multi-byte character; the decoder carries it over.
  const decoder = new StringDecoder('utf8');
  const timer = setInterval(() => {
    const size = sizeOf(file);
    if (size < offset) {
      offset = 0;
    }
    if (size === offset) {
      return;
    }
    const chunk = readRange(file, offset, size);
    offset += chunk.length;
    const text = decoder.write(chunk);
    if (text !== '') {
      onData(text);
    }
  }, intervalMs);

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
