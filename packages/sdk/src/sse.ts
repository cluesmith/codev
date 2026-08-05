/**
 * Tower SSE decoding, lifted from `@cluesmith/codev-client` (issue #1189
 * absorption). Pure and synchronous so it is unit-testable without a stream.
 */

/** A decoded Tower SSE event (envelope `{ type, body }` on the `data:` field). */
export interface SseEnvelope {
  type: string;
  body: unknown;
}

/**
 * Parse newly-arrived SSE text, invoking `onEnvelope` for each complete event.
 * Returns the unconsumed tail to prepend to the next chunk. Tower emits each
 * event as a JSON envelope on the `data:` field with no `event:` name, so we
 * decode `data:` ourselves.
 */
export function parseSseText(
  buffer: string,
  onEnvelope: (env: SseEnvelope) => void,
): string {
  const lines = buffer.split('\n');
  const tail = lines.pop() ?? '';
  let data = '';
  for (const line of lines) {
    if (line.startsWith('data:')) {
      data = line.slice(5).trim();
    } else if (line === '' && data) {
      try {
        const env = JSON.parse(data) as { type?: unknown; body?: unknown };
        if (typeof env.type === 'string') onEnvelope({ type: env.type, body: env.body });
      } catch {
        // ignore non-JSON keepalive frames (e.g. ":heartbeat")
      }
      data = '';
    }
  }
  return tail;
}
