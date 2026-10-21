/**
 * Test fixtures (Spec 1658): shellper command lines as the Windows census
 * reports them, built with the same argv quoting Node uses on Windows.
 */

/** Quote one argument the way Node (libuv) does when it builds a Windows command line. */
export function quoteWindowsArg(arg: string): string {
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

/** A shellper command line as the Windows census reports it. */
export function windowsShellperCmdline(config: Record<string, unknown>): string {
  return [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@cluesmith\\codev\\dist\\terminal\\shellper-main.js',
    JSON.stringify(config),
  ].map(quoteWindowsArg).join(' ');
}
