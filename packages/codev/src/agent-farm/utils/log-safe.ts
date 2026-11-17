/**
 * Header values headed for a log line. A leaf module so any route can use it
 * without importing a server module's graph.
 */

/** Trim a header value to something safe and bounded for a log line. */
export function logSafe(value: string | string[] | undefined, max = 160): string {
  if (value === undefined) return '';
  const flat = Array.isArray(value) ? value.join(',') : value;
  // Collapse control characters — a hostile header must not forge log lines.
  // eslint-disable-next-line no-control-regex
  return flat.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}
