/**
 * Shared decode for Tower SSE events. Tower emits each event as a JSON envelope
 * `{ type, body }` on the SSE `data:` field with no `event:` name, so every
 * consumer inspects `type` itself. These helpers are the single decode used
 * across the extension (the builder-spawn handler, the editor provider, ...).
 */

/** A Tower SSE envelope as it arrives on the `data:` field. */
export interface SseEnvelope {
  type?: unknown;
  body?: unknown;
}

/** Parse a raw SSE `data:` payload into its envelope, or null if it is not JSON. */
export function parseSseEnvelope(data: string): SseEnvelope | null {
  try {
    return JSON.parse(data) as SseEnvelope;
  } catch {
    return null;
  }
}

/** Parse an envelope's `body` (a JSON string) into `T`, or null if absent/invalid. */
export function parseSseBody<T>(body: unknown): T | null {
  if (typeof body !== 'string') {
    return null;
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}
