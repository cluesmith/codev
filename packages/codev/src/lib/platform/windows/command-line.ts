/**
 * Windows command-line quoting (Spec 1658): reading a raw command line back
 * as `CommandLineToArgvW` would, and quoting one argument as Node does. A leaf
 * module (no imports).
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
 * Quote one argument the way Node (libuv) does when it builds a Windows
 * command line, so `CommandLineToArgvW` reads it back unchanged: the inverse
 * of `unquoteWindowsCommandLine` for a single argument.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return out + '\\'.repeat(backslashes * 2) + '"';
}
