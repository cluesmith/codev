/**
 * Pure parsers for a shellper's command line (Spec 1658): Windows argv
 * unquoting and the JSON config field reader. A leaf module (no imports), so
 * the shellper transport's Windows implementation can use them without a
 * cycle; `shellper-cmdline.ts` re-exports both.
 */

/**
 * Undo Windows argv quoting across a whole command line, the way
 * `CommandLineToArgvW` reads it, without splitting into arguments: `2n`
 * backslashes before a `"` become `n` backslashes and the quote is a delimiter
 * (dropped); `2n+1` backslashes before a `"` become `n` backslashes and a
 * literal `"`; backslashes not followed by a quote are literal. The result
 * holds each argument's text, so a JSON argument reads as plain JSON.
 */
export function unquoteWindowsCommandLine(cmdline: string): string {
  let out = '';
  let i = 0;
  while (i < cmdline.length) {
    const ch = cmdline[i];
    if (ch === '\\') {
      let run = 0;
      while (cmdline[i] === '\\') {
        run++;
        i++;
      }
      if (cmdline[i] === '"') {
        out += '\\'.repeat(Math.floor(run / 2));
        if (run % 2 === 1) out += '"';
        i++;
      } else {
        out += '\\'.repeat(run);
      }
      continue;
    }
    if (ch !== '"') out += ch;
    i++;
  }
  return out;
}

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
