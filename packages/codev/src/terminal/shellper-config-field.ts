/**
 * Reading one field of a shellper's JSON config out of command-line text
 * (Spec 1658). A leaf module (no imports), so the shellper transport's
 * implementations can use it without a cycle.
 */

/**
 * Extract and JSON-decode a `"key":"value"` string field from text holding a
 * shellper's JSON config. Regex rather than JSON.parse of the whole blob: the
 * config embeds the full process env, so a partial or unusual line must
 * degrade to "field absent" (null) rather than throw. An empty value also
 * reads as absent.
 */
export function readJsonStringField(text: string, key: string): string | null {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`));
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    if (typeof value !== 'string' || value === '') return null;
    return value;
  } catch {
    return null;
  }
}
