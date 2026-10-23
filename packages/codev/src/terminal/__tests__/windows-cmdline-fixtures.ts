/**
 * Test fixtures (Spec 1658): shellper command lines as the Windows census
 * reports them, built with the same argv quoting Node uses on Windows.
 */

import { quoteWindowsArg } from '../shellper-cmdline.js';

export { quoteWindowsArg };

/** A shellper command line as the Windows census reports it. */
export function windowsShellperCmdline(config: Record<string, unknown>): string {
  return [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@cluesmith\\codev\\dist\\terminal\\shellper-main.js',
    JSON.stringify(config),
  ].map(quoteWindowsArg).join(' ');
}
